'use strict';
/**
 * /api/checklist · /api/settings — 컬리 로그인 없이 쓰는 장볼 목록.
 * 담음 체크·초기화·장보기 완료, '목록 알림만 받기' 모드의 실행 결과까지 확인합니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { setupEnv, startServer, request, register } = require('./helpers');

setupEnv();

const webPush = require('web-push');

let server;
const originalSend = webPush.sendNotification;

test.before(async () => {
  server = await startServer();
  webPush.sendNotification = async () => ({ statusCode: 201 });
});

test.after(async () => {
  webPush.sendNotification = originalSend;
  await server.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const planItem = {
  productNo: 5029849,
  dealProductNo: 10029849,
  name: '유정란 15구',
  price: 8290,
  unitSize: 15,
  unitLabel: '구',
  consumption: 30, // → 2개
  active: true,
};

async function waitForRun(cookie, previousCount = 0, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await request(server.baseUrl, '/api/runs?limit=10', { cookie });
    if ((runs.body?.runs || []).length > previousCount) return runs.body.runs[0];
    await sleep(80);
  }
  throw new Error('실행 기록이 남지 않았습니다(시간 초과).');
}

async function seed(cookie) {
  await request(server.baseUrl, '/api/plan', {
    method: 'POST',
    cookie,
    body: { items: [planItem], schedule: { weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2030-01-04' } },
  });
  await request(server.baseUrl, '/api/recipes', {
    method: 'PUT',
    cookie,
    body: {
      recipes: [
        {
          id: 'r1',
          name: '계란말이',
          selectedForNextRun: true,
          ingredients: [
            { productNo: 5029849, name: '유정란 15구', price: 8290, quantity: 1 },
            { productNo: 900, name: '대파', price: 3200, quantity: 1 },
          ],
        },
      ],
    },
  });
}

test('GET /api/checklist — 정기 + 요리 목록, 겹치는 상품은 한 줄', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  await seed(me.cookie);

  const res = await request(server.baseUrl, '/api/checklist', { cookie: me.cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.checklist.count, 2);
  assert.equal(res.body.checklist.checkedCount, 0);
  const egg = res.body.checklist.items.find((i) => i.productNo === 5029849);
  assert.equal(egg.quantity, 2, '정기 수량 유지 (2+1 아님)');
  assert.equal(egg.url, 'https://www.kurly.com/goods/5029849');
  assert.equal(res.body.checklistOnly, false);
});

test('POST /api/checklist/check — 담음 체크 저장·해제, 잘못된 번호는 400', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  await seed(me.cookie);

  const on = await request(server.baseUrl, '/api/checklist/check', {
    method: 'POST',
    cookie: me.cookie,
    body: { productNo: 900, checked: true },
  });
  assert.equal(on.status, 200);
  assert.equal(on.body.checklist.checkedCount, 1);
  assert.equal(on.body.checklist.items.find((i) => i.productNo === 900).checked, true);
  assert.equal(on.body.plan.checklistSummary.checkedCount, 1);

  const reread = await request(server.baseUrl, '/api/checklist', { cookie: me.cookie });
  assert.equal(reread.body.checklist.checkedCount, 1, '새로고침해도 체크가 남습니다.');
  assert.ok(reread.body.checkedAt);

  const off = await request(server.baseUrl, '/api/checklist/check', {
    method: 'POST',
    cookie: me.cookie,
    body: { productNo: 900, checked: false },
  });
  assert.equal(off.body.checklist.checkedCount, 0);

  const bad = await request(server.baseUrl, '/api/checklist/check', {
    method: 'POST',
    cookie: me.cookie,
    body: { productNo: 0 },
  });
  assert.equal(bad.status, 400);
});

test('POST /api/checklist/reset — 체크만 초기화하고 요리 선택은 그대로', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  await seed(me.cookie);
  await request(server.baseUrl, '/api/checklist/check', {
    method: 'POST',
    cookie: me.cookie,
    body: { productNo: 900, checked: true },
  });

  const res = await request(server.baseUrl, '/api/checklist/reset', { method: 'POST', cookie: me.cookie, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.checklist.checkedCount, 0);
  const plan = await request(server.baseUrl, '/api/plan', { cookie: me.cookie });
  assert.equal(plan.body.plan.recipes[0].selectedForNextRun, true, '체크 초기화는 요리 선택을 건드리지 않습니다.');
});

test('POST /api/checklist/complete — 체크와 이번 주 요리 선택을 함께 초기화', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  await seed(me.cookie);
  await request(server.baseUrl, '/api/checklist/check', {
    method: 'POST',
    cookie: me.cookie,
    body: { productNo: 900, checked: true },
  });

  const res = await request(server.baseUrl, '/api/checklist/complete', { method: 'POST', cookie: me.cookie, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.clearedRecipes, 1);
  assert.equal(res.body.checklist.checkedCount, 0);
  assert.equal(res.body.checklist.count, 1, '요리 선택이 풀려 정기 품목만 남습니다.');

  const plan = await request(server.baseUrl, '/api/plan', { cookie: me.cookie });
  assert.equal(plan.body.plan.recipes[0].selectedForNextRun, false);
  assert.equal(plan.body.plan.checklistSummary.count, 1);
});

test('장볼 목록은 사용자별로 분리된다', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  const other = await register(server.baseUrl, { loadStarter: false });
  await seed(me.cookie);
  await request(server.baseUrl, '/api/checklist/check', {
    method: 'POST',
    cookie: me.cookie,
    body: { productNo: 900, checked: true },
  });

  const theirs = await request(server.baseUrl, '/api/checklist', { cookie: other.cookie });
  assert.equal(theirs.body.checklist.count, 0);
  assert.equal(theirs.body.checklist.checkedCount, 0);
});

test('"목록 알림만 받기" — 설정을 켜면 정기 실행이 장볼 목록 준비로 기록된다', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  await seed(me.cookie);

  const setting = await request(server.baseUrl, '/api/settings', {
    method: 'PUT',
    cookie: me.cookie,
    body: { checklistOnly: true },
  });
  assert.equal(setting.status, 200);
  assert.equal(setting.body.checklistOnly, true);
  assert.equal(setting.body.plan.checklistOnly, true);

  const before = await request(server.baseUrl, '/api/runs', { cookie: me.cookie });
  const started = await request(server.baseUrl, '/api/run', {
    method: 'POST',
    cookie: me.cookie,
    body: { mode: 'auto' },
  });
  assert.equal(started.status, 202);

  const run = await waitForRun(me.cookie, (before.body.runs || []).length);
  assert.equal(run.status, 'checklist');
  assert.equal(run.checklistMode, true);
  assert.equal(run.errorCode, null);
  assert.equal(run.checklist.reason, 'checklist_only');
  assert.equal(run.checklist.count, 2);
  assert.equal(run.items.every((i) => i.status === 'planned'), true);
  // 담은 게 아니므로 요리 선택은 유지됩니다.
  const plan = await request(server.baseUrl, '/api/plan', { cookie: me.cookie });
  assert.equal(plan.body.plan.recipes[0].selectedForNextRun, true);

  // 다시 끄기
  const off = await request(server.baseUrl, '/api/settings', {
    method: 'PUT',
    cookie: me.cookie,
    body: { checklistOnly: false },
  });
  assert.equal(off.body.checklistOnly, false);
});

test('컬리 세션이 없으면 정기 실행이 실패가 아니라 장볼 목록이 된다', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  await seed(me.cookie);

  const before = await request(server.baseUrl, '/api/runs', { cookie: me.cookie });
  await request(server.baseUrl, '/api/run', { method: 'POST', cookie: me.cookie, body: { mode: 'auto' } });
  const run = await waitForRun(me.cookie, (before.body.runs || []).length);
  assert.equal(run.status, 'checklist');
  assert.equal(run.checklist.reason, 'no_session');
  assert.equal(run.error, null);
});

test('장볼 목록 API 도 로그인·CSRF 보호를 따른다', async () => {
  for (const [method, url] of [
    ['GET', '/api/checklist'],
    ['POST', '/api/checklist/check'],
    ['POST', '/api/checklist/reset'],
    ['POST', '/api/checklist/complete'],
    ['PUT', '/api/settings'],
  ]) {
    const res = await request(server.baseUrl, url, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${url}`);
  }
  const me = await register(server.baseUrl, { loadStarter: false });
  const csrf = await request(server.baseUrl, '/api/checklist/check', {
    method: 'POST',
    cookie: me.cookie,
    headers: { Origin: 'https://evil.example.com' },
    body: { productNo: 900 },
  });
  assert.equal(csrf.status, 403);
});
