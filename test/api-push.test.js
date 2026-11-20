'use strict';
/**
 * /api/push/* — VAPID 공개키, 구독 등록·해지, 테스트 발송, 만료(410) 정리, 사용자별 분리.
 * 실제 푸시 서비스로 나가지 않도록 web-push.sendNotification 만 바꿔 끼웁니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { setupEnv, startServer, request, register } = require('./helpers');

setupEnv();

const webPush = require('web-push');

let server;
let originalSend;
const sentCalls = [];

function stubSend(impl) {
  webPush.sendNotification = async (subscription, payload, options) => {
    sentCalls.push({ subscription, payload, options });
    return impl ? impl(subscription, payload, options) : { statusCode: 201 };
  };
}

function subscriptionFor(label, host = 'push.example.com') {
  return {
    endpoint: `https://${host}/${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    keys: { p256dh: `p256dh-${label}`, auth: `auth-${label}` },
    deviceLabel: label,
  };
}

function userFile(userId) {
  return path.join(server.dataDir, 'users', `${userId}.json`);
}

function savedSubscriptions(userId) {
  return JSON.parse(fs.readFileSync(userFile(userId), 'utf8')).pushSubscriptions || [];
}

test.before(async () => {
  server = await startServer();
  originalSend = webPush.sendNotification;
});

test.after(async () => {
  webPush.sendNotification = originalSend;
  await server.close();
});

test('푸시 API 는 로그인이 필요하다', async () => {
  for (const [method, url] of [
    ['GET', '/api/push/vapid-key'],
    ['GET', '/api/push/vapid-key?endpoint=https%3A%2F%2Fpush.example.com%2Fx'],
    ['GET', '/api/push/status'],
    ['POST', '/api/push/subscribe'],
    ['POST', '/api/push/unsubscribe'],
    ['POST', '/api/push/test'],
  ]) {
    const res = await request(server.baseUrl, url, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${url} 는 401 이어야 합니다.`);
  }
});

test('GET /api/push/vapid-key — 저장된 공개키를 돌려준다', async () => {
  const me = await register(server.baseUrl);
  const res = await request(server.baseUrl, '/api/push/vapid-key', { cookie: me.cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.publicKey, /^[A-Za-z0-9_-]{80,}$/);

  const saved = JSON.parse(fs.readFileSync(path.join(server.dataDir, 'vapid.json'), 'utf8'));
  assert.equal(res.body.publicKey, saved.publicKey);
  // 개인키는 절대 내보내지 않습니다.
  assert.ok(!JSON.stringify(res.body).includes(saved.privateKey));
});

test('GET /api/push/vapid-key?endpoint= — 이 기기 구독이 서버에 등록돼 있는지 알려준다', async () => {
  const me = await register(server.baseUrl);
  const other = await register(server.baseUrl);
  const sub = subscriptionFor('동기화폰');

  // 구독 전 — endpoint 가 없으면 registered 는 false 입니다.
  const before = await request(server.baseUrl, '/api/push/vapid-key', { cookie: me.cookie });
  assert.equal(before.status, 200);
  assert.equal(before.body.ok, true);
  assert.equal(before.body.enabled, true, '서버 푸시가 켜져 있다는 표시');
  assert.equal(before.body.registered, false, 'endpoint 를 주지 않으면 false');

  const unknown = await request(
    server.baseUrl,
    `/api/push/vapid-key?endpoint=${encodeURIComponent(sub.endpoint)}`,
    { cookie: me.cookie }
  );
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.registered, false, '등록되지 않은 endpoint 는 false');

  await request(server.baseUrl, '/api/push/subscribe', { method: 'POST', cookie: other.cookie, body: sub });
  const others = await request(
    server.baseUrl,
    `/api/push/vapid-key?endpoint=${encodeURIComponent(sub.endpoint)}`,
    { cookie: me.cookie }
  );
  assert.equal(others.body.registered, false, '남의 기기 구독을 내 것으로 보면 안 됩니다.');

  // 내 구독으로 등록한 뒤 — 같은 endpoint 면 registered: true.
  await request(server.baseUrl, '/api/push/subscribe', { method: 'POST', cookie: me.cookie, body: sub });
  const after = await request(
    server.baseUrl,
    `/api/push/vapid-key?endpoint=${encodeURIComponent(sub.endpoint)}`,
    { cookie: me.cookie }
  );
  assert.equal(after.status, 200);
  assert.equal(after.body.registered, true);
  assert.equal(after.body.publicKey, before.body.publicKey, '키는 언제나 같은 값을 돌려줍니다.');

  // 해지하면 다시 false — 앱이 다음에 열릴 때 다시 등록할 수 있어야 합니다.
  await request(server.baseUrl, '/api/push/unsubscribe', {
    method: 'POST',
    cookie: me.cookie,
    body: { endpoint: sub.endpoint },
  });
  const gone = await request(
    server.baseUrl,
    `/api/push/vapid-key?endpoint=${encodeURIComponent(sub.endpoint)}`,
    { cookie: me.cookie }
  );
  assert.equal(gone.body.registered, false);

  // 개인키는 어떤 경우에도 나가지 않습니다.
  const saved = JSON.parse(fs.readFileSync(path.join(server.dataDir, 'vapid.json'), 'utf8'));
  assert.ok(!JSON.stringify(gone.body).includes(saved.privateKey));
});

test('POST /api/push/subscribe — 사용자 파일에만 저장하고 같은 endpoint 는 하나로 유지', async () => {
  const me = await register(server.baseUrl);
  const other = await register(server.baseUrl);
  const sub = subscriptionFor('아이폰');

  const first = await request(server.baseUrl, '/api/push/subscribe', {
    method: 'POST',
    cookie: me.cookie,
    body: sub,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 1);

  const mine = savedSubscriptions(me.body.user.userId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].endpoint, sub.endpoint);
  assert.equal(mine[0].deviceLabel, '아이폰');
  assert.equal(mine[0].keys.p256dh, sub.keys.p256dh);

  // 사용자별 완전 분리 — 다른 사용자 파일에는 아무것도 없어야 합니다.
  assert.deepEqual(savedSubscriptions(other.body.user.userId), []);

  // 같은 기기에서 다시 구독(권한 갱신 등)해도 한 개만 남습니다.
  const again = await request(server.baseUrl, '/api/push/subscribe', {
    method: 'POST',
    cookie: me.cookie,
    body: { ...sub, deviceLabel: '아이폰 · 새 라벨' },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.count, 1);
  assert.equal(savedSubscriptions(me.body.user.userId)[0].deviceLabel, '아이폰 · 새 라벨');

  const status = await request(server.baseUrl, '/api/push/status', { cookie: me.cookie });
  assert.equal(status.status, 200);
  assert.equal(status.body.count, 1);
  assert.equal(status.body.subscriptions[0].endpoint, sub.endpoint);
  assert.equal(status.body.subscriptions[0].keys, undefined, '구독 키는 내보내지 않습니다.');
});

test('POST /api/push/subscribe — 잘못된 구독은 400', async () => {
  const me = await register(server.baseUrl);
  for (const body of [
    {},
    { endpoint: 'http://insecure.example.com/x', keys: { p256dh: 'a', auth: 'b' } },
    { endpoint: 'https://push.example.com/x', keys: {} },
    { endpoint: 'nope', keys: { p256dh: 'a', auth: 'b' } },
  ]) {
    const res = await request(server.baseUrl, '/api/push/subscribe', { method: 'POST', cookie: me.cookie, body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(savedSubscriptions(me.body.user.userId), []);
});

test('POST /api/push/test — 구독한 기기로 제목·본문·아이콘 경로를 보낸다', async () => {
  const me = await register(server.baseUrl);
  const sub = subscriptionFor('테스트폰');
  await request(server.baseUrl, '/api/push/subscribe', { method: 'POST', cookie: me.cookie, body: sub });

  sentCalls.length = 0;
  stubSend();
  const res = await request(server.baseUrl, '/api/push/test', { method: 'POST', cookie: me.cookie, body: {} });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sent, 1);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.lastError, null, '성공하면 오류 사유는 없습니다.');

  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].subscription.endpoint, sub.endpoint);
  assert.equal(sentCalls[0].subscription.keys.p256dh, sub.keys.p256dh);
  assert.equal(sentCalls[0].subscription.keys.auth, sub.keys.auth);
  const payload = JSON.parse(sentCalls[0].payload);
  assert.match(payload.title, /테스트 알림/);
  assert.match(payload.body, /푸시가 제대로 연결/);
  assert.equal(payload.url, '/#settings');
  assert.equal(sentCalls[0].options.TTL > 0, true);
});

test('POST /api/push/test — 구독이 없으면 400', async () => {
  const me = await register(server.baseUrl);
  const res = await request(server.baseUrl, '/api/push/test', { method: 'POST', cookie: me.cookie, body: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /푸시 알림이 꺼져/);
});

test('만료(410/404) 구독은 자동 정리되고 다른 사용자 구독은 건드리지 않는다', async () => {
  const me = await register(server.baseUrl);
  const other = await register(server.baseUrl);
  const deadSub = subscriptionFor('죽은기기', 'push.example.com');
  const liveSub = subscriptionFor('산기기', 'push.example.com');
  await request(server.baseUrl, '/api/push/subscribe', { method: 'POST', cookie: me.cookie, body: deadSub });
  await request(server.baseUrl, '/api/push/subscribe', { method: 'POST', cookie: other.cookie, body: liveSub });

  sentCalls.length = 0;
  stubSend((subscription) => {
    if (subscription.endpoint === deadSub.endpoint) {
      throw Object.assign(new Error('Gone'), { statusCode: 410 });
    }
    return { statusCode: 201 };
  });

  const res = await request(server.baseUrl, '/api/push/test', { method: 'POST', cookie: me.cookie, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, 0);
  assert.equal(res.body.pruned, 1);
  assert.deepEqual(savedSubscriptions(me.body.user.userId), [], '만료된 구독은 사용자 파일에서 지워져야 합니다.');

  // 다른 사용자의 구독은 그대로
  assert.equal(savedSubscriptions(other.body.user.userId).length, 1);

  // 다음 테스트 발송은 보낼 곳이 없어 400
  const again = await request(server.baseUrl, '/api/push/test', { method: 'POST', cookie: me.cookie, body: {} });
  assert.equal(again.status, 400);
});

test('전송 실패(500)는 구독을 지우지 않고 failed 로 센다', async () => {
  const me = await register(server.baseUrl);
  const sub = subscriptionFor('일시오류');
  await request(server.baseUrl, '/api/push/subscribe', { method: 'POST', cookie: me.cookie, body: sub });

  stubSend(() => {
    throw Object.assign(new Error('push service unavailable'), { statusCode: 503, body: 'try later' });
  });
  const res = await request(server.baseUrl, '/api/push/test', { method: 'POST', cookie: me.cookie, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, 0);
  assert.equal(res.body.failed, 1);
  assert.equal(res.body.pruned, 0);
  assert.match(res.body.lastError, /HTTP 503/);
  assert.match(res.body.lastError, /try later/);
  assert.equal(savedSubscriptions(me.body.user.userId).length, 1, '일시 오류로 구독을 지우면 안 됩니다.');
});

test('POST /api/push/unsubscribe — 그 endpoint 만 지운다', async () => {
  const me = await register(server.baseUrl);
  const phone = subscriptionFor('폰');
  const pad = subscriptionFor('패드');
  await request(server.baseUrl, '/api/push/subscribe', { method: 'POST', cookie: me.cookie, body: phone });
  await request(server.baseUrl, '/api/push/subscribe', { method: 'POST', cookie: me.cookie, body: pad });

  const res = await request(server.baseUrl, '/api/push/unsubscribe', {
    method: 'POST',
    cookie: me.cookie,
    body: { endpoint: phone.endpoint },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, 1);
  assert.equal(res.body.count, 1);
  const left = savedSubscriptions(me.body.user.userId);
  assert.equal(left.length, 1);
  assert.equal(left[0].endpoint, pad.endpoint);

  // 없는 endpoint 해지는 조용히 0
  const missing = await request(server.baseUrl, '/api/push/unsubscribe', {
    method: 'POST',
    cookie: me.cookie,
    body: { endpoint: 'https://push.example.com/none' },
  });
  assert.equal(missing.status, 200);
  assert.equal(missing.body.removed, 0);

  const bad = await request(server.baseUrl, '/api/push/unsubscribe', { method: 'POST', cookie: me.cookie, body: {} });
  assert.equal(bad.status, 400);
});

test('PWA 껍데기 — 서비스 워커가 push·notificationclick 을 처리하고 설정에 푸시 UI 가 있다', async () => {
  const sw = await request(server.baseUrl, '/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.text, /kurly-v2\.2\.2/);
  // 새로 배포한 HTML/JS/CSS 가 홈 화면 앱을 다시 열 때 바로 반영되도록 네트워크 우선이어야 합니다.
  assert.match(sw.text, /request\.destination === 'script'/);
  assert.match(sw.text, /cache: 'no-store'/);
  assert.match(sw.text, /addEventListener\('push'/);
  assert.match(sw.text, /self\.registration\.showNotification/);
  assert.match(sw.text, /addEventListener\('notificationclick'/);
  assert.match(sw.text, /icons\/icon-192\.png/);

  const index = await request(server.baseUrl, '/');
  assert.match(index.text, /id="pushToggle"/);
  assert.match(index.text, /이 기기 푸시 알림/);
  assert.match(index.text, /id="pushTestBtn"/);
  assert.match(index.text, /테스트 알림 보내기/);
  assert.match(index.text, /id="pushHint"/);

  const app = await request(server.baseUrl, '/app.js');
  assert.match(app.text, /pushManager\.subscribe/);
  assert.match(app.text, /\/api\/push\/subscribe/);
  assert.match(app.text, /serviceWorker\.ready/);
  // 아이폰에서 ready 가 늦어도 '확인 중…' 에 멈추지 않아야 합니다.
  assert.match(app.text, /serviceWorker\.getRegistration/);
  assert.match(app.text, /Promise\.race/);
  assert.match(app.text, /3500/);
  // 켜 둔 푸시가 오지 않을 때 사용자가 스위치를 꺼다 켜지 않아도 되도록 자동 동기화가 들어 있어야 합니다.
  assert.match(app.text, /syncPushSubscriptionIfNeeded/);
  assert.match(app.text, /\/api\/push\/vapid-key\?endpoint=/);
  assert.match(app.text, /sameApplicationServerKey/);
  assert.match(app.text, /resubscribePush/);
  // refreshPushUI 와 sendTestPush 둘 다에서 조용히 맞춥니다.
  const syncCalls = app.text.match(/syncPushSubscriptionIfNeeded\(\)/g) || [];
  assert.ok(syncCalls.length >= 3, `syncPushSubscriptionIfNeeded 는 정의 + 화면 갱신 + 테스트 발송에서 불려야 합니다 (${syncCalls.length})`);
});
