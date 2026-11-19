'use strict';
/**
 * 컬리 세션 직접 가져오기 — 붙여넣은 글/업로드한 파일을 Playwright storageState 로 바꿉니다.
 *
 * 왜 필요한가:
 *   클라우드(Railway 등) 서버 IP 에서는 컬리 로그인에 붙은 구글 reCAPTCHA 가 봇으로 판단해
 *   비밀번호가 맞아도 로그인을 거부합니다(HTTP 422 · S001 / 401 · S012).
 *   이때 사용자가 이미 로그인된 자기 브라우저(또는 로컬 kurly-auto-cart)의 세션을 그대로 옮겨오면
 *   로그인 화면을 거치지 않고 담기를 할 수 있습니다.
 *
 * 2026-11-19 실제 컬리 응답 헤더로 확인한 세션 구조:
 *   set-cookie: ksi=…; Domain=kurly.com; Path=/; Max-Age=18000;      Secure; HttpOnly; SameSite=None
 *   set-cookie: krt=…; Domain=kurly.com; Path=/; Max-Age=21600;      Secure; HttpOnly; SameSite=None
 *   set-cookie: kdi=…; Domain=kurly.com; Path=/; Max-Age=315360000;  Secure; HttpOnly; SameSite=None
 *   → 로그인 세션은 **HttpOnly 쿠키**(ksi·krt)에 있습니다. 그래서 주소창에서 쓰는
 *     `document.cookie` 로는 복사할 수 없고, 개발자도구 Network 탭의 `Cookie:` 요청 헤더나
 *     storageState JSON 파일이 필요합니다. (ksi 없이 붙여넣으면 경고를 돌려줍니다)
 *
 * 지원 입력:
 *   1. Playwright storageState JSON      { "cookies": [...], "origins": [...] }
 *   2. 쿠키 배열 JSON                    [ { "name": "ksi", "value": "..." }, ... ]
 *   3. `Cookie:` 요청 헤더 문자열        ksi=…; krt=…; kdi=…
 *   4. 요청 헤더 블록 전체 붙여넣기       (여러 줄 중 `cookie:` 줄만 사용)
 */

const KURLY_COOKIE_DOMAIN = '.kurly.com';
const KURLY_WEB_HOST = 'www.kurly.com';
/** 컬리 로그인 세션을 담는 HttpOnly 쿠키 (2026-11-19 실측) */
const SESSION_COOKIE_NAMES = ['ksi', 'krt'];
const MAX_INPUT_CHARS = 400 * 1024;
const COOKIE_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const MISSING_SESSION_WARNING =
  '컬리 로그인 세션 쿠키(ksi·krt)가 보이지 않습니다. 브라우저 주소창의 document.cookie 에는 ' +
  'HttpOnly 쿠키가 빠지므로, 개발자도구 Network 탭에서 요청 하나를 고른 뒤 `Cookie:` 요청 헤더 전체를 ' +
  '복사하거나 storageState JSON(kurly-state.json / storage-state.json)을 올려 주세요.';

class SessionImportError extends Error {
  constructor(message, code = 'SESSION_IMPORT_INVALID') {
    super(message);
    this.name = 'SessionImportError';
    this.code = code;
  }
}

/* ─────────────── 도우미 ─────────────── */

function isKurlyHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\.+/, '');
  return h === 'kurly.com' || h.endsWith('.kurly.com');
}

/** 만료 시각을 Playwright 규격(초 단위, 세션 쿠키는 -1)으로 바꿉니다. */
function normalizeExpires(value) {
  if (value === undefined || value === null || value === '') return -1;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return -1;
    return Math.floor(n > 1e12 ? n / 1000 : n); // 밀리초로 준 값도 받아줍니다.
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : -1;
}

function normalizeSameSite(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'lax') return 'Lax';
  if (v === 'none') return 'None';
  // 컬리는 SameSite=None 으로 내려줍니다. 값이 없거나 낯설면 그에 맞춥니다.
  return 'None';
}

/**
 * 쿠키 1개를 Playwright storageState 형식으로 정규화합니다.
 * 컬리(kurly.com)와 무관한 쿠키나 이름이 없는 항목은 null 로 버립니다.
 */
function normalizeCookie(input) {
  if (!input || typeof input !== 'object') return null;
  const name = String(input.name ?? '').trim();
  if (!name || !COOKIE_TOKEN_RE.test(name)) return null;

  let domain = String(input.domain ?? '').trim();
  if (!domain) domain = KURLY_COOKIE_DOMAIN;
  const bare = domain.replace(/^\.+/, '').toLowerCase();
  if (!isKurlyHost(bare)) return null;
  // 컬리는 Domain=kurly.com 으로 내려주므로 www/상위 표기는 하나로 모읍니다.
  domain = bare === 'kurly.com' || bare === KURLY_WEB_HOST ? KURLY_COOKIE_DOMAIN : `.${bare}`;

  const path = typeof input.path === 'string' && input.path.startsWith('/') ? input.path : '/';

  return {
    name,
    value: input.value === undefined || input.value === null ? '' : String(input.value),
    domain,
    path,
    expires: normalizeExpires(input.expires),
    httpOnly: input.httpOnly === false ? false : true,
    secure: input.secure === false ? false : true,
    sameSite: normalizeSameSite(input.sameSite),
  };
}

