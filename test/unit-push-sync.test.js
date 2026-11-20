'use strict';
/**
 * 클라이언트 자동 동기화 —public/app.js 의 syncPushSubscriptionIfNeeded / sendTestPush 를
 * 그대로 읽어 가짜 브라우저(PushManager·API)에 물려 동작을 확인합니다.
 *
 * 푸시가 오지 않아 사용자가 스위치를 껐다 켜야 했던 두 가지 원인을 앱이 스스로 고치는지 봅니다:
 *   ① 서버에 이 endpoint 기록이 없음(볼륨 초기화·재배포) → 다시 등록
 *   ② 서버 VAPID 공개키가 바뀜 → 구독을 해지하고 새 키로 다시 만든 뒤 등록
 * 그리고 테스트 발송이 0건이면 한 번 더 시도하는지도 확인합니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function slice(startMarker, endMarker) {
  const start = APP_SOURCE.indexOf(startMarker);
  assert.ok(start >= 0, `public/app.js 에서 "${startMarker}" 를 찾지 못했습니다.`);
  const end = APP_SOURCE.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `public/app.js 에서 "${endMarker}" 를 찾지 못했습니다.`);
  return APP_SOURCE.slice(start, end);
}

const SYNC_CODE = slice('function sameApplicationServerKey', 'async function refreshPushUI()');
const TEST_PUSH_CODE = slice('async function sendTestPush()', 'function maybeShowInstallHint()');

const PUBLIC_KEY = 'BOrEUZr6cJ0mY3H8mZP1j4i7l6T7m0aQ0h3V4bb2sV1n8sK5yQ0e9Z1c2p3x4r5t6u7v8w9A0B1C2D3E4F5';
const OTHER_KEY = 'BNx7T2m9pQ1r3s5v7y9B1D3F5H7J9L1N3P5R7T9V1X3Z5b7d9f1h3j5l7n9q1s3u5w7y9A1C3E5G7J';

function bytesOf(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64url'));
}

function makeSubscription(endpoint, keyBytes, log = []) {
  const key = keyBytes ? keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) : undefined;
  return {
    endpoint,
    options: { applicationServerKey: key },
    toJSON() {
      return { endpoint, keys: { p256dh: `p-${endpoint.slice(-4)}`, auth: `a-${endpoint.slice(-4)}` } };
    },
    async unsubscribe() {
      log.push({ type: 'unsubscribe', endpoint });
      return true;
    },
  };
}

/**
 * 가짜 브라우저 + 가짜 서버를 만들고 app.js 의 함수들을 그 위에서 돌립니다.
 * @param {object} opts
 * @param {'granted'|'default'} opts.permission
 * @param {object|null} opts.subscription  이미 이 기기에 있는 구독
 * @param {(info:{path:string, body:any, call:number}) => any} opts.apiHandler
 */
function makeHarness(opts = {}) {
  const log = [];
  const apiCalls = [];
  const subscribeCalls = [];
  let subscription = opts.subscription || null;
  const apiHandler = opts.apiHandler || (() => ({ ok: true }));

  // 처음부터 있던 구독의 해지도 이 하니스의 기록에 남깁니다.
  if (subscription) {
    const unsubscribe = subscription.unsubscribe.bind(subscription);
    subscription.unsubscribe = async () => {
      log.push({ type: 'unsubscribe', endpoint: subscription.endpoint });
      return unsubscribe();
    };
  }

  const reg = {
    pushManager: {
      async getSubscription() {
        return subscription;
      },
      async subscribe(options) {
        subscribeCalls.push(options);
        subscription = makeSubscription('https://web.push.apple.com/NEW-ENDPOINT', bytesOf(PUBLIC_KEY), log);
        log.push({ type: 'subscribe' });
        return subscription;
      },
    },
  };

  const context = {
    pushState: { registration: reg, subscription: null, busy: false, syncing: null },
    Notification: { permission: opts.permission || 'granted' },
    pushSupport: () => ({ ok: opts.support === false ? false : true, reason: '' }),
    pushRegistration: async () => reg,
    deviceLabel: () => '테스트 기기',
    urlBase64ToUint8Array: (b64) => bytesOf(b64),
    api: async (apiPath, init) => {
      apiCalls.push({ path: apiPath, body: init && init.body });
      return apiHandler({ path: apiPath, body: init && init.body, call: apiCalls.length });
    },
    console: { info() {}, warn() {}, error() {}, log() {} },
    setTimeout,
    clearTimeout,
    Promise,
    Buffer,
    ArrayBuffer,
    Uint8Array,
  };
  vm.createContext(context);
  vm.runInContext(`${SYNC_CODE}\n${TEST_PUSH_CODE}`, context);
  return { context, log, apiCalls, subscribeCalls, reg, getSubscription: () => subscription };
}

