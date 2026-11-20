'use strict';
/**
 * /api/recipes · /api/run · 미리보기 — 요리 저장, 정기 품목과의 합치기(수량 합산 없음), 사용자별 분리.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { setupEnv, startServer, request, register } = require('./helpers');

setupEnv();

const webPush = require('web-push');

let server;
const originalSend = webPush.sendNotification;

test.before(async () => {
  server = await startServer();
  // 실제 푸시 서비스로 나가지 않게 합니다.
  webPush.sendNotification = async () => ({ statusCode: 201 });
});

test.after(async () => {
  webPush.sendNotification = originalSend;
  await server.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function userFile(userId) {
  return path.join(server.dataDir, 'users', `${userId}.json`);
}

/** 실행 작업이 큐에서 끝나 기록이 남을 때까지 기다립니다. */
async function waitForRun(cookie, previousCount = 0, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await request(server.baseUrl, '/api/runs?limit=10', { cookie });
    if ((runs.body?.runs || []).length > previousCount) return runs.body.runs[0];
    await sleep(80);
  }
  throw new Error('실행 기록이 남지 않았습니다(시간 초과).');
}

const tofu = { productNo: 21, name: '국산 두부', price: 2900, quantity: 1 };
const zucchini = { productNo: 22, name: '애호박', price: 1980, quantity: 2 };
const egg = { productNo: 5029849, name: '유정란 15구', price: 8290, quantity: 1 };

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

test('GET /api/recipes — 처음에는 비어 있고 기본 설정이 켜져 있다', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  const res = await request(server.baseUrl, '/api/recipes', { cookie: me.cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.recipes, []);
  assert.deepEqual(res.body.recipeSettings, { mergeWithRegularPlan: true, clearSelectedAfterRun: true });
  assert.equal(res.body.summary.selectedCount, 0);

  // /api/plan 에도 함께 실려 화면이 한 번에 그릴 수 있어야 합니다.
  const plan = await request(server.baseUrl, '/api/plan', { cookie: me.cookie });
  assert.deepEqual(plan.body.plan.recipes, []);
  assert.equal(plan.body.plan.recipeSettings.mergeWithRegularPlan, true);
  assert.ok(plan.body.plan.recipeSummary);
});

test('PUT /api/recipes — 저장·검증·다시 읽기', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });

  const invalidName = await request(server.baseUrl, '/api/recipes', {
    method: 'PUT',
    cookie: me.cookie,
    body: { recipes: [{ name: '', ingredients: [tofu] }] },
  });
  assert.equal(invalidName.status, 400);

  const invalidProduct = await request(server.baseUrl, '/api/recipes', {
    method: 'PUT',
    cookie: me.cookie,
    body: { recipes: [{ name: '된장찌개', ingredients: [{ productNo: 0, name: '두부' }] }] },
  });
  assert.equal(invalidProduct.status, 400);
  assert.match(invalidProduct.body.error, /상품번호/);

  const saved = await request(server.baseUrl, '/api/recipes', {
    method: 'PUT',
    cookie: me.cookie,
    body: {
      recipes: [
        { id: 'r1', name: '된장찌개', note: '주말', selectedForNextRun: true, ingredients: [tofu, zucchini] },
        { id: 'r2', name: '계란말이', selectedForNextRun: false, ingredients: [egg] },
      ],
      recipeSettings: { mergeWithRegularPlan: false, clearSelectedAfterRun: false },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.recipes.length, 2);
  assert.equal(saved.body.recipes[0].name, '된장찌개');
  assert.equal(saved.body.recipes[0].ingredients.length, 2);
  assert.equal(saved.body.recipes[0].ingredients[1].quantity, 2);
  assert.deepEqual(saved.body.recipeSettings, { mergeWithRegularPlan: false, clearSelectedAfterRun: false });
  assert.equal(saved.body.summary.selectedCount, 1);
  assert.equal(saved.body.summary.includedIngredientCount, 2);

  const reread = await request(server.baseUrl, '/api/recipes', { cookie: me.cookie });
  assert.equal(reread.body.recipes.length, 2);
  assert.equal(reread.body.recipes[1].name, '계란말이');

  // 디스크에도 남아 있고, 사용자 파일에 요리가 들어 있습니다.
  const onDisk = JSON.parse(fs.readFileSync(userFile(me.body.user.userId), 'utf8'));
  assert.equal(onDisk.recipes.length, 2);
  assert.equal(onDisk.recipeSettings.mergeWithRegularPlan, false);
});

