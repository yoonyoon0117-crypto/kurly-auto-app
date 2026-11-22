'use strict';
/**
 * 기본 상품(seeds) — 컬리 4개 + 오아시스 4개.
 *  · 가격·상품번호는 실제 마켓에서 확인한 값입니다. (컬리 2026-11-18, 오아시스 2026-11-22)
 *  · 오아시스 상품은 자동 담기 대상이 아니므로 market='oasis' 로 구분되어야 합니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { STARTER_ITEMS, starterItems } = require('../lib/seeds');
const { computeQuantity, productUrlFor } = require('../lib/plan');

test('기본 상품: 컬리 4개 + 오아시스 4개, 모두 8개', () => {
  assert.equal(STARTER_ITEMS.length, 8);
  const kurly = STARTER_ITEMS.filter((i) => i.market === 'kurly');
  const oasis = STARTER_ITEMS.filter((i) => i.market === 'oasis');
  assert.equal(kurly.length, 4);
  assert.equal(oasis.length, 4);
});

test('기본 상품: 오아시스 4개는 상품번호·가격·단위가 확인된 값', () => {
  const byNo = new Map(STARTER_ITEMS.map((i) => [i.productNo, i]));
  const expected = [
    { productNo: 105322, price: 11600, unitSize: 20, unitLabel: '구' },
    { productNo: 98649, price: 11800, unitSize: 1.3, unitLabel: 'kg' },
    { productNo: 74079, price: 4620, unitSize: 2, unitLabel: '입' },
    { productNo: 1116, price: 6950, unitSize: 350, unitLabel: 'g' },
  ];
  for (const want of expected) {
    const item = byNo.get(want.productNo);
    assert.ok(item, `상품번호 ${want.productNo} 가 기본 상품에 있어야 합니다.`);
    assert.equal(item.market, 'oasis');
    assert.equal(item.price, want.price);
    assert.equal(item.unitSize, want.unitSize);
    assert.equal(item.unitLabel, want.unitLabel);
    assert.equal(computeQuantity(item), 1, '기본 소비량은 1주에 1단위(1개)입니다.');
    assert.equal(item.url, productUrlFor('oasis', want.productNo));
  }
});

test('기본 상품: 오아시스 4개 합계 34,970원 (컬리 4개 37,576원)', () => {
  const total = (market) =>
    STARTER_ITEMS.filter((i) => i.market === market).reduce((sum, i) => sum + i.price * computeQuantity(i), 0);
  assert.equal(total('oasis'), 11600 + 11800 + 4620 + 6950);
  assert.equal(total('oasis'), 34970);
  assert.equal(total('kurly'), 8290 + 12900 + 5990 + 10396);
  assert.equal(total('kurly') + total('oasis'), 72546);
});

test('기본 상품: id 는 사용자별로 겹치지 않게 붙고, 마켓·상품번호도 유일하다', () => {
  const plain = starterItems('');
  const mine = starterItems('user-1234567');
  assert.equal(new Set(plain.map((i) => i.id)).size, plain.length);
  assert.equal(new Set(mine.map((i) => i.id)).size, mine.length);
  assert.equal(mine[0].id, `${plain[0].id}-user-1`);
  assert.equal(new Set(mine.map((i) => `${i.market}:${i.productNo}`)).size, mine.length);
  // 원본은 그대로 (얕은 복사)
  assert.equal(STARTER_ITEMS[0].id, plain[0].id);
});

test('기본 상품: 모든 항목이 계획 저장에 필요한 값을 갖춘다', () => {
  for (const item of STARTER_ITEMS) {
    assert.ok(item.name);
    assert.ok(Number.isInteger(item.productNo) && item.productNo > 0);
    assert.ok(item.unitSize > 0);
    assert.ok(item.consumption >= 0);
    assert.ok(item.unitLabel);
    assert.ok(/^https:\/\//.test(item.url));
    assert.equal(item.quantityOverride, null);
    assert.equal(item.active, true);
  }
});
