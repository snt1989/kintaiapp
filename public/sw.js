/* 勤怠管理システムのサービスワーカー
 * - 画面(HTML・CSS・JS・アイコン)だけを端末に保存し、表示を速くする。
 * - /api/ のデータ(打刻・勤怠・給与など)は保存しない。通信できないときは、打刻などはできない。
 * - 画面のファイルを更新したときは、VERSION を変える。 */
const VERSION = 'kintai-v2';
const SHELL = [
  '/offline.html', '/css/style.css', '/js/api.js', '/js/demo-mock.js', '/js/pwa.js',
  '/favicon.png', '/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // データは、いつも通信して取得する

  // 画面(HTML): 通信できるときは最新を取り、できないときは保存済みの画面か、オフラインの案内を出す
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('/offline.html')))
    );
    return;
  }

  // CSS・JS・画像: 保存済みを先に使い、裏で更新する
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
