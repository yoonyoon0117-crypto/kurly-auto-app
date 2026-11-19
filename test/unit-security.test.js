'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.APP_SECRET = 'unit-test-secret-abcdefghijklmnopqrstuvwxyz';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/kurly-unit-test-data';

const { sealJson, openJson } = require('../lib/crypto-box');
const { hashPassword, verifyPassword } = require('../lib/passwords');
const sessions = require('../lib/sessions');

test('AES-256-GCM 세션 봉투: 암호화 → 복호화 왕복', () => {
  const session = {
    cookies: [{ name: 'PCID', value: 'abc123', domain: '.kurly.com', path: '/', expires: 1765000000 }],
    origins: [{ origin: 'https://www.kurly.com', localStorage: [{ name: 'token', value: 'secret-token' }] }],
  };
  const sealed = sealJson(session);
  assert.equal(sealed.v, 1);
  assert.equal(sealed.alg, 'aes-256-gcm');
  assert.ok(sealed.iv && sealed.tag && sealed.data);

  // 평문이 그대로 보이지 않아야 합니다.
  const raw = Buffer.from(sealed.data, 'base64').toString('utf8');
  assert.ok(!raw.includes('secret-token'));

  const opened = openJson(sealed);
  assert.deepEqual(opened, session);

  // 두 번 암호화하면 IV 가 달라 다른 암호문이 됩니다.
  assert.notEqual(sealJson(session).data, sealed.data);
});

test('AES-256-GCM: 변조·다른 키는 복호화 실패', () => {
  const sealed = sealJson({ cookies: [{ name: 'a', value: 'b' }] });
  const tampered = { ...sealed, data: Buffer.from('tampered-data').toString('base64') };
  assert.throws(() => openJson(tampered), /복호화하지 못했습니다/);

  const badTag = { ...sealed, tag: Buffer.alloc(16, 1).toString('base64') };
  assert.throws(() => openJson(badTag), /복호화하지 못했습니다/);

  assert.throws(() => openJson(sealed, 'another-secret-value-1234567890'), /복호화하지 못했습니다/);
  assert.throws(() => openJson(null), /암호화된 데이터가 없습니다/);
});

test('비밀번호: scrypt + 사용자별 salt', () => {
  const a = hashPassword('password123');
  const b = hashPassword('password123');
  assert.notEqual(a, b, 'salt 가 달라 같은 비밀번호도 다른 해시여야 합니다.');
  assert.match(a, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(verifyPassword('password123', a), true);
  assert.equal(verifyPassword('password124', a), false);
  assert.equal(verifyPassword('password123', 'not-a-hash'), false);
  assert.equal(verifyPassword('', a), false);
});

test('세션 쿠키: HMAC 서명 · 만료 · 변조 검증', () => {
  const userId = 'abcdefgh12345678';
  const { token, payload } = sessions.issue(userId);
  assert.equal(payload.u, userId);
  assert.ok(token.includes('.'));

  const verified = sessions.verifyToken(token);
  assert.equal(verified.userId, userId);

  // 서명 변조
  const [body, sig] = token.split('.');
  const flipped = `${body}.${sig.slice(0, -2)}${sig.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
  assert.equal(sessions.verifyToken(flipped), null);

  // 본문 변조 (다른 사용자로)
  const forgedBody = Buffer.from(JSON.stringify({ u: 'attacker0000000', iat: Date.now(), exp: Date.now() + 1000 }))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(sessions.verifyToken(`${forgedBody}.${sig}`), null);

  // 만료
  const expired = sessions.issue(userId, Date.now() - 40 * 24 * 3600 * 1000);
  assert.equal(sessions.verifyToken(expired.token), null);

  // 엉터리 값
  assert.equal(sessions.verifyToken(''), null);
  assert.equal(sessions.verifyToken('a.b.c'), null);
  assert.equal(sessions.verifyToken(crypto.randomBytes(20).toString('hex')), null);

  // 30일 이내 → 연장 필요 없음, 7일 미만 → 연장
  assert.equal(sessions.needsRefresh(payload), false);
  const old = sessions.issue(userId, Date.now() - 25 * 24 * 3600 * 1000);
  assert.equal(sessions.needsRefresh(sessions.verifyToken(old.token)), true);
});
