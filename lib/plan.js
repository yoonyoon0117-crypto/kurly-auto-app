'use strict';
/**
 * 장바구니 계획 · 주기(기본 1주) 계산 (파일 입출력 없음 — 사용자별 레코드 안에서 동작)
 *
 *  수량 규칙: 담을 수량 = ceil(소비량 ÷ 한 단위 크기)   (g↔kg, ml↔L 자동 환산)
 *  주기 규칙: 기준일(anchorDate)부터 정확히 intervalWeeks 주 간격 (기본 1주 = 7일, 1~8주 설정 가능)
 *             요일·시각은 Asia/Seoul 고정 (한국은 서머타임 없음)
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_QUANTITY = 99;
// 상품을 사는 마켓. 컬리는 자동 담기, 오아시스는 장볼 목록으로만 안내합니다.
const MARKETS = ['kurly', 'oasis'];
const MARKET_LABEL = { kurly: '컬리', oasis: '오아시스' };
const MARKET_HOME = { kurly: 'https://www.kurly.com', oasis: 'https://m.oasis.co.kr' };
const BASE_FACTOR = { g: 1, kg: 1000, ml: 1, l: 1000 };
const UNIT_LABELS = ['구', 'g', 'kg', '입', '개', '팩', '봉', 'ml', 'L', '마리', '장', '병'];

function toBase(amount, label) {
  const factor = BASE_FACTOR[String(label ?? '').toLowerCase()];
  return Number(amount) * (factor ?? 1);
}

function clampQuantity(n) {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_QUANTITY, Math.round(n));
}

/** 저장된 마켓 값 → 'kurly' | 'oasis' (없거나 모르는 값은 컬리) */
function normalizeMarket(value) {
  return String(value ?? '').trim().toLowerCase() === 'oasis' ? 'oasis' : 'kurly';
}

/** 마켓별 상품 페이지 주소 */
function productUrlFor(market, productNo) {
  const no = Number(productNo);
  const home = MARKET_HOME[normalizeMarket(market)];
  if (!Number.isInteger(no) || no <= 0) return home;
  return normalizeMarket(market) === 'oasis' ? `${home}/product/detail/${no}` : `${home}/goods/${no}`;
}

/** 한 상품의 담을 수량 */
function computeQuantity(item) {
  const override = Number(item?.quantityOverride);
  if (Number.isFinite(override) && override > 0) return clampQuantity(override);
  const unitSize = Number(item?.unitSize);
  const consumption = Number(item?.consumption);
  if (!(unitSize > 0) || !(consumption > 0)) return 1;
  const ratio = toBase(consumption, item?.unitLabel) / toBase(unitSize, item?.unitLabel);
  return clampQuantity(Math.ceil(ratio - 1e-9));
}

/* ─────────────── 한국 시간 ─────────────── */

function kstParts(ms) {
  const d = new Date(Number(ms) + KST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** 2026-11-20 (금) 21:00 */
function formatKst(ms) {
  const p = kstParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} (${WEEKDAY_KO[p.weekday]}) ${pad(p.hour)}:${pad(p.minute)}`;
}

function formatKstIso(ms) {
  const p = kstParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+09:00`;
}

function kstDateString(ms) {
  const p = kstParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 오늘(KST) 이후 가장 가까운 해당 요일의 날짜 (YYYY-MM-DD) — 오늘이면 7일 뒤 */
function nextWeekdayDate(weekday, nowMs = Date.now()) {
  const today = kstParts(nowMs);
  const base = Date.UTC(today.year, today.month - 1, today.day);
  let delta = (weekday - today.weekday + 7) % 7;
  if (delta === 0) delta = 7;
  const d = new Date(base + delta * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function normalizeSchedule(raw = {}, nowMs = Date.now()) {
  const intervalWeeks =
    Number.isFinite(Number(raw.intervalWeeks)) && Number(raw.intervalWeeks) >= 1 && Number(raw.intervalWeeks) <= 8
      ? Math.round(Number(raw.intervalWeeks))
      : 1;
  const weekday =
    Number.isInteger(Number(raw.weekday)) && Number(raw.weekday) >= 0 && Number(raw.weekday) <= 6
      ? Number(raw.weekday)
      : 5;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.time ?? '')) ? String(raw.time) : '21:00';
  const anchorDate = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.anchorDate ?? ''))
    ? String(raw.anchorDate)
    : nextWeekdayDate(weekday, nowMs);
  return {
    enabled: raw.enabled !== false,
    weekday,
    time,
    intervalWeeks,
    timezone: 'Asia/Seoul',
    anchorDate,
  };
}