test('요리는 사용자별로 완전히 분리된다', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  const other = await register(server.baseUrl, { loadStarter: false });
  await request(server.baseUrl, '/api/recipes', {
    method: 'PUT',
    cookie: me.cookie,
    body: { recipes: [{ name: '내 요리', selectedForNextRun: true, ingredients: [tofu] }] },
  });
  const otherRecipes = await request(server.baseUrl, '/api/recipes', { cookie: other.cookie });
  assert.deepEqual(otherRecipes.body.recipes, []);
  assert.equal(otherRecipes.body.summary.selectedCount, 0);
});

test('PATCH·DELETE /api/recipes/:id — 하나만 수정·삭제', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  await request(server.baseUrl, '/api/recipes', {
    method: 'PUT',
    cookie: me.cookie,
    body: {
      recipes: [
        { id: 'r1', name: '된장찌개', ingredients: [tofu] },
        { id: 'r2', name: '계란말이', ingredients: [egg] },
      ],
    },
  });

  const patched = await request(server.baseUrl, '/api/recipes/r1', {
    method: 'PATCH',
    cookie: me.cookie,
    body: { selectedForNextRun: true, note: '저녁' },
  });
  assert.equal(patched.status, 200);
  const r1 = patched.body.recipes.find((r) => r.id === 'r1');
  assert.equal(r1.selectedForNextRun, true);
  assert.equal(r1.note, '저녁');
  assert.equal(patched.body.recipes.find((r) => r.id === 'r2').selectedForNextRun, false);

  const deleted = await request(server.baseUrl, '/api/recipes/r2', { method: 'DELETE', cookie: me.cookie });
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    deleted.body.recipes.map((r) => r.id),
    ['r1']
  );

  const missing = await request(server.baseUrl, '/api/recipes/nope', { method: 'DELETE', cookie: me.cookie });
  assert.equal(missing.status, 404);
});

