'use strict';
/**
 * 요리(레시피) — 검증, 정기 품목과의 합치기, 중복 재료 처리, 이번 주 제외, 담은 뒤 초기화.
 *
 *  핵심 규칙: 같은 상품(productNo)은 한 줄로만 담고 **수량을 더하지 않습니다.**
 *   · 정기 품목에 있는 상품   → 정기 품목의 수량 그대로
 *   · 요리끼리 겹치는 재료    → 둘 중 큰 수량
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRecipes,
  normalizeRecipeSettings,
  normalizeRunMode,
  mergeForRun,
  summarizeRecipes,
  resetAfterRun,
  describeRunMix,
  MAX_QUANTITY,
} = require('../lib/recipes');

const egg = (quantity = 2, extra = {}) => ({
  productNo: 5029849,
  dealProductNo: 10029849,
  name: '유정란 15구',
  price: 8290,
  volume: '15구',
  quantity,
  ...extra,
});

function regularItem(overrides = {}) {
  return {
    id: 'item-1',
    productNo: 5029849,
    dealProductNo: 10029849,
    name: '유정란 15구',
    unitSize: 15,
    unitLabel: '구',
    consumption: 30, // → 2개
    price: 8290,
    active: true,
    ...overrides,
  };
}

function makeUser(overrides = {}) {
  return {
    items: [regularItem()],
    recipes: [],
    recipeSettings: {},
    ...overrides,
  };
}

test('요리 설정 기본값: 정기와 함께 담기 / 담은 뒤 선택 해제 둘 다 켜짐', () => {
  assert.deepEqual(normalizeRecipeSettings(), { mergeWithRegularPlan: true, clearSelectedAfterRun: true });
  assert.deepEqual(normalizeRecipeSettings({}), { mergeWithRegularPlan: true, clearSelectedAfterRun: true });
  assert.deepEqual(normalizeRecipeSettings({ mergeWithRegularPlan: false, clearSelectedAfterRun: false }), {
    mergeWithRegularPlan: false,
    clearSelectedAfterRun: false,
  });
  assert.equal(normalizeRunMode('recipes_only'), 'recipes_only');
  assert.equal(normalizeRunMode('nope'), 'auto');
});

test('요리 검증 — 이름·상품번호가 없으면 거부, 수량은 1~99', () => {
  const [recipe] = normalizeRecipes([
    {
      id: 'r1',
      name: '된장찌개',
      note: '주말 저녁',
      selectedForNextRun: true,
      ingredients: [
        { productNo: 1, name: '두부', price: 2900, quantity: 0 },
        { productNo: 2, name: '애호박', price: 1980, quantity: 200 },
      ],
    },
  ]);
  assert.equal(recipe.name, '된장찌개');
  assert.equal(recipe.note, '주말 저녁');
  assert.equal(recipe.selectedForNextRun, true);
  assert.equal(recipe.ingredients[0].quantity, 1, '0 이하는 1로 올립니다.');
  assert.equal(recipe.ingredients[1].quantity, MAX_QUANTITY, '99를 넘지 않습니다.');
  assert.match(recipe.ingredients[0].url, /kurly\.com\/goods\/1/);

  assert.throws(() => normalizeRecipes([{ name: '', ingredients: [] }]), /이름/);
  assert.throws(() => normalizeRecipes([{ name: '찌개', ingredients: [{ productNo: 0, name: '두부' }] }]), /상품번호/);
  assert.throws(() => normalizeRecipes([{ name: '찌개', ingredients: [{ productNo: 1, name: '' }] }]), /재료 이름/);
  assert.throws(() => normalizeRecipes('nope'), /요리 목록/);
  assert.throws(
    () => normalizeRecipes(Array.from({ length: 61 }, (_, i) => ({ name: `요리${i}`, ingredients: [] }))),
    /최대/
  );
});

test('한 요리 안에서 같은 재료를 두 번 넣어도 수량은 큰 쪽만 남는다', () => {
  const [recipe] = normalizeRecipes([
    {
      name: '찌개',
      ingredients: [
        { productNo: 11, name: '두부', quantity: 2 },
        { productNo: 11, name: '두부', quantity: 1 },
      ],
    },
  ]);
  assert.equal(recipe.ingredients.length, 1);
  assert.equal(recipe.ingredients[0].quantity, 2);
});

test('정기 품목 + 이번 주 요리 — 같은 상품은 수량을 더하지 않고 정기 수량을 유지', () => {
  const user = makeUser({
    items: [regularItem({ consumption: 30 })], // 정기 2개
    recipes: [
      {
        id: 'r1',
        name: '계란말이',
        selectedForNextRun: true,
        ingredients: [egg(1), { productNo: 900, name: '대파', price: 3200, quantity: 1 }],
      },
    ],
  });

  const merged = mergeForRun(user, { mode: 'combined' });
  assert.equal(merged.mode, 'combined');
  const eggLine = merged.items.find((i) => i.productNo === 5029849);
  assert.equal(merged.items.filter((i) => i.productNo === 5029849).length, 1, '한 줄로만 담습니다.');
  assert.equal(eggLine.quantity, 2, '정기 품목 수량(2)을 그대로 유지합니다 (2+1=3 이 아님).');
  assert.equal(eggLine.source, 'both');
  assert.deepEqual(eggLine.recipeNames, ['계란말이']);
  assert.equal(merged.items.length, 2);
  assert.equal(merged.counts.deduped, 1);
  assert.equal(merged.estimatedTotal, 8290 * 2 + 3200);
});

test('여러 요리에 같은 재료가 있으면 큰 수량만 담는다', () => {
  const user = makeUser({
    items: [],
    recipes: [
      { id: 'r1', name: '된장찌개', selectedForNextRun: true, ingredients: [egg(1)] },
      { id: 'r2', name: '계란말이', selectedForNextRun: true, ingredients: [egg(3)] },
      { id: 'r3', name: '볶음밥', selectedForNextRun: true, ingredients: [egg(2)] },
    ],
  });
  const merged = mergeForRun(user, { mode: 'recipes_only' });
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].quantity, 3, '1+3+2=6 이 아니라 큰 값 3');
  assert.equal(merged.items[0].source, 'recipe');
  assert.deepEqual(merged.items[0].recipeNames, ['된장찌개', '계란말이', '볶음밥']);
  assert.equal(merged.counts.deduped, 2);
});

test('이번 주 제외(skippedThisWeek) 재료는 담지 않고, 선택하지 않은 요리도 담지 않는다', () => {
  const user = makeUser({
    items: [],
    recipes: [
      {
        id: 'r1',
        name: '된장찌개',
        selectedForNextRun: true,
        ingredients: [
          { productNo: 21, name: '두부', price: 2900, quantity: 1, skippedThisWeek: true },
          { productNo: 22, name: '애호박', price: 1980, quantity: 1 },
        ],
      },
      {
        id: 'r2',
        name: '김치찌개',
        selectedForNextRun: false,
        ingredients: [{ productNo: 31, name: '김치', price: 5500, quantity: 1 }],
      },
    ],
  });
  const merged = mergeForRun(user, { mode: 'combined' });
  assert.deepEqual(
    merged.items.map((i) => i.productNo),
    [22]
  );
  assert.equal(merged.counts.skipped, 1);
  assert.equal(merged.counts.recipeCount, 1);
  assert.equal(merged.counts.recipeIngredientCount, 1);
  assert.equal(merged.estimatedTotal, 1980);
});

test('모드별 담을 범위 — regular_only / recipes_only / auto', () => {
  const user = makeUser({
    items: [regularItem()],
    recipes: [
      { id: 'r1', name: '계란말이', selectedForNextRun: true, ingredients: [{ productNo: 900, name: '대파', price: 3200, quantity: 1 }] },
    ],
  });

  const regularOnly = mergeForRun(user, { mode: 'regular_only' });
  assert.equal(regularOnly.items.length, 1);
  assert.equal(regularOnly.items[0].productNo, 5029849);

  const recipesOnly = mergeForRun(user, { mode: 'recipes_only' });
  assert.equal(recipesOnly.items.length, 1);
  assert.equal(recipesOnly.items[0].productNo, 900);

  // auto: 정기와 함께 담기가 켜져 있고 이번 주 요리가 있으면 combined
  assert.equal(mergeForRun(user, { mode: 'auto' }).mode, 'combined');
  assert.equal(mergeForRun(user, { mode: 'auto' }).items.length, 2);

  // '함께 담기'를 끄면 정기 품목만
  const separated = { ...user, recipeSettings: { mergeWithRegularPlan: false } };
  assert.equal(mergeForRun(separated, { mode: 'auto' }).mode, 'regular_only');
  assert.equal(mergeForRun(separated, { mode: 'auto' }).items.length, 1);

  // 이번 주 요리가 없으면 정기 품목만
  const noneSelected = { ...user, recipes: user.recipes.map((r) => ({ ...r, selectedForNextRun: false })) };
  assert.equal(mergeForRun(noneSelected, { mode: 'auto' }).mode, 'regular_only');
});

test('요약 — 선택 요리·재료 수·예상 금액·실행 모드', () => {
  const user = makeUser({
    items: [regularItem()],
    recipes: [
      {
        id: 'r1',
        name: '된장찌개',
        selectedForNextRun: true,
        ingredients: [
          { productNo: 21, name: '두부', price: 2900, quantity: 1 },
          { productNo: 22, name: '애호박', price: 1980, quantity: 2, skippedThisWeek: true },
        ],
      },
      { id: 'r2', name: '김치찌개', selectedForNextRun: false, ingredients: [] },
    ],
  });
  const summary = summarizeRecipes(user);
  assert.equal(summary.recipeCount, 2);
  assert.equal(summary.selectedCount, 1);
  assert.deepEqual(summary.selectedNames, ['된장찌개']);
  assert.equal(summary.includedIngredientCount, 1);
  assert.equal(summary.skippedCount, 1);
  assert.equal(summary.recipeEstimatedTotal, 2900);
  assert.equal(summary.runMode, 'combined');
  assert.equal(summary.plannedCount, 2, '정기 1 + 요리 1 (겹치지 않음)');
  assert.equal(describeRunMix({ regular: 4, recipeCount: 2, recipeIngredientCount: 5 }), '정기 4개 + 이번 주 요리 2개(재료 5개)');
});

test('담은 뒤 초기화 — 선택을 풀고 이번 주 제외도 되돌린다', () => {
  const { recipes, cleared } = resetAfterRun([
    {
      id: 'r1',
      name: '된장찌개',
      selectedForNextRun: true,
      ingredients: [
        { productNo: 21, name: '두부', skippedThisWeek: true },
        { productNo: 22, name: '애호박', skippedThisWeek: false },
      ],
    },
    { id: 'r2', name: '김치찌개', selectedForNextRun: false, ingredients: [] },
  ]);
  assert.equal(cleared, 1);
  assert.equal(recipes[0].selectedForNextRun, false);
  assert.equal(recipes[0].ingredients[0].skippedThisWeek, false);
  assert.equal(recipes[0].ingredients[1].skippedThisWeek, false);
  assert.equal(recipes[1].selectedForNextRun, false);
});
