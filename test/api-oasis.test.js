'use strict';
/**
 * /api/search · /api/product · /api/plan · /api/recipes · /api/checklist 의 마켓(market) 처리.
 *  · 바깥 사이트(컬리·오아시스)로 나가는 fetch 만 fixture 로 바꿔 끼웁니다 — 네트워크 불필요.
 *  · 같은 상품번호(100888)를 컬리와 오아시스에 각각 담아, 서버가 섞지 않는지 확인합니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { setupEnv, startServer, request, register, SILENT_LOGGER } = require('./helpers');

setupEnv();

const OASIS_SEARCH_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'oasis-search.html'), 'utf8');
const OASIS_DETAIL_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'oasis-detail.html'), 'utf8');
const KURLY_SEARCH_JSON = JSON.stringify({
  data: {
    listSections: [
      {
        view: { sectionCode: 'PRODUCT_LIST' },
        data: {
          totalCount: 1,
          items: [
            {
              no: 100888,
              name: '컬리 유정란 15구',
              shortDescription: '깐깐하게 고른 달걀',
              discountedPrice: 8290,
              salesPrice: 9990,
              discountRate: 17,
              listImageUrl: 'https://img-cf.kurly.com/goods/100888.jpg',
              isSoldOut: false,
            },
          ],
        },
      },
    ],
  },
});

// 바깥 사이트 요청만 가로채고, 테스트 서버(127.0.0.1) 요청은 그대로 보냅니다.
const realFetch = global.fetch;
const requested = [];
global.fetch = async (url, init) => {
  const target = String(url);
  requested.push(target);
  if (target.startsWith('https://m.oasis.co.kr/product/search')) {
    return new Response(OASIS_SEARCH_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (target.startsWith('https://m.oasis.co.kr/product/detail/')) {
    return new Response(OASIS_DETAIL_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (target.startsWith('https://api.kurly.com/search/')) {
    return new Response(KURLY_SEARCH_JSON, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

test.after(() => {
  global.fetch = realFetch;
});

let server;
test.before(async () => {
  server = await startServer({ logger: SILENT_LOGGER });
});
test.after(async () => {
  if (server) await server.close();
});

async function signup() {
  const res = await register(server.baseUrl, { nickname: `마켓${Math.random().toString(36).slice(2, 6)}` });
  assert.equal(res.status, 201);
  return res.cookie;
}

test('검색: market 을 주지 않으면 컬리, market=oasis 면 오아시스에서 찾는다', async () => {
  const cookie = await signup();

  const kurly = await request(server.baseUrl, '/api/search?q=%EC%9C%A0%EC%A0%95%EB%9E%80', { cookie });
  assert.equal(kurly.status, 200);
  assert.equal(kurly.body.market, 'kurly');
  assert.equal(kurly.body.products[0].market, 'kurly');
  assert.match(requested.at(-1), /^https:\/\/api\.kurly\.com\//);

  const oasis = await request(server.baseUrl, '/api/search?q=%EC%9C%A0%EC%A0%95%EB%9E%80&market=oasis', { cookie });
  assert.equal(oasis.status, 200);
  assert.equal(oasis.body.market, 'oasis');
  assert.equal(oasis.body.products.length, 3);
  assert.equal(oasis.body.total, 3);
  const egg = oasis.body.products.find((p) => p.no === 100888);
  assert.equal(egg.market, 'oasis');
  assert.equal(egg.price, 25000);
  assert.equal(egg.url, 'https://m.oasis.co.kr/product/detail/100888');
  assert.match(requested.at(-1), /^https:\/\/m\.oasis\.co\.kr\/product\/search\?keyword=/);
});

test('검색: 모르는 market 값은 400 으로 거절한다', async () => {
  const cookie = await signup();
  const bad = await request(server.baseUrl, '/api/search?q=%EC%9C%A0%EC%A0%95%EB%9E%80&market=coupang', { cookie });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /kurly 또는 oasis/);
});

test('상품 상세: market=oasis 는 오아시스 페이지에서 읽는다', async () => {
  const cookie = await signup();
  const res = await request(server.baseUrl, '/api/product?no=100888&market=oasis', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.market, 'oasis');
  assert.equal(res.body.product.name, '미식만찬 난각번호1번 오늘 산란한 유정란 40구 동물복지 인증');
  assert.deepEqual(res.body.product.unitSuggestion, { unitSize: 40, unitLabel: '구' });
  assert.match(requested.at(-1), /^https:\/\/m\.oasis\.co\.kr\/product\/detail\/100888$/);
});

test('계획: 컬리·오아시스 상품이 각자의 market 으로 저장되고, 장볼 목록도 마켓별로 나뉜다', async () => {
  const cookie = await signup();
  const save = await request(server.baseUrl, '/api/plan', {
    method: 'POST',
    cookie,
    body: {
      items: [
        { id: 'k', market: 'kurly', productNo: 100888, name: '컬리 유정란 15구', unitSize: 15, unitLabel: '구', consumption: 15, price: 8290 },
        { id: 'o', market: 'oasis', productNo: 100888, name: '오아시스 유정란 40구', unitSize: 40, unitLabel: '구', consumption: 40, price: 25000 },
      ],
      schedule: { intervalWeeks: 1, weekday: 5, time: '21:00' },
      notification: {},
    },
  });
  assert.equal(save.status, 200);
  const items = save.body.plan.items;
  assert.deepEqual(items.map((i) => `${i.market}:${i.productNo}`).sort(), ['kurly:100888', 'oasis:100888']);
  assert.equal(items.find((i) => i.market === 'oasis').url, 'https://m.oasis.co.kr/product/detail/100888');

  const list = await request(server.baseUrl, '/api/checklist', { cookie });
  assert.equal(list.status, 200);
  assert.equal(list.body.checklist.count, 2);
  assert.deepEqual(list.body.checklist.marketCounts, { kurly: 1, oasis: 1 });

  // 오아시스 상품만 체크 → 컬리 상품(같은 상품번호)은 그대로 남아 있어야 합니다.
  const check = await request(server.baseUrl, '/api/checklist/check', {
    method: 'POST',
    cookie,
    body: { market: 'oasis', productNo: 100888, checked: true },
  });
  assert.equal(check.status, 200);
  const after = check.body.checklist;
  assert.equal(after.items.find((i) => i.market === 'oasis').checked, true);
  assert.equal(after.items.find((i) => i.market === 'kurly').checked, false);

  const uncheck = await request(server.baseUrl, '/api/checklist/check', {
    method: 'POST',
    cookie,
    body: { market: 'oasis', productNo: 100888, checked: false },
  });
  assert.equal(uncheck.body.checklist.checkedCount, 0);
});

test('요리 재료: market=oasis 재료가 그대로 저장되고 목록에 오아시스로 나온다', async () => {
  const cookie = await signup();
  const save = await request(server.baseUrl, '/api/recipes', {
    method: 'PUT',
    cookie,
    body: {
      recipes: [
        {
          name: '계란말이',
          selectedForNextRun: true,
          ingredients: [
            { name: '오아시스 유정란 40구', market: 'oasis', productNo: 100888, price: 25000, quantity: 1 },
            { name: '대파', productNo: 900, price: 3200, quantity: 1 },
          ],
        },
      ],
      recipeSettings: {},
    },
  });
  assert.equal(save.status, 200);
  const ingredients = save.body.recipes[0].ingredients;
  assert.equal(ingredients[0].market, 'oasis');
  assert.equal(ingredients[0].url, 'https://m.oasis.co.kr/product/detail/100888');
  assert.equal(ingredients[1].market, 'kurly');

  const list = await request(server.baseUrl, '/api/checklist', { cookie });
  const oasis = list.body.checklist.items.filter((i) => i.market === 'oasis');
  assert.equal(oasis.length, 1);
  assert.equal(oasis[0].name, '오아시스 유정란 40구');
  assert.equal(oasis[0].source, 'recipe');
});
