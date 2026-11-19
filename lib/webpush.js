'use strict';
/**
 * Web Push (VAPID) — 아이폰 홈 화면 앱(PWA)으로 직접 푸시 알림.
 *
 *   · VAPID 키: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 환경변수가 있으면 그대로 쓰고,
 *     없으면 DATA_DIR/vapid.json 에 최초 1회 만들어 보관합니다(권한 0600).
 *     → Railway 처럼 /data 볼륨만 붙이면 환경변수 없이도 바로 동작합니다.
 *   · 구독은 DATA_DIR/users/{userId}.json 의 pushSubscriptions 에 사용자별로 저장합니다.
 *   · 푸시 서비스가 404/410 으로 답하면 만료된 구독이므로 사용자 기록에서 자동으로 지웁니다.
 *
 *  아이폰은 iOS 16.4 이상에서 "홈 화면에 추가"한 앱(Safari standalone)에서만 웹 푸시를 받습니다.
 */
const fs = require('fs');
const path = require('path');
const webPush = require('web-push');
const { DATA_DIR } = require('./paths');
const store = require('./store');

const DEFAULT_SUBJECT = 'mailto:kurly-auto-app@example.invalid';
const MAX_SUBSCRIPTIONS_PER_USER = 12;
const VAPID_FILE_NAME = 'vapid.json';

/* ─────────────── VAPID 키 ─────────────── */

let cachedKeys = null;
let warnedPartialEnv = false;

function vapidFilePath() {
  return path.join(DATA_DIR, VAPID_FILE_NAME);
}

function envSubject() {
  const subject = String(process.env.VAPID_SUBJECT || '').trim();
  if (!subject) return DEFAULT_SUBJECT;
  // VAPID subject 는 mailto: 또는 https: 주소여야 합니다. 아니면 푸시 서비스가 403 을 돌려줍니다.
  if (/^(mailto:|https:)/i.test(subject)) return subject;
  return `mailto:${subject}`;
}

function envKeys() {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  if (publicKey && privateKey) return { publicKey, privateKey };
  if ((publicKey || privateKey) && !warnedPartialEnv) {
    warnedPartialEnv = true;
    // 한쪽만 넣으면 키가 어긋나 모든 푸시가 401 이 됩니다. 둘 다 없을 때와 같이 자동 생성 키를 씁니다.
    console.warn('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 는 둘 다 넣어야 합니다. DATA_DIR 의 자동 생성 키를 사용합니다.');
  }
  return null;
}

function readKeyFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(vapidFilePath(), 'utf8'));
    if (raw && typeof raw.publicKey === 'string' && typeof raw.privateKey === 'string') {
      try {
        fs.chmodSync(vapidFilePath(), 0o600);
      } catch {
        /* 일부 파일시스템(윈도우 마운트)에서는 무시 */
      }
      return { publicKey: raw.publicKey, privateKey: raw.privateKey, subject: raw.subject || null, createdAt: raw.createdAt || null };
    }
  } catch {
    /* 파일이 없거나 깨졌으면 새로 만듭니다 */
  }
  return null;
}

