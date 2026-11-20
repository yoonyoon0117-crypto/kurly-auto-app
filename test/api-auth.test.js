'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { setupEnv, startServer, request, register } = require('./helpers');

setupEnv();

let server;
test.before(async () => {
  server = await startServer();
});
test.after(async () => {
  await server.close();
});

test('공개 엔드포인트: 상태 확인과 앱 설정', async () => {
  const health = await request(server.baseUrl, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.service, 'kurly-auto-app');

  const config = await request(server.baseUrl, '/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.inviteRequired, true);
  assert.equal(config.body.registrationOpen, true);
});

test('회원가입: 잘못된 초대 코드·형식 오류는 거부', async () => {
  const wrong = await request(server.baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { inviteCode: 'NOPE', nickname: '테스터', password: 'password123' },
  });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.error, /초대 코드/);

  const shortPw = await register(server.baseUrl, { nickname: '짧은비번', password: '123' });
  assert.equal(shortPw.status, 400);
  assert.match(shortPw.body.error, /6자/);

  const badNick = await register(server.baseUrl, { nickname: 'a', password: 'password123' });
  assert.equal(badNick.status, 400);
  assert.match(badNick.body.error, /닉네임/);

  const spaceNick = await register(server.baseUrl, { nickname: '앰 버', password: 'password123' });
  assert.equal(spaceNick.status, 400);
});

