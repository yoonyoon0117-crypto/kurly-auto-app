'use strict';
/**
 * 세션 쿠키 — HMAC-SHA256 으로 서명한 HttpOnly 쿠키.
 *   값 = base64url(JSON payload) + "." + base64url(HMAC)
 *   payload = { u: userId, iat, exp }
 * 서버에 세션 저장소가 없어도 되고, APP_SECRET 을 바꾸면 모든 세션이 무효가 됩니다.
 */
const crypto = require('crypto');

const COOKIE_NAME = 'kurly_sid';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일
const REFRESH_WHEN_LEFT_MS = 7 * 24 * 60 * 60 * 1000; // 남은 기간이 7일 미만이면 자동 연장

function secret() {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) throw new Error('APP_SECRET 이 설정되어 있지 않습니다.');
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', secret()).update(payloadB64).digest());
}

function issue(userId, nowMs = Date.now(), epoch = 1) {
  const payload = { u: userId, e: Number(epoch) || 1, iat: nowMs, exp: nowMs + TTL_MS };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return { token: `${payloadB64}.${sign(payloadB64)}`, payload, maxAgeSec: Math.floor(TTL_MS / 1000) };
}

/** @returns {{userId:string, exp:number}|null} */
function verifyToken(token, nowMs = Date.now()) {
  if (!token || typeof token !== 'string') return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  let expected;
  try {
    expected = sign(payloadB64);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.u !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp <= nowMs) return null;
  return { userId: payload.u, exp: payload.exp, epoch: Number(payload.e) || 0 };
}

function needsRefresh(payload, nowMs = Date.now()) {
  return Boolean(payload) && payload.exp - nowMs < REFRESH_WHEN_LEFT_MS;
}

module.exports = { COOKIE_NAME, TTL_MS, issue, verifyToken, needsRefresh };