/** `name=value; name2=value2` 형태 문자열을 쿠키 목록으로 바꿉니다. */
function parseCookieHeader(text) {
  const cookies = [];
  for (const chunk of String(text || '').split(/[;\r\n]+/)) {
    const part = chunk.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (name.startsWith('$')) continue; // RFC 6265 의 $Version 등 속성 표기
    if (/^https?$/i.test(name) && value.startsWith('//')) continue; // URL 줄
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    cookies.push(
      normalizeCookie({ name, value, domain: KURLY_COOKIE_DOMAIN, path: '/', secure: true, httpOnly: true, sameSite: 'None' })
    );
  }
  return cookies.filter(Boolean);
}

/** 요청 헤더 블록에서 `cookie:` 줄만 뽑습니다. */
function extractCookieHeader(text) {
  const picks = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*cookie\s*:\s*(.*)$/i);
    if (match) picks.push(match[1].trim());
  }
  if (picks.length) return picks.join('; ');
  return String(text || '').replace(/^\s*cookie\s*:\s*/i, '');
}

/** storageState 의 origins(localStorage) 중 컬리 것만 남깁니다. */
function normalizeOrigins(origins) {
  if (!Array.isArray(origins)) return [];
  const out = [];
  for (const entry of origins) {
    if (!entry || typeof entry.origin !== 'string') continue;
    let host = '';
    try {
      host = new URL(entry.origin).host;
    } catch {
      continue;
    }
    if (!isKurlyHost(host)) continue;
    const items = Array.isArray(entry.localStorage) ? entry.localStorage : [];
    out.push({
      origin: entry.origin,
      localStorage: items
        .filter((item) => item && typeof item.name === 'string' && item.name && !item.name.startsWith('$'))
        .map((item) => ({ name: item.name, value: String(item.value ?? '') })),
    });
  }
  return out;
}

function buildResult(cookies, origins, source) {
  // 같은 이름·도메인이 여러 번 오면 마지막 값을 씁니다(헤더/JSON 뒤쪽이 최신).
  const byKey = new Map();
  for (const cookie of cookies) {
    if (cookie) byKey.set(`${cookie.domain}|${cookie.name}`, cookie);
  }
  const normalized = [...byKey.values()];
  if (!normalized.length) {
    throw new SessionImportError(
      '컬리(kurly.com) 쿠키를 찾지 못했습니다. 컬리에 로그인된 브라우저에서 복사했는지 확인해 주세요.'
    );
  }

  const cookieNames = [...new Set(normalized.map((c) => c.name))];
  const lower = new Set(cookieNames.map((n) => n.toLowerCase()));
  const missingSessionCookies = !SESSION_COOKIE_NAMES.some((n) => lower.has(n));
  const warnings = missingSessionCookies ? [MISSING_SESSION_WARNING] : [];

  return {
    storageState: { cookies: normalized, origins },
    source,
    cookieNames,
    missingSessionCookies,
    warnings,
  };
}

/* ─────────────── 공개 API ─────────────── */

/**
 * 붙여넣은 글/업로드 파일/이미 파싱된 객체를 storageState 로 바꿉니다.
 * @param {string|object} raw
 * @returns {{storageState:{cookies:Array,origins:Array}, source:string, cookieNames:string[], missingSessionCookies:boolean, warnings:string[]}}
 */
function parseSessionInput(raw) {
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.cookies)) return buildResult(raw.cookies.map(normalizeCookie), normalizeOrigins(raw.origins), 'storageState');
    if (Array.isArray(raw)) return buildResult(raw.map(normalizeCookie), [], 'cookie-list');
    throw new SessionImportError('세션 JSON 에 cookies 배열이 없습니다. storageState JSON 이나 Cookie 헤더를 넣어 주세요.');
  }

  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) {
    throw new SessionImportError(
      '가져올 세션이 비어 있습니다. `Cookie:` 요청 헤더를 붙여넣거나 storageState JSON 파일을 올려 주세요.'
    );
  }
  if (text.length > MAX_INPUT_CHARS) {
    throw new SessionImportError('세션 정보가 너무 큽니다(400KB 이하). 필요한 쿠키만 붙여넣어 주세요.');
  }

  const looksJson = text.startsWith('{') || text.startsWith('[');
  if (looksJson) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SessionImportError(
        'JSON 형식이 올바르지 않습니다. storageState 파일 내용 전체를 그대로 붙여넣거나, Cookie 헤더 문자열을 넣어 주세요.'
      );
    }
    return parseSessionInput(parsed);
  }

  const header = extractCookieHeader(text);
  const cookies = parseCookieHeader(header);
  if (!cookies.length) {
    throw new SessionImportError(
      'name=value 형태의 쿠키를 찾지 못했습니다. 개발자도구 Network 탭의 `Cookie:` 요청 헤더를 통째로 복사하거나 storageState JSON 파일을 올려 주세요.'
    );
  }
  return buildResult(cookies, [], 'cookie-header');
}

module.exports = {
  KURLY_COOKIE_DOMAIN,
  SESSION_COOKIE_NAMES,
  MISSING_SESSION_WARNING,
  SessionImportError,
  parseSessionInput,
  parseCookieHeader,
  normalizeCookie,
  normalizeExpires,
  isKurlyHost,
  extractCookieHeader,
};
