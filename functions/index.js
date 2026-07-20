const { setGlobalOptions } = require("firebase-functions");
const { onCall, onRequest, HttpsError } = require("firebase-functions/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

// Price IDは秘密情報ではないので直接記載。テスト⇔本番切り替え時はここを差し替える。
const STRIPE_PRICE_MONTHLY = "price_1TuvdgA9PEdE0jGyzCwGhDQT"; // テスト環境: 月額¥300
const STRIPE_PRICE_YEARLY = "price_1Tuve5A9PEdE0jGyKwanHPRN"; // テスト環境: 年額¥3,000
const APP_URL = "https://yujismz.github.io/shared-kakeibo-aa995/";

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
