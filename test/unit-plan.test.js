'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeQuantity,
  normalizeSchedule,
  normalizePlanInput,
  nextRunAt,
  computeDue,
  upcomingRuns,
  describeSchedule,
  formatKst,
  nextWeekdayDate,
  summarizePlan,
  estimatedTotal,
  kstParts,
} = require('../lib/plan');

test('담을 수량 = 올림(소비량 ÷ 한 단위)', () => {
  assert.equal(computeQuantity({ unitSize: 15, unitLabel: '구', consumption: 30 }), 2);
  assert.equal(computeQuantity({ unitSize: 1.3, unitLabel: 'kg', consumption: 2.6 }), 2);
  assert.equal(computeQuantity({ unitSize: 5, unitLabel: '입', consumption: 10 }), 2);
  assert.equal(computeQuantity({ unitSize: 500, unitLabel: 'g', consumption: 1000 }), 2);
  // 올림 확인: 700g ÷ 500g = 1.4 → 2
  assert.equal(computeQuantity({ unitSize: 500, unitLabel: 'g', consumption: 700 }), 2);
  // 같은 단위로 비교합니다 (단위 라벨은 상품마다 하나)
  // 수동 수량 우선
  assert.equal(computeQuantity({ unitSize: 15, unitLabel: '구', consumption: 30, quantityOverride: 3 }), 3);
  // 소비량 0 → 최소 1
  assert.equal(computeQuantity({ unitSize: 15, unitLabel: '구', consumption: 0 }), 1);
  // 상한 99
  assert.equal(computeQuantity({ unitSize: 1, unitLabel: '개', consumption: 1000 }), 99);
});

test('일정 기본값과 설명', () => {
  const now = Date.parse('2026-11-19T09:00:00+09:00');
  const s = normalizeSchedule({}, now);
  assert.equal(s.enabled, true);
  assert.equal(s.weekday, 5);
  assert.equal(s.time, '21:00');
  assert.equal(s.intervalWeeks, 1);
  assert.equal(s.timezone, 'Asia/Seoul');
  // 다음 금요일(2026-11-20)
  assert.equal(s.anchorDate, '2026-11-20');
  assert.equal(nextWeekdayDate(5, now), '2026-11-20');
  assert.equal(describeSchedule(s), '1주마다 금요일 21:00 (KST)');
});

test('2주 간격 다음 실행 시각 계산', () => {
  const schedule = { weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-11-20' };
  const anchor = Date.parse('2026-11-20T21:00:00+09:00');

  // 기준일 전 → 기준일
  assert.equal(nextRunAt(schedule, Date.parse('2026-11-19T12:00:00+09:00')), anchor);
  // 기준일 직후 → 14일 뒤
  assert.equal(nextRunAt(schedule, anchor + 1000), anchor + 14 * 86400000);
  // 정확히 기준일 시각 → 다음 주기
  assert.equal(nextRunAt(schedule, anchor), anchor + 14 * 86400000);
  // 5주 뒤 → 6주째 슬롯
  const fiveWeeks = anchor + 35 * 86400000;
  assert.equal(nextRunAt(schedule, fiveWeeks), anchor + 42 * 86400000);

  const upcoming = upcomingRuns(schedule, Date.parse('2026-11-20T22:00:00+09:00'), 3);
  assert.equal(upcoming.length, 3);
  assert.equal(upcoming[0].at, anchor + 14 * 86400000);
  assert.equal(upcoming[1].at, anchor + 28 * 86400000);
  assert.match(upcoming[0].label, /^2026-12-04 \(금\) 21:00$/);
});

test('실행 창(due)과 멱등 키', () => {
  const anchor = Date.parse('2026-11-20T21:00:00+09:00');
  const schedule = { weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-11-20' };

  // 기준일 직전에는 아직 아님
  assert.equal(computeDue(schedule, anchor - 60000), null);
  // 정확히 실행 시각
  const atSlot = computeDue(schedule, anchor);
  assert.equal(atSlot.key, '2026-11-20#0');
  // 5시간 늦게(서버 재시작) → 같은 키 (한 번만 실행되도록)
  assert.equal(computeDue(schedule, anchor + 5 * 3600000).key, '2026-11-20#0');
  // 7시간 늦으면 실행 창을 벗어남
  assert.equal(computeDue(schedule, anchor + 7 * 3600000), null);
  // 14일 뒤 슬롯은 다른 키
  assert.equal(computeDue(schedule, anchor + 14 * 86400000).key, '2026-11-20#1');
  // 정지 스위치
  assert.equal(computeDue({ ...schedule, enabled: false }, anchor), null);
});

test('계획 검증 — 잘못된 입력은 거부', () => {
  const good = {
    items: [
      {
        productNo: 5029849,
        dealProductNo: 10029849,
        name: '유정란 15구',
        unitSize: 15,
        unitLabel: '구',
        consumption: 30,
        price: 8290,
      },
    ],
    schedule: { weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-11-20' },
    notification: { webhookUrl: 'https://hooks.slack.com/services/T/B/X', webhookType: 'auto' },
  };
  const plan = normalizePlanInput(good, { nowMs: Date.parse('2026-11-19T00:00:00+09:00') });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].quantity, 2);
  assert.equal(plan.schedule.intervalWeeks, 2);

  assert.throws(() => normalizePlanInput({ items: [{ ...good.items[0], productNo: 0 }] }), /상품번호/);
  assert.throws(() => normalizePlanInput({ items: [{ ...good.items[0], unitSize: 0 }] }), /단위 크기/);
  assert.throws(() => normalizePlanInput({ items: [{ ...good.items[0], consumption: -1 }] }), /소비량/);
  assert.throws(() => normalizePlanInput({ items: [], notification: { webhookUrl: 'ftp://x' } }), /웹훅/);

  const defaults = normalizePlanInput({ items: [] });
  assert.equal(defaults.schedule.intervalWeeks, 1);
  assert.equal(defaults.schedule.weekday, 5);
});

test('요약 — 예상 금액과 다음 실행', () => {
  const user = {
    items: [
      { name: '계란', price: 8290, unitSize: 15, unitLabel: '구', consumption: 30, active: true },
      { name: '우유', price: 3000, unitSize: 1, unitLabel: '개', consumption: 2, active: true },
      { name: '휴지', price: 9000, unitSize: 1, unitLabel: '개', consumption: 1, active: false },
    ],
    schedule: { weekday: 5, time: '21:00', intervalWeeks: 2, anchorDate: '2026-11-20' },
  };
  assert.equal(estimatedTotal(user.items), 8290 * 2 + 3000 * 2);
  const now = Date.parse('2026-11-19T10:00:00+09:00');
  const summary = summarizePlan(user, now);
  assert.equal(summary.activeCount, 2);
  assert.equal(summary.itemCount, 3);
  assert.equal(summary.estimatedTotal, 8290 * 2 + 3000 * 2);
  assert.equal(summary.nextRunLabel, '2026-11-20 (금) 21:00');
  assert.equal(summary.upcoming.length, 3);

  const p = kstParts(Date.parse('2026-11-20T21:00:00+09:00'));
  assert.equal(formatKst(Date.parse('2026-11-20T21:00:00+09:00')), '2026-11-20 (금) 21:00');
  assert.equal(p.weekday, 5);
  assert.equal(p.hour, 21);
});
