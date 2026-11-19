#!/usr/bin/env node
'use strict';
/**
 * 컬리 정기 장바구니 — 멀티유저 PWA 서버
 *
 *   npm start  →  http://localhost:3000
 *
 *  외부 패키지는 playwright 하나뿐이고, HTTP 서버·세션·암호화는 Node 내장 모듈로 처리합니다.
 *  사용자 데이터는 DATA_DIR/users/{userId}.json 에 사용자별로 완전히 분리해 저장합니다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadEnv, envBool, envInt } = require('./lib/env');
loadEnv();

const { PUBLIC_DIR, DATA_DIR } = require('./lib/paths');
const { HttpError, applySecurityHeaders, sendJson, sendText, readJson, parseCookies, serializeCookie, isHttps, sameOriginOk, sendFile } = require('./lib/http');
const sessions = require('./lib/sessions');
const { hashPassword, verifyPassword } = require('./lib/passwords');
const { sealJson, openJson } = require('./lib/crypto-box');
const { normalizePlanInput, summarizePlan, computeQuantity } = require('./lib/plan');
const { searchProducts, getProductDetail, KurlyApiError } = require('./lib/kurly-api');
const { parseSessionInput } = require('./lib/session-import');
const { starterItems } = require('./lib/seeds');
const { createLogger } = require('./lib/logger');
const { JobQueue } = require('./lib/queue');
const { Scheduler } = require('./lib/scheduler');
const { runCartForUser, previewPlan } = require('./lib/runner');
const store = require('./lib/store');

const APP_NAME = '컬리 정기 장바구니';
const VERSION = require('./package.json').version;
const PORT = Number(process.env.PORT) || 3000;

/* ─────────────── 시작 전 점검 ─────────────── */

function ensureSecrets(logger) {
  if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('APP_SECRET 이 없습니다. 16자 이상의 임의 문자열을 환경변수로 넣어 주세요. (예: openssl rand -hex 32)');
    }
    process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
    logger?.warn('APP_SECRET 이 없어 임시 키를 만들었습니다. 서버를 다시 켜면 로그인·컬리 연결이 초기화됩니다. (.env 에 넣어 주세요)');
  }
  if (!process.env.INVITE_CODE) {
    logger?.warn('INVITE_CODE 가 없습니다. 새 회원가입은 막히고 기존 사용자 로그인만 됩니다.');
  }
}

/* ─────────────── 작은 캐시 / 레이트리밋 ─────────────── */

const cache = new Map();
function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  return producer().then((value) => {
    cache.set(key, { value, expires: Date.now() + ttlMs });
    if (cache.size > 300) {
      const now = Date.now();
      for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
    }
    return value;
  });
}

const rateBuckets = new Map();
function rateLimit(key, { max, windowMs }) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}
function resetRateLimit(key) {
  rateBuckets.delete(key);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
}, 5 * 60 * 1000).unref();

