'use strict';
/**
 * 서비스 워커 — 앱 껍데기(HTML/CSS/JS/아이콘)만 캐시하고, API 는 절대 캐시하지 않습니다.
 *  · 설치: 앱 껍데기 미리 받기
 *  · 화면 요청: 네트워크 우선 → 실패하면 캐시된 index.html (오프라인에서도 "앱처럼" 열림)
 *  · HTML/JS/CSS(앱 껍데기): 네트워크 우선 — 새로 배포한 버전이 홈 화면 앱을 다시 열 때 바로 반영
 *  · /api/*: 항상 네트워크 (장바구니·실행 상태가 낡으면 안 됨)
 *  · push: 서버가 보낸 웹 푸시를 알림으로 표시 (iOS 16.4+ 홈 화면 앱)
 *  · notificationclick: 앱을 열거나 이미 열린 창을 앞으로 가져옵니다.
 */
const VERSION = 'kurly-v2.2.2';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

/* ─────────────── 웹 푸시 ─────────────── */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || '컬리 정기 장바구니';
  const options = {
    body: payload.body || '장바구니 담기 결과가 도착했어요.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || 'kurly-run',
    renotify: Boolean(payload.tag),
    data: { url: payload.url || '/#run', ...(payload.data || {}) },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || '/#run',
    self.location.origin
  ).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const sameApp = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (sameApp) {
        await sameApp.focus();
        // 실행 탭처럼 알림이 가리키는 화면으로 이동 (지원되는 경우)
        if ('navigate' in sameApp) {
          try {
            await sameApp.navigate(target);
          } catch {
            /* 무시 */
          }
        }
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })()
  );
});

/* ─────────────── 캐시 ─────────────── */

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // API 는 서비스 워커가 손대지 않음

  const isDocument = request.mode === 'navigate';
  const isShellAsset =
    request.destination === 'script' ||
    request.destination === 'style' ||
    /\.(?:html|js|css)$/i.test(url.pathname);

  // 앱 껍데기(HTML/JS/CSS)는 네트워크 우선입니다.
  // 캐시 우선이면 새로 배포해도 아이폰 홈 화면 앱이 예전 app.js 를 계속 써서
  // 두세 번 껐다 켜야 바뀌었습니다. 네트워크가 없을 때만 캐시로 대신합니다.
  if (isDocument || isShellAsset) {
    const key = isDocument ? '/index.html' : request;
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(key, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(key).then((cached) => cached || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
