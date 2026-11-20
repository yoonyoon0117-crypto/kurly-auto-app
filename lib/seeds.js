'use strict';
/**
 * 기본 4개 상품 — 기존 kurly-auto-cart 에서 2026-11-18 실제 검색·재고·가격으로 확인한 목록.
 * 회원가입 직후 한 번에 불러올 수 있습니다(언제든 수정·삭제 가능).
 */
const STARTER_ITEMS = [
  {
    id: 'item-eggs',
    productNo: 5029849,
    dealProductNo: 10029849,
    name: "[Kurly's] 동물복지 유정란 15구",
    shortDescription: '깐깐하게 고른 우리집 달걀',
    imageUrl: 'https://img-cf.kurly.com/shop/data/goods/1655861174158l0.jpg',
    price: 8290,
    unitPriceText: '1구 당 553원',
    volume: '15구 (780g)',
    url: 'https://www.kurly.com/goods/5029849',
    unitSize: 15,
    unitLabel: '구',
    consumption: 15,
    quantityOverride: null,
    optionName: null,
    active: true,
    note: '1주에 15구(1팩) 기준',
  },
  {
    id: 'item-apple',
    productNo: 5061259,
    dealProductNo: 10061259,
    name: '고랭지 햇사과 1.3kg (4~6입)',
    shortDescription: '달콤하게 만나는 사과',
    imageUrl: 'https://product-image.kurly.com/product/image/14eca172-5349-4870-b7cb-fb93f470f432.jpg',
    price: 12900,
    unitPriceText: '100g 당 992원',
    volume: '1.3kg내외',
    url: 'https://www.kurly.com/goods/5061259',
    unitSize: 1.3,
    unitLabel: 'kg',
    consumption: 1.3,
    quantityOverride: null,
    optionName: null,
    active: true,
    note: '1주에 1.3kg(1봉) 기준',
  },
  {
    id: 'item-cucumber',
    productNo: 1002030322,
    dealProductNo: 1002030321,
    name: '[제각각] 다다기오이 5입',
    shortDescription: '휘어진 모습이 개성 있는',
    imageUrl: 'https://product-image.kurly.com/product/image/a5a3c278-21ea-48c2-b16d-fab6e8c9d07e.jpg',
    price: 5990,
    unitPriceText: '1개 당 1,198원',
    volume: '',
    url: 'https://www.kurly.com/goods/1002030322',
    unitSize: 5,
    unitLabel: '입',
    consumption: 5,
    quantityOverride: null,
    optionName: null,
    active: true,
    note: '1주에 5입(1봉) 기준',
  },
  {
    id: 'item-chicken',
    productNo: 5090273,
    dealProductNo: 10090273,
    name: '[자연실록] 무항생제 닭 다리살 (정육) 500g',
    shortDescription: '간편하게 즐기는 촉촉한 살코기',
    imageUrl: 'https://product-image.kurly.com/product/image/8f07cafa-4640-47bf-a859-55711ea29713.jpeg',
    price: 10396,
    unitPriceText: '100g 당 2,079원',
    volume: '500g',
    url: 'https://www.kurly.com/goods/5090273',
    unitSize: 500,
    unitLabel: 'g',
    consumption: 500,
    quantityOverride: null,
    optionName: null,
    active: true,
    note: '1주에 500g(1팩) 기준',
  },
];

/** 새 사용자에게 넣어줄 기본 상품 (id 접두어를 사용자별로 분리) */
function starterItems(userId = '') {
  const suffix = userId ? `-${String(userId).slice(0, 6)}` : '';
  return STARTER_ITEMS.map((item) => ({ ...item, id: `${item.id}${suffix}` }));
}

module.exports = { STARTER_ITEMS, starterItems };
