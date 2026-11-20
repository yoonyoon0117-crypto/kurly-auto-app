'use strict';
/**
 * 주기(기본 1주) 정기 실행 스케줄러 — 60초마다 사용자별로 "지금이 실행 창인지" 확인합니다.
 *
 *  · 창(window) : 실행 시각이 지난 뒤 graceHours(기본 6시간) 안
 *  · 멱등성    : 슬롯마다 키(anchorDate#k)를 만들어 user.lastDueKey 에 먼저 적고 큐에 넣습니다.
 *                같은 슬롯에서는 서버가 재시작되거나 틱이 겹쳐도 한 번만 실행됩니다.
 *  · 실행은 큐(동시 1개)로 넘기므로 이 루프는 기다리지 않습니다.
 */
const { computeDue, formatKst } = require('./plan');
const store = require('./store');

class Scheduler {
  /**
   * @param {object} opts
   * @param {import('./queue').JobQueue} opts.queue
   * @param {() => number} [opts.now]
   * @param {number} [opts.intervalMs]
   * @param {number} [opts.graceHours]
   */
  constructor({ queue, logger = null, now = () => Date.now(), intervalMs = 60000, graceHours = 6 } = {}) {
    this.queue = queue;
    this.logger = logger;
    this.now = now;
    this.intervalMs = intervalMs;
    this.graceMs = Math.max(1, graceHours) * 60 * 60 * 1000;
    this.timer = null;
    this.ticking = false;
    this.lastTickAt = null;
    this.lastEnqueued = [];
  }

  start() {
    if (this.timer) return;
    this.tick().catch((err) => this.logger?.error(`스케줄러 첫 점검 실패: ${err.message}`));
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger?.error(`스케줄러 점검 실패: ${err.message}`));
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.logger?.info(`스케줄러 시작 — ${Math.round(this.intervalMs / 1000)}초마다 확인, 실행 창 ${this.graceMs / 3600000}시간`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 한 번 점검합니다. 실행 대상이면 큐에 넣고 그 목록을 돌려줍니다.
   * @returns {Promise<Array<{userId:string, nickname:string, key:string, slotLabel:string}>>}
   */
  async tick() {
    if (this.ticking) return [];
    this.ticking = true;
    const enqueued = [];
    const nowMs = this.now();
    try {
      this.lastTickAt = nowMs;
      let users = [];
      try {
        users = store.listUsers();
      } catch (err) {
        this.logger?.error(`사용자 목록을 읽지 못했습니다: ${err.message}`);
        return [];
      }
      for (const user of users) {
        let due = null;
        try {
          due = computeDue(user.schedule, nowMs, this.graceMs);
        } catch (err) {
          this.logger?.warn(`${user.nickname} 일정 계산 실패: ${err.message}`);
          continue;
        }
        if (!due) continue;
        if (user.lastDueKey === due.key) {
          // 이 슬롯을 이미 예약했더라도, 실제 실행 기록이 없으면(서버가 큐를 처리하기 전에 재시작)
          // 다시 큐에 넣습니다. 이미 큐에 있으면 dedupeKey 가 중복을 막아줍니다.
          const ranAt = Number(user.lastRunAt) || 0;
          if (ranAt >= due.slotMs) continue;
          this.logger?.warn(`${user.nickname} 이전 예약이 실행되지 않아 다시 예약합니다 (키 ${due.key})`);
        }

        // 멱등성: 큐에 넣기 전에 먼저 기록합니다(동시 틱·재시작에도 한 번만).
        try {
          const updated = await store.updateUser(user.userId, (u) => {
            if (u.lastDueKey === due.key) return u;
            u.lastDueKey = due.key;
            u.lastDueAt = due.slotMs;
            return u;
          });
          if (updated.lastDueKey !== due.key) continue;
        } catch (err) {
          this.logger?.error(`${user.nickname} 스케줄 기록 실패: ${err.message}`);
          continue;
        }

        this.queue.enqueue({
          type: 'run',
          userId: user.userId,
          trigger: 'scheduled',
          dedupeKey: `${user.userId}:${due.key}`,
          slotKey: due.key,
        });
        enqueued.push({ userId: user.userId, nickname: user.nickname, key: due.key, slotLabel: due.slotLabel });
        this.logger?.info(`정기 실행 예약: ${user.nickname} — ${due.slotLabel} (키 ${due.key})`);
      }
      if (enqueued.length) this.lastEnqueued = enqueued;
      return enqueued;
    } finally {
      this.ticking = false;
    }
  }

  status() {
    return {
      running: Boolean(this.timer),
      lastTickAt: this.lastTickAt,
      lastTickLabel: this.lastTickAt ? formatKst(this.lastTickAt) : null,
      intervalSeconds: Math.round(this.intervalMs / 1000),
      graceHours: this.graceMs / 3600000,
      lastEnqueued: this.lastEnqueued,
    };
  }
}

module.exports = { Scheduler };