test('서버에 기록이 없으면(볼륨 초기화·재배포) 같은 구독을 조용히 다시 등록한다', async () => {
  const sub = makeSubscription('https://web.push.apple.com/AAA', bytesOf(PUBLIC_KEY));
  const harness = makeHarness({
    subscription: sub,
    apiHandler: ({ path: apiPath }) => {
      if (apiPath.startsWith('/api/push/vapid-key?endpoint=')) {
        return { ok: true, enabled: true, publicKey: PUBLIC_KEY, registered: false };
      }
      return { ok: true, count: 1 };
    },
  });

  const result = await harness.context.syncPushSubscriptionIfNeeded();

  assert.equal(result, sub);
  assert.equal(harness.subscribeCalls.length, 0, '키가 같으면 구독을 새로 만들지 않습니다.');
  assert.equal(harness.log.filter((e) => e.type === 'unsubscribe').length, 0);
  const subscribePosts = harness.apiCalls.filter((c) => c.path === '/api/push/subscribe');
  assert.equal(subscribePosts.length, 1, '같은 endpoint 를 서버에 다시 등록해야 합니다.');
  assert.equal(subscribePosts[0].body.endpoint, sub.endpoint);
  assert.equal(subscribePosts[0].body.deviceLabel, '테스트 기기');
  // endpoint 를 쿼리로 넘겨 서버가 그 기기의 등록 여부를 판단하게 합니다.
  assert.equal(
    harness.apiCalls[0].path,
    `/api/push/vapid-key?endpoint=${encodeURIComponent(sub.endpoint)}`
  );
  assert.equal(harness.context.pushState.subscription, sub);
  assert.equal(harness.context.pushState.syncing, null, '동기화가 끝나면 잠금이 풀려야 합니다.');
});

test('서버 VAPID 키가 바뀌었으면 구독을 해지하고 새 키로 다시 만든다', async () => {
  const stale = makeSubscription('https://web.push.apple.com/OLD', bytesOf(OTHER_KEY));
  const harness = makeHarness({
    subscription: stale,
    apiHandler: ({ path: apiPath }) => {
      if (apiPath.startsWith('/api/push/vapid-key')) {
        return { ok: true, enabled: true, publicKey: PUBLIC_KEY, registered: true };
      }
      return { ok: true, count: 1 };
    },
  });

  const result = await harness.context.syncPushSubscriptionIfNeeded();

  assert.equal(harness.log.filter((e) => e.type === 'unsubscribe').length, 1, '옛 키 구독은 해지해야 합니다.');
  assert.equal(harness.subscribeCalls.length, 1);
  const usedKey = new Uint8Array(harness.subscribeCalls[0].applicationServerKey);
  assert.deepEqual([...usedKey], [...bytesOf(PUBLIC_KEY)], '서버가 준 공개키로 구독해야 합니다.');
  assert.equal(harness.subscribeCalls[0].userVisibleOnly, true);
  assert.equal(result.endpoint, 'https://web.push.apple.com/NEW-ENDPOINT');
  const post = harness.apiCalls.filter((c) => c.path === '/api/push/subscribe');
  assert.equal(post.length, 1, '새 구독을 서버에 등록해야 합니다.');
  assert.equal(post[0].body.endpoint, result.endpoint);
  assert.equal(harness.context.pushState.subscription, result);
});

