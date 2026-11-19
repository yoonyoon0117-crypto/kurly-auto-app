'use strict';
/**
 * 실행(runner)이 끝나면 웹훅과 별개로 그 사용자의 기기들에 푸시를 보내는지 확인합니다.
 * 컬리 세션이 없는 사용자를 쓰므로 브라우저(Playwright)는 띄우지 않습니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { setupEnv } = require('./helpers');
setupEnv();

const webPush = require('web-push');
const store = require('../lib/store');
const push = require('../lib/webpush');
const { runCartForUser } = require('../lib/runner');

const SILENT = { info() {}, step() {}, warn() {}, error() {}, file: null };

const originalSend = webPush.sendNotification;
const calls = [];

function stubSend(impl) {
  webPush.sendNotification = async (subscription, payload, options) => {
    calls.push({ subscription, payload, options });
    return impl ? impl(subscription, payload, options) : { statusCode: 201 };
  };
}

test.after(() => {
  webPush.sendNotification = originalSend;
});

async function makeUser(nickname, { items = true } = {}) {
  store.ensureDirs();
  const user = await store.createUser({ nickname, passwordHash: 'x' });
  if (items) {
    await store.updateUser(user.userId, (u) => {
      u.items = [
        {
          id: 'item-test-1',
          productNo: 5090273,
          dealProductNo: 1002030322,
          name: '유정란 15구',
          unitSize: 15,
          unitLabel: '구',
          consumption: 30,
          price: 7990,
          active: true,
        },
      ];
      return u;
    });
  }
  return store.getUser(user.userId);
}

async function addSubscription(userId, label) {
  return push.subscribeUser(userId, {
    endpoint: `https://push.example.com/${label}-${Math.random().toString(36).slice(2, 8)}`,
    keys: { p256dh: `pub-${label}`, auth: `auth-${label}` },
    deviceLabel: label,
  });
}

test('실행이 끝나면 이 사용자의 기기로 푸시를 보낸다 (웹훅 없이도)', async () => {
  const user = await makeUser('푸시테스터');
  const sub = await addSubscription(user.userId, '아이폰');
  calls.length = 0;
  stubSend();

  const summary = await runCartForUser({ user, trigger: 'scheduled', logger: SILENT });

  assert.equal(summary.notification?.webhook ?? null, null, '웹훅은 설정하지 않았습니다.');
  assert.equal(summary.push.sent, 1);
  assert.equal(summary.push.pruned, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subscription.endpoint, sub.subscription.endpoint);

  const payload = JSON.parse(calls[0].payload);
  assert.match(payload.title, /확인이 필요해요/); // 세션이 없어 실패한 실행
  assert.match(payload.body, /정기 실행/);
  assert.match(payload.body, /유정란 15구/);
  assert.equal(payload.url, '/#run');
  assert.match(payload.tag, /^kurly-run-/);
});

test('직접 실행(manual)은 "직접 실행"으로 표시된다', async () => {
  const user = await makeUser('직접실행');
  await addSubscription(user.userId, '폰');
  calls.length = 0;
  stubSend();

  const summary = await runCartForUser({ user, trigger: 'manual', logger: SILENT });
  assert.equal(summary.push.sent, 1);
  const payload = JSON.parse(calls[0].payload);
  assert.match(payload.body, /직접 실행/);
});

test('미리보기(dryRun)에는 푸시를 보내지 않는다', async () => {
  const user = await makeUser('미리보기');
  await addSubscription(user.userId, '폰');
  calls.length = 0;
  stubSend();

  const summary = await runCartForUser({ user, trigger: 'manual', dryRun: true, logger: SILENT });
  assert.equal(summary.push, undefined);
  assert.equal(calls.length, 0);
});

test('구독이 없으면 조용히 건너뛴다', async () => {
  const user = await makeUser('구독없음');
  calls.length = 0;
  stubSend();

  const summary = await runCartForUser({ user, logger: SILENT });
  assert.equal(summary.push.skipped, true);
  assert.equal(summary.push.sent, 0);
  assert.equal(calls.length, 0);
});

test('410(만료) 구독은 실행 중에도 정리된다', async () => {
  const user = await makeUser('만료정리');
  const sub = await addSubscription(user.userId, '만료폰');
  calls.length = 0;
  stubSend(() => {
    throw Object.assign(new Error('Gone'), { statusCode: 410 });
  });

  const summary = await runCartForUser({ user, logger: SILENT });
  assert.equal(summary.push.sent, 0);
  assert.equal(summary.push.pruned, 1);
  assert.equal(push.listSubscriptions(user.userId).length, 0);
  assert.equal(push.findSubscription(user.userId, sub.subscription.endpoint), null);
});

test('푸시 전송이 예외로 죽어도 실행 기록은 남는다', async () => {
  const user = await makeUser('푸시예외');
  await addSubscription(user.userId, '폰');
  calls.length = 0;
  webPush.sendNotification = async () => {
    throw new Error('boom');
  };

  const summary = await runCartForUser({ user, logger: SILENT });
  assert.ok(summary.push, '실패해도 결과 객체는 있어야 합니다.');
  assert.equal(summary.push.failed, 1);

  const saved = store.getUser(user.userId);
  assert.equal(saved.runHistory[0].id, summary.id);
  assert.equal(saved.runHistory[0].push.failed, 1);
});
