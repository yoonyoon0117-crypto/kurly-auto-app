'use strict';
/**
 * 요리(레시피) — 좋아하는 요리마다 필수재료를 저장해 두고,
 * "이번 주 담기"로 고른 요리의 재료를 정기 장바구니에 함께 담습니다.
 *
 *  · user.recipes        : [{ id, name, note, selectedForNextRun, ingredients:[…] }]
 *  · user.recipeSettings : { mergeWithRegularPlan:true, clearSelectedAfterRun:true }
 *  · 담을 때 같은 상품번호(productNo)는 한 줄로만 담습니다 — 수량은 절대 더하지 않습니다.
 *      정기 품목에 있는 상품  → 정기 품목 수량 그대로
 *      요리끼리 겹치는 재료   → 둘 중 큰 수량
 *  · skippedThisWeek(집에 있음) 재료는 이번 주만 빼고, 다음 주에 다시 담깁니다.
 *
 * 이 파일은 파일 입출력을 하지 않습니다 — 사용자 레코드 안에서만 계산합니다.
 */
const crypto = require('crypto');
const { computeQuantity, MAX_QUANTITY } = require('./plan');

const MAX_RECIPES = 60;
const MAX_INGREDIENTS_PER_RECIPE = 30;
const MAX_RECIPE_NAME = 40;
const MAX_RECIPE_NOTE = 100;
const RUN_MODES = ['auto', 'combined', 'recipes_only', 'regular_only'];
const RUN_MODE_LABEL = {
  auto: '자동',
  combined: '정기 + 요리',
  recipes_only: '요리만',
  regular_only: '정기만',
};

function clampQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_QUANTITY, Math.round(n));
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('base64url')}`;
}

function badInput(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const trimmed = (value, max) => String(value ?? '').trim().slice(0, max);

/* ─────────────── 검증 ─────────────── */

function normalizeIngredient(raw = {}, { recipeName = '', index = 0 } = {}) {
  const name = trimmed(raw.name, 200);
  if (!name) throw badInput(`'${recipeName}' 요리의 ${index + 1}번째 재료 이름이 없습니다.`);
  const productNo = Number(raw.productNo);
  if (!Number.isInteger(productNo) || productNo <= 0) {
    throw badInput(`'${name}' 재료의 상품번호가 올바르지 않습니다.`);
  }
  return {
    id: trimmed(raw.id, 80) || randomId('ing'),
    productNo,
    dealProductNo: Number(raw.dealProductNo) || null,
    name,
    optionName: raw.optionName ? trimmed(raw.optionName, 200) : null,
    price: Math.max(0, Number(raw.price) || 0),
    imageUrl: raw.imageUrl ? trimmed(raw.imageUrl, 500) : null,
    url: raw.url ? trimmed(raw.url, 500) : `https://www.kurly.com/goods/${productNo}`,
    volume: raw.volume ? trimmed(raw.volume, 100) : null,
    quantity: clampQuantity(raw.quantity ?? 1),
    skippedThisWeek: raw.skippedThisWeek === true,
  };
}

/** 한 요리의 재료 목록 — 같은 상품은 수량을 더해 한 줄로 합칩니다. */
function normalizeIngredients(rawList, recipeName) {
  if (rawList === undefined || rawList === null) return [];
  if (!Array.isArray(rawList)) throw badInput(`'${recipeName}' 요리의 재료 목록이 올바르지 않습니다.`);
  if (rawList.length > MAX_INGREDIENTS_PER_RECIPE) {
    throw badInput(`한 요리의 재료는 최대 ${MAX_INGREDIENTS_PER_RECIPE}개까지 담을 수 있습니다.`);
  }
  const byProduct = new Map();
  const out = [];
  rawList.forEach((raw, i) => {
    const ingredient = normalizeIngredient(raw, { recipeName, index: i });
    const key = String(ingredient.productNo);
    const existing = byProduct.get(key);
    if (existing) {
      // 같은 재료를 두 번 넣어도 두 배로 주문하지 않습니다 — 많은 쪽 수량만 남깁니다.
      existing.quantity = Math.max(existing.quantity, ingredient.quantity);
      existing.skippedThisWeek = existing.skippedThisWeek && ingredient.skippedThisWeek;
      return;
    }
    byProduct.set(key, ingredient);
    out.push(ingredient);
  });
  // id 중복 정리
  const seen = new Set();
  for (const ingredient of out) {
    let id = ingredient.id;
    while (seen.has(id)) id = randomId('ing');
    ingredient.id = id;
    seen.add(id);
  }
  return out;
}

