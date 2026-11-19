'use strict';
/**
 * VAPID 키 관리 — 환경변수 우선, 없으면 DATA_DIR/vapid.json 에 자동 생성·보관(0600).
 * Railway 처럼 /data 볼륨만 있는 배포에서 환경변수 없이 동작하는지 확인합니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { setupEnv } = require('./helpers');
setupEnv();

const webPush = require('web-push');
const push = require('../lib/webpush');

function vapidFile() {
  return path.join(process.env.DATA_DIR, 'vapid.json');
}

function clearVapidEnv() {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
}

test('환경변수가 없으면 DATA_DIR/vapid.json 에 키를 만들어 0600 으로 보관한다', () => {
  clearVapidEnv();
  push._resetCacheForTests();
  assert.equal(fs.existsSync(vapidFile()), false);

  const keys = push.getVapidKeys();
  assert.equal(keys.source, 'generated');
  assert.match(keys.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  assert.match(keys.privateKey, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(keys.subject, push.DEFAULT_SUBJECT);

  assert.ok(fs.existsSync(vapidFile()), 'vapid.json 이 만들어져야 합니다.');
  const mode = fs.statSync(vapidFile()).mode & 0o777;
  assert.equal(mode, 0o600, 'VAPID 개인키 파일은 0600 이어야 합니다.');

  const saved = JSON.parse(fs.readFileSync(vapidFile(), 'utf8'));
  assert.equal(saved.publicKey, keys.publicKey);
  assert.equal(saved.privateKey, keys.privateKey);

  // 서버를 다시 켜도(캐시 초기화) 같은 키를 읽어야 구독이 살아 있습니다.
  push._resetCacheForTests();
  const again = push.getVapidKeys();
  assert.equal(again.source, 'file');
  assert.equal(again.publicKey, keys.publicKey);
  assert.equal(again.privateKey, keys.privateKey);
});

test('VAPID_PUBLIC_KEY·PRIVATE_KEY 환경변수가 있으면 파일보다 우선한다', () => {
  const pair = webPush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = pair.publicKey;
  process.env.VAPID_PRIVATE_KEY = pair.privateKey;
  process.env.VAPID_SUBJECT = 'ops@example.com';
  push._resetCacheForTests();

  const keys = push.getVapidKeys();
  assert.equal(keys.source, 'env');
  assert.equal(keys.publicKey, pair.publicKey);
  assert.equal(keys.privateKey, pair.privateKey);
  assert.equal(keys.subject, 'mailto:ops@example.com', 'mailto: 가 없으면 붙여 줍니다.');
  assert.equal(push.publicKey(), pair.publicKey);

  // https: subject 는 그대로 둡니다.
  process.env.VAPID_SUBJECT = 'https://kurly.example.com';
  push._resetCacheForTests();
  assert.equal(push.getVapidKeys().subject, 'https://kurly.example.com');
});

test('키가 한쪽만 있으면 환경변수를 무시하고 저장된 키를 쓴다', () => {
  const saved = JSON.parse(fs.readFileSync(vapidFile(), 'utf8'));
  clearVapidEnv();
  process.env.VAPID_PUBLIC_KEY = webPush.generateVAPIDKeys().publicKey; // 짝이 없는 공개키
  push._resetCacheForTests();

  const keys = push.getVapidKeys();
  assert.equal(keys.source, 'file');
  assert.equal(keys.publicKey, saved.publicKey);

  clearVapidEnv();
  push._resetCacheForTests();
});

test('configureVapid 는 web-push 에 서명 정보를 설정한다', () => {
  const result = push.configureVapid(null);
  assert.equal(result.ok, true);
  assert.ok(['file', 'env', 'generated', undefined].includes(result.source));
});

test('구독 입력값 검사 — endpoint 는 https, keys.p256dh/auth 필수', () => {
  assert.throws(() => push.sanitizeSubscription({}), /endpoint/);
  assert.throws(() => push.sanitizeSubscription({ endpoint: 'http://push.example.com/x' }), /https/);
  assert.throws(() => push.sanitizeSubscription({ endpoint: 'not-a-url' }), /URL/);
  assert.throws(
    () => push.sanitizeSubscription({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a' } }),
    /p256dh/
  );

  const ok = push.sanitizeSubscription({
    endpoint: 'https://push.example.com/x',
    keys: { p256dh: 'pubkey', auth: 'authkey' },
    deviceLabel: '아이폰 · 홈 화면 앱',
    userAgent: 'Mozilla/5.0',
  });
  assert.deepEqual(ok, {
    endpoint: 'https://push.example.com/x',
    keys: { p256dh: 'pubkey', auth: 'authkey' },
    deviceLabel: '아이폰 · 홈 화면 앱',
    userAgent: 'Mozilla/5.0',
  });
  assert.equal(push.sanitizeSubscription({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } }).deviceLabel, '이 기기');
});
