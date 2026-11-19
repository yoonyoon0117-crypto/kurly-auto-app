'use strict';
/**
 * VAPID sub 주소 자동 교체와 푸시 실패 사유(lastError) 전달.
 *
 *  · 2026-11-19 이전 vapid.json 은 sub 이 mailto:…@example.invalid 였고,
 *    애플 web.push.apple.com 이 이를 403 으로 거부해 아이폰 테스트 알림이 오지 않았습니다.
 *  · 기존 키(publicKey/privateKey)는 그대로 두고 sub 만 바꿔 저장해야 구독이 살아 있습니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { setupEnv } = require('./helpers');
setupEnv();

const webPush = require('web-push');
const push = require('../lib/webpush');
const store = require('../lib/store');

function vapidFile() {
  return path.join(process.env.DATA_DIR, 'vapid.json');
}

function clearVapidEnv() {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
}

function writeLegacyFile(subject) {
  const pair = webPush.generateVAPIDKeys();
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  fs.writeFileSync(
    vapidFile(),
    `${JSON.stringify({ version: 1, publicKey: pair.publicKey, privateKey: pair.privateKey, subject, createdAt: '2026-11-01T00:00:00.000Z' }, null, 2)}\n`
  );
  return pair;
}

test('쓸 수 없는 VAPID sub — .invalid·localhost·mailto/https 아님', () => {
  assert.equal(push.isUnusableSubject('mailto:kurly-auto-app@example.invalid'), true);
  assert.equal(push.isUnusableSubject('https://example.invalid'), true);
  assert.equal(push.isUnusableSubject('https://localhost:3000'), true);
  assert.equal(push.isUnusableSubject('mailto:ops@localhost'), true);
  assert.equal(push.isUnusableSubject('ops@example.com'), true); // mailto: 가 아님
  assert.equal(push.isUnusableSubject(''), true);

  assert.equal(push.isUnusableSubject(push.DEFAULT_SUBJECT), false);
  assert.equal(push.isUnusableSubject('mailto:ops@example.com'), false);
  assert.equal(push.isUnusableSubject('https://kurly.example.com'), false);
});

test('기본 sub 은 푸시 서버가 거부하지 않는 주소다', () => {
  assert.match(push.DEFAULT_SUBJECT, /^https:\/\//);
  assert.equal(/\.invalid$/.test(new URL(push.DEFAULT_SUBJECT).hostname), false);
  assert.equal(push.isUnusableSubject(push.DEFAULT_SUBJECT), false);
});

test('예전 vapid.json(.invalid) 은 키를 그대로 두고 sub 만 바꿔 저장한다', () => {
  clearVapidEnv();
  const legacy = writeLegacyFile('mailto:kurly-auto-app@example.invalid');
  push._resetCacheForTests();

  const keys = push.getVapidKeys();
  assert.equal(keys.source, 'file');
  assert.equal(keys.publicKey, legacy.publicKey, '공개키는 그대로여야 구독이 살아 있습니다.');
  assert.equal(keys.privateKey, legacy.privateKey, '개인키도 그대로여야 합니다.');
  assert.equal(keys.subject, push.DEFAULT_SUBJECT);
  assert.equal(keys.subjectMigrated, true);

  const saved = JSON.parse(fs.readFileSync(vapidFile(), 'utf8'));
  assert.equal(saved.subject, push.DEFAULT_SUBJECT, 'vapid.json 에도 바뀐 sub 이 저장되어야 합니다.');
  assert.equal(saved.publicKey, legacy.publicKey);
  assert.equal(saved.privateKey, legacy.privateKey);
  assert.equal(saved.createdAt, '2026-11-01T00:00:00.000Z', '만든 시각은 유지합니다.');

  // 다음 실행부터는 파일에 좋은 sub 이 있으므로 다시 바꾸지 않습니다.
  push._resetCacheForTests();
  const again = push.getVapidKeys();
  assert.equal(again.subject, push.DEFAULT_SUBJECT);
  assert.ok(!again.subjectMigrated);
});

test('정상 sub 이 들어 있는 vapid.json 은 건드리지 않는다', () => {
  clearVapidEnv();
  const pair = writeLegacyFile('https://kurly.example.com');
  push._resetCacheForTests();

  const keys = push.getVapidKeys();
  assert.equal(keys.subject, 'https://kurly.example.com');
  assert.ok(!keys.subjectMigrated);
  assert.equal(JSON.parse(fs.readFileSync(vapidFile(), 'utf8')).publicKey, pair.publicKey);
});

test('환경변수 sub 이 .invalid 면 기본값으로 대체한다(푸시가 통째로 막히지 않게)', () => {
  const pair = webPush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = pair.publicKey;
  process.env.VAPID_PRIVATE_KEY = pair.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:ops@example.invalid';
  push._resetCacheForTests();

  const keys = push.getVapidKeys();
  assert.equal(keys.source, 'env');
  assert.equal(keys.subject, push.DEFAULT_SUBJECT);

  clearVapidEnv();
  push._resetCacheForTests();
});

test('푸시 전송 실패 시 lastError 에 HTTP 상태와 사유를 담아 돌려준다', async () => {
  clearVapidEnv();
  push._resetCacheForTests();
  store.ensureDirs();
  const user = await store.createUser({ nickname: '실패사유', passwordHash: 'x' });
  await push.subscribeUser(user.userId, {
    endpoint: 'https://web.push.apple.com/fail-1',
    keys: { p256dh: 'pub', auth: 'auth' },
    deviceLabel: '아이폰',
  });

  const original = webPush.sendNotification;
  webPush.sendNotification = async () => {
    const err = new Error('Received unexpected response code');
    err.statusCode = 403;
    err.body = '{"reason":"BadJwtToken"}';
    throw err;
  };
  try {
    const result = await push.sendToUser(user.userId, { title: 't', body: 'b' });
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.lastError, 'HTTP 403: {"reason":"BadJwtToken"}');
  } finally {
    webPush.sendNotification = original;
  }

  // 본문이 없는 오류도 사유를 잃지 않습니다.
  webPush.sendNotification = async () => {
    const err = new Error('socket hang up');
    err.statusCode = 502;
    throw err;
  };
  try {
    const result = await push.sendToUser(user.userId, { title: 't', body: 'b' });
    assert.equal(result.lastError, 'HTTP 502: socket hang up');
  } finally {
    webPush.sendNotification = original;
  }

  // 상태 코드가 없는 오류는 메시지를 그대로 씁니다.
  webPush.sendNotification = async () => {
    throw new Error('network down');
  };
  try {
    const result = await push.sendToUser(user.userId, { title: 't', body: 'b' });
    assert.equal(result.lastError, 'network down');
  } finally {
    webPush.sendNotification = original;
  }

  // 성공하면 lastError 는 없습니다.
  webPush.sendNotification = async () => ({ statusCode: 201 });
  try {
    const result = await push.sendToUser(user.userId, { title: 't', body: 'b' });
    assert.equal(result.sent, 1);
    assert.equal(result.lastError, null);
  } finally {
    webPush.sendNotification = original;
  }
});
