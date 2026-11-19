'use strict';
/**
 * 로그인 실패 원인 표시 — 순수 함수 단위 테스트
 * (Playwright 브라우저 없이 응답/모달 데이터만으로 문장이 만들어지는지 확인)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeLoginFailure, isLoginRelatedUrl, redactSecrets } = require('../lib/kurly-browser');

// 2026-11-19 실제 확인: 해외/클라우드 IP 에서 auth.kurly.com/v2/login 이 돌려준 응답 (HTTP 401)
const S012 = {
  url: 'https://auth.kurly.com/v2/login',
  status: 401,
  method: 'POST',
  errorCode: 'S012',
  title: '비정상적인 접근이 감지됐어요',
  message: '로그인을 위해 고객행복센터(1644-1107)로 문의해주세요.',
  captchaRequired: true,
  snippet: '{"errorCode":"S012","loginFailCount":1,"isCaptchaRequired":true}',
};

test('로그인 차단(S012): 실제 컬리 문구와 HTTP 상태·코드를 그대로 보여준다', () => {
  const result = summarizeLoginFailure({ responses: [S012] });
  assert.ok(result);
  assert.equal(result.code, 'LOGIN_BLOCKED');
  assert.equal(result.decisive, true);
  assert.match(result.message, /비정상적인 접근이 감지됐어요/);
  assert.match(result.message, /1644-1107/);
  assert.match(result.message, /HTTP 401 · S012/);
  assert.match(result.message, /클라우드·해외 서버/);
  assert.match(result.message, /보안문자\(captcha\)/);
});

test('로그인 차단(HTTP 403): 본문이 비어 있어도 상태 코드로 안내한다', () => {
  const result = summarizeLoginFailure({
    responses: [{ url: 'https://www.kurly.com/member/login', status: 403, snippet: null }],
  });
  assert.equal(result.code, 'LOGIN_BLOCKED');
  assert.match(result.message, /HTTP 403/);
  assert.match(result.message, /한국 인터넷/);
});

test('로그인 차단(HTTP 429): 요청 과다도 차단으로 안내한다', () => {
  const result = summarizeLoginFailure({ responses: [{ url: 'https://auth.kurly.com/v2/login', status: 429 }] });
  assert.equal(result.code, 'LOGIN_BLOCKED');
  assert.match(result.message, /HTTP 429/);
});

test('아이디·비밀번호 오류 응답: 컬리가 준 메시지를 그대로 쓴다', () => {
  const result = summarizeLoginFailure({
    responses: [
      {
        url: 'https://auth.kurly.com/v2/login',
        status: 401,
        errorCode: 'M001',
        message: '아이디 또는 비밀번호가 일치하지 않습니다.',
      },
    ],
  });
  assert.equal(result.code, 'LOGIN_REJECTED');
  assert.equal(result.decisive, true);
  assert.match(result.message, /아이디 또는 비밀번호가 일치하지 않습니다/);
  assert.match(result.message, /HTTP 401 · M001/);
});

test('보안 서비스(reCAPTCHA) 동반 거부(S001)에는 봇 판단 가능성을 함께 알린다', () => {
  // 2026-11-19 실제 확인: 헤드리스 브라우저에서 auth.kurly.com/v2/login 이 돌려준 응답
  const result = summarizeLoginFailure({
    responses: [
      {
        url: 'https://auth.kurly.com/v2/login',
        status: 422,
        errorCode: 'S001',
        message: '아이디 또는 비밀번호를 확인해주세요.',
        captchaRequired: true,
      },
    ],
  });
  assert.equal(result.code, 'LOGIN_REJECTED');
  assert.equal(result.decisive, true);
  assert.match(result.message, /HTTP 422 · S001/);
  assert.match(result.message, /reCAPTCHA/);
});

test('응답은 2xx 뿐이고 모달만 있을 때: 모달 문구를 보여준다', () => {
  const result = summarizeLoginFailure({
    responses: [{ url: 'https://auth.kurly.com/v2/login', status: 200 }],
    modals: ['  잠시 후  다시 시도해 주세요.  '],
  });
  assert.equal(result.code, 'LOGIN_FAILED');
  assert.equal(result.decisive, false);
  assert.match(result.message, /잠시 후 다시 시도해 주세요\./);
});

test('JS 알림(alert)만 있을 때: 알림 문구를 보여준다', () => {
  const result = summarizeLoginFailure({ dialogs: ['로그인 정보를 확인해 주세요.'] });
  assert.equal(result.code, 'LOGIN_DIALOG');
  assert.match(result.message, /로그인 정보를 확인해 주세요\./);
});

test('단서가 전혀 없으면 null (기존 일반 문구 유지)', () => {
  assert.equal(summarizeLoginFailure({}), null);
  assert.equal(summarizeLoginFailure({ responses: [{ status: 200 }], modals: [], dialogs: [] }), null);
});

test('비밀번호는 응답 본문 스니펫에서도 가린다', () => {
  const secret = 'MySecretPw123!';
  assert.equal(redactSecrets(`{"id":"abc","password":"${secret}"}`, [secret]), '{"id":"abc","password":"***"}');
  assert.equal(redactSecrets('짧은 값 유지', ['ab']), '짧은 값 유지');
});

test('원인 수집 대상 URL: 인증/로그인 관련만 (장바구니 응답은 제외)', () => {
  assert.equal(isLoginRelatedUrl('https://auth.kurly.com/v2/login'), true);
  assert.equal(isLoginRelatedUrl('https://www.kurly.com/member/login'), true);
  assert.equal(isLoginRelatedUrl('https://api.kurly.com/member/v1/profile?token=1'), true);
  assert.equal(isLoginRelatedUrl('https://api.kurly.com/external-cart/v2/refresh'), false);
  assert.equal(isLoginRelatedUrl('https://www.kurly.com/goods/5029849'), false);
  assert.equal(isLoginRelatedUrl('https://example.com/login'), false);
  assert.equal(isLoginRelatedUrl('not-a-url'), false);
});
