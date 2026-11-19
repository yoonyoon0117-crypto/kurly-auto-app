'use strict';
/**
 * 프로세스 안에서 도는 순차 실행 큐.
 *  · 동시에 1개 작업만 실행합니다 → 작은 컨테이너(512MB~1GB)에서 Chromium 이 여러 개 떠 OOM 나는 것을 막습니다.
 *  · 작업 상태(대기/실행 중/완료/실패)와 진행 메시지를 메모리에 두고, 화면(/api/status)이 읽어 갑니다.
 *  · 실행 결과의 영구 기록은 runner 가 사용자 레코드(runHistory)에 저장합니다.
 */
const crypto = require('crypto');

class JobQueue {
  constructor({ handler, logger = null, keepHistory = 60, concurrency = 1 } = {}) {
    if (typeof handler !== 'function') throw new Error('JobQueue 에는 handler 함수가 필요합니다.');
    this.handler = handler;
    this.logger = logger;
    this.keepHistory = keepHistory;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.jobs = [];
    this.pending = [];
    this.runningCount = 0;
    this.stopped = false;
  }

  enqueue(spec = {}) {
    const dedupeKey = spec.dedupeKey || null;
    if (dedupeKey) {
      const existing = this.jobs.find(
        (j) => j.dedupeKey === dedupeKey && (j.status === 'queued' || j.status === 'running')
      );
      if (existing) return existing;
    }
    const job = {
      id: `job_${crypto.randomBytes(6).toString('base64url')}`,
      type: spec.type || 'run',
      userId: spec.userId || null,
      trigger: spec.trigger || 'manual',
      dedupeKey,
      // 비밀번호·세션 같은 비밀값은 작업이 도는 동안만 들고 있고, 끝나면 지웁니다.
      secret: spec.secret ?? null,
      status: 'queued',
      progress: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    this.pending.push(job);
    this.jobs.unshift(job);
    if (this.jobs.length > this.keepHistory) {
      // 실행이 끝난 오래된 작업만 정리합니다.
      const keep = this.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
      const finished = this.jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');
      this.jobs = [...keep, ...finished.slice(0, this.keepHistory - keep.length)].sort(
        (a, b) => b.createdAt - a.createdAt
      );
    }
    this.pump();
    return job;
  }

  setProgress(job, message) {
    if (!job) return;
    job.progress = String(message).slice(0, 200);
  }

  pump() {
    if (this.stopped) return;
    while (this.runningCount < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      this.runningCount += 1;
      job.status = 'running';
      job.startedAt = Date.now();
      Promise.resolve()
        .then(() => this.handler(job, { setProgress: (m) => this.setProgress(job, m) }))
        .then((result) => {
          job.status = 'done';
          job.result = result ?? null;
        })
        .catch((err) => {
          job.status = 'error';
          job.error = err?.message || String(err);
          if (this.logger) this.logger.error(`작업 실패 (${job.type} · ${job.userId || '-'}): ${job.error}`);
        })
        .finally(() => {
          job.finishedAt = Date.now();
          job.secret = null;
          this.runningCount -= 1;
          this.pump();
        });
    }
  }

  get(jobId) {
    return this.jobs.find((j) => j.id === jobId) || null;
  }

  activeFor(userId) {
    return this.jobs.find((j) => j.userId === userId && (j.status === 'queued' || j.status === 'running')) || null;
  }

  stats() {
    const queued = this.jobs.filter((j) => j.status === 'queued').length;
    const running = this.jobs.filter((j) => j.status === 'running').length;
    return { queued, running, pending: this.pending.length, runningCount: this.runningCount };
  }

  stop() {
    this.stopped = true;
  }
}

module.exports = { JobQueue };