function normalizeRecipe(raw = {}, index = 0) {
  const name = trimmed(raw.name, MAX_RECIPE_NAME);
  if (!name) throw badInput(`${index + 1}번째 요리 이름이 없습니다.`);
  return {
    id: trimmed(raw.id, 80) || randomId('recipe'),
    name,
    note: trimmed(raw.note, MAX_RECIPE_NOTE),
    selectedForNextRun: raw.selectedForNextRun === true,
    ingredients: normalizeIngredients(raw.ingredients, name),
    createdAt: Number(raw.createdAt) || null,
    updatedAt: Number(raw.updatedAt) || null,
  };
}

function normalizeRecipes(raw, { maxRecipes = MAX_RECIPES } = {}) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badInput('요리 목록이 올바르지 않습니다.');
  if (raw.length > maxRecipes) throw badInput(`요리는 최대 ${maxRecipes}개까지 등록할 수 있습니다.`);
  const out = raw.map((recipe, i) => normalizeRecipe(recipe, i));
  const seenIds = new Set();
  for (const recipe of out) {
    let id = recipe.id;
    while (seenIds.has(id)) id = randomId('recipe');
    recipe.id = id;
    seenIds.add(id);
  }
  return out;
}

function normalizeRecipeSettings(raw = {}) {
  return {
    // 정기 실행에 이번 주 요리 재료를 함께 담을지
    mergeWithRegularPlan: raw?.mergeWithRegularPlan !== false,
    // 한 번 담은 뒤 선택을 풀어 다음 주를 깨끗하게 시작할지
    clearSelectedAfterRun: raw?.clearSelectedAfterRun !== false,
  };
}

function normalizeRunMode(raw) {
  const mode = String(raw ?? '').trim();
  return RUN_MODES.includes(mode) ? mode : 'auto';
}

/* ─────────────── 계산을 위한 작은 도우미 ─────────────── */

function selectedRecipes(user) {
  return (Array.isArray(user?.recipes) ? user.recipes : []).filter((r) => r.selectedForNextRun);
}

function includedIngredients(recipe) {
  return (recipe?.ingredients || []).filter((i) => !i.skippedThisWeek);
}

function regularActiveItems(user) {
  return (Array.isArray(user?.items) ? user.items : []).filter((i) => i.active !== false);
}

/**
 * 실행 모드를 실제로 결정합니다.
 *  · auto: '정기 실행에 함께 담기'가 켜져 있고 이번 주 요리가 있으면 combined, 아니면 regular_only
 */
function resolveRunMode(user, mode = 'auto') {
  const requested = normalizeRunMode(mode);
  if (requested !== 'auto') return requested;
  const settings = normalizeRecipeSettings(user?.recipeSettings);
  const hasRecipes = selectedRecipes(user).length > 0;
  return settings.mergeWithRegularPlan && hasRecipes ? 'combined' : 'regular_only';
}

/**
 * 이번 실행에 담을 상품 목록을 만듭니다. (정기 품목 + 요리 재료)
 *  · 같은 상품번호는 한 줄로만 담고, 수량은 더하지 않습니다.
 *  · 정기 품목에 이미 있는 상품은 정기 품목의 수량을 그대로 씁니다.
 *  · 요리끼리만 겹치는 재료는 큰 수량(max)을 씁니다.
 * @returns {{mode:string, items:Array, counts:object, estimatedTotal:number}}
 */