function anchorMsOf(schedule) {
  const ms = Date.parse(`${schedule.anchorDate}T${schedule.time}:00+09:00`);
  if (!Number.isFinite(ms)) throw new Error(`기준일 형식이 올바르지 않습니다: ${schedule.anchorDate}`);
  return ms;
}

function intervalMsOf(schedule) {
  return schedule.intervalWeeks * 7 * 86400000;
}

/** 기준일부터 intervalWeeks 간격으로 계산한 다음 실행 시각(ms) */
function nextRunAt(schedule, nowMs = Date.now()) {
  const s = normalizeSchedule(schedule, nowMs);
  const anchor = anchorMsOf(s);
  const intervalMs = intervalMsOf(s);
  let k = 0;
  if (nowMs > anchor) k = Math.ceil((nowMs - anchor) / intervalMs);
  let candidate = anchor + k * intervalMs;
  let guard = 0;
  while (candidate <= nowMs && guard < 10000) {
    candidate += intervalMs;
    guard += 1;
  }
  return candidate;
}

function upcomingRuns(schedule, nowMs = Date.now(), count = 3) {
  const s = normalizeSchedule(schedule, nowMs);
  const intervalMs = intervalMsOf(s);
  const out = [];
  let at = nextRunAt(s, nowMs);
  for (let i = 0; i < count; i += 1) {
    out.push({ at, label: formatKst(at), iso: formatKstIso(at) });
    at += intervalMs;
  }
  return out;
}

/**
 * 지금이 정기 실행 "창" 안에 있는지 계산합니다.
 *  - 실행 시각(slot)이 지났고, 지난 지 graceMs 이내이면 실행 대상
 *  - 키는 슬롯마다 고유 (`anchorDate#k`) 해서 같은 슬롯에 두 번 실행되지 않습니다.
 * @returns {{key:string, slotMs:number, lateMs:number, slotLabel:string}|null}
 */
function computeDue(schedule, nowMs = Date.now(), graceMs = 6 * 60 * 60 * 1000) {
  const s = normalizeSchedule(schedule, nowMs);
  if (s.enabled === false) return null;
  const anchor = anchorMsOf(s);
  const intervalMs = intervalMsOf(s);
  if (nowMs < anchor) return null;
  const k = Math.floor((nowMs - anchor) / intervalMs);
  const slotMs = anchor + k * intervalMs;
  const lateMs = nowMs - slotMs;
  if (lateMs < 0 || lateMs > graceMs) return null;
  return { key: `${s.anchorDate}#${k}`, slotMs, lateMs, slotLabel: formatKst(slotMs) };
}

function describeSchedule(schedule) {
  const s = normalizeSchedule(schedule);
  const [h, m] = s.time.split(':');
  return `${s.intervalWeeks}주마다 ${WEEKDAY_KO[s.weekday]}요일 ${Number(h)}:${m} (KST)`;
}

/* ─────────────── 계획 검증 ─────────────── */

