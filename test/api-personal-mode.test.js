'use strict';
/**
 * 개인용(1인) 모드 — REQUIRE_AUTH 를 켜지 않았을 때(기본값)
 *  · 로그인/회원가입 화면 없이 '개인' 기본 계정으로 바로 열립니다.
 *  · 세션 쿠키가 없거나 만료돼도 계획·요리·장볼 목록·설정 API 가 그대로 동작합니다.
 *  · REQUIRE_AUTH=true(로그인 모드)로 바꾸면 예전 로그인·회원가입·로그아웃이 그대로 살아납니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { setupEnv, startServer, request, register } = require('./helpers');

setupEnv();
// 환경변수를 두지 않은 기본값(개인용 모드)을 그대로 확인합니다.
delete process.env.REQUIRE_AUTH;

let server;
test.before(async () => {
  server = await startServer();
});
test.after(async () => {
  await server.close();
});

const base = () => server.baseUrl;
const MARKETS = ['kurly', 'kurly', 'kurly', 'kurly', 'oasis', 'oasis', 'oasis', 'oasis'];

test('기본값은 개인용 모드 — /api/config · /api/health 가 requireAuth:false', async () => {
  const config = await request(base(), '/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.version, '2.4.0');
  assert.equal(config.body.requireAuth, false);
  assert.equal(config.body.personalMode, true);

  const health = await request(base(), '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.version, '2.4.0');
  assert.equal(health.body.requireAuth, false);
  assert.equal(health.body.mode, 'personal');
});

test('쿠키 없이 /api/auth/session → 기본 계정과 기본 8개 상품(컬리 4·오아시스 4)', async () => {
  const res = await request(base(), '/api/auth/session');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.requireAuth, false);
  assert.ok(res.body.user, '개인용 모드에서는 바로 사용자가 붙어야 합니다.');
  assert.equal(res.body.user.userId, 'personal');
  assert.equal(res.body.user.nickname, '개인');
  assert.ok(!('password' in res.body.user));
  assert.equal(res.body.plan.items.length, 8);
  assert.deepEqual(res.body.plan.items.map((i) => i.market).sort(), MARKETS);
  assert.equal(res.body.plan.summary.activeCount, 8);

  // 세션 쿠키도 함께 발급되어 다음 요청부터는 쿠키로 이어집니다.
  assert.match(res.setCookies.join('; '), /kurly_sid=/);
  assert.match(res.setCookies.join('; '), /HttpOnly/i);

  const withCookie = await request(base(), '/api/auth/session', { cookie: res.cookie });
  assert.equal(withCookie.body.user.userId, 'personal');
  assert.equal(res.body.user.userId, withCookie.body.user.userId);
});

test('기본 계정은 한 번만 만들고, 계속 같은 계정으로 이어진다', async () => {
  for (let i = 0; i < 3; i += 1) {
    const plan = await request(base(), '/api/plan');
    assert.equal(plan.status, 200);
    assert.equal(plan.body.plan.items.length, 8);
  }
  const index = JSON.parse(fs.readFileSync(path.join(server.dataDir, 'users-index.json'), 'utf8'));
  assert.equal(index.users.filter((u) => u.userId === 'personal').length, 1);
  assert.equal(index.users.length, 1, '동시에 여러 계정이 생기면 안 됩니다.');
  assert.ok(fs.existsSync(path.join(server.dataDir, 'users', 'personal.json')));
});

test('로그인 없이 계획·요리·장볼 목록·설정·상태 API 가 모두 동작한다', async () => {
  const plan = await request(base(), '/api/plan');
  assert.equal(plan.status, 200);
  assert.equal(plan.body.plan.items.length, 8);

  const checklist = await request(base(), '/api/checklist');
  assert.equal(checklist.status, 200);
  assert.equal(checklist.body.checklist.count, 8);

  const checked = await request(base(), '/api/checklist/check', {
    method: 'POST',
    body: { market: 'kurly', productNo: 5029849, checked: true },
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.checklist.checkedCount, 1);

  const recipes = await request(base(), '/api/recipes', {
    method: 'PUT',
    body: {
      recipes: [
        {
          id: 'recipe-egg-fried-rice',
          name: '계란볶음밥',
          selectedForNextRun: true,
          ingredients: [{ market: 'kurly', productNo: 5029849, name: '달걀', quantity: 1 }],
        },
      ],
      recipeSettings: {},
    },
  });
  assert.equal(recipes.status, 200);
  assert.equal(recipes.body.recipes.length, 1);
  assert.equal(recipes.body.summary.selectedCount, 1);

  const settings = await request(base(), '/api/settings', { method: 'PUT', body: { checklistOnly: true } });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.checklistOnly, true);

  const status = await request(base(), '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.checklistOnly, true);
  assert.equal(status.body.plan.activeCount, 8);

  const starter = await request(base(), '/api/items/starter', { method: 'POST', body: {} });
  assert.equal(starter.status, 200);
  assert.equal(starter.body.added, 0, '기본 상품은 이미 담겨 있어야 합니다.');
});

test('개인용 자동 세션 엔드포인트가 기본 계정 세션을 다시 붙인다', async () => {
  const res = await request(base(), '/api/auth/personal-session', { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.personal, true);
  assert.equal(res.body.user.userId, 'personal');
  assert.equal(res.body.plan.items.length, 8);
  assert.match(res.setCookies.join('; '), /kurly_sid=/);
});

test('개인용 모드에서는 로그아웃해도 다시 기본 계정으로 열린다(로그인 화면에 갇히지 않음)', async () => {
  const session = await request(base(), '/api/auth/session');
  const out = await request(base(), '/api/auth/logout', { method: 'POST', cookie: session.cookie, body: {} });
  assert.equal(out.status, 200);

  const again = await request(base(), '/api/plan', { cookie: session.cookie });
  assert.equal(again.status, 200, '로그아웃한 쿠키로도 개인용 모드에서는 계속 열려야 합니다.');
  assert.equal(again.body.plan.items.length, 8);
});

test('기본 계정은 비밀번호로 로그인되지 않는다', async () => {
  const wrong = await request(base(), '/api/auth/login', {
    method: 'POST',
    body: { nickname: '개인', password: 'password123' },
  });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error, /닉네임 또는 비밀번호/);
});

test('REQUIRE_AUTH=true(로그인 모드)에서는 예전처럼 로그인 화면·401·회원가입·로그아웃', async () => {
  const authServer = await startServer({ appOptions: { requireAuth: true } });
  try {
    const config = await request(authServer.baseUrl, '/api/config');
    assert.equal(config.body.requireAuth, true);
    assert.equal(config.body.personalMode, false);

    const health = await request(authServer.baseUrl, '/api/health');
    assert.equal(health.body.mode, 'auth');

    const session = await request(authServer.baseUrl, '/api/auth/session');
    assert.equal(session.status, 200);
    assert.equal(session.body.user, null);
    assert.equal(session.body.requireAuth, true);
    assert.equal(session.setCookies.length, 0, '로그인 모드에서는 쿠키 없이 사용자를 붙이지 않습니다.');

    const plan = await request(authServer.baseUrl, '/api/plan');
    assert.equal(plan.status, 401);

    const personal = await request(authServer.baseUrl, '/api/auth/personal-session', { method: 'POST', body: {} });
    assert.equal(personal.status, 404, '로그인 모드에는 개인용 자동 세션이 없어야 합니다.');

    const created = await register(authServer.baseUrl, { nickname: '앰버', password: 'kurly1234', loadStarter: true });
    assert.equal(created.status, 201);
    assert.equal(created.body.plan.items.length, 8);

    const login = await request(authServer.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { nickname: '앰버', password: 'kurly1234' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.nickname, '앰버');

    const out = await request(authServer.baseUrl, '/api/auth/logout', {
      method: 'POST',
      cookie: login.cookie,
      body: {},
    });
    assert.equal(out.status, 200);
    const afterOut = await request(authServer.baseUrl, '/api/auth/me', { cookie: login.cookie });
    assert.equal(afterOut.status, 401);
  } finally {
    await authServer.close();
  }
});
