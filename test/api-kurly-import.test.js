'use strict';
/**
 * POST /api/kurly/import-session — 인증·입력 검증·연결 결과 저장 테스트
 * 실제 브라우저 대신 verifyKurlySession 을 바꿔 끼워 네트워크 없이 확인합니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { setupEnv, startServer, request, register } = require('./helpers');

setupEnv();

const COOKIE_HEADER = 'ksi=SESSION-AAA-111; krt=SESSION-BBB-222; kdi=DEVICE-CCC-333';
const calls = [];

let server;
test.before(async () => {
  server = await startServer({
    appOptions: {
      // 로그인된 세션인지 여부를 환경변수로 정해, 성공/실패 두 경우를 모두 확인합니다.
      verifyKurlySession: async (storageState) => {
        calls.push(storageState);
        const names = storageState.cookies.map((c) => c.name);
        const ok = names.includes('ksi') && process.env.FAKE_SESSION_LOGGED_IN !== '0';
        return { loggedIn: ok, storageState: ok ? storageState : null };
      },
    },
  });
});
test.after(async () => {
  await server.close();
});

async function waitForIdle(cookie, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await request(server.baseUrl, '/api/status', { cookie });
    if (!status.body.queue?.active) return status.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('작업이 끝나지 않았습니다.');
}

test('로그인 없이는 401', async () => {
  const res = await request(server.baseUrl, '/api/kurly/import-session', { method: 'POST', body: { session: COOKIE_HEADER } });
  assert.equal(res.status, 401);
});

test('빈 입력·해석 불가능한 입력은 400 (큐에 넣지 않는다)', async () => {
  const user = await register(server.baseUrl, { nickname: '세션러1', password: 'password123' });
  assert.equal(user.status, 201);

  const empty = await request(server.baseUrl, '/api/kurly/import-session', {
    method: 'POST',
    cookie: user.cookie,
    body: { session: '   ' },
  });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /비어 있습니다/);

  const junk = await request(server.baseUrl, '/api/kurly/import-session', {
    method: 'POST',
    cookie: user.cookie,
    body: { session: '그냥 텍스트' },
  });
  assert.equal(junk.status, 400);
  assert.match(junk.body.error, /name=value/);

  const notKurly = await request(server.baseUrl, '/api/kurly/import-session', {
    method: 'POST',
    cookie: user.cookie,
    body: { session: JSON.stringify({ cookies: [{ name: 'sid', value: '1', domain: 'example.com' }] }) },
  });
  assert.equal(notKurly.status, 400);
  assert.match(notKurly.body.error, /컬리/);

  const status = await request(server.baseUrl, '/api/status', { cookie: user.cookie });
  assert.equal(status.body.queue.active, null, '검증 실패는 작업을 만들지 않아야 합니다.');
});

test('유효한 세션: 202 → 확인 후 connected·별칭·암호화 저장', async () => {
  const user = await register(server.baseUrl, { nickname: '세션러2', password: 'password123' });
  const res = await request(server.baseUrl, '/api/kurly/import-session', {
    method: 'POST',
    cookie: user.cookie,
    body: { session: COOKIE_HEADER, label: '내 폰 크롬' },
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.job?.id);
  assert.deepEqual(res.body.session.cookieNames, ['ksi', 'krt', 'kdi']);
  assert.deepEqual(res.body.session.warnings, []);

  const status = await waitForIdle(user.cookie);
  assert.equal(status.kurly.status, 'connected');
  assert.equal(status.kurly.account, '내 폰 크롬');
  assert.equal(status.kurly.lastError, null);
  assert.equal(status.kurly.hasSession, true);
  assert.ok(status.kurly.connectedAt);

  const before = calls.length;
  assert.ok(before >= 1, '세션 확인 함수가 호출되어야 합니다.');
  assert.ok(calls.some((state) => state.cookies.some((c) => c.name === 'ksi' && c.value === 'SESSION-AAA-111')));

  // 저장 파일에는 평문 쿠키 값이 남지 않아야 합니다.
  const userFile = path.join(server.dataDir, 'users', `${user.body.user.userId}.json`);
  const stored = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  assert.equal(stored.kurly.status, 'connected');
  assert.equal(stored.kurly.account, '내 폰 크롬');
  assert.ok(stored.kurly.session && stored.kurly.session.alg === 'aes-256-gcm');
  assert.ok(!JSON.stringify(stored).includes('SESSION-AAA-111'), '평문 세션 쿠키가 저장되면 안 됩니다.');
});

test('storageState JSON 도 받고, origins 의 localStorage 는 컬리 것만 보관한다', async () => {
  const user = await register(server.baseUrl, { nickname: '세션러3', password: 'password123' });
  const payload = {
    cookies: [
      { name: 'ksi', value: 'S3-A', domain: '.kurly.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
      { name: 'krt', value: 'S3-B', domain: '.kurly.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
    ],
    origins: [
      { origin: 'https://www.kurly.com', localStorage: [{ name: 'seen', value: '1' }] },
      { origin: 'https://other.example.com', localStorage: [{ name: 'x', value: 'y' }] },
    ],
  };
  const res = await request(server.baseUrl, '/api/kurly/import-session', {
    method: 'POST',
    cookie: user.cookie,
    body: { session: JSON.stringify(payload) },
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.session.source, 'storageState');

  const status = await waitForIdle(user.cookie);
  assert.equal(status.kurly.status, 'connected');
  assert.equal(status.kurly.account, '세션 연결됨', '별칭이 없으면 기본 표기를 씁니다.');
});

test('유효하지 않은 세션: lastError 문구를 남기고 연결되지 않는다', async () => {
  process.env.FAKE_SESSION_LOGGED_IN = '0';
  try {
    const user = await register(server.baseUrl, { nickname: '세션러4', password: 'password123' });
    const res = await request(server.baseUrl, '/api/kurly/import-session', {
      method: 'POST',
      cookie: user.cookie,
      body: { session: COOKIE_HEADER },
    });
    assert.equal(res.status, 202);

    const status = await waitForIdle(user.cookie);
    assert.equal(status.kurly.status, 'disconnected');
    assert.equal(status.kurly.hasSession, false);
    assert.equal(
      status.kurly.lastError,
      '유효한 컬리 로그인 세션을 확인하지 못했습니다. 로그인된 상태에서 다시 복사해 주세요.'
    );
  } finally {
    delete process.env.FAKE_SESSION_LOGGED_IN;
  }
});

test('HttpOnly 세션 쿠키가 빠진 입력은 경고와 함께 접수된다', async () => {
  const user = await register(server.baseUrl, { nickname: '세션러5', password: 'password123' });
  const res = await request(server.baseUrl, '/api/kurly/import-session', {
    method: 'POST',
    cookie: user.cookie,
    body: { session: 'AMP_TOKEN=abc; amplitudeBucket=xyz' },
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.session.warnings.length, 1);
  assert.match(res.body.session.warnings[0], /HttpOnly/);

  const status = await waitForIdle(user.cookie);
  assert.equal(status.kurly.status, 'disconnected');
});

test('가져온 세션은 사용자별로 분리된다 (다른 사용자 상태는 그대로)', async () => {
  const a = await register(server.baseUrl, { nickname: '세션A', password: 'password123' });
  const b = await register(server.baseUrl, { nickname: '세션B', password: 'password123' });

  const res = await request(server.baseUrl, '/api/kurly/import-session', {
    method: 'POST',
    cookie: a.cookie,
    body: { session: COOKIE_HEADER, label: 'A 계정' },
  });
  assert.equal(res.status, 202);
  await waitForIdle(a.cookie);

  const statusB = await request(server.baseUrl, '/api/kurly/status', { cookie: b.cookie });
  assert.equal(statusB.body.kurly.status, 'disconnected');
  assert.equal(statusB.body.kurly.hasSession, false);

  const statusA = await request(server.baseUrl, '/api/kurly/status', { cookie: a.cookie });
  assert.equal(statusA.body.kurly.account, 'A 계정');
});
