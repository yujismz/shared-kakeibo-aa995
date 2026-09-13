/*
  揉めない家計簿 - Service Worker
  目的：デスクトップ/ホーム画面への「インストール」を可能にするための最小構成。
  データはFirebase Realtime Databaseとの通信が前提のアプリなので、
  「常に最新を優先し、通信できない時だけキャッシュで補う」方針にする。
  アプリ本体(index.html等)を積極的にキャッシュして古いバージョンを配信する事故を避けるため、
  事前キャッシュ(precache)はアイコン等の静的アセットのみに限定している。

  バージョンを上げるときは CACHE_NAME の日付を更新すること（古いキャッシュは自動破棄される）。
*/
const CACHE_NAME = 'kakeibo-shell-v2026-08-09';
const PRECACHE_URLS = [
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ネットワーク優先。取得できたときだけ静的アセットをキャッシュへ保存し、
// オフライン等で通信できない場合のみキャッシュから返す（HTML本体は基本キャッシュしない＝常に最新）。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && new URL(req.url).pathname.startsWith('/assets/')) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(()=>{});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
