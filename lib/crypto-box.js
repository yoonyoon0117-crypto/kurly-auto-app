'use strict';
/**
 * 암호화 도우미 — 컬리 로그인 세션(storageState)을 AES-256-GCM 으로 감쌉니다.
 *
 * 키는 APP_SECRET 에서 scrypt 로 유도합니다(고정 salt, 버전 접두어).
 *  · 암호문에는 IV(12바이트) · 인증태그 · 본문이 함께 들어가고, 복호화 시 변조되면 실패합니다.
 *  · APP_SECRET 을 바꾸면 기존에 저장된 컬리 세션은 복호화되지 않습니다(다시 연결 필요).
 */
const crypto = require('crypto');

const VERSION = 1;
const SALT = 'kurly-auto-app/session-key/v1';

function appSecret() {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('APP_SECRET 이 설정되어 있지 않거나 너무 짧습니다(16자 이상).');
  }
  return secret;
}

const keyCache = new Map();
function deriveKey(secret = appSecret()) {
  if (keyCache.has(secret)) return keyCache.get(secret);
  const key = crypto.scryptSync(secret, SALT, 32);
  keyCache.set(secret, key);
  return key;
}

/** 임의의 JSON 직렬화 가능한 값을 암호화합니다. */
function sealJson(value, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: VERSION,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: body.toString('base64'),
  };
}

/** sealJson 으로 만든 봉투를 복호화합니다. 실패하면 Error 를 던집니다. */
function openJson(envelope, secret) {
  if (!envelope || typeof envelope !== 'object') throw new Error('암호화된 데이터가 없습니다.');
  if (envelope.v !== VERSION || envelope.alg !== 'aes-256-gcm') {
    throw new Error('지원하지 않는 암호화 형식입니다.');
  }
  const key = deriveKey(secret);
  const iv = Buffer.from(String(envelope.iv), 'base64');
  const tag = Buffer.from(String(envelope.tag), 'base64');
  const data = Buffer.from(String(envelope.data), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch (err) {
    throw new Error('저장된 세션을 복호화하지 못했습니다(변조되었거나 APP_SECRET 이 바뀌었습니다).');
  }
}

module.exports = { sealJson, openJson, deriveKey, VERSION };
