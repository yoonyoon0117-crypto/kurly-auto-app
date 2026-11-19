'use strict';
/**
 * 세션 직접 가져오기 — 입력 해석 단위 테스트 (브라우저·네트워크 불필요)
 *
 * 2026-11-19 실제 컬리 응답 헤더(ksi·krt·kdi, HttpOnly)를 기준으로 확인합니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSessionInput,
  parseCookieHeader,
  normalizeCookie,
  normalizeExpires,
  isKurlyHost,
  extractCookieHeader,
  SESSION_COOKIE_NAMES,
} = require('../lib/session-import');

const STORAGE_STATE = {
  cookies: [
    { name: 'ksi', value: 'AAA111', domain: '.kurly.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' },
    { name: 'krt', value: 'BBB222', domain: 'kurly.com', path: '/', expires: 1893456000, httpOnly: true, secure: true, sameSite: 'None' },
    { name: 'kdi', value: 'CCC333', domain: 'www.kurly.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' },
    { name: 'NID_AUT', value: 'naver', domain: '.naver.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' },
  ],
  origins: [
    { origin: 'https://www.kurly.com', localStorage: [{ name: 'kurly.recent', value: '123' }] },
    { origin: 'https://accounts.google.com', localStorage: [{ name: 'token', value: 'secret' }] },
  ],
};

test('storageState JSON: 쿠키 도메인·경로·보안 속성을 정규화하고 컬리 외 쿠키는 버린다', () => {
  const result = parseSessionInput(JSON.stringify(STORAGE_STATE));
  assert.equal(result.source, 'storageState');
  assert.deepEqual(result.cookieNames, ['ksi', 'krt', 'kdi']);
  assert.equal(result.missingSessionCookies, false);
  assert.deepEqual(result.warnings, []);

  const cookies = result.storageState.cookies;
  assert.equal(cookies.length, 3, 'naver 쿠키는 가져오지 않아야 합니다.');
  for (const cookie of cookies) {
    assert.equal(cookie.domain, '.kurly.com');
    assert.equal(cookie.path, '/');
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'None');
    assert.equal(typeof cookie.expires, 'number');
  }
  assert.equal(cookies.find((c) => c.name === 'ksi').expires, -1);

  // 컬리 origin 만 남기고 구글 localStorage 는 가져오지 않습니다.
  assert.equal(result.storageState.origins.length, 1);
  assert.equal(result.storageState.origins[0].origin, 'https://www.kurly.com');
});

test('쿠키 배열만 있는 JSON 도 받는다', () => {
  const result = parseSessionInput(JSON.stringify([{ name: 'ksi', value: 'x' }, { name: 'krt', value: 'y' }]));
  assert.equal(result.source, 'cookie-list');
  assert.deepEqual(result.cookieNames, ['ksi', 'krt']);
  assert.equal(result.storageState.cookies[0].domain, '.kurly.com');
});

test('Cookie 헤더 문자열: 값에 = 가 들어 있어도 첫 = 에서만 나눈다', () => {
  const result = parseSessionInput('ksi=AAA=.BBB; krt=CCC==; kdi=DDD');
  assert.equal(result.source, 'cookie-header');
  assert.deepEqual(result.cookieNames, ['ksi', 'krt', 'kdi']);
  const ksi = result.storageState.cookies.find((c) => c.name === 'ksi');
  assert.equal(ksi.value, 'AAA=.BBB');
  assert.equal(result.missingSessionCookies, false);
});

test('`Cookie:` 접두어가 붙은 한 줄도 받는다', () => {
  const result = parseSessionInput('Cookie: ksi=AAA; krt=BBB');
  assert.deepEqual(result.cookieNames, ['ksi', 'krt']);
  assert.equal(result.source, 'cookie-header');
});

test('개발자도구 요청 헤더 블록 전체를 붙여넣어도 cookie 줄만 읽는다', () => {
  const block = [
    'GET /main HTTP/2',
    'Host: www.kurly.com',
    'User-Agent: Mozilla/5.0',
    'Cookie: ksi=AAA; krt=BBB; kdi=CCC',
    'Accept: text/html',
  ].join('\n');
  const result = parseSessionInput(block);
  assert.deepEqual(result.cookieNames, ['ksi', 'krt', 'kdi']);
  assert.equal(result.storageState.cookies.find((c) => c.name === 'krt').value, 'BBB');
});

test('HttpOnly 세션 쿠키(ksi·krt)가 없으면 경고를 함께 돌려준다 (document.cookie 복사 실패 안내)', () => {
  const result = parseSessionInput('AMP_TOKEN=abc; amplitudeBucket=xyz');
  assert.equal(result.missingSessionCookies, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /HttpOnly/);
  assert.match(result.warnings[0], /Network/);
  assert.ok(SESSION_COOKIE_NAMES.every((n) => result.warnings[0].includes(`${n}`) || result.warnings[0].includes(n)));
});

test('빈 입력·잘못된 JSON·쿠키 없는 글은 명확한 오류로 거부한다', () => {
  assert.throws(() => parseSessionInput('   '), /비어 있습니다/);
  assert.throws(() => parseSessionInput('{ "cookies": [ '), /JSON 형식/);
  assert.throws(() => parseSessionInput('그냥 문장입니다'), /name=value/);
  assert.throws(() => parseSessionInput({ foo: 'bar' }), /cookies 배열/);
  assert.throws(() => parseSessionInput('{}'), /cookies 배열/);
});

test('컬리가 아닌 도메인 쿠키만 있으면 거부한다', () => {
  const other = JSON.stringify({ cookies: [{ name: 'JSESSIONID', value: 'x', domain: 'example.com', path: '/' }] });
  assert.throws(() => parseSessionInput(other), /컬리\(kurly\.com\) 쿠키/);
});

test('너무 큰 입력은 거부한다', () => {
  const huge = `ksi=${'a'.repeat(420 * 1024)}`;
  assert.throws(() => parseSessionInput(huge), /너무 큽니다/);
});

test('쿠키 정규화 — 낯선 속성값은 안전한 기본값으로', () => {
  const cookie = normalizeCookie({ name: 'ksi', value: 'v', domain: 'auth.kurly.com', path: '/x', sameSite: 'weird', secure: false, httpOnly: false });
  assert.equal(cookie.domain, '.auth.kurly.com');
  assert.equal(cookie.path, '/x');
  assert.equal(cookie.sameSite, 'None');
  assert.equal(cookie.secure, false);
  assert.equal(cookie.httpOnly, false);
  assert.equal(cookie.expires, -1);
  assert.equal(normalizeCookie({ name: '' }), null);
  assert.equal(normalizeCookie({ name: 'bad name' }), null);
  assert.equal(normalizeCookie(null), null);
});

test('만료 시각 — 초·밀리초·ISO 문자열을 모두 초 단위로', () => {
  assert.equal(normalizeExpires(-1), -1);
  assert.equal(normalizeExpires(null), -1);
  assert.equal(normalizeExpires(1893456000), 1893456000);
  assert.equal(normalizeExpires(1893456000000), 1893456000);
  assert.equal(normalizeExpires('1893456000'), 1893456000);
  assert.equal(normalizeExpires('2030-01-01T00:00:00Z'), 1893456000);
  assert.equal(normalizeExpires('이상한 값'), -1);
});

test('도우미 — 컬리 호스트 판별과 헤더 추출', () => {
  assert.equal(isKurlyHost('kurly.com'), true);
  assert.equal(isKurlyHost('.kurly.com'), true);
  assert.equal(isKurlyHost('www.kurly.com'), true);
  assert.equal(isKurlyHost('kurly.com.evil.com'), false);
  assert.equal(isKurlyHost('notkurly.com'), false);
  assert.equal(isKurlyHost(''), false);

  assert.equal(extractCookieHeader('cookie: a=1'), 'a=1');
  assert.equal(extractCookieHeader('KRT=1; ksi=2'), 'KRT=1; ksi=2');
  assert.deepEqual(
    parseCookieHeader('$Version=1; a=1; b="2"').map((c) => `${c.name}=${c.value}`),
    ['a=1', 'b=2']
  );
});
