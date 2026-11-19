'use strict';
/**
 * POST /api/kurly/connect — 아이디·비밀번호 연결 경로 회귀 테스트
 *
 * 2026-11-19 회귀 발견: 큐(JobQueue)가 enqueue 시 `secret` 을 복사하지 않아
 * 핸들러가 늘 "컬리 아이디와 비밀번호를 입력해 주세요." 로 실패했습니다.
 * (enqueue 가 secret 을 전달하는지 test/scheduler-queue.test.js 에서도 확인합니다)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { setupEnv, startServer, request, register } = require('./helpers');

setupEnv();

const received = [];

let server;
test.before(async () => {
  server = await startServer({
    appOptions: {
      loginKurly: async ({ kurlyId, kurlyPassword }) => {
        received.push({ kurlyId, kurlyPassword });
        if (kurlyPassword !== 'kurly-pass-1234') throw new Error('아이디 또는 비밀번호가 맞지 않습니다.');
        return {
          account: `${kurlyId.slice(0, 2)}***`,
          storageState: {
            cookies: [{ name: 'ksi', value: 'LOGIN-COOKIE', domain: '.kurly.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' }],
            origins: [],
          },
        };
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

test('연결 성공: 핸들러가 아이디·비밀번호를 받고, 마스킹된 계정으로 connected 저장', async () => {
  const user = await register(server.baseUrl, { nickname: '연결러', password: 'password123' });
  const res = await request(server.baseUrl, '/api/kurly/connect', {
    method: 'POST',
    cookie: user.cookie,
    body: { kurlyId: 'seoyoon@example.com', kurlyPassword: 'kurly-pass-1234' },
  });
  assert.equal(res.status, 202);
  assert.ok(res.body.job?.id);

  const status = await waitForIdle(user.cookie);
  assert.equal(status.kurly.status, 'connected');
  assert.equal(status.kurly.account, 'se***');
  assert.equal(status.kurly.hasSession, true);

  const last = received[received.length - 1];
  assert.equal(last.kurlyId, 'seoyoon@example.com');
  assert.equal(last.kurlyPassword, 'kurly-pass-1234');
});

test('연결 실패: 컬리가 거부한 사유를 lastError 로 보여주고 세션은 저장하지 않는다', async () => {
  const user = await register(server.baseUrl, { nickname: '연결실패', password: 'password123' });
  const res = await request(server.baseUrl, '/api/kurly/connect', {
    method: 'POST',
    cookie: user.cookie,
    body: { kurlyId: 'someone', kurlyPassword: 'wrong-pass' },
  });
  assert.equal(res.status, 202);

  const status = await waitForIdle(user.cookie);
  assert.equal(status.kurly.status, 'disconnected');
  assert.equal(status.kurly.hasSession, false);
  assert.match(status.kurly.lastError, /아이디 또는 비밀번호가 맞지 않습니다/);
});

test('아이디·비밀번호가 빠지면 400', async () => {
  const user = await register(server.baseUrl, { nickname: '연결검증', password: 'password123' });
  const res = await request(server.baseUrl, '/api/kurly/connect', {
    method: 'POST',
    cookie: user.cookie,
    body: { kurlyId: 'onlyid' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /모두 입력/);
});
