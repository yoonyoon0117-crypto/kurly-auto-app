'use strict';
/** 테스트 도우미 — 임시 DATA_DIR 로 실제 서버를 띄우고 HTTP 로 확인합니다. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SILENT_LOGGER = {
  info() {},
  step() {},
  warn() {},
  error() {},
  file: null,
};

function setupEnv(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurly-auto-app-test-'));
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.APP_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
  process.env.INVITE_CODE = 'INVITE-TEST-123';
  process.env.SCHEDULER = 'false';
  process.env.NODE_ENV = 'test';
  process.env.COOKIE_SECURE = 'false';
  process.env.TRUST_PROXY = '1';
  process.env.REGISTER_RATE_LIMIT = '1000';
  process.env.LOGIN_RATE_LIMIT = '1000';
  // 기존 테스트는 초대 코드 로그인·회원가입 화면(멀티유저) 동작을 확인합니다.
  // 개인용 모드(REQUIRE_AUTH=false)는 test/api-personal-mode.test.js 에서 따로 검증합니다.
  process.env.REQUIRE_AUTH = 'true';
  Object.assign(process.env, overrides);
  return root;
}

async function startServer({ logger = SILENT_LOGGER, appOptions = {} } = {}) {
  const { createApp } = require('../server');
  const app = createApp({ logger, schedulerEnabled: false, ...appOptions });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    app,
    baseUrl,
    dataDir: process.env.DATA_DIR,
    close: () =>
      new Promise((resolve) => {
        app.scheduler.stop();
        app.queue.stop();
        app.server.close(resolve);
      }),
  };
}

async function request(baseUrl, urlPath, { method = 'GET', body, cookie, headers = {} } = {}) {
  const init = { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }, redirect: 'manual' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(baseUrl + urlPath, init);
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie')]
        : [];
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return {
    status: res.status,
    body: data,
    text,
    headers: res.headers,
    setCookies,
    cookie: setCookies.map((c) => c.split(';')[0]).join('; '),
  };
}

async function register(baseUrl, opts = {}) {
  const nickname = opts.nickname || `친구${Math.random().toString(36).slice(2, 7)}`;
  const res = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      inviteCode: opts.inviteCode ?? process.env.INVITE_CODE,
      nickname,
      password: opts.password || 'password123',
      loadStarter: opts.loadStarter === true,
    },
  });
  return { ...res, nickname, cookie: res.cookie };
}

module.exports = { setupEnv, startServer, request, register, SILENT_LOGGER };