test('이미 키도 기록도 맞으면 아무 것도 하지 않는다 (불필요한 구독 갱신 금지)', async () => {
  const sub = makeSubscription('https://web.push.apple.com/SAME', bytesOf(PUBLIC_KEY));
  const harness = makeHarness({
    subscription: sub,
    apiHandler: () => ({ ok: true, enabled: true, publicKey: PUBLIC_KEY, registered: true }),
  });

  await harness.context.syncPushSubscriptionIfNeeded();

  assert.equal(harness.subscribeCalls.length, 0);
  assert.equal(harness.log.length, 0);
  assert.equal(harness.apiCalls.filter((c) => c.path !== `/api/push/vapid-key?endpoint=${encodeURIComponent(sub.endpoint)}`).length, 0);
  assert.equal(harness.context.pushState.subscription, sub);
});

test('켜지 않은 기기(로컬 구독 없음)·권한 없음·미지원에서는 서버를 건드리지 않는다', async () => {
  const noSub = makeHarness({ subscription: null });
  assert.equal(await noSub.context.syncPushSubscriptionIfNeeded(), null);
  assert.equal(noSub.apiCalls.length, 0);

  const denied = makeHarness({
    permission: 'default',
    subscription: makeSubscription('https://web.push.apple.com/X', bytesOf(PUBLIC_KEY)),
  });
  assert.equal(await denied.context.syncPushSubscriptionIfNeeded(), null);
  assert.equal(denied.apiCalls.length, 0);

  const unsupported = makeHarness({
    support: false,
    subscription: makeSubscription('https://web.push.apple.com/X', bytesOf(PUBLIC_KEY)),
  });
  assert.equal(await unsupported.context.syncPushSubscriptionIfNeeded(), null);
  assert.equal(unsupported.apiCalls.length, 0);
});

test('동기화가 실패해도 예외를 던지지 않고 화면을 막지 않는다', async () => {
  const harness = makeHarness({
    subscription: makeSubscription('https://web.push.apple.com/ERR', bytesOf(PUBLIC_KEY)),
    apiHandler: () => {
      throw Object.assign(new Error('네트워크 오류'), { status: 500 });
    },
  });

  assert.equal(await harness.context.syncPushSubscriptionIfNeeded(), null);
  assert.equal(harness.context.pushState.syncing, null);
});

test('같은 순간 여러 번 불려도 서버 요청은 한 번만 나간다', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const harness = makeHarness({
    subscription: makeSubscription('https://web.push.apple.com/DEDUPE', bytesOf(PUBLIC_KEY)),
    apiHandler: async () => {
      await gate;
      return { ok: true, enabled: true, publicKey: PUBLIC_KEY, registered: true };
    },
  });

  const first = harness.context.syncPushSubscriptionIfNeeded();
  const second = harness.context.syncPushSubscriptionIfNeeded();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, '동시에 불러도 같은 결과를 돌려줘야 합니다.');
  assert.equal(harness.apiCalls.length, 1, '진행 중인 동기화가 있으면 새로 요청하지 않습니다.');
});

