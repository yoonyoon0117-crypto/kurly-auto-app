'use strict';
/**
 * 장볼 목록(checklist) — 컬리 로그인 없이도 쓸 수 있는 "이번 주 장보기 목록".
 *
 *  · 목록은 정기 품목 + 이번 주 요리 재료를 합친 것과 **똑같습니다**(같은 상품은 한 줄, 수량 합산 없음).
 *  · 각 줄에 `담음` 체크를 사용자별로 저장해 두고, 장보는 동안 하나씩 지워 갑니다.
 *  · `컬리에서 열기` / `오아시스에서 열기` 는 그 마켓의 상품 페이지로 바로 갑니다.
 *  · 장보기가 끝나면 [이번 주 장보기 완료] 로 체크와 요리 선택을 한 번에 초기화합니다.
 *
 * 체크 키는 `${market}:${productNo}` 입니다. 다만 컬리는 예전 저장값과 그대로 이어지도록
 * 상품번호만 쓴 키('5029849')도 함께 읽고, 새로 저장할 때도 그 형태를 씁니다.
 * (오아시스는 'oasis:100888' 처럼 마켓을 붙여, 두 마켓의 상품번호가 겹쳐도 섞이지 않게 합니다.)
 *
 * 파일 입출력은 하지 않습니다 — 사용자 레코드 안에서만 계산합니다.
 */
const recipes = require('./recipes');
const { normalizeMarket, productUrlFor } = require('./plan');

const MAX_CHECKED = 300;

/** 체크 키 — 컬리는 예전 그대로 상품번호, 오아시스는 마켓을 붙입니다. */
function checkKey(market, productNo) {
  const no = Number(productNo);
  if (!Number.isInteger(no) || no <= 0) return null;
  return normalizeMarket(market) === 'oasis' ? `oasis:${no}` : String(no);
}

/** 저장된 키('5029849', 'kurly:5029849', 'oasis:100888') → 표준 키 */
function canonicalKey(key) {
  const raw = String(key ?? '').trim();
  const m = raw.match(/^(kurly|oasis):(\d+)$/);
  if (m) return checkKey(m[1], m[2]);
  return checkKey('kurly', raw);
}

/** 저장된 체크 상태를 안전한 형태({ '상품번호': true, 'oasis:100888': true })로 정리합니다. */
function sanitizeChecked(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (n >= MAX_CHECKED) break;
    const clean = canonicalKey(key);
    if (!clean) continue;
    if (value === true || value === 'true' || value === 1) {
      out[clean] = true;
      n += 1;
    }
  }
  return out;
}

/** 체크 상태를 바꾼 새 맵을 돌려줍니다. (원본은 그대로) */
function toggleChecked(checked, target, next) {
  const base = sanitizeChecked(checked);
  // 예전 호출 방식(toggleChecked(checked, productNo, true))도 그대로 동작합니다.
  const opts = target && typeof target === 'object' ? target : { productNo: target };
  const key = checkKey(opts.market, opts.productNo);
  if (!key) {
    throw Object.assign(new Error('상품번호가 올바르지 않습니다.'), { status: 400 });
  }
  const want = next === undefined ? !base[key] : Boolean(next);
  if (want) base[key] = true;
  else delete base[key];
  return base;
}

function productUrl(productNo, market = 'kurly') {
  return productUrlFor(market, productNo);
}

/**
 * 이번 주 장볼 목록 — 정기 품목 + 이번 주 요리 재료(합친 결과 그대로).
 * @returns {{items:Array, count:number, checkedCount:number, estimatedTotal:number, checkedTotal:number, allChecked:boolean, mode:string, mixLabel:string, marketCounts:{kurly:number, oasis:number}}}
 */
function buildChecklist(user, { mode = 'auto' } = {}) {
  const merged = recipes.mergeForRun(user, { mode });
  const checked = sanitizeChecked(user?.checklist?.checked);
  const items = merged.items.map((item) => {
    const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
    const price = Math.max(0, Number(item.price) || 0);
    const market = normalizeMarket(item.market);
    return {
      market,
      productNo: item.productNo,
      name: item.name,
      quantity,
      price,
      lineTotal: price * quantity,
      volume: item.volume ?? null,
      imageUrl: item.imageUrl ?? null,
      source: item.source,
      recipeNames: item.recipeNames || [],
      url: item.url || productUrl(item.productNo, market),
      checked: checked[checkKey(market, item.productNo)] === true,
    };
  });
  const estimatedTotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
  const checkedItems = items.filter((i) => i.checked);
  const marketCounts = { kurly: 0, oasis: 0 };
  items.forEach((item) => {
    marketCounts[item.market] += 1;
  });
  return {
    items,
    count: items.length,
    checkedCount: checkedItems.length,
    remainingCount: items.length - checkedItems.length,
    estimatedTotal,
    checkedTotal: checkedItems.reduce((sum, i) => sum + i.lineTotal, 0),
    allChecked: items.length > 0 && checkedItems.length === items.length,
    mode: merged.mode,
    mixLabel: recipes.describeRunMix(merged.counts),
    counts: merged.counts,
    marketCounts,
  };
}

/** 장보기 완료 — 체크를 비우고, 설정에 따라 이번 주 요리 선택도 푼다. */
function completeChecklist(user) {
  const settings = recipes.normalizeRecipeSettings(user?.recipeSettings);
  const reset = settings.clearSelectedAfterRun
    ? recipes.resetAfterRun(user?.recipes)
    : { recipes: Array.isArray(user?.recipes) ? user.recipes : [], cleared: 0 };
  return {
    checked: {},
    recipes: reset.recipes,
    clearedRecipes: reset.cleared,
    completedAt: Date.now(),
  };
}

module.exports = {
  MAX_CHECKED,
  checkKey,
  sanitizeChecked,
  toggleChecked,
  buildChecklist,
  completeChecklist,
  productUrl,
};
