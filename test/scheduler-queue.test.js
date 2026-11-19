'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { setupEnv } = require('./helpers');
setupEnv();

const store = require('../lib/store');
const { Scheduler } = require('../lib/scheduler');
const { JobQueue } = require('../lib/queue');
const { hashPassword } = require('../lib/passwords');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('조건이 만족되지 않았습니다.');
    await sleep(20);
  }
}

function makeUser(nickname, schedule, nowMs) {
  return store.createUser({ nickname, passwordHash: hashPassword('password123'), nowMs }).then((user) =>
    store.updateUser(user.userId, (u) => {
      u.schedule = schedule;
      return u;
    })
  );
}

/** 앞선 테스트가 만든 사용자의 정기 실행을 꺼서 이번 테스트만 관찰합니다. */
async function disableAllUsers() {
  for (const user of store.listUsers()) {
    await store.updateUser(user.userId, (u) => {
      u.schedule = { ...u.schedule, enabled: false };
      return u;
    });
  }
}

test('스케줄러: 2주 슬롯마다 정확히 한 번만 큐에 넣는다 (멱등성)', async () => {
  const anchorMs = Date.parse('2026-11-20T21:00:00+09:00');
  let now = anchorMs;
  const queue = { calls: [], enqueue(job) { this.calls.push(job); return job; } };
  const scheduler = new Scheduler({ queue, now: () => now, graceHours: 6 });

  const user = await makeUser('정기', { enabled: true, weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-11-20' }, anchorMs);

  // 실행 시각 직전
  now = anchorMs - 60 * 1000;
  assert.deepEqual(await scheduler.tick(), []);
  assert.equal(queue.calls.length, 0);

  // 실행 시각
  now = anchorMs + 30 * 1000;
  const first = await scheduler.tick();
  assert.equal(first.length, 1);
  assert.equal(first[0].key, '2026-11-20#0');
  await sleep(50);
  assert.equal(store.getUser(user.userId).lastDueKey, '2026-11-20#0');

  // 실행이 끝나 기록이 남은 상황 (실제 큐 핸들러가 하는 일)
  await store.updateUser(user.userId, (u) => {
    u.lastRunAt = anchorMs + 60 * 1000;
    return u;
  });

  // 같은 슬롯에서 여러 번 점검해도 다시 넣지 않는다 (서버 재시작 시나리오)
  now = anchorMs + 2 * 3600 * 1000;
  assert.deepEqual(await scheduler.tick(), []);
  now = anchorMs + 5 * 3600 * 1000;
  assert.deepEqual(await scheduler.tick(), []);
  assert.equal(queue.calls.length, 1);

  // 실행 창(6시간)을 벗어나면 실행하지 않는다
  now = anchorMs + 7 * 3600 * 1000;
  assert.deepEqual(await scheduler.tick(), []);

  // 2주 뒤 다음 슬롯은 새 키로 한 번 더
  now = anchorMs + 14 * 86400000 + 60 * 1000;
  const second = await scheduler.tick();
  assert.equal(second.length, 1);
  assert.equal(second[0].key, '2026-11-20#1');
  assert.equal(queue.calls.length, 2);
  assert.equal(store.getUser(user.userId).lastDueKey, '2026-11-20#1');
});

test('스케줄러: 꺼진 일정·미래 기준일은 실행하지 않는다', async () => {
  await disableAllUsers();
  const anchorMs = Date.parse('2026-11-20T21:00:00+09:00');
  const queue = { calls: [], enqueue(job) { this.calls.push(job); return job; } };
  let now = anchorMs;
  const scheduler = new Scheduler({ queue, now: () => now });

  await makeUser('꺼짐', { enabled: false, weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-11-20' }, anchorMs);
  await makeUser('미래', { enabled: true, weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-12-04' }, anchorMs);
  await makeUser('켜짐', { enabled: true, weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-11-20' }, anchorMs);

  const enqueued = await scheduler.tick();
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].nickname, '켜짐');
});

test('스케줄러: 사용자가 여러 명이면 모두 큐에 넣고, 큐는 순서대로 하나씩 실행', async () => {
  await disableAllUsers();
  const anchorMs = Date.parse('2026-11-20T21:00:00+09:00');
  const order = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const queue = new JobQueue({
    concurrency: 1,
    handler: async (job) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(job.userId);
      await sleep(40);
      concurrent -= 1;
    },
  });
  const scheduler = new Scheduler({ queue, now: () => anchorMs + 1000 });

  const u1 = await makeUser('첫째', { enabled: true, weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-11-20' }, anchorMs);
  const u2 = await makeUser('둘째', { enabled: true, weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-11-20' }, anchorMs);

  const enqueued = await scheduler.tick();
  assert.equal(enqueued.length, 2);
  await waitUntil(() => queue.jobs.filter((j) => j.status === 'done').length === 2);
  assert.equal(maxConcurrent, 1, '동시에 두 개의 브라우저가 뜨면 안 됩니다.');
  assert.deepEqual(order.sort(), [u1.userId, u2.userId].sort());
  assert.equal(queue.stats().queued, 0);
  queue.stop();
});

test('스케줄러: 예약만 되고 실행 기록이 없으면 재시작 후 다시 예약한다', async () => {
  await disableAllUsers();
  const anchorMs = Date.parse('2026-11-20T21:00:00+09:00');
  const queue = { calls: [], enqueue(job) { this.calls.push(job); return job; } };
  const scheduler = new Scheduler({ queue, now: () => anchorMs + 10 * 60 * 1000 });

  const user = await makeUser('재시작', { enabled: true, weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-11-20' }, anchorMs);
  // 서버가 큐에 넣고 바로 죽은 상황을 흠내: lastDueKey 만 있고 lastRunAt 은 없음
  await store.updateUser(user.userId, (u) => {
    u.lastDueKey = '2026-11-20#0';
    u.lastRunAt = null;
    return u;
  });

  const retried = await scheduler.tick();
  assert.equal(retried.length, 1, '실행 기록이 없으면 다시 예약해야 합니다.');
  assert.equal(queue.calls.length, 1);

  // 이번에는 실행이 기록된 상황 → 다시 예약하지 않는다
  queue.calls.length = 0;
  await store.updateUser(user.userId, (u) => {
    u.lastRunAt = anchorMs + 60 * 1000;
    return u;
  });
  assert.deepEqual(await scheduler.tick(), []);
  assert.equal(queue.calls.length, 0);
});

test('큐: 순차 실행·진행 메시지·오류 처리', async () => {
  const seen = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const queue = new JobQueue({
    concurrency: 1,
    handler: async (job, { setProgress }) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      setProgress(`${job.type} 진행 중`);
      seen.push(job.type);
      await sleep(30);
      concurrent -= 1;
      if (job.type === 'boom') throw new Error('일부러 실패');
      return { ok: true };
    },
  });

  const a = queue.enqueue({ type: 'one', userId: 'u1' });
  const b = queue.enqueue({ type: 'boom', userId: 'u1' });
  const c = queue.enqueue({ type: 'three', userId: 'u2' });

  await waitUntil(() => [a, b, c].every((j) => j.status === 'done' || j.status === 'error'));
  assert.deepEqual(seen, ['one', 'boom', 'three']);
  assert.equal(maxConcurrent, 1);
  assert.equal(a.status, 'done');
  assert.equal(b.status, 'error');
  assert.match(b.error, /일부러 실패/);
  assert.equal(c.status, 'done');
  assert.equal(queue.get(c.id).status, 'done');
  queue.stop();
});

test('큐: dedupeKey 로 같은 작업이 중복되지 않는다', async () => {
  const queue = new JobQueue({ concurrency: 1, handler: async () => { await sleep(60); } });
  const first = queue.enqueue({ type: 'run', userId: 'u1', dedupeKey: 'u1:slot' });
  const second = queue.enqueue({ type: 'run', userId: 'u1', dedupeKey: 'u1:slot' });
  assert.equal(first.id, second.id);
  assert.equal(queue.jobs.length, 1);

  const other = queue.enqueue({ type: 'run', userId: 'u1', dedupeKey: 'u1:other-slot' });
  assert.notEqual(other.id, first.id);
  await waitUntil(() => queue.jobs.every((j) => j.status === 'done'));
  queue.stop();
});

test('사용자 파일 저장은 원자적이고 동시 갱신이 유실되지 않는다', async () => {
  const user = await store.createUser({ nickname: '동시성', passwordHash: hashPassword('password123') });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.updateUser(user.userId, (u) => {
        u.stats = { ...(u.stats || {}), runs: (u.stats?.runs || 0) + 1 };
        u.items = [...(u.items || []), { id: `i${i}` }];
        return u;
      })
    )
  );
  const saved = store.getUser(user.userId);
  assert.equal(saved.stats.runs, 20);
  assert.equal(saved.items.length, 20);
});
