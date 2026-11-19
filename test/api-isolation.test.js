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

async function waitForIdle(cookie, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    const res = await request(server.baseUrl, '/api/status', { cookie });
    if (res.status === 200 && !res.body.queue.active) return res.body;
    if (Date.now() - started > timeoutMs) throw new Error('작업이 끝나지 않았습니다.');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const EGG = {
  productNo: 5029849,
  dealProductNo: 10029849,
  name: "[Kurly's] 동물복지 유정란 15구",
  price: 8290,
  unitSize: 15,
  unitLabel: '구',
  consumption: 30,
};

test('사용자별 데이터 격리: A 의 계획이 B 에게 보이지 않는다', async () => {
  const a = await register(server.baseUrl, { nickname: '에이', password: 'password123', loadStarter: false });
  const b = await register(server.baseUrl, { nickname: '비이', password: 'password123', loadStarter: false });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.user.userId, b.body.user.userId);

  const saved = await request(server.baseUrl, '/api/plan', {
    method: 'POST',
    cookie: a.cookie,
    body: {
      items: [EGG],
      schedule: { enabled: true, weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-11-20' },
      notification: { webhookUrl: '', webhookType: 'auto' },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.plan.items.length, 1);

  const bPlan = await request(server.baseUrl, '/api/plan', { cookie: b.cookie });
  assert.equal(bPlan.status, 200);
  assert.equal(bPlan.body.plan.items.length, 0, 'B 는 A 의 상품을 볼 수 없습니다.');
  assert.equal(bPlan.body.plan.summary.activeCount, 0);

  // B 가 자기 계획을 저장해도 A 에게 영향이 없습니다.
  await request(server.baseUrl, '/api/plan', {
    method: 'POST',
    cookie: b.cookie,
    body: {
      items: [{ ...EGG, productNo: 5061259, name: '고랭지 햇사과 1.3kg', unitSize: 1.3, unitLabel: 'kg', consumption: 2.6 }],
      schedule: { enabled: false, weekday: 3, time: '10:00', intervalWeeks: 1, anchorDate: '2026-11-25' },
      notification: { webhookUrl: '', webhookType: 'auto' },
    },
  });

  const aAgain = await request(server.baseUrl, '/api/plan', { cookie: a.cookie });
  assert.equal(aAgain.body.plan.items.length, 1);
  assert.equal(aAgain.body.plan.items[0].name, EGG.name);
  assert.equal(aAgain.body.plan.schedule.intervalWeeks, 2, 'A 의 일정은 그대로여야 합니다.');

  // 파일도 완전히 분리
  const dir = path.join(server.dataDir, 'users');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 2);
  const aFile = fs.readFileSync(path.join(dir, `${a.body.user.userId}.json`), 'utf8');
  const bFile = fs.readFileSync(path.join(dir, `${b.body.user.userId}.json`), 'utf8');
  assert.ok(aFile.includes('유정란'));
  assert.ok(!bFile.includes('유정란'));
  assert.ok(!aFile.includes('햇사과'));
  assert.ok(!bFile.includes('password123'));
});

test('남의 실행 기록은 보이지 않는다 (실패한 실행도 본인 기록에만)', async () => {
  const a = await register(server.baseUrl, { nickname: '실행에이', password: 'password123', loadStarter: true });
  const b = await register(server.baseUrl, { nickname: '실행비이', password: 'password123', loadStarter: true });

  // A 가 바로 담기 실행 → 컬리 연결이 없으므로 실패 기록이 남습니다(브라우저는 열지 않음)
  const started = await request(server.baseUrl, '/api/cart/run-now', { method: 'POST', cookie: a.cookie, body: {} });
  assert.equal(started.status, 202);
  assert.ok(started.body.job.id.startsWith('job_'));

  const status = await waitForIdle(a.cookie);
  assert.equal(status.queue.active, null);
  assert.ok(status.lastRun, 'A 의 마지막 실행 기록이 있어야 합니다.');
  assert.equal(status.lastRun.status, 'failed');
  assert.match(status.lastRun.error, /컬리 계정 연결이 필요합니다/);

  const aRuns = await request(server.baseUrl, '/api/runs', { cookie: a.cookie });
  assert.equal(aRuns.status, 200);
  assert.equal(aRuns.body.runs.length, 1);
  assert.equal(aRuns.body.stats.runs, 1);

  const bRuns = await request(server.baseUrl, '/api/runs', { cookie: b.cookie });
  assert.equal(bRuns.body.runs.length, 0, 'B 는 A 의 실행 기록을 볼 수 없습니다.');

  // B 는 자기 기록만 1건
  const bStart = await request(server.baseUrl, '/api/cart/run-now', { method: 'POST', cookie: b.cookie, body: {} });
  assert.equal(bStart.status, 202);
  await waitForIdle(b.cookie);
  const bAfter = await request(server.baseUrl, '/api/runs', { cookie: b.cookie });
  assert.equal(bAfter.body.runs.length, 1);
  assert.equal(bAfter.body.runs[0].trigger, 'manual');

  const aAfter = await request(server.baseUrl, '/api/runs', { cookie: a.cookie });
  assert.equal(aAfter.body.runs.length, 1);
});

test('실행 중복 요청은 409 로 막힌다', async () => {
  const a = await register(server.baseUrl, { nickname: '중복', password: 'password123', loadStarter: true });
  const queue = server.app.queue;
  const originalHandler = queue.handler;
  // 실행 중인 작업을 흨내하기 위해 핸들러를 잠시 느리게 만듭니다.
  queue.handler = () => new Promise((resolve) => setTimeout(resolve, 300));
  try {
    const blocker = queue.enqueue({ type: 'run', userId: a.body.user.userId, trigger: 'manual', dedupeKey: 'test-blocker' });
    const busy = await request(server.baseUrl, '/api/cart/run-now', { method: 'POST', cookie: a.cookie, body: {} });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.job.id, blocker.id);
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    queue.handler = originalHandler;
  }
  await waitForIdle(a.cookie);
});

test('컬리 연결 상태 조회 / 연결 없이 해제 요청은 안전하게 처리', async () => {
  const a = await register(server.baseUrl, { nickname: '상태', password: 'password123', loadStarter: false });
  const status = await request(server.baseUrl, '/api/kurly/status', { cookie: a.cookie });
  assert.equal(status.status, 200);
  assert.equal(status.body.kurly.status, 'disconnected');
  assert.equal(status.body.kurly.hasSession, false);

  const verify = await request(server.baseUrl, '/api/kurly/verify', { method: 'POST', cookie: a.cookie, body: {} });
  assert.equal(verify.status, 400);

  const disconnect = await request(server.baseUrl, '/api/kurly/disconnect', { method: 'POST', cookie: a.cookie, body: {} });
  assert.equal(disconnect.status, 200);
  assert.equal(disconnect.body.kurly.status, 'disconnected');

  const badConnect = await request(server.baseUrl, '/api/kurly/connect', {
    method: 'POST',
    cookie: a.cookie,
    body: { kurlyId: '', kurlyPassword: '' },
  });
  assert.equal(badConnect.status, 400);
});

test('미리보기는 아무것도 담지 않고 계산만 한다', async () => {
  const a = await register(server.baseUrl, { nickname: '미리보기', password: 'password123', loadStarter: true });
  const preview = await request(server.baseUrl, '/api/cart/preview', { cookie: a.cookie });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview.count, 4);
  assert.equal(preview.body.preview.estimatedTotal, 8290 * 2 + 12900 * 2 + 5990 * 2 + 10396 * 2);

  const runs = await request(server.baseUrl, '/api/runs', { cookie: a.cookie });
  assert.equal(runs.body.runs.length, 0, '미리보기는 실행 기록을 남기지 않습니다.');
});

test('사용자 파일에는 암호화된 세션만 저장된다 (평문 자격증명 없음)', async () => {
  const a = await register(server.baseUrl, { nickname: '암호화', password: 'password123', loadStarter: false });
  const file = path.join(server.dataDir, 'users', `${a.body.user.userId}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.kurly.status, 'disconnected');
  assert.equal(stored.kurly.session, null);
  assert.equal(stored.kurly.account, null);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('password123'));
});