function mergeForRun(user, { mode = 'auto' } = {}) {
  const resolved = resolveRunMode(user, mode);
  const includeRegular = resolved === 'combined' || resolved === 'regular_only';
  const includeRecipes = resolved === 'combined' || resolved === 'recipes_only';

  const items = [];
  const indexByProduct = new Map();
  let dedupedLines = 0;

  /**
   * 한 줄을 더합니다. 같은 상품이 이미 있으면 수량을 더하지 않습니다.
   *  · 정기 품목에 있던 상품  → 정기 품목의 수량을 그대로 유지
   *  · 요리끼리 겹치는 재료  → 둘 중 큰 수량만 유지 (두 배로 주문하지 않게)
   */
  const addEntry = (entry, sourceName, { fromRegular = false } = {}) => {
    const key = String(entry.productNo);
    const existing = indexByProduct.get(key);
    if (!existing) {
      const item = {
        ...entry,
        quantity: clampQuantity(entry.quantity),
        sources: [sourceName],
        fromRegular,
      };
      indexByProduct.set(key, item);
      items.push(item);
      return;
    }
    dedupedLines += 1;
    if (fromRegular && !existing.fromRegular) {
      // 정기 품목이 나중에 나오는 경우는 없지만, 그때도 정기 수량을 우선합니다.
      existing.quantity = clampQuantity(entry.quantity);
      existing.fromRegular = true;
    } else if (!existing.fromRegular && !fromRegular) {
      // 여러 요리에 같은 재료가 있으면 큰 수량만 남깁니다.
      existing.quantity = Math.max(existing.quantity, clampQuantity(entry.quantity));
    }
    // existing.fromRegular 이고 요리 재료인 경우: 정기 수량을 그대로 둡니다.
    if (!existing.sources.includes(sourceName)) existing.sources.push(sourceName);
    if (!(Number(existing.price) > 0) && Number(entry.price) > 0) existing.price = entry.price;
    if (!existing.dealProductNo && entry.dealProductNo) existing.dealProductNo = entry.dealProductNo;
    if (!existing.imageUrl && entry.imageUrl) existing.imageUrl = entry.imageUrl;
    if (!existing.optionName && entry.optionName) existing.optionName = entry.optionName;
  };

  let regularCount = 0;
  if (includeRegular) {
    for (const item of regularActiveItems(user)) {
      addEntry(
        {
          id: item.id,
          productNo: item.productNo,
          dealProductNo: item.dealProductNo ?? null,
          name: item.name,
          optionName: item.optionName ?? null,
          unitLabel: item.unitLabel,
          unitSize: item.unitSize,
          consumption: item.consumption,
          quantity: computeQuantity(item),
          price: Math.max(0, Number(item.price) || 0),
          imageUrl: item.imageUrl ?? null,
          volume: item.volume ?? null,
          url: item.url ?? `https://www.kurly.com/goods/${item.productNo}`,
        },
        'regular',
        { fromRegular: true }
      );
      regularCount += 1;
    }
  }

  const pickedRecipes = includeRecipes ? selectedRecipes(user) : [];
  let recipeIngredientCount = 0;
  let skippedCount = 0;
  for (const recipe of pickedRecipes) {
    for (const ingredient of recipe.ingredients || []) {
      if (ingredient.skippedThisWeek) {
        skippedCount += 1;
        continue;
      }
      recipeIngredientCount += 1;
      addEntry(
        {
          id: `recipe-${recipe.id}-${ingredient.productNo}`,
          productNo: ingredient.productNo,
          dealProductNo: ingredient.dealProductNo ?? null,
          name: ingredient.name,
          optionName: ingredient.optionName ?? null,
          unitLabel: ingredient.volume ? null : '개',
          unitSize: 1,
          consumption: null,
          quantity: clampQuantity(ingredient.quantity),
          price: Math.max(0, Number(ingredient.price) || 0),
          imageUrl: ingredient.imageUrl ?? null,
          volume: ingredient.volume ?? null,
          url: ingredient.url ?? `https://www.kurly.com/goods/${ingredient.productNo}`,
        },
        `recipe:${recipe.name}`
      );
    }
  }

  return {
    mode: resolved,
    items: items.map((item) => {
      const { fromRegular, ...rest } = item;
      const fromRecipe = item.sources.some((s) => s !== 'regular');
      return {
        ...rest,
        source: fromRegular && fromRecipe ? 'both' : fromRegular ? 'regular' : 'recipe',
        recipeNames: item.sources.filter((s) => s.startsWith('recipe:')).map((s) => s.slice('recipe:'.length)),
      };
    }),
    counts: {
      regular: regularCount,
      recipeCount: pickedRecipes.length,
      recipeNames: pickedRecipes.map((r) => r.name),
      recipeIngredientCount,
      skipped: skippedCount,
      unique: items.length,
      // 수량을 더하지 않고 한 줄로 정리한 횟수 (정기 품목과 겹친 요리 재료 포함)
      deduped: dedupedLines,
      merged: dedupedLines,
    },
    estimatedTotal: items.reduce((sum, i) => sum + (Number(i.price) || 0) * i.quantity, 0),
  };
}

