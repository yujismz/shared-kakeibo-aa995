const { setGlobalOptions } = require("firebase-functions");
const { onCall, onRequest, HttpsError } = require("firebase-functions/https");
const { onSchedule } = require("firebase-functions/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

// Price IDは秘密情報ではないので直接記載。テスト⇔本番切り替え時はここを差し替える。
const STRIPE_PRICE_MONTHLY = "price_1TuujsA9PEdE0jGynMUiaReV"; // 本番環境: 月額¥300
const STRIPE_PRICE_YEARLY = "price_1TuuoNA9PEdE0jGyOKwugPx2"; // 本番環境: 年額¥3,000
const APP_URL = "https://shared-kakeibo-aa995.web.app/";

// ログイン中ユーザーが所属する世帯IDを取得する
async function getHouseholdId(uid) {
  const snap = await admin.database().ref("userHouseholds/" + uid).once("value");
  const hid = snap.val();
  if (!hid) {
    throw new HttpsError("failed-precondition", "世帯が見つかりません。");
  }
  return hid;
}

exports.createCheckoutSession = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const plan = request.data && request.data.plan;
    if (plan !== "monthly" && plan !== "yearly") {
      throw new HttpsError("invalid-argument", "プラン指定が不正です。");
    }

    const hid = await getHouseholdId(request.auth.uid);
    const priceId = plan === "monthly" ? STRIPE_PRICE_MONTHLY : STRIPE_PRICE_YEARLY;
    const stripe = new Stripe(STRIPE_SECRET_KEY.value());

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: hid,
      metadata: { householdId: hid, plan },
      subscription_data: { metadata: { householdId: hid, plan } },
      success_url: APP_URL + "?checkout=success",
      cancel_url: APP_URL + "?checkout=cancel",
    });

    return { url: session.url };
  }
);

exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const stripe = new Stripe(STRIPE_SECRET_KEY.value());
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      logger.error("Webhook signature verification failed", err);
      res.status(400).send("Webhook signature verification failed");
      return;
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const hid = session.metadata && session.metadata.householdId;
          if (hid) {
            await admin.database().ref("households/" + hid + "/premium").update({
              active: true,
              plan: session.metadata.plan || null,
              stripeCustomerId: session.customer,
              stripeSubscriptionId: session.subscription,
              updatedAt: admin.database.ServerValue.TIMESTAMP,
            });
          }
          break;
        }
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const hid = subscription.metadata && subscription.metadata.householdId;
          if (hid) {
            const active = subscription.status === "active" || subscription.status === "trialing";
            await admin.database().ref("households/" + hid + "/premium").update({
              active,
              stripeSubscriptionId: subscription.id,
              status: subscription.status,
              updatedAt: admin.database.ServerValue.TIMESTAMP,
            });
          }
          break;
        }
        default:
          break;
      }
      res.status(200).send("ok");
    } catch (err) {
      logger.error("Webhook handling error", err);
      res.status(500).send("internal error");
    }
  }
);

const BACKUP_RETENTION_DAYS = 30;

// Realtime Database全体を毎日Cloud Storageへバックアップし、古いものは自動削除する
exports.dailyBackup = onSchedule(
  { schedule: "every day 04:00", timeZone: "Asia/Tokyo" },
  async () => {
    const snapshot = await admin.database().ref("/").once("value");
    const json = JSON.stringify(snapshot.val());
    const dateKey = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }); // YYYY-MM-DD（JST基準）

    const bucket = admin.storage().bucket();
    const file = bucket.file(`backups/${dateKey}.json`);
    await file.save(json, { contentType: "application/json" });
    logger.info(`Backup saved: backups/${dateKey}.json (${json.length} bytes)`);

    const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const [files] = await bucket.getFiles({ prefix: "backups/" });
    for (const f of files) {
      const [meta] = await f.getMetadata();
      if (new Date(meta.timeCreated).getTime() < cutoff) {
        await f.delete();
        logger.info(`Deleted old backup: ${f.name}`);
      }
    }
  }
);

/* ===================== アップデート連絡（管理者専用・admin.htmlから利用） ===================== */
// アプリ開発者本人のFirebase Auth UID。管理者向け機能はこのUIDでのみ許可する
// （世帯ごとの「管理者」役割＝家計の作成者とは別物。こちらはアプリ全体の運営者チェック）
const ADMIN_UID = "bBz3i9ugyBeT9mYJ2fnvLIvzWqm2"; // momenai.kakeibo@gmail.com

// 送信元アドレスは秘密情報ではないので直接記載（パスワード再設定メールと同じ送信元）
const GMAIL_USER = "momenai.kakeibo@gmail.com";
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

function requireAdmin(request) {
  if (!request.auth || request.auth.uid !== ADMIN_UID) {
    throw new HttpsError("permission-denied", "この操作を行う権限がありません。");
  }
}

// 全世帯・全ユーザーのメールアドレスを、重複を除いて集める
async function collectAnnouncementRecipients() {
  const snapshot = await admin.database().ref("households").once("value");
  const households = snapshot.val() || {};
  const recipients = new Map(); // メールアドレス（小文字）-> 表示名
  Object.values(households).forEach((h) => {
    const users = (h && h.data && h.data.users) || [];
    users.forEach((u) => {
      if (u && u.email) {
        const key = String(u.email).trim().toLowerCase();
        if (key && !recipients.has(key)) recipients.set(key, u.name || "");
      }
    });
  });
  return recipients;
}

// 送信前に対象人数だけを確認するための下見用エンドポイント（実際には送信しない）
exports.previewAnnouncementRecipients = onCall(async (request) => {
  requireAdmin(request);
  const recipients = await collectAnnouncementRecipients();
  return { count: recipients.size };
});

// 全ユーザーへアップデート連絡メールを一斉送信する（Gmail SMTPリレー使用）
exports.sendUpdateAnnouncement = onCall(
  { secrets: [GMAIL_APP_PASSWORD] },
  async (request) => {
    requireAdmin(request);
    const subject = (request.data && String(request.data.subject || "").trim()) || "";
    const body = (request.data && String(request.data.body || "").trim()) || "";
    if (!subject || !body) {
      throw new HttpsError("invalid-argument", "件名と本文を入力してください。");
    }

    const recipients = await collectAnnouncementRecipients();
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.value() },
    });

    let sent = 0;
    let failed = 0;
    for (const [email, name] of recipients) {
      try {
        await transporter.sendMail({
          from: `"揉めない家計簿" <${GMAIL_USER}>`,
          to: email,
          subject,
          text:
            (name ? name + "様\n\n" : "") +
            body +
            "\n\n---\nこのメールは「揉めない家計簿」にご登録いただいた方にお送りしています。",
        });
        sent++;
      } catch (e) {
        logger.error("announcement send error", email, e);
        failed++;
      }
    }
    logger.info(`Announcement sent: ${sent}/${recipients.size} (failed: ${failed})`);
    return { total: recipients.size, sent, failed };
  }
);
