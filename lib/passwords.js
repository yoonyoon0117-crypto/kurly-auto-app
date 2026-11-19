'use strict';
/**
 * 비밀번호 해시 — Node 내장 crypto.scryptSync + 사용자별 salt.
 * 저장 형식: scrypt$N$r$p$<saltBase64>$<hashBase64>
 */
const crypto = require('crypto');

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptHash(password, salt, params = PARAMS) {
  return crypto.scryptSync(String(password), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r * 2,
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = scryptHash(password, salt);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const params = { N: Number(n), r: Number(r), p: Number(p), keylen: Buffer.from(hashB64, 'base64').length };
  if (!params.N || !params.r || !params.p || !params.keylen) return false;
  let candidate;
  try {
    candidate = scryptHash(password, Buffer.from(saltB64, 'base64'), params);
  } catch {
    return false;
  }
  const expected = Buffer.from(hashB64, 'base64');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

module.exports = { hashPassword, verifyPassword, PARAMS };