/** 화면에 보여줄 요리 요약 */
function summarizeRecipes(user, { nowMs = Date.now() } = {}) {
  void nowMs;
  const recipes = Array.isArray(user?.recipes) ? user.recipes : [];
  const settings = normalizeRecipeSettings(user?.recipeSettings);
  const selected = recipes.filter((r) => r.selectedForNextRun);
  const ingredientCount = recipes.reduce((sum, r) => sum + (r.ingredients || []).length, 0);
  let includedIngredientCount = 0;
  let skippedCount = 0;
  let recipeEstimatedTotal = 0;
  for (const recipe of selected) {
    for (const ingredient of recipe.ingredients || []) {
      if (ingredient.skippedThisWeek) {
        skippedCount += 1;
        continue;
      }
      includedIngredientCount += 1;
      recipeEstimatedTotal += (Number(ingredient.price) || 0) * clampQuantity(ingredient.quantity);
    }
  }
  const merged = mergeForRun(user, { mode: 'auto' });
  return {
    recipeCount: recipes.length,
    selectedCount: selected.length,
    selectedIds: selected.map((r) => r.id),
    selectedNames: selected.map((r) => r.name),
    ingredientCount,
    includedIngredientCount,
    skippedCount,
    recipeEstimatedTotal,
    mergeWithRegularPlan: settings.mergeWithRegularPlan,
    clearSelectedAfterRun: settings.clearSelectedAfterRun,
    runMode: merged.mode,
    plannedCount: merged.items.length,
    plannedEstimatedTotal: merged.estimatedTotal,
    regularActiveCount: regularActiveItems(user).length,
  };
}

/**
 * 한 번 담은 뒤의 요리 목록 — 선택을 풀고, 이번 주 제외(skippedThisWeek)를 모두 되돌립니다.
 * @returns {{recipes:Array, cleared:number}}
 */
function resetAfterRun(recipes) {
  let cleared = 0;
  const out = (Array.isArray(recipes) ? recipes : []).map((recipe) => {
    const wasSelected = recipe.selectedForNextRun === true;
    if (wasSelected) cleared += 1;
    return {
      ...recipe,
      selectedForNextRun: false,
      ingredients: (recipe.ingredients || []).map((i) =>
        i.skippedThisWeek ? { ...i, skippedThisWeek: false } : i
      ),
    };
  });
  return { recipes: out, cleared };
}

/** 요약 문구: "정기 4개 + 이번 주 요리 2개(재료 5개)" */
function describeRunMix(counts = {}) {
  const bits = [];
  if (counts.regular) bits.push(`정기 ${counts.regular}개`);
  if (counts.recipeCount) bits.push(`이번 주 요리 ${counts.recipeCount}개(재료 ${counts.recipeIngredientCount}개)`);
  if (!bits.length) return '';
  return bits.join(' + ');
}

module.exports = {
  MAX_RECIPES,
  MAX_INGREDIENTS_PER_RECIPE,
  MAX_RECIPE_NAME,
  MAX_RECIPE_NOTE,
  MAX_QUANTITY,
  RUN_MODES,
  RUN_MODE_LABEL,
  clampQuantity,
  normalizeIngredient,
  normalizeIngredients,
  normalizeRecipe,
  normalizeRecipes,
  normalizeRecipeSettings,
  normalizeRunMode,
  selectedRecipes,
  includedIngredients,
  resolveRunMode,
  mergeForRun,
  summarizeRecipes,
  resetAfterRun,
  describeRunMix,
};