function writeKeyFile({ publicKey, privateKey, subject }) {
  const file = vapidFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { version: 1, publicKey, privateKey, subject, createdAt: new Date().toISOString() };
  const tmp = path.join(path.dirname(file), `.${VAPID_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
  return record;
}

/**
 * VAPID 키를 확정합니다. (환경변수 → DATA_DIR/vapid.json → 새로 생성)
 * @returns {{publicKey:string, privateKey:string, subject:string, source:'env'|'file'|'generated'}}
 */
function getVapidKeys() {
  const subject = envSubject();
  const fromEnv = envKeys();
  if (fromEnv) {
    cachedKeys = { ...fromEnv, subject, source: 'env' };
    return cachedKeys;
  }
  if (cachedKeys && cachedKeys.source !== 'env') return { ...cachedKeys, subject };

  const existing = readKeyFile();
  if (existing) {
    cachedKeys = {
      publicKey: existing.publicKey,
      privateKey: existing.privateKey,
      subject: existing.subject && /^(mailto:|https:)/i.test(existing.subject) ? existing.subject : subject,
      source: 'file',
    };
    return cachedKeys;
  }

  const generated = webPush.generateVAPIDKeys();
  writeKeyFile({ publicKey: generated.publicKey, privateKey: generated.privateKey, subject });
  cachedKeys = { ...generated, subject, source: 'generated' };
  return cachedKeys;
}

function publicKey() {
  return getVapidKeys().publicKey;
}

/** web-push 에 VAPID 서명 정보를 설정합니다. (실패해도 서버는 계속 동작) */
function configureVapid(logger = null) {
  const keys = getVapidKeys();
  try {
    webPush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
    return { ok: true, source: keys.source };
  } catch (err) {
    logger?.warn?.(`VAPID 설정 실패: ${err.message}`);
    return { ok: false, error: err.message, source: keys.source };
  }
}

/* ─────────────── 구독 ─────────────── */

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** 브라우저가 보낸 구독을 검사해 저장용 형태로 만듭니다. */
function sanitizeSubscription(input = {}) {
  const endpoint = String(input.endpoint ?? '').trim();
  if (!endpoint) throw badRequest('푸시 구독 주소(endpoint)가 없습니다.');
  if (endpoint.length > 2048) throw badRequest('푸시 구독 주소가 너무 깁니다.');
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw badRequest('푸시 구독 주소가 올바른 URL 이 아닙니다.');
  }
  if (parsed.protocol !== 'https:') throw badRequest('푸시 구독 주소는 https 여야 합니다.');

  const keys = input.keys || {};
  const p256dh = String(keys.p256dh ?? '').trim();
  const auth = String(keys.auth ?? '').trim();
  if (!p256dh || !auth) throw badRequest('푸시 구독 키(p256dh·auth)가 없습니다.');
  if (p256dh.length > 200 || auth.length > 100) throw badRequest('푸시 구독 키가 너무 깁니다.');

  const deviceLabel = String(input.deviceLabel ?? '').trim().slice(0, 60) || '이 기기';
  const userAgent = String(input.userAgent ?? '').trim().slice(0, 200) || null;
  return { endpoint, keys: { p256dh, auth }, deviceLabel, userAgent };
}

function listSubscriptions(userId) {
  const user = store.getUser(userId);
  return Array.isArray(user?.pushSubscriptions) ? user.pushSubscriptions : [];
}

function findSubscription(userId, endpoint) {
  return listSubscriptions(userId).find((s) => s.endpoint === endpoint) || null;
}

/** 구독 추가/갱신 — 같은 endpoint 는 덮어써 한 기기에 하나만 남깁니다. */
async function subscribeUser(userId, input) {
  const sub = sanitizeSubscription(input);
  const updated = await store.updateUser(userId, (user) => {
    const list = Array.isArray(user.pushSubscriptions) ? user.pushSubscriptions : [];
    const now = Date.now();
    const existing = list.find((s) => s.endpoint === sub.endpoint);
    if (existing) {
      existing.keys = sub.keys;
      existing.deviceLabel = sub.deviceLabel;
      existing.userAgent = sub.userAgent;
      existing.lastSeenAt = now;
      existing.lastError = null;
    } else {
      list.unshift({
        ...sub,
        id: `sub_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: now,
        lastSeenAt: now,
        lastError: null,
      });
    }
    // 기기 수 상한 — 오래된 것부터 버립니다.
    user.pushSubscriptions = list.slice(0, MAX_SUBSCRIPTIONS_PER_USER);
    return user;
  });
  return {
    subscription: updated.pushSubscriptions.find((s) => s.endpoint === sub.endpoint) || null,
    count: updated.pushSubscriptions.length,
  };
}

async function unsubscribeUser(userId, endpoint) {
  const target = String(endpoint ?? '').trim();
  if (!target) throw badRequest('해지할 푸시 구독 주소(endpoint)가 없습니다.');
  let removed = 0;
  const updated = await store.updateUser(userId, (user) => {
    const list = Array.isArray(user.pushSubscriptions) ? user.pushSubscriptions : [];
    const next = list.filter((s) => s.endpoint !== target);
    removed = list.length - next.length;
    user.pushSubscriptions = next;
    return user;
  });
  return { removed, count: updated.pushSubscriptions.length };
}

async function pruneSubscriptions(userId, endpoints) {
  if (!endpoints || !endpoints.size) return 0;
  try {
    const updated = await store.updateUser(userId, (user) => {
      const list = Array.isArray(user.pushSubscriptions) ? user.pushSubscriptions : [];
      user.pushSubscriptions = list.filter((s) => !endpoints.has(s.endpoint));
      return user;
    });
    return Array.isArray(updated.pushSubscriptions) ? updated.pushSubscriptions.length : 0;
  } catch {
    return null;
  }
}

/* ─────────────── 전송 ─────────────── */

/**
 * 사용자의 모든 기기로 푸시를 보냅니다.
 * 404/410(구독 만료)은 자동으로 정리하고, 나머지 실패는 sent/failed 로만 셉니다.
 *
 * @param {string} userId
 * @param {object|string} payload 앱 서비스 워커가 받는 JSON ({title, body, url, tag})
 * @returns {Promise<{sent:number, pruned:number, failed:number, total:number, skipped:boolean}>}
 */