test('미리보기 — 정기 품목과 겹치는 요리 재료는 수량을 더하지 않는다', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  await request(server.baseUrl, '/api/plan', {
    method: 'POST',
    cookie: me.cookie,
    body: { items: [planItem], schedule: { weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2030-01-04' } },
  });
  await request(server.baseUrl, '/api/recipes', {
    method: 'PUT',
    cookie: me.cookie,
    body: {
      recipes: [
        { id: 'r1', name: '계란말이', selectedForNextRun: true, ingredients: [egg, tofu] },
        { id: 'r2', name: '계란찜', selectedForNextRun: true, ingredients: [{ ...egg, quantity: 3 }] },
      ],
    },
  });

  const auto = await request(server.baseUrl, '/api/cart/preview', { cookie: me.cookie });
  assert.equal(auto.status, 200);
  assert.equal(auto.body.preview.mode, 'combined');
  const eggLine = auto.body.preview.items.find((i) => i.name === '유정란 15구');
  assert.equal(eggLine.quantity, 2, '정기 품목 수량 2를 유지합니다 (2+1+3 아님).');
  assert.equal(eggLine.source, 'both');
  assert.deepEqual(eggLine.recipeNames.sort(), ['계란말이', '계란찜']);
  assert.equal(auto.body.preview.items.filter((i) => i.name === '유정란 15구').length, 1);
  assert.equal(auto.body.preview.count, 2, '정기 계란 + 두부 한 줄');
  assert.equal(auto.body.preview.estimatedTotal, 8290 * 2 + 2900);

  const recipesOnly = await request(server.baseUrl, '/api/cart/preview?mode=recipes_only', { cookie: me.cookie });
  assert.equal(recipesOnly.body.preview.mode, 'recipes_only');
  assert.equal(recipesOnly.body.preview.items.length, 2);
  assert.equal(recipesOnly.body.preview.items.find((i) => i.name === '유정란 15구').quantity, 3, '요리끼리는 큰 수량');

  const regularOnly = await request(server.baseUrl, '/api/cart/preview?mode=regular_only', { cookie: me.cookie });
  assert.equal(regularOnly.body.preview.items.length, 1);
  assert.equal(regularOnly.body.preview.items[0].name, '유정란 15구');
});

test('POST /api/run — 요리를 고르지 않았으면 400, 고르면 요리만 담는 실행이 기록된다', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  await request(server.baseUrl, '/api/plan', {
    method: 'POST',
    cookie: me.cookie,
    body: { items: [planItem], schedule: { weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2030-01-04' } },
  });

  const none = await request(server.baseUrl, '/api/run', {
    method: 'POST',
    cookie: me.cookie,
    body: { mode: 'recipes_only' },
  });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /요리/);

  await request(server.baseUrl, '/api/recipes', {
    method: 'PUT',
    cookie: me.cookie,
    body: {
      recipes: [{ id: 'r1', name: '된장찌개', selectedForNextRun: true, ingredients: [tofu, zucchini] }],
      recipeSettings: { clearSelectedAfterRun: false }, // 이 테스트에서는 선택을 유지
    },
  });

  const before = await request(server.baseUrl, '/api/runs', { cookie: me.cookie });
  const started = await request(server.baseUrl, '/api/run', {
    method: 'POST',
    cookie: me.cookie,
    body: { mode: 'recipes_only' },
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.mode, 'recipes_only');
  assert.equal(started.body.itemCount, 2);

  const run = await waitForRun(me.cookie, (before.body.runs || []).length);
  assert.equal(run.mode, 'recipes_only');
  assert.equal(run.counts.recipeCount, 1);
  assert.equal(run.items.length, 2);
  assert.ok(run.items.every((i) => i.source === 'recipe'), '정기 품목은 담기지 않아야 합니다.');
  // 컬리 세션이 없으면 실패가 아니라 '장볼 목록' 준비로 기록됩니다(로그인 없이 쓰는 모드).
  assert.equal(run.status, 'checklist');
  assert.equal(run.checklistMode, true);
  assert.equal(run.errorCode, null);
  assert.equal(run.checklist.count, 2);
  assert.ok(run.push, '푸시 결과도 실행 기록에 남습니다.');
  assert.equal(run.push.skipped, true, '등록된 기기가 없으면 skipped');
});

test('GET /api/status — 요리 요약을 함께 돌려준다', async () => {
  const me = await register(server.baseUrl, { loadStarter: false });
  await request(server.baseUrl, '/api/recipes', {
    method: 'PUT',
    cookie: me.cookie,
    body: { recipes: [{ id: 'r1', name: '된장찌개', selectedForNextRun: true, ingredients: [tofu] }] },
  });
  const res = await request(server.baseUrl, '/api/status', { cookie: me.cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.recipes.recipeCount, 1);
  assert.equal(res.body.recipes.selectedCount, 1);
  assert.equal(res.body.recipes.includedIngredientCount, 1);
  assert.equal(res.body.recipes.runMode, 'combined');
});

test('요리 API 도 로그인·CSRF 보호를 따른다', async () => {
  for (const [method, url] of [
    ['GET', '/api/recipes'],
    ['PUT', '/api/recipes'],
    ['POST', '/api/run'],
  ]) {
    const res = await request(server.baseUrl, url, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${url}`);
  }
  const me = await register(server.baseUrl, { loadStarter: false });
  const csrf = await request(server.baseUrl, '/api/recipes', {
    method: 'PUT',
    cookie: me.cookie,
    headers: { Origin: 'https://evil.example.com' },
    body: { recipes: [] },
  });
  assert.equal(csrf.status, 403);
});