function normalizeItem(raw, index = 0) {
  const name = String(raw?.name ?? '').trim();
  const productNo = Number(raw?.productNo);
  if (!name) throw new Error(`${index + 1}번째 상품의 이름이 없습니다.`);
  if (!Number.isInteger(productNo) || productNo <= 0) {
    throw new Error(`'${name}' 상품의 상품번호가 올바르지 않습니다.`);
  }
  const unitSize = Number(raw?.unitSize);
  if (!(unitSize > 0)) throw new Error(`'${name}' 상품의 단위 크기는 0보다 커야 합니다.`);
  const consumption = Number(raw?.consumption);
  if (!Number.isFinite(consumption) || consumption < 0) {
    throw new Error(`'${name}' 상품의 소비량은 0 이상이어야 합니다.`);
  }
  const unitLabel = UNIT_LABELS.includes(String(raw?.unitLabel))
    ? String(raw.unitLabel)
    : String(raw?.unitLabel ?? '개').trim() || '개';
  const overrideRaw = raw?.quantityOverride;
  const override =
    overrideRaw === null || overrideRaw === undefined || overrideRaw === '' ? null : Number(overrideRaw);
  if (override !== null && !(override > 0)) {
    throw new Error(`'${name}' 상품의 수동 수량은 1 이상이어야 합니다.`);
  }

  const item = {
    id: String(raw?.id ?? `item-${productNo}-${index + 1}`).slice(0, 80),
    market: normalizeMarket(raw?.market),
    productNo,
    dealProductNo: Number(raw?.dealProductNo) || null,
    name: name.slice(0, 200),
    shortDescription: String(raw?.shortDescription ?? '').slice(0, 200),
    imageUrl: raw?.imageUrl ? String(raw.imageUrl).slice(0, 500) : null,
    price: Math.max(0, Number(raw?.price) || 0),
    unitPriceText: raw?.unitPriceText ? String(raw.unitPriceText).slice(0, 100) : null,
    volume: raw?.volume ? String(raw.volume).slice(0, 100) : null,
    url: raw?.url ? String(raw.url).slice(0, 500) : productUrlFor(raw?.market, productNo),
    unitSize,
    unitLabel,
    consumption,
    quantityOverride: override === null ? null : clampQuantity(override),
    optionName: raw?.optionName ? String(raw.optionName).slice(0, 200) : null,
    active: raw?.active !== false,
    note: String(raw?.note ?? '').slice(0, 200),
  };
  item.quantity = computeQuantity(item);
  return item;
}

const { checkWebhookUrl } = require('./webhook-url');

function normalizeNotification(raw = {}) {
  const url = String(raw.webhookUrl ?? '').trim();
  if (url) {
    const checked = checkWebhookUrl(url);
    if (!checked.ok) throw new Error(checked.reason);
  }
  return {
    webhookUrl: url,
    webhookType: ['auto', 'slack', 'discord', 'ntfy', 'generic'].includes(raw.webhookType)
      ? raw.webhookType
      : 'auto',
  };
}

/**
 * 입력을 검증해 저장용 계획으로 만듭니다. 잘못된 항목이 있으면 400 용 오류를 던집니다.
 * @returns {{items:Array, schedule:object, notification:object}}
 */
function normalizePlanInput(raw = {}, { nowMs = Date.now(), maxItems = 100 } = {}) {
  const itemsRaw = Array.isArray(raw.items) ? raw.items : [];
  if (itemsRaw.length > maxItems) throw new Error(`상품은 최대 ${maxItems}개까지 담을 수 있습니다.`);
  const items = itemsRaw.map((item, i) => normalizeItem(item, i));

  const seen = new Set();
  for (const item of items) {
    let id = item.id;
    while (seen.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
    item.id = id;
    seen.add(id);
  }

  return {
    items,
    schedule: normalizeSchedule(raw.schedule, nowMs),
    notification: normalizeNotification(raw.notification),
  };
}

function estimatedTotal(items) {
  return items
    .filter((i) => i.active !== false)
    .reduce((sum, i) => sum + (Number(i.price) || 0) * computeQuantity(i), 0);
}

/** 화면에 보여줄 요약 */
function summarizePlan(user, nowMs = Date.now()) {
  const items = Array.isArray(user.items) ? user.items : [];
  const active = items.filter((i) => i.active !== false);
  const schedule = normalizeSchedule(user.schedule, nowMs);
  const next = nextRunAt(schedule, nowMs);
  return {
    itemCount: items.length,
    activeCount: active.length,
    estimatedTotal: estimatedTotal(items),
    schedule,
    scheduleLabel: describeSchedule(schedule),
    nextRunAt: next,
    nextRunLabel: formatKst(next),
    nextRunIso: formatKstIso(next),
    upcoming: upcomingRuns(schedule, nowMs, 3),
  };
}

module.exports = {
  WEEKDAY_KO,
  WEEKDAY_EN,
  UNIT_LABELS,
  MAX_QUANTITY,
  MARKETS,
  MARKET_LABEL,
  MARKET_HOME,
  normalizeMarket,
  productUrlFor,
  toBase,
  computeQuantity,
  clampQuantity,
  kstParts,
  kstDateString,
  formatKst,
  formatKstIso,
  nextWeekdayDate,
  normalizeSchedule,
  normalizeItem,
  normalizeNotification,
  normalizePlanInput,
  anchorMsOf,
  intervalMsOf,
  nextRunAt,
  upcomingRuns,
  computeDue,
  describeSchedule,
  estimatedTotal,
  summarizePlan,
};
