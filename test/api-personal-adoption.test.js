'use strict';
/**
 * 개인용 모드에서 계정이 하나뿐인 배포는 그 계정을 이어서 씁니다.
 *  · 로그인 쿠키를 잃어도(브라우저를 바꾸거나 Railway 가 재시작) 기존 계획·컬리 연결이 그대로 남습니다.
 *  · 계정이 둘 이상이면(지인과 함께 쓰는 배포) 남의 계정을 붙이지 않고 'personal' 기본 계정을 따로 만듭니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { setupEnv, startServer, request, register } = require('./helpers');

setupEnv();
delete process.env.REQUIRE_AUTH;

let server;
test.before(async () => {
  server = await startServer();
});
test.after(async () => {
  await server.close();
});

test('저장된 계정이 하나뿐이면 쿠키 없이도 그 계정으로 이어진다(기본 상품 보충)', async () => {
  const only = await register(server.baseUrl, { nickname: '앰버', password: 'password123', loadStarter: false });
  assert.equal(only.status, 201);

  const fresh = await request(server.baseUrl, '/api/auth/session');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.user.userId, only.body.user.userId, '유일한 계정을 이어서 써야 합니다.');
  assert.equal(fresh.body.user.nickname, '앰버');
  assert.equal(fresh.body.plan.items.length, 8, '비어 있던 계획에는 기본 8개를 채웁니다.');
});

test('계정이 둘 이상이면 남의 계정 대신 personal 기본 계정을 만든다', async () => {
  const second = await register(server.baseUrl, { nickname: '지인', password: 'password123', loadStarter: false });
  assert.equal(second.status, 201);

  const fresh = await request(server.baseUrl, '/api/auth/session');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.user.userId, 'personal');
  assert.equal(fresh.body.user.nickname, '개인');
  assert.equal(fresh.body.plan.items.length, 8);
});
