/**
 * 跑管家 PWA Service Worker (Network-First 輕量版)
 * - 支援 Android Chrome「安裝應用程式」與 iOS 全螢幕主畫面啟動
 * - 連網一律優先取最新程式，絕不卡舊快取；離線時自動回退本機快取
 * - 完全略過 GAS / 外部網域與非 GET 請求，確保同步與金流/報名不受干擾
 */
const CACHE_NAME = 'tur-run-manager-v5.22';
const CORE_ASSETS = [
  './',
  './index.html',
  './public.html',
  './manifest.webmanifest',
  './assets/icon-180.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/tur-logo.jpg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS).catch(() => {}))
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => (k.startsWith('tur-run-manager-') || k.startsWith('tur-timing-king-')) && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  // 僅處理同源靜態資源；外部 API（如 Google Apps Script、字型 CDN）一律直接走網路
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => {
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }))
  );
});
