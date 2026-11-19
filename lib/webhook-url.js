'use strict';
/**
 * 웹훅 주소 안전 검사.
 * 서버가 사용자가 준 주소로 요청을 보내므로, 클라우드 메타데이터(169.254.169.254)나
 * 내부망 주소를 찌르는 SSRF 를 기본적으로 막습니다.
 *   → 사내/집에서 localhost·ntfy 를 쓰려면 WEBHOOK_ALLOW_PRIVATE=1
 */
const BLOCKED_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /^metadata\./i,
  /^metadata$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{0,2}:/i,
  /^\[?fe80:/i,
];

function allowPrivate() {
  return /^(1|true|yes|on)$/i.test(String(process.env.WEBHOOK_ALLOW_PRIVATE || ''));
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return BLOCKED_PATTERNS.some((re) => re.test(host));
}

/**
 * @param {string} url
 * @returns {{ok:true,url:string}|{ok:false,reason:string}}
 */
function checkWebhookUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return { ok: false, reason: '웹훅 주소가 비어 있습니다.' };
  if (raw.length > 500) return { ok: false, reason: '웹훅 주소가 너무 깁니다.' };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: '웹훅 주소 형식이 올바르지 않습니다.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '웹훅 주소는 http:// 또는 https:// 로 시작해야 합니다.' };
  }
  if (!allowPrivate() && isPrivateHost(parsed.hostname)) {
    return {
      ok: false,
      reason: '내부망·로컬 주소로는 알림을 보낼 수 없습니다. (직접 운영하는 서버라면 WEBHOOK_ALLOW_PRIVATE=1)',
    };
  }
  return { ok: true, url: raw };
}

module.exports = { checkWebhookUrl, isPrivateHost, allowPrivate };