test('테스트 발송이 0건이면 구독을 새로 만들고 한 번 더 보낸다', async () => {
  const dead = makeSubscription('https://web.push.apple.com/DEAD', bytesOf(PUBLIC_KEY));
  const toasts = [];
  let testPosts = 0;
  const harness = makeHarness({
    subscription: dead,
    apiHandler: ({ path: apiPath }) => {
      if (apiPath.startsWith('/api/push/vapid-key')) {
        return { ok: true, enabled: true, publicKey: PUBLIC_KEY, registered: true };
      }
      if (apiPath === '/api/push/subscribe') return { ok: true, count: 1 };
      if (apiPath === '/api/push/test') {
        testPosts += 1;
        // 첫 발송은 실패(구독 만료 정리), 다시 연결한 뒤 두 번째는 성공.
        return testPosts === 1
          ? { ok: true, sent: 0, failed: 0, pruned: 1, lastError: null }
          : { ok: true, sent: 1, failed: 0, pruned: 0, lastError: null };
      }
      return { ok: true };
    },
  });
  Object.assign(harness.context, {
    $: () => ({ disabled: false }),
    toast: (message, isError) => toasts.push({ message, isError }),
    refreshPushUI: async () => {},
  });

  await harness.context.sendTestPush();

  const testCalls = harness.apiCalls.filter((c) => c.path === '/api/push/test');
  assert.equal(testCalls.length, 2, '실패하면 한 번 더 시도해야 합니다.');
  assert.equal(harness.subscribeCalls.length, 1, '새 키로 다시 구독해야 합니다.');
  assert.equal(harness.log.filter((e) => e.type === 'unsubscribe').length, 1);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /보냈어요/);
  assert.ok(!toasts[0].isError, '성공하면 오류 토스트가 아닙니다.');
  assert.ok(!/껐다가 다시 켜/.test(toasts[0].message), '이제 스위치를 껐다 켜라고 하지 않습니다.');
});

test('서버 기록이 없어 400 이 나도 다시 등록하고 한 번 더 보낸다', async () => {
  const sub = makeSubscription('https://web.push.apple.com/400', bytesOf(PUBLIC_KEY));
  const toasts = [];
  const harness = makeHarness({
    subscription: sub,
    apiHandler: ({ path: apiPath }) => {
      if (apiPath.startsWith('/api/push/vapid-key')) {
        return { ok: true, enabled: true, publicKey: PUBLIC_KEY, registered: true };
      }
      if (apiPath === '/api/push/subscribe') return { ok: true, count: 1 };
      if (apiPath === '/api/push/test') {
        if (harness.apiCalls.filter((c) => c.path === '/api/push/test').length === 1) {
          throw Object.assign(new Error('이 기기 푸시 알림이 꺼져 있습니다.'), { status: 400 });
        }
        return { ok: true, sent: 1, failed: 0, pruned: 0, lastError: null };
      }
      return { ok: true };
    },
  });
  Object.assign(harness.context, {
    $: () => ({ disabled: false }),
    toast: (message, isError) => toasts.push({ message, isError }),
    refreshPushUI: async () => {},
  });

  await harness.context.sendTestPush();

  assert.equal(harness.apiCalls.filter((c) => c.path === '/api/push/subscribe').length, 1);
  assert.equal(harness.apiCalls.filter((c) => c.path === '/api/push/test').length, 2);
  assert.equal(harness.subscribeCalls.length, 0, '키가 맞으면 구독을 새로 만들 필요는 없습니다.');
  assert.match(toasts[0].message, /보냈어요/);
  assert.ok(!toasts[0].isError);
});

test('계속 0건이면 푸시 서버가 준 사유를 보여 준다', async () => {
  const harness = makeHarness({
    subscription: makeSubscription('https://web.push.apple.com/BAD', bytesOf(PUBLIC_KEY)),
    apiHandler: ({ path: apiPath }) => {
      if (apiPath.startsWith('/api/push/vapid-key')) {
        return { ok: true, enabled: true, publicKey: PUBLIC_KEY, registered: true };
      }
      if (apiPath === '/api/push/subscribe') return { ok: true, count: 1 };
      if (apiPath === '/api/push/test') {
        return { ok: true, sent: 0, failed: 1, pruned: 0, lastError: 'HTTP 403: BadJwtToken' };
      }
      return { ok: true };
    },
  });
  const toasts = [];
  Object.assign(harness.context, {
    $: () => ({ disabled: false }),
    toast: (message, isError) => toasts.push({ message, isError }),
    refreshPushUI: async () => {},
  });

  await harness.context.sendTestPush();

  assert.equal(harness.apiCalls.filter((c) => c.path === '/api/push/test').length, 2, '자동으로 한 번만 더 시도합니다.');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].isError, true);
  assert.match(toasts[0].message, /HTTP 403: BadJwtToken/);
});