test('회원가입 성공: HttpOnly 세션 쿠키 + 사용자별 파일 + 기본 4개 상품', async () => {
  const res = await register(server.baseUrl, { nickname: '앰버', password: 'password123', loadStarter: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.user.nickname, '앰버');
  assert.ok(!('password' in res.body.user), '사용자 응답에 비밀번호 해시가 없어야 합니다.');
  assert.equal(res.body.plan.items.length, 4);
  assert.equal(res.body.plan.items[0].quantity, 1);

  const setCookie = res.setCookies.join('; ');
  assert.match(setCookie, /kurly_sid=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=/);

  const userId = res.body.user.userId;
  const userFile = path.join(server.dataDir, 'users', `${userId}.json`);
  assert.ok(fs.existsSync(userFile), '사용자 파일이 DATA_DIR/users 안에 생겨야 합니다.');
  const stored = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  assert.match(stored.password, /^scrypt\$/);
  assert.ok(!JSON.stringify(stored).includes('password123'), '평문 비밀번호가 저장되면 안 됩니다.');
  assert.equal((fs.statSync(userFile).mode & 0o777).toString(8), '600');

  const index = JSON.parse(fs.readFileSync(path.join(server.dataDir, 'users-index.json'), 'utf8'));
  assert.ok(index.users.some((u) => u.userId === userId));

  // 세션으로 내 정보 조회
  const me = await request(server.baseUrl, '/api/auth/me', { cookie: res.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.userId, userId);
  assert.equal(me.body.plan.items.length, 4);
});

test('닉네임 중복(대소문자 무시)은 409', async () => {
  const first = await register(server.baseUrl, { nickname: 'Yuna', password: 'password123' });
  assert.equal(first.status, 201);
  const dup = await register(server.baseUrl, { nickname: 'yuna', password: 'password123' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /이미 사용 중/);
});

test('로그인: 틀린 비밀번호 401, 맞으면 새 세션', async () => {
  const created = await register(server.baseUrl, { nickname: '민준', password: 'password123' });
  assert.equal(created.status, 201);

  const wrong = await request(server.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { nickname: '민준', password: 'wrong-password' },
  });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error, /닉네임 또는 비밀번호/);

  const unknown = await request(server.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { nickname: '없는사람', password: 'password123' },
  });
  assert.equal(unknown.status, 401);

  const ok = await request(server.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { nickname: '민준', password: 'password123' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.nickname, '민준');
  assert.ok(ok.cookie.includes('kurly_sid='));
});

test('세션 없이·변조된 세션으로는 사용자 API 접근 불가', async () => {
  const noCookie = await request(server.baseUrl, '/api/plan');
  assert.equal(noCookie.status, 401);

  const bad = await request(server.baseUrl, '/api/plan', { cookie: 'kurly_sid=forged.token' });
  assert.equal(bad.status, 401);

  const res = await register(server.baseUrl, { nickname: '해커', password: 'password123' });
  const tampered = `${res.cookie.slice(0, -4)}AAAA`;
  const withTampered = await request(server.baseUrl, '/api/plan', { cookie: tampered });
  assert.equal(withTampered.status, 401);

  const search = await request(server.baseUrl, '/api/search?q=사과');
  assert.equal(search.status, 401);
});

test('로그아웃하면 세션 쿠키가 지워지고 다시 401', async () => {
  const res = await register(server.baseUrl, { nickname: '지우', password: 'password123' });
  const out = await request(server.baseUrl, '/api/auth/logout', { method: 'POST', cookie: res.cookie, body: {} });
  assert.equal(out.status, 200);
  assert.match(out.setCookies.join(';'), /Max-Age=0/);

  const me = await request(server.baseUrl, '/api/auth/me', { cookie: res.cookie });
  // 서버가 sessionEpoch 를 올려 이전 쿠키도 완전히 무효화합니다.
  assert.equal(me.status, 401);
});

test('계획 저장: 검증 실패는 400, 성공하면 다음 실행일이 계산된다', async () => {
  const res = await register(server.baseUrl, { nickname: '계획러', password: 'password123', loadStarter: false });
  assert.equal(res.status, 201);
  assert.equal(res.body.plan.items.length, 0);

  const invalid = await request(server.baseUrl, '/api/plan', {
    method: 'POST',
    cookie: res.cookie,
    body: { items: [{ productNo: 1, name: '이름없음상품', unitSize: 0, consumption: 1 }] },
  });
  assert.equal(invalid.status, 400);

  const valid = await request(server.baseUrl, '/api/plan', {
    method: 'POST',
    cookie: res.cookie,
    body: {
      items: [
        {
          productNo: 5029849,
          dealProductNo: 10029849,
          name: "[Kurly's] 동물복지 유정란 15구",
          price: 8290,
          unitSize: 15,
          unitLabel: '구',
          consumption: 30,
        },
      ],
      schedule: { enabled: true, weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2030-01-04' },
      notification: { webhookUrl: '', webhookType: 'auto' },
    },
  });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.plan.items.length, 1);
  assert.equal(valid.body.plan.items[0].quantity, 2);
  assert.equal(valid.body.plan.summary.nextRunLabel, '2030-01-04 (금) 21:00');
  assert.equal(valid.body.plan.summary.estimatedTotal, 8290 * 2);

  const read = await request(server.baseUrl, '/api/plan', { cookie: res.cookie });
  assert.equal(read.status, 200);
  assert.equal(read.body.plan.items[0].name, "[Kurly's] 동물복지 유정란 15구");

  // 파일에 실제로 남았는지
  const userFile = path.join(server.dataDir, 'users', `${res.body.user.userId}.json`);
  const stored = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  assert.equal(stored.items.length, 1);
  assert.equal(stored.schedule.anchorDate, '2030-01-04');
});

test('다른 사이트에서 보낸 상태 변경 요청은 403 (CSRF 보조)', async () => {
  const res = await register(server.baseUrl, { nickname: '보안', password: 'password123' });
  const blocked = await request(server.baseUrl, '/api/plan', {
    method: 'POST',
    cookie: res.cookie,
    headers: { Origin: 'https://evil.example.com' },
    body: { items: [] },
  });
  assert.equal(blocked.status, 403);
});

test('기본 상품 다시 불러오기 — 중복은 늘지 않는다', async () => {
  const res = await register(server.baseUrl, { nickname: '기본상품', password: 'password123', loadStarter: true });
  assert.equal(res.body.plan.items.length, 4);
  const again = await request(server.baseUrl, '/api/items/starter', { method: 'POST', cookie: res.cookie, body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.body.added, 0);
  assert.equal(again.body.plan.items.length, 4);
});
