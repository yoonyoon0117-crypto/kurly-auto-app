'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { setupEnv, startServer, request, register } = require('./helpers');

setupEnv();

let server;
test.before(async () => {
  server = await startServer();
});
test.after(async () => {
  await server.close();
});

test('실제 컬리 검색 API — /api/search 가 살아 있는 상품을 돌려준다', async (t) => {
  const user = await register(server.baseUrl, { nickname: '검색', password: 'password123' });
  let res;
  try {
    res = await request(server.baseUrl, '/api/search?q=' + encodeURIComponent('유정란 15구'), { cookie: user.cookie });
  } catch (err) {
    t.skip(`네트워크에 접근할 수 없어 건너뜁니다: ${err.message}`);
    return;
  }
  if (res.status === 502) {
    t.skip(`컬리 API 응답 없음: ${res.body?.error}`);
    return;
  }
  assert.equal(res.status, 200);
  assert.equal(res.body.keyword, '유정란 15구');
  assert.ok(Array.isArray(res.body.products));
  assert.ok(res.body.products.length > 0, '검색 결과가 있어야 합니다.');
  const first = res.body.products[0];
  assert.ok(first.no > 0);
  assert.equal(typeof first.name, 'string');
  assert.ok(first.name.length > 0);
  assert.ok(first.price > 0);
  assert.match(first.url, /^https:\/\/www\.kurly\.com\/goods\//);
  t.diagnostic(`검색 결과 ${res.body.products.length}개 · 첫 상품: ${first.name} (${first.price}원)`);
});

test('실제 컬리 상품 상세 — 단위·옵션·품절 여부 파싱', async (t) => {
  const user = await register(server.baseUrl, { nickname: '상세', password: 'password123' });
  let res;
  try {
    res = await request(server.baseUrl, '/api/product?no=5029849', { cookie: user.cookie });
  } catch (err) {
    t.skip(`네트워크에 접근할 수 없어 건너뜁니다: ${err.message}`);
    return;
  }
  if (res.status === 502) {
    t.skip(`컬리 API 응답 없음: ${res.body?.error}`);
    return;
  }
  assert.equal(res.status, 200);
  const p = res.body.product;
  assert.equal(p.no, 5029849);
  assert.match(p.name, /유정란/);
  assert.ok(p.price > 0);
  assert.ok(p.unitSuggestion, '단위 추정값이 있어야 합니다.');
  assert.equal(p.unitSuggestion.unitSize, 15);
  assert.equal(p.unitSuggestion.unitLabel, '구');
  t.diagnostic(`상품: ${p.name} · ${p.price}원 · ${p.volume}`);
});

test('검색어 검증 — 빈 검색어/너무 긴 검색어는 400', async () => {
  const user = await register(server.baseUrl, { nickname: '검증', password: 'password123' });
  const empty = await request(server.baseUrl, '/api/search?q=', { cookie: user.cookie });
  assert.equal(empty.status, 400);
  const long = await request(server.baseUrl, '/api/search?q=' + 'ㄱ'.repeat(70), { cookie: user.cookie });
  assert.equal(long.status, 400);
});
