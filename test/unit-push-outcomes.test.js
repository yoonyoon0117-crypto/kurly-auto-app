'use strict';
/**
 * 실행 결과별 푸시 알림 — 담을 것 없음 / 세션 만료 / 실패 / 성공,
 * 세션(쿠키) 갱신 저장, 담은 뒤 요리 선택 해제까지 한 파일에서 확인합니다.
 * 브라우저(Playwright)는 띄우지 않고 lib/kurly-browser 의 함수만 바꿔 끼웁니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { setupEnv } = require('./helpers');
setupEnv();

const webPush = require('web-push');
const store = require('../lib/store');
const push = require('../lib/webpush');
const { sealJson, openJson } = require('../lib/crypto-box');
const { runCartForUser } = require('../lib/runner');
const kurlyBrowser = require('../lib/kurly-browser');

const SILENT = { info() {}, step() {}, warn() {}, error() {}, file: null };

const originalSend = webPush.sendNotification;
const originalBrowser = {
  launchBrowser: kurlyBrowser.launchBrowser,
  isLoggedIn: kurlyBrowser.isLoggedIn,
  addItemToCart: kurlyBrowser.addItemToCart,
  readCart: kurlyBrowser.readCart,
};

const calls = [];

function stubPush(impl) {
  webPush.sendNotification = async (subscription, payload, options) => {
    calls.push({ subscription, payload: String(payload), options });
    return impl ? impl(subscription, payload, options) : { statusCode: 201 };
  };
}

test.after(() => {
  webPush.sendNotification = originalSend;
  Object.assign(kurlyBrowser, originalBrowser);
});

function fakePage(storageState, { onTimeout = null } = {}) {
  return {
    context: () => ({ storageState: async () => storageState }),
    waitForTimeout: async () => {
      if (onTimeout) await onTimeout();
    },
  };
}

function stubBrowser({ loggedIn = true, storageState = { cookies: [], origins: [] }, addResult = null } = {}) {
  kurlyBrowser.launchBrowser = async () => ({ browser: { close: async () => {} }, page: fakePage(storageState) });
  kurlyBrowser.isLoggedIn = async () => loggedIn;
  kurlyBrowser.addItemToCart = async () => addResult || { status: 'added', quantity: 1, optionLabel: null };
  kurlyBrowser.readCart = async () => ({ totalCount: 3, items: [] });
}

async function makeUser(nickname, { items = true, session = true } = {}) {
  store.ensureDirs();
  const created = await store.createUser({ nickname, passwordHash: 'x' });
  return store.updateUser(created.userId, (u) => {
    if (items) {
      u.items = [
        {
          id: 'item-1',
          productNo: 5090273,
          dealProductNo: 1002030322,
          name: '유정란 15구',
          unitSize: 15,
          unitLabel: '구',
          consumption: 15, // → 1개
          price: 7990,
          active: true,
        },
      ];
    }
    if (session) {
      u.kurly = {
        status: 'connected',
        account: 'tester',
        connectedAt: Date.now(),
        lastVerifiedAt: Date.now(),
        lastError: null,
        session: sealJson({ cookies: [{ name: 'ksi', value: 'old-token', domain: '.kurly.com' }], origins: [] }),
      };
    }
    return u;
  });
}

async function subscribe(userId) {
  await push.subscribeUser(userId, {
    endpoint: `https://push.example.com/${Math.random().toString(36).slice(2, 10)}`,
    keys: { p256dh: 'pub-key', auth: 'auth-key' },
    deviceLabel: '아이폰',
  });
}

function lastPayload() {
  assert.ok(calls.length, '푸시가 한 번은 나가야 합니다.');
  return JSON.parse(calls[calls.length - 1].payload);
}

test('담을 상품이 없어도(NO_ITEMS) 푸시를 보내고 기록에 남긴다', async () => {
  const user = await makeUser('빈계획', { items: false, session: false });
  await subscribe(user.userId);
  calls.length = 0;
  stubPush();
  stubBrowser();

  const summary = await runCartForUser({ user, trigger: 'scheduled', logger: SILENT });
  assert.equal(summary.errorCode, 'NO_ITEMS');
  assert.equal(summary.push.sent, 1);
  const payload = lastPayload();
  assert.match(payload.title, /담을 상품이 없어요/);
  assert.match(payload.body, /계획/);
  assert.equal(payload.data.errorCode, 'NO_ITEMS');

  const saved = store.getUser(user.userId);
  assert.equal(saved.runHistory[0].errorCode, 'NO_ITEMS');
  assert.equal(saved.runHistory[0].push.sent, 1, '실행 기록에 푸시 결과가 함께 남습니다.');
});

test('컬리 세션을 읽지 못하면(KURLY_NOT_CONNECTED) 연결 안내를 보낸다', async () => {
  const user = await makeUser('세션깨짐');
  await store.updateUser(user.userId, (u) => {
    u.kurly = { ...u.kurly, session: 'not-a-sealed-value' };
    return u;
  });
  await subscribe(user.userId);
  calls.length = 0;
  stubPush();

  const summary = await runCartForUser({ user: store.getUser(user.userId), logger: SILENT });
  assert.equal(summary.errorCode, 'KURLY_NOT_CONNECTED');
  assert.equal(summary.push.sent, 1);
  const payload = lastPayload();
  assert.match(payload.title, /컬리 계정 연결/);
  assert.equal(payload.url, '/#settings');
});

test('컬리 미연결 + 정기 실행 — 실패가 아니라 장볼 목록 알림을 보낸다', async () => {
  const user = await makeUser('목록알림', { session: false });
  await subscribe(user.userId);
  calls.length = 0;
  stubPush();

  const summary = await runCartForUser({ user, trigger: 'scheduled', logger: SILENT });
  assert.equal(summary.status, 'checklist');
  assert.equal(summary.checklistMode, true);
  assert.equal(summary.error, null);
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].status, 'planned');
  assert.equal(summary.push.sent, 1);

  const payload = lastPayload();
  assert.equal(payload.title, '🛒 이번 주 장볼 목록을 체크할 시간이에요');
  assert.match(payload.body, /유정란 15구 ×1/);
  assert.match(payload.body, /컬리에서 열기/);
  assert.equal(payload.url, '/#run');

  const saved = store.getUser(user.userId);
  assert.equal(saved.runHistory[0].status, 'checklist');
  assert.equal(saved.runHistory[0].push.sent, 1);
});

test('"목록 알림만 받기"를 켜면 컬리가 연결돼 있어도 담지 않고 목록만 준비', async () => {
  const user = await makeUser('목록모드');
  await store.updateUser(user.userId, (u) => {
    u.checklistOnly = true;
    return u;
  });
  await subscribe(user.userId);
  calls.length = 0;
  stubPush();
  // 브라우저가 열리면 안 됩니다.
  kurlyBrowser.launchBrowser = async () => {
    throw new Error('목록 모드에서는 브라우저를 열지 않습니다.');
  };

  const summary = await runCartForUser({ user: store.getUser(user.userId), trigger: 'scheduled', logger: SILENT });
  assert.equal(summary.status, 'checklist');
  assert.equal(summary.checklist.reason, 'checklist_only');
  assert.equal(summary.sessionRefreshed, false);
  assert.equal(lastPayload().title, '🛒 이번 주 장볼 목록을 체크할 시간이에요');
  // 요리 선택은 담은 게 아니므로 자동으로 풀리지 않습니다.
  assert.equal(summary.recipesCleared, 0);
});

test('세션 만료(SESSION_EXPIRED) — 제목에 만료·재연결이 분명히 보인다', async () => {
  const user = await makeUser('세션만료');
  await subscribe(user.userId);
  calls.length = 0;
  stubPush();
  stubBrowser({ loggedIn: false });

  const summary = await runCartForUser({ user, trigger: 'scheduled', logger: SILENT });
  assert.equal(summary.errorCode, 'SESSION_EXPIRED');
  assert.equal(summary.status, 'failed');
  assert.equal(summary.push.sent, 1);
  const payload = lastPayload();
  assert.match(payload.title, /로그인 만료/);
  assert.match(payload.title, /컬리에서 열기/);
  assert.match(payload.body, /컬리 로그인이 만료/);
  assert.equal(payload.url, '/#settings');

  const saved = store.getUser(user.userId);
  assert.equal(saved.kurly.status, 'expired');
  assert.equal(saved.runHistory[0].errorCode, 'SESSION_EXPIRED');
});

test('실행 중 예외(RUN_FAILED)도 실패 제목으로 푸시하고 기록한다', async () => {
  const user = await makeUser('실행예외');
  await subscribe(user.userId);
  calls.length = 0;
  stubPush();
  kurlyBrowser.launchBrowser = async () => {
    throw Object.assign(new Error('브라우저를 시작하지 못했습니다'), { code: 'RUN_FAILED' });
  };

  const summary = await runCartForUser({ user, logger: SILENT });
  assert.equal(summary.errorCode, 'RUN_FAILED');
  assert.equal(summary.push.sent, 1);
  assert.match(lastPayload().title, /담기 실패/);
});

test('실행 성공 — 새로 받은 컬리 세션(쿠키)을 암호화해 저장한다', async () => {
  const user = await makeUser('세션갱신');
  await subscribe(user.userId);
  calls.length = 0;
  stubPush();
  const refreshed = {
    cookies: [
      { name: 'ksi', value: 'new-token', domain: '.kurly.com' },
      { name: 'krt', value: 'new-refresh', domain: '.kurly.com' },
    ],
    origins: [{ origin: 'https://www.kurly.com', localStorage: [] }],
  };
  stubBrowser({ loggedIn: true, storageState: refreshed, addResult: { status: 'added', quantity: 1 } });

  const summary = await runCartForUser({ user, trigger: 'scheduled', logger: SILENT });
  assert.equal(summary.status, 'success');
  assert.equal(summary.added, 1);
  assert.equal(summary.sessionRefreshed, true);
  assert.match(lastPayload().title, /담았어요/);

  const saved = store.getUser(user.userId);
  assert.equal(saved.kurly.status, 'connected');
  assert.ok(saved.kurly.sessionRefreshedAt, '세션 갱신 시각이 남습니다.');
  const opened = openJson(saved.kurly.session);
  assert.equal(opened.cookies.length, 2);
  assert.equal(opened.cookies.find((c) => c.name === 'ksi').value, 'new-token');
  assert.ok(!JSON.stringify(saved).includes('new-token'), '쿠키는 평문으로 저장되지 않습니다.');
});

test('로그인이 풀린 경우(빈 쿠키)에는 기존 세션을 덮어쓰지 않는다', async () => {
  const user = await makeUser('빈쿠키');
  stubPush();
  stubBrowser({ loggedIn: true, storageState: { cookies: [], origins: [] } });

  const summary = await runCartForUser({ user, logger: SILENT });
  assert.equal(summary.sessionRefreshed, false);
  const saved = store.getUser(user.userId);
  assert.equal(openJson(saved.kurly.session).cookies[0].value, 'old-token', '기존 세션을 유지합니다.');
});

test('요리를 담은 실행이 성공하면 이번 주 선택을 풀고 제외를 되돌린다', async () => {
  const user = await makeUser('요리담기', { items: false });
  await store.updateUser(user.userId, (u) => {
    u.recipes = [
      {
        id: 'r1',
        name: '된장찌개',
        selectedForNextRun: true,
        ingredients: [
          { id: 'i1', productNo: 21, name: '두부', price: 2900, quantity: 1, skippedThisWeek: true },
          { id: 'i2', productNo: 22, name: '애호박', price: 1980, quantity: 1, skippedThisWeek: false },
        ],
      },
    ];
    u.recipeSettings = { mergeWithRegularPlan: true, clearSelectedAfterRun: true };
    return u;
  });
  calls.length = 0;
  stubPush();
  stubBrowser({ loggedIn: true, storageState: { cookies: [{ name: 'ksi', value: 'x' }] } });

  const fresh = store.getUser(user.userId);
  const summary = await runCartForUser({ user: fresh, trigger: 'scheduled', mode: 'recipes_only', logger: SILENT });
  assert.equal(summary.status, 'success');
  assert.equal(summary.mode, 'recipes_only');
  assert.equal(summary.items.length, 1, '집에 있음 재료는 빼고 담습니다.');
  assert.equal(summary.recipesCleared, 1);

  const saved = store.getUser(user.userId);
  assert.equal(saved.recipes[0].selectedForNextRun, false);
  assert.equal(saved.recipes[0].ingredients[0].skippedThisWeek, false);
});

test('"담은 뒤 선택 해제"가 꺼져 있으면 요리 선택을 그대로 둔다', async () => {
  const user = await makeUser('선택유지', { items: false });
  await store.updateUser(user.userId, (u) => {
    u.recipes = [
      { id: 'r1', name: '된장찌개', selectedForNextRun: true, ingredients: [{ id: 'i1', productNo: 21, name: '두부', price: 2900, quantity: 1 }] },
    ];
    u.recipeSettings = { mergeWithRegularPlan: true, clearSelectedAfterRun: false };
    return u;
  });
  stubPush();
  stubBrowser({ loggedIn: true, storageState: { cookies: [{ name: 'ksi', value: 'x' }] } });

  const fresh = store.getUser(user.userId);
  const summary = await runCartForUser({ user: fresh, mode: 'recipes_only', logger: SILENT });
  assert.equal(summary.status, 'success');
  assert.equal(summary.recipesCleared, 0);
  assert.equal(store.getUser(user.userId).recipes[0].selectedForNextRun, true);
});