/* ─────────────── 인증 도우미 ─────────────── */

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function publicUser(user) {
  return {
    userId: user.userId,
    nickname: user.nickname,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function kurlyStatus(user) {
  const k = user.kurly || {};
  return {
    status: k.status || 'disconnected',
    account: k.account || null,
    connectedAt: k.connectedAt || null,
    lastVerifiedAt: k.lastVerifiedAt || null,
    lastError: k.lastError || null,
    hasSession: Boolean(k.session),
  };
}

function planPayload(user) {
  const summary = summarizePlan(user);
  return {
    items: (user.items || []).map((item) => ({ ...item, quantity: computeQuantity(item) })),
    schedule: summary.schedule,
    notification: user.notification,
    summary,
  };
}

/* ─────────────── 사용자 데이터 변경 도우미 ─────────────── */

async function addStarterItems(user) {
  const existing = new Set(
    (user.items || []).map((i) => `${i.productNo}:${i.optionName || ''}`)
  );
  const toAdd = starterItems(user.userId).filter((i) => !existing.has(`${i.productNo}:${i.optionName || ''}`));
  if (!toAdd.length) return { added: 0, user };
  const updated = await store.updateUser(user.userId, (u) => {
    u.items = [...(u.items || []), ...toAdd];
    return u;
  });
  return { added: toAdd.length, user: updated };
}

/* ─────────────── 앱 만들기 ─────────────── */

function createApp({ logger = createLogger('app'), schedulerEnabled = envBool('SCHEDULER', true), verifyKurlySession = null, loginKurly = null } = {}) {
  ensureSecrets(logger);
  store.ensureDirs();

  // 세션 확인·로그인은 기본적으로 Playwright 로 합니다. 테스트에서는 브라우저 없이 바꿔 끼울 수 있습니다.
  const verifySessionImpl =
    verifyKurlySession ||
    (async (storageState) => {
      const lib = require('./lib/kurly-browser');
      return lib.verifySessionWithState(storageState, { headless: true });
    });
  const loginImpl =
    loginKurly ||
    ((opts) => {
      const lib = require('./lib/kurly-browser');
      return lib.loginAndCapture(opts);
    });
  const INVALID_SESSION_MESSAGE = '유효한 컬리 로그인 세션을 확인하지 못했습니다. 로그인된 상태에서 다시 복사해 주세요.';

  /* 큐: 어떤 사용자의 작업이든 동시에 1개(Chromium 1개)만 실행 */
  const queue = new JobQueue({
    logger,
    concurrency: Math.max(1, envInt('MAX_CONCURRENT_RUNS', 1)),
    handler: async (job, { setProgress }) => {
      if (job.type === 'kurly-connect') {
        const user = store.getUser(job.userId);
        if (!user) throw new Error('사용자를 찾을 수 없습니다.');
        const { kurlyId, kurlyPassword } = job.secret || {};
        job.secret = null;
        if (!kurlyId || !kurlyPassword) throw new Error('컬리 아이디와 비밀번호를 입력해 주세요.');
        setProgress('컬리 로그인 중…');
        try {
          const { storageState, account } = await loginImpl({
            kurlyId,
            kurlyPassword,
            logger,
            headless: true,
          });
          const sealed = sealJson(storageState);
          await store.updateUser(job.userId, (u) => {
            u.kurly = {
              status: 'connected',
              account,
              connectedAt: Date.now(),
              lastVerifiedAt: Date.now(),
              lastError: null,
              session: sealed,
            };
            return u;
          });
          logger.info(`컬리 연결 완료: ${user.nickname} (${account})`);
          return { status: 'connected', account };
        } catch (err) {
          await store.updateUser(job.userId, (u) => {
            u.kurly = {
              ...u.kurly,
              status: u.kurly?.session ? 'expired' : 'disconnected',
              lastError: err.message,
            };
            return u;
          });
          throw err;
        }
      }

      if (job.type === 'kurly-import') {
        const user = store.getUser(job.userId);
        if (!user) throw new Error('사용자를 찾을 수 없습니다.');
        const { storageState, label } = job.secret || {};
        job.secret = null;
        if (!storageState || !Array.isArray(storageState.cookies)) throw new Error('가져온 세션이 없습니다.');
        setProgress('가져온 컬리 세션 확인 중…');

        let verified;
        try {
          verified = await verifySessionImpl(storageState);
        } catch (err) {
          // Playwright 설치 안내처럼 긴 오류문 전체를 화면에 남기지 않도록 한 줄로 줄입니다.
          const brief = String(err?.message || err || '').replace(/\s+/g, ' ').trim().slice(0, 200);
          const message = `가져온 세션을 확인하지 못했습니다: ${brief}`;
          await store.updateUser(job.userId, (u) => {
            u.kurly = { ...u.kurly, lastError: message };
            return u;
          });
          throw err;
        }

        if (!verified || verified.loggedIn !== true) {
          await store.updateUser(job.userId, (u) => {
            u.kurly = {
              ...u.kurly,
              // 기존에 연결된 세션이 있으면 그 상태는 건드리지 않고 실패 사유만 남깁니다.
              status: u.kurly?.session ? u.kurly.status || 'expired' : 'disconnected',
              lastError: INVALID_SESSION_MESSAGE,
            };
            return u;
          });
          logger.info(`컬리 세션 가져오기 실패(유효하지 않음): ${user.nickname}`);
          return { status: 'invalid', error: INVALID_SESSION_MESSAGE };
        }

        const account = String(label || '').trim().slice(0, 40) || '세션 연결됨';
        const sealed = sealJson(verified.storageState || storageState);
        await store.updateUser(job.userId, (u) => {
          u.kurly = {
            status: 'connected',
            account,
            connectedAt: Date.now(),
            lastVerifiedAt: Date.now(),
            lastError: null,
            session: sealed,
          };
          return u;
        });
        logger.info(`컬리 세션 가져오기 완료: ${user.nickname} (${account})`);
        return { status: 'connected', account };
      }

      if (job.type === 'kurly-verify') {
        const user = store.getUser(job.userId);
        if (!user?.kurly?.session) throw new Error('연결된 컬리 계정이 없습니다.');
        setProgress('컬리 로그인 상태 확인 중…');
        const lib = require('./lib/kurly-browser');
        let alive = false;
        try {
          alive = await lib.verifySession(openJson(user.kurly.session), { headless: true });
        } catch (err) {
          await store.updateUser(job.userId, (u) => {
            u.kurly = { ...u.kurly, status: 'expired', lastError: err.message };
            return u;
          });
          throw err;
        }
        await store.updateUser(job.userId, (u) => {
          u.kurly = {
            ...u.kurly,
            status: alive ? 'connected' : 'expired',
            lastVerifiedAt: Date.now(),
            lastError: alive ? null : '컬리 로그인이 만료되었습니다. 다시 연결해 주세요.',
          };
          return u;
        });
        return { status: alive ? 'connected' : 'expired' };
      }

      if (job.type === 'run') {
        const user = store.getUser(job.userId);
        if (!user) throw new Error('사용자를 찾을 수 없습니다.');
        return runCartForUser({
          user,
          trigger: job.trigger,
          onProgress: setProgress,
          logger,
        });
      }
      throw new Error(`알 수 없는 작업 종류: ${job.type}`);
    },
  });

  const scheduler = new Scheduler({
    queue,
    logger,
    graceHours: envInt('RUN_GRACE_HOURS', 6),
    intervalMs: Math.max(5, envInt('SCHEDULER_INTERVAL_SECONDS', 60)) * 1000,
  });

  /* ─────────────── 요청 처리 ─────────────── */

  function currentUser(req) {
    const token = parseCookies(req)[sessions.COOKIE_NAME];
    const payload = sessions.verifyToken(token);
    if (!payload) return null;
    const user = store.getUser(payload.userId);
    if (!user) return null;
    // 로그아웃하면 sessionEpoch 가 올라가 그 전에 발급한 쿠키는 모두 무효가 됩니다.
    if ((Number(user.sessionEpoch) || 1) !== payload.epoch) return null;
    return user;
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, '로그인이 필요합니다.');
    return user;
  }

  function setSession(req, res, userId, epoch = 1) {
    const { token, maxAgeSec } = sessions.issue(userId, Date.now(), epoch);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(sessions.COOKIE_NAME, token, {
        maxAge: maxAgeSec,
        httpOnly: true,
        sameSite: 'Lax',
        secure: isHttps(req),
      })
    );
  }

  function clearSession(res) {
    res.setHeader(
      'Set-Cookie',
      serializeCookie(sessions.COOKIE_NAME, '', { maxAge: 0, httpOnly: true, sameSite: 'Lax' })
    );
  }

  async function handleRegister(req, res, body) {
    const invite = process.env.INVITE_CODE;
    if (!invite) throw new HttpError(503, '초대 코드가 설정되지 않아 회원가입을 받을 수 없습니다. 운영자에게 문의해 주세요.');
    const ip = req.socket?.remoteAddress || 'unknown';
    if (!rateLimit(`register:${ip}`, { max: envInt('REGISTER_RATE_LIMIT', 20), windowMs: 60 * 60 * 1000 })) {
      throw new HttpError(429, '가입 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    }
    if (!safeEqual(String(body.inviteCode ?? '').trim(), invite)) {
      throw new HttpError(403, '초대 코드가 올바르지 않습니다.');
    }
    const nickname = store.normalizeNickname(body.nickname);
    const password = String(body.password ?? '');
    if (password.length < 6) throw new HttpError(400, '비밀번호는 6자 이상으로 만들어 주세요.');
    if (password.length > 200) throw new HttpError(400, '비밀번호가 너무 깁니다.');

    const user = await store.createUser({ nickname, passwordHash: hashPassword(password) });
    let finalUser = user;
    if (body.loadStarter !== false) {
      const added = await addStarterItems(user);
      finalUser = added.user;
    }
    setSession(req, res, user.userId, user.sessionEpoch);
    logger.info(`새 사용자: #${user.userId} (${user.nickname})`);
    return sendJson(res, 201, {
      ok: true,
      user: publicUser(finalUser),
      plan: planPayload(finalUser),
    });
  }

  async function handleLogin(req, res, body) {
    const ip = req.socket?.remoteAddress || 'unknown';
    const nickname = store.normalizeNickname(body.nickname);
    const key = `login:${ip}:${nickname.toLowerCase()}`;
    if (!rateLimit(key, { max: envInt('LOGIN_RATE_LIMIT', 10), windowMs: 15 * 60 * 1000 })) {
      throw new HttpError(429, '로그인 시도가 너무 많습니다. 15분 뒤 다시 시도해 주세요.');
    }
    const entry = store.findIndexEntryByNickname(nickname);
    if (!entry) throw new HttpError(401, '닉네임 또는 비밀번호가 올바르지 않습니다.');
    const user = store.getUser(entry.userId);
    if (!user || !verifyPassword(String(body.password ?? ''), user.password)) {
      throw new HttpError(401, '닉네임 또는 비밀번호가 올바르지 않습니다.');
    }
    resetRateLimit(key);
    const fresh = await store.touchLogin(user.userId);
    setSession(req, res, user.userId, (fresh || user).sessionEpoch);
    return sendJson(res, 200, { ok: true, user: publicUser(fresh || user), plan: planPayload(fresh || user) });
  }

  async function handlePlanSave(req, res, user, body) {
    let normalized;
    try {
      normalized = normalizePlanInput(body, { nowMs: Date.now(), maxItems: 100 });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const updated = await store.updateUser(user.userId, (u) => {
      u.items = normalized.items;
      u.schedule = normalized.schedule;
      u.notification = normalized.notification;
      return u;
    });
    return sendJson(res, 200, { ok: true, plan: planPayload(updated) });
  }

  async function handleKurlyConnect(req, res, user, body) {
    const kurlyId = String(body.kurlyId ?? '').trim();
    const kurlyPassword = String(body.kurlyPassword ?? '');
    if (!kurlyId || !kurlyPassword) throw new HttpError(400, '컬리 아이디와 비밀번호를 모두 입력해 주세요.');
    if (kurlyId.length > 100 || kurlyPassword.length > 200) throw new HttpError(400, '입력값이 너무 깁니다.');
    if (!rateLimit(`kurly-connect:${user.userId}`, { max: 6, windowMs: 15 * 60 * 1000 })) {
      throw new HttpError(429, '연결 시도가 너무 많습니다. 15분 뒤 다시 시도해 주세요.');
    }
    const active = queue.activeFor(user.userId);
    if (active && active.type === 'kurly-connect') {
      return sendJson(res, 202, { ok: true, job: { id: active.id, status: active.status, progress: active.progress } });
    }
    const job = queue.enqueue({
      type: 'kurly-connect',
      userId: user.userId,
      trigger: 'manual',
      dedupeKey: `kurly-connect:${user.userId}`,
      secret: { kurlyId, kurlyPassword },
    });
    return sendJson(res, 202, { ok: true, job: { id: job.id, status: job.status, progress: job.progress } });
  }

  async function handleKurlyImport(req, res, user, body) {
    const raw = typeof body.session === 'string' ? body.session : typeof body.raw === 'string' ? body.raw : '';
    const label = String(body.label ?? '').trim().slice(0, 40);
    if (!rateLimit(`kurly-import:${user.userId}`, { max: 10, windowMs: 15 * 60 * 1000 })) {
      throw new HttpError(429, '세션 가져오기 시도가 너무 많습니다. 15분 뒤 다시 시도해 주세요.');
    }

    let parsed;
    try {
      parsed = parseSessionInput(raw);
    } catch (err) {
      throw new HttpError(400, err.message);
    }

    const active = queue.activeFor(user.userId);
    if (active && active.type === 'kurly-import') {
      return sendJson(res, 202, {
        ok: true,
        job: { id: active.id, status: active.status, progress: active.progress },
        session: { source: parsed.source, cookieNames: parsed.cookieNames, warnings: parsed.warnings },
      });
    }

    const job = queue.enqueue({
      type: 'kurly-import',
      userId: user.userId,
      trigger: 'manual',
      dedupeKey: `kurly-import:${user.userId}`,
      secret: { storageState: parsed.storageState, label },
    });
    logger.info(`컬리 세션 가져오기 접수: ${user.nickname} · 쿠키 ${parsed.cookieNames.length}개(${parsed.cookieNames.join(',')})`);
    return sendJson(res, 202, {
      ok: true,
      job: { id: job.id, status: job.status, progress: job.progress },
      session: { source: parsed.source, cookieNames: parsed.cookieNames, warnings: parsed.warnings },
    });
  }

  async function handle(req, res) {
    applySecurityHeaders(res);
    const startedAt = Date.now();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendText(res, 400, '잘못된 요청입니다.');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendText(res, 400, '잘못된 경로입니다.');
    }
    const method = req.method || 'GET';

    try {
      if (pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'kurly-auto-app',
          version: VERSION,
          users: store.countUsers(),
          uptimeSec: Math.round(process.uptime()),
          time: new Date().toISOString(),
        });
      }

      if (pathname === '/api/config' && method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          appName: APP_NAME,
          version: VERSION,
          inviteRequired: Boolean(process.env.INVITE_CODE),
          registrationOpen: Boolean(process.env.INVITE_CODE),
        });
      }

      if (pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD' && !sameOriginOk(req)) {
          throw new HttpError(403, '다른 사이트에서 보낸 요청은 처리하지 않습니다.');
        }

        const body =
          method === 'POST' || method === 'PUT' || method === 'PATCH' ? await readJson(req, 512 * 1024) : {};

        /* ── 인증 ── */
        if (pathname === '/api/auth/register' && method === 'POST') return await handleRegister(req, res, body);
        if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(req, res, body);
        if (pathname === '/api/auth/logout' && method === 'POST') {
          const user = currentUser(req);
          if (user) {
            await store.updateUser(user.userId, (u) => {
              u.sessionEpoch = (Number(u.sessionEpoch) || 1) + 1;
              return u;
            });
          }
          clearSession(res);
          return sendJson(res, 200, { ok: true });
        }
        if (pathname === '/api/auth/session' && method === 'GET') {
          // 로그인 전에도 200 으로 답해 첫 화면에서 불필요한 401 콘솔 오류를 만들지 않습니다.
          const user = currentUser(req);
          if (!user) return sendJson(res, 200, { ok: true, user: null, plan: null });
          // 남은 기간이 7일 미만이면 쿠키를 자동 연장합니다(슬라이딩 세션).
          const payload = sessions.verifyToken(parseCookies(req)[sessions.COOKIE_NAME]);
          if (payload && sessions.needsRefresh(payload)) setSession(req, res, user.userId, user.sessionEpoch);
          return sendJson(res, 200, { ok: true, user: publicUser(user), plan: planPayload(user) });
        }
        if (pathname === '/api/auth/me' && method === 'GET') {
          const user = currentUser(req);
          if (!user) return sendJson(res, 401, { ok: false, error: '로그인이 필요합니다.' });
          return sendJson(res, 200, { ok: true, user: publicUser(user), plan: planPayload(user) });
        }

        /* ── 이 아래는 로그인 필요 ── */
        const user = requireUser(req);

        if (pathname === '/api/plan' && method === 'GET') {
          return sendJson(res, 200, { ok: true, plan: planPayload(user) });
        }
        if (pathname === '/api/plan' && (method === 'POST' || method === 'PUT')) {
          return await handlePlanSave(req, res, user, body);
        }

        if (pathname === '/api/items/starter' && method === 'POST') {
          const result = await addStarterItems(user);
          return sendJson(res, 200, { ok: true, added: result.added, plan: planPayload(result.user) });
        }

        if (pathname === '/api/search' && method === 'GET') {
          const q = String(url.searchParams.get('q') ?? '').trim();
          const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
          if (!q) throw new HttpError(400, '검색어를 입력해 주세요.');
          if (q.length > 60) throw new HttpError(400, '검색어가 너무 깁니다.');
          const result = await cached(`search:${q}:${page}`, 5 * 60 * 1000, () =>
            searchProducts(q, { page, limit: 24 })
          );
          return sendJson(res, 200, { ok: true, ...result });
        }

        if (pathname === '/api/product' && method === 'GET') {
          const no = Number(url.searchParams.get('no'));
          if (!Number.isInteger(no) || no <= 0) throw new HttpError(400, '상품번호가 올바르지 않습니다.');
          const detail = await cached(`product:${no}`, 10 * 60 * 1000, () => getProductDetail(no));
          return sendJson(res, 200, { ok: true, product: detail });
        }

        if (pathname === '/api/kurly/status' && method === 'GET') {
          return sendJson(res, 200, { ok: true, kurly: kurlyStatus(user) });
        }
        if (pathname === '/api/kurly/connect' && method === 'POST') {
          return await handleKurlyConnect(req, res, user, body);
        }
        if (pathname === '/api/kurly/import-session' && method === 'POST') {
          return await handleKurlyImport(req, res, user, body);
        }
        if (pathname === '/api/kurly/verify' && method === 'POST') {
          if (!user.kurly?.session) throw new HttpError(400, '먼저 컬리 계정을 연결해 주세요.');
          const active = queue.activeFor(user.userId);
          if (active) return sendJson(res, 202, { ok: true, job: { id: active.id, status: active.status, progress: active.progress } });
          const job = queue.enqueue({
            type: 'kurly-verify',
            userId: user.userId,
            trigger: 'manual',
            dedupeKey: `kurly-verify:${user.userId}`,
          });
          return sendJson(res, 202, { ok: true, job: { id: job.id, status: job.status } });
        }
        if (pathname === '/api/kurly/disconnect' && method === 'POST') {
          const updated = await store.updateUser(user.userId, (u) => {
            u.kurly = {
              status: 'disconnected',
              account: null,
              connectedAt: null,
              lastVerifiedAt: null,
              lastError: null,
              session: null,
            };
            return u;
          });
          return sendJson(res, 200, { ok: true, kurly: kurlyStatus(updated) });
        }

        if (pathname === '/api/cart/preview' && method === 'GET') {
          return sendJson(res, 200, { ok: true, preview: previewPlan(user) });
        }

        if (pathname === '/api/cart/run-now' && method === 'POST') {
          const active = queue.activeFor(user.userId);
          if (active) {
            return sendJson(res, 409, {
              ok: false,
              error: '이미 실행 중인 작업이 있습니다. 끝난 뒤 다시 시도해 주세요.',
              job: { id: active.id, status: active.status, progress: active.progress },
            });
          }
          if (!(user.items || []).some((i) => i.active !== false)) {
            throw new HttpError(400, '계획에 담을 상품이 없습니다. 먼저 상품을 추가해 주세요.');
          }
          const job = queue.enqueue({
            type: 'run',
            userId: user.userId,
            trigger: 'manual',
            dedupeKey: `run:${user.userId}:${Date.now()}`,
          });
          return sendJson(res, 202, {
            ok: true,
            job: { id: job.id, status: job.status, progress: job.progress },
          });
        }

        if (pathname === '/api/runs' && method === 'GET') {
          const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          return sendJson(res, 200, {
            ok: true,
            runs: (user.runHistory || []).slice(0, limit),
            stats: user.stats || { runs: 0, added: 0, failed: 0 },
            lastRunAt: user.lastRunAt,
          });
        }

        if (pathname === '/api/status' && method === 'GET') {
          const summary = summarizePlan(user);
          const active = queue.activeFor(user.userId);
          return sendJson(res, 200, {
            ok: true,
            serverTime: Date.now(),
            plan: {
              activeCount: summary.activeCount,
              estimatedTotal: summary.estimatedTotal,
              nextRunAt: summary.nextRunAt,
              nextRunLabel: summary.nextRunLabel,
              scheduleLabel: summary.scheduleLabel,
              schedule: summary.schedule,
            },
            kurly: kurlyStatus(user),
            queue: {
              active: active
                ? {
                    id: active.id,
                    type: active.type,
                    status: active.status,
                    progress: active.progress,
                    createdAt: active.createdAt,
                    startedAt: active.startedAt,
                  }
                : null,
            },
            lastRun: (user.runHistory || [])[0] || null,
            stats: user.stats || { runs: 0, added: 0, failed: 0 },
          });
        }

        if (pathname === '/api/schedule/status' && method === 'GET') {
          return sendJson(res, 200, { ok: true, scheduler: scheduler.status(), queue: queue.stats() });
        }

        throw new HttpError(404, '없는 API 입니다.');
      }

      /* ─────────────── 정적 파일 (PWA) ─────────────── */
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '지원하지 않는 메서드입니다.');

      let rel;
      if (pathname === '/') rel = 'index.html';
      else if (pathname === '/manifest.webmanifest' || pathname === '/manifest.json') rel = 'manifest.json';
      else if (pathname === '/sw.js') rel = 'sw.js';
      else rel = pathname.replace(/^\/+/, '');

      const filePath = path.join(PUBLIC_DIR, rel);
      const normalizedPublic = path.resolve(PUBLIC_DIR) + path.sep;
      if (!path.resolve(filePath).startsWith(normalizedPublic)) {
        throw new HttpError(403, '접근할 수 없습니다.');
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        if (pathname === '/sw.js') {
          res.setHeader('Service-Worker-Allowed', '/');
          return sendFile(req, res, filePath, { cacheControl: 'no-store' });
        }
        return sendFile(req, res, filePath);
      }
      if (path.extname(pathname)) return sendText(res, 404, '파일을 찾을 수 없습니다.');
      return sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'), { cacheControl: 'no-store' });
    } catch (err) {
      const status =
        err instanceof HttpError
          ? err.status
          : err instanceof KurlyApiError
            ? 502
            : typeof err.status === 'number' && err.status >= 400 && err.status < 500
              ? err.status
              : 500;
      const message =
        status < 500
          ? err.message
          : err instanceof KurlyApiError
            ? err.message
            : '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
      if (status >= 500) logger.error(`${req.method} ${pathname} → ${status}: ${err.message}`);
      else logger.info(`${req.method} ${pathname} → ${status}: ${err.message}`);
      if (!res.headersSent) sendJson(res, status, { ok: false, error: message });
      return undefined;
    } finally {
      if (process.env.LOG_REQUESTS === '1') {
        logger.info(`${method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
      }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error(`처리되지 않은 오류: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: '서버 오류가 발생했습니다.' });
    });
  });

  function startScheduler() {
    if (!schedulerEnabled) {
      logger.info('스케줄러 비활성(SCHEDULER=false)');
      return;
    }
    scheduler.start();
  }

  return { server, queue, scheduler, startScheduler, logger };
}

/* ─────────────── 직접 실행 ─────────────── */

if (require.main === module) {
  const logger = createLogger('app');
  let app;
  try {
    app = createApp({ logger });
  } catch (err) {
    console.error(`시작할 수 없습니다: ${err.message}`);
    process.exit(1);
  }
  const { server } = app;

  server.listen(PORT, () => {
    console.log(`
🛒 ${APP_NAME} v${VERSION}
   웹 앱   : http://localhost:${PORT}
   데이터  : ${DATA_DIR}
   초대코드: ${process.env.INVITE_CODE ? '설정됨' : '없음(가입 막힘)'}
   종료    : Ctrl + C
`);
    app.startScheduler();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`포트 ${PORT} 이(가) 이미 사용 중입니다. PORT=3001 npm start 처럼 다른 포트를 쓰세요.`);
    } else {
      console.error('서버 오류:', err.message);
    }
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} — 정리 중…`);
    app.scheduler.stop();
    app.queue.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createApp, APP_NAME, VERSION };