async function sendToUser(userId, payload, { logger = null, ttlSec = 2 * 24 * 60 * 60, timeoutMs = 10000 } = {}) {
  const subs = listSubscriptions(userId);
  if (!subs.length) return { sent: 0, pruned: 0, failed: 0, total: 0, skipped: true };

  const configured = configureVapid(logger);
  if (!configured.ok) {
    return { sent: 0, pruned: 0, failed: subs.length, total: subs.length, skipped: false, error: configured.error };
  }

  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const dead = new Set();
  let sent = 0;
  let failed = 0;

  for (const sub of subs) {
    try {
      // 모듈 객체의 메서드를 그때그때 호출합니다(테스트에서 sendNotification 을 바꿔 끼울 수 있게).
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.keys?.p256dh, auth: sub.keys?.auth } },
        body,
        { TTL: ttlSec, timeout: timeoutMs }
      );
      sent += 1;
    } catch (err) {
      const status = Number(err?.statusCode || err?.status || 0);
      if (status === 404 || status === 410) {
        dead.add(sub.endpoint);
      } else {
        failed += 1;
        logger?.warn?.(`푸시 전송 실패 (${status || 'unknown'}): ${err?.message || err}`);
      }
    }
  }

  if (dead.size) {
    await pruneSubscriptions(userId, dead);
    logger?.info?.(`만료된 푸시 구독 ${dead.size}개를 정리했습니다.`);
  }

  return { sent, pruned: dead.size, failed, total: subs.length, skipped: false };
}

const STATUS_MARK = { added: '✅', merged: '➕', planned: '•', skipped: '⏭', failed: '❌', pending: '•' };

/** 실행 요약 → 잠금화면에 보일 푸시 알림(제목·본문). */
function buildRunPushPayload(summary = {}, { nickname } = {}) {
  const added = Number(summary.added) || 0;
  const merged = Number(summary.merged) || 0;
  const failedCount = Number(summary.failed) || 0;
  const count = added + merged;

  let title;
  if (summary.error) title = '⚠️ 컬리 장바구니 · 확인이 필요해요';
  else if (failedCount > 0) title = `⚠️ 컬리 장바구니 · ${count}개 담음 / ${failedCount}개 실패`;
  else title = `🛒 컬리 장바구니에 ${count}개 상품을 담았어요`;

  const lines = [];
  const when = String(summary.ranAtLabel || '').trim();
  const trigger = summary.trigger === 'scheduled' ? '정기 실행' : '직접 실행';
  lines.push(when ? `${when} · ${trigger}` : trigger);
  if (summary.error) lines.push(String(summary.error));

  const items = Array.isArray(summary.items) ? summary.items : [];
  items.slice(0, 3).forEach((item) => {
    const mark = STATUS_MARK[item.status] || '•';
    const qty = item.quantity ? ` ×${item.quantity}` : '';
    const reason = item.reason ? ` — ${item.reason}` : '';
    lines.push(`${mark} ${item.name}${qty}${reason}`);
  });
  if (items.length > 3) lines.push(`… 외 ${items.length - 3}개`);
  if (typeof summary.cartTotalCount === 'number') lines.push(`장바구니 총 ${summary.cartTotalCount}건`);
  if (summary.estimatedTotal) lines.push(`예상 금액 ${Number(summary.estimatedTotal).toLocaleString('ko-KR')}원`);
  if (nickname) lines.push(`— ${nickname}님`);

  return {
    title,
    body: lines.join('\n').slice(0, 900),
    url: '/#run',
    tag: summary.id ? `kurly-run-${summary.id}` : 'kurly-run',
    data: { runId: summary.id || null, status: summary.status || null },
  };
}

/**
 * 실행 결과를 그 사용자의 모든 기기로 푸시합니다. (웹훅과 별개)
 * 미리보기(dryRun)에는 보내지 않습니다.
 */
async function notifyRun(summary, { userId, nickname } = {}, logger = null) {
  if (!userId || !summary || summary.dryRun) return null;
  try {
    const payload = buildRunPushPayload(summary, { nickname });
    const result = await sendToUser(userId, payload, { logger });
    if (logger && !result.skipped) {
      logger.info(
        `푸시 알림 ${result.sent}건 전송` +
          (result.pruned ? ` · 만료 구독 ${result.pruned}개 정리` : '') +
          (result.failed ? ` · 실패 ${result.failed}건` : '')
      );
    }
    return result;
  } catch (err) {
    logger?.warn?.(`푸시 알림 실패: ${err.message}`);
    return { sent: 0, pruned: 0, failed: 0, total: 0, skipped: false, error: err.message };
  }
}

/** 테스트에서 키 캐시를 비웁니다. */
function _resetCacheForTests() {
  cachedKeys = null;
  warnedPartialEnv = false;
}

module.exports = {
  MAX_SUBSCRIPTIONS_PER_USER,
  DEFAULT_SUBJECT,
  getVapidKeys,
  publicKey,
  configureVapid,
  vapidFilePath,
  sanitizeSubscription,
  listSubscriptions,
  findSubscription,
  subscribeUser,
  unsubscribeUser,
  pruneSubscriptions,
  sendToUser,
  buildRunPushPayload,
  notifyRun,
  _resetCacheForTests,
};
