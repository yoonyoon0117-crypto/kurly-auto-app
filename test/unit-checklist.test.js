'use strict';
/**
 * 장볼 목록(checklist) — 정기 품목 + 이번 주 요리 재료를 그대로 목록으로 만들고,
 * 담음 체크·«담은 뒤 초기화» 를 사용자별로 다룹니다. (수량은 더하지 않는 규칙 그대로)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeChecked, toggleChecked, buildChecklist, completeChecklist, productUrl } = require('../lib/checklist');

function user(overrides = {}) {
  return {
    items: [
      {
        id: 'item-1',
        productNo: 5029849,
        name: '유정란 15구',
        unitSize: 15,
        unitLabel: '구',
        consumption: 30, // → 2개
        price: 8290,
        active: true,
      },
    ],
    recipes: [
      {
        id: 'r1',
        name: '계란말이',
        selectedForNextRun: true,
        ingredients: [
          { productNo: 5029849, name: '유정란 15구', price: 8290, quantity: 1 }, // 정기와 겹침 → 2 유지
          { productNo: 900, name: '대파', price: 3200, quantity: 1 },
        ],
      },
    ],
    recipeSettings: {},
    checklist: { checked: {} },
    ...overrides,
  };
}

test('목록은 정기 품목 + 요리 재료를 합친 결과 그대로 (수량 합산 없음)', () => {
  const list = buildChecklist(user());
  assert.equal(list.count, 2);
  assert.equal(list.mode, 'combined');
  const egg = list.items.find((i) => i.productNo === 5029849);
  assert.equal(egg.quantity, 2, '정기 수량 2 유지 (2+1 아님)');
  assert.equal(egg.source, 'both');
  assert.equal(egg.lineTotal, 8290 * 2);
  assert.equal(egg.url, 'https://www.kurly.com/goods/5029849');
  assert.equal(egg.checked, false);
  assert.equal(list.estimatedTotal, 8290 * 2 + 3200);
  assert.equal(list.checkedCount, 0);
  assert.equal(list.allChecked, false);
  assert.match(list.mixLabel, /정기 1개/);
});

test('담음 체크는 상품번호별로 저장되고 합계에서도 빠진다', () => {
  const list = buildChecklist(user({ checklist: { checked: { 900: true } } }));
  assert.equal(list.checkedCount, 1);
  assert.equal(list.remainingCount, 1);
  assert.equal(list.checkedTotal, 3200);
  assert.equal(list.items.find((i) => i.productNo === 900).checked, true);

  const all = buildChecklist(user({ checklist: { checked: { 900: true, 5029849: true } } }));
  assert.equal(all.allChecked, true);
});

test('저장된 체크 값이 깨져 있어도 안전하게 정리한다', () => {
  assert.deepEqual(sanitizeChecked(null), {});
  assert.deepEqual(sanitizeChecked('nope'), {});
  assert.deepEqual(sanitizeChecked([]), {});
  assert.deepEqual(sanitizeChecked({ 900: true, 0: true, abc: true, 5: false }), { 900: true });
  assert.deepEqual(sanitizeChecked({ 7: 1 }), { 7: true });
});

test('체크 토글 — 지정/반전/해제, 잘못된 상품번호는 거부', () => {
  assert.deepEqual(toggleChecked({}, 900, true), { 900: true });
  assert.deepEqual(toggleChecked({ 900: true }, 900), {}); // 지정 없이 누르면 반전
  assert.deepEqual(toggleChecked({ 900: true }, 900, true), { 900: true });
  assert.deepEqual(toggleChecked({ 900: true }, 900, false), {});
  assert.throws(() => toggleChecked({}, 0, true), /상품번호/);
  assert.throws(() => toggleChecked({}, 'x', true), /상품번호/);
});

test('장보기 완료 — 체크를 비우고, 설정에 따라 요리 선택도 푼다', () => {
  const base = user({
    checklist: { checked: { 900: true } },
    recipes: [
      {
        id: 'r1',
        name: '계란말이',
        selectedForNextRun: true,
        ingredients: [{ productNo: 900, name: '대파', skippedThisWeek: true }],
      },
    ],
  });

  const done = completeChecklist(base);
  assert.deepEqual(done.checked, {});
  assert.equal(done.clearedRecipes, 1);
  assert.equal(done.recipes[0].selectedForNextRun, false);
  assert.equal(done.recipes[0].ingredients[0].skippedThisWeek, false);

  const keep = completeChecklist({ ...base, recipeSettings: { clearSelectedAfterRun: false } });
  assert.equal(keep.clearedRecipes, 0);
  assert.equal(keep.recipes[0].selectedForNextRun, true);
});

test('상품 페이지 주소', () => {
  assert.equal(productUrl(123), 'https://www.kurly.com/goods/123');
  assert.equal(productUrl(0), 'https://www.kurly.com');
});
