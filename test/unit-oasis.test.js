'use strict';
/**
 * 오아시스마켓 — 검색 HTML 파서, 마켓 필드(plan·recipes·checklist), 자동 담기 대상 분리.
 *  · 실제 m.oasis.co.kr 응답에서 발췌한 fixture 로 파싱합니다. (네트워크 불필요)
 *  · 컬리와 오아시스의 상품번호가 겹쳐도 섞이지 않는지 함께 확인합니다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  parseSearchHtml,
  parseTotal,
  parseDetailHtml,
  cleanText,
  decodeEntities,
} = require('../lib/oasis-api');
const { normalizeItem, normalizeMarket, productUrlFor, MARKETS } = require('../lib/plan');
const recipes = require('../lib/recipes');
const checklist = require('../lib/checklist');
const runner = require('../lib/runner');

const SEARCH_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'oasis-search.html'), 'utf8');
const DETAIL_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'oasis-detail.html'), 'utf8');

/* ─────────────── 검색 결과 파싱 ─────────────── */

test('오아시스 검색 HTML 에서 상품번호·이름·가격·썸네일·품절을 읽는다', () => {
  const products = parseSearchHtml(SEARCH_HTML, { limit: 10 });
  assert.equal(products.length, 3);

  const egg = products.find((p) => p.no === 100888);
  assert.equal(egg.market, 'oasis');
  assert.equal(egg.name, '미식만찬 난각번호1번 오늘 산란한 유정란 40구 동물복지 인증');
  assert.equal(egg.price, 25000);
  assert.equal(egg.originalPrice, 29900);
  assert.equal(egg.discountRate, 16);
  assert.equal(egg.soldOut, false);
  assert.equal(egg.shortDescription, '1번유정란');
  assert.equal(egg.imageUrl, 'https://oasisprodproduct.edge.naverncp.com/100888/thumb/300');
  assert.equal(egg.url, 'https://m.oasis.co.kr/product/detail/100888');

  // 품절 상품은 담기 전에 알 수 있게 표시하고, 이름에 섞인 아이콘 태그는 걷어 냅니다.
  const soldOut = products.find((p) => p.no === 104714);
  assert.equal(soldOut.soldOut, true);
  assert.equal(soldOut.name, '동물복지 자유란 15구');
  assert.equal(soldOut.price, 9020);
  assert.equal(soldOut.unitPriceText, null);
});

test('할인 표시가 없는 상품도 판매가를 읽고, 엔티티(&amp;)를 풀어 쓴다', () => {
  const products = parseSearchHtml(SEARCH_HTML, { limit: 10 });
  const tangerine = products.find((p) => p.no === 5001);
  assert.equal(tangerine.price, 9900);
  assert.equal(tangerine.originalPrice, null);
  assert.equal(tangerine.discountRate, 0);
  assert.equal(tangerine.shortDescription, '노지에서 자란 & 당도 높은 제주 감귤');
});

test('limit 만큼만 돌려주고, 상품이 없는 HTML 은 빈 목록', () => {
  assert.equal(parseSearchHtml(SEARCH_HTML, { limit: 2 }).length, 2);
  assert.deepEqual(parseSearchHtml('', { limit: 5 }), []);
  assert.deepEqual(parseSearchHtml('<html><body>결과 없음</body></html>'), []);
});

test('검색 결과 전체 건수(oSearch_cnt)를 읽는다', () => {
  assert.equal(parseTotal(SEARCH_HTML), 3);
  assert.equal(parseTotal('<html></html>'), null);
});

test('텍스트 정리 도우미: 태그·중복 공백·엔티티', () => {
  assert.equal(cleanText('  <b>유정란</b>\n 15구 '), '유정란 15구');
  assert.equal(decodeEntities('감귤 &amp; 사과 &#40;2입&#41;'), '감귤 & 사과 (2입)');
});

/* ─────────────── 상품 상세 파싱 ─────────────── */

test('오아시스 상품 상세에서 이름·가격·단위 추정을 읽는다', () => {
  const detail = parseDetailHtml(DETAIL_HTML, 100888);
  assert.equal(detail.market, 'oasis');
  assert.equal(detail.no, 100888);
  assert.equal(detail.name, '미식만찬 난각번호1번 오늘 산란한 유정란 40구 동물복지 인증');
  assert.equal(detail.shortDescription, '1번유정란');
  assert.equal(detail.price, 25000);
  assert.equal(detail.originalPrice, 29900);
  assert.equal(detail.discountRate, 16);
  assert.deepEqual(detail.unitSuggestion, { unitSize: 40, unitLabel: '구' });
  assert.equal(detail.url, 'https://m.oasis.co.kr/product/detail/100888');
  // 품절 여부는 상세 마크업만으로 확정할 수 없어 비워 둡니다.
  assert.equal(detail.soldOut, null);
});

test('상품 정보가 없는 상세 HTML 은 오류로 알린다', () => {
  assert.throws(() => parseDetailHtml('<html><body>없음</body></html>', 1), /상품 정보를 찾지 못했습니다/);
});

/* ─────────────── 마켓 필드 (plan · recipes) ─────────────── */

test('계획 상품은 market 기본값이 컬리이고, 오아시스는 주소도 오아시스로 만든다', () => {
  assert.deepEqual(MARKETS, ['kurly', 'oasis']);
  assert.equal(normalizeMarket(undefined), 'kurly');
  assert.equal(normalizeMarket('oasis'), 'oasis');
  assert.equal(normalizeMarket('OASIS'), 'oasis');
  assert.equal(normalizeMarket('coupang'), 'kurly');

  const kurly = normalizeItem({ name: '유정란 15구', productNo: 100888, unitSize: 15, unitLabel: '구', consumption: 15 });
  assert.equal(kurly.market, 'kurly');
  assert.equal(kurly.url, 'https://www.kurly.com/goods/100888');

  const oasis = normalizeItem({
    name: '오아시스 유정란 40구',
    market: 'oasis',
    productNo: 100888,
    unitSize: 40,
    unitLabel: '구',
    consumption: 40,
  });
  assert.equal(oasis.market, 'oasis');
  assert.equal(oasis.url, 'https://m.oasis.co.kr/product/detail/100888');
  assert.equal(productUrlFor('oasis', 100888), 'https://m.oasis.co.kr/product/detail/100888');
});

test('요리 재료도 마켓을 기억하고, 같은 상품번호라도 마켓이 다르면 다른 재료', () => {
  const list = recipes.normalizeIngredients(
    [
      { name: '유정란 15구', productNo: 100888, quantity: 1 },
      { name: '오아시스 유정란 40구', market: 'oasis', productNo: 100888, quantity: 2 },
    ],
    '계란말이'
  );
  assert.equal(list.length, 2);
  assert.equal(list[0].market, 'kurly');
  assert.equal(list[1].market, 'oasis');
  assert.equal(list[1].url, 'https://m.oasis.co.kr/product/detail/100888');
});

test('실행 목록(mergeForRun)은 마켓별로 한 줄씩 — 컬리 100888 과 오아시스 100888 은 따로', () => {
  const user = {
    items: [
      { id: 'a', market: 'kurly', productNo: 100888, name: '컬리 유정란', unitSize: 15, unitLabel: '구', consumption: 15, price: 8000, active: true },
      { id: 'b', market: 'oasis', productNo: 100888, name: '오아시스 유정란', unitSize: 40, unitLabel: '구', consumption: 40, price: 25000, active: true },
    ],
    recipeSettings: {},
  };
  const merged = recipes.mergeForRun(user, { mode: 'regular_only' });
  assert.equal(merged.items.length, 2);
  assert.deepEqual(merged.items.map((i) => `${i.market}:${i.productNo}`).sort(), ['kurly:100888', 'oasis:100888']);
  assert.equal(merged.estimatedTotal, 8000 + 25000);
});

/* ─────────────── 장볼 목록 키 분리 ─────────────── */

function mixedUser(checked = {}) {
  return {
    items: [
      { id: 'a', market: 'kurly', productNo: 100888, name: '컬리 유정란', unitSize: 15, unitLabel: '구', consumption: 15, price: 8000, active: true },
      { id: 'b', market: 'oasis', productNo: 100888, name: '오아시스 유정란', unitSize: 40, unitLabel: '구', consumption: 40, price: 25000, active: true },
    ],
    recipes: [],
    recipeSettings: {},
    checklist: { checked },
  };
}

test('장볼 목록은 마켓별 개수를 함께 주고, 상품 주소도 마켓별', () => {
  const list = checklist.buildChecklist(mixedUser());
  assert.equal(list.count, 2);
  assert.deepEqual(list.marketCounts, { kurly: 1, oasis: 1 });
  const kurly = list.items.find((i) => i.market === 'kurly');
  const oasis = list.items.find((i) => i.market === 'oasis');
  assert.equal(kurly.url, 'https://www.kurly.com/goods/100888');
  assert.equal(oasis.url, 'https://m.oasis.co.kr/product/detail/100888');
});

test('담음 체크는 마켓별로 따로 저장된다 (같은 상품번호여도 섞이지 않음)', () => {
  const oasisOnly = checklist.buildChecklist(mixedUser({ 'oasis:100888': true }));
  assert.equal(oasisOnly.checkedCount, 1);
  assert.equal(oasisOnly.items.find((i) => i.market === 'oasis').checked, true);
  assert.equal(oasisOnly.items.find((i) => i.market === 'kurly').checked, false);

  // 예전 저장값(상품번호만)은 컬리 상품의 체크로 이어집니다.
  const legacy = checklist.buildChecklist(mixedUser({ 100888: true }));
  assert.equal(legacy.items.find((i) => i.market === 'kurly').checked, true);
  assert.equal(legacy.items.find((i) => i.market === 'oasis').checked, false);
});

test('toggleChecked 는 마켓을 받고, 예전 호출(상품번호만)도 그대로 동작한다', () => {
  assert.deepEqual(checklist.toggleChecked({}, { market: 'oasis', productNo: 100888 }, true), { 'oasis:100888': true });
  assert.deepEqual(checklist.toggleChecked({ 'oasis:100888': true }, { market: 'oasis', productNo: 100888 }), {});
  assert.deepEqual(checklist.toggleChecked({}, { market: 'kurly', productNo: 900 }, true), { 900: true });
  assert.deepEqual(checklist.toggleChecked({}, 900, true), { 900: true });
  // 저장된 키도 형태를 알아봅니다 (예전 값 정리).
  assert.deepEqual(checklist.sanitizeChecked({ 'oasis:123': true, 'kurly:9': true, 7: true, x: true }), {
    'oasis:123': true,
    9: true,
    7: true,
  });
  assert.throws(() => checklist.toggleChecked({}, { market: 'oasis', productNo: 0 }, true), /상품번호/);
});

/* ─────────────── 자동 담기 대상 분리 ─────────────── */

test('자동 담기는 컬리 상품만 — 오아시스 상품은 목록에서 직접 담는다', () => {
  const planned = runner.plannedItems(mixedUser());
  assert.equal(planned.length, 2);
  assert.equal(planned.find((p) => p.market === 'oasis').url, 'https://m.oasis.co.kr/product/detail/100888');

  const automation = runner.selectAutomationItems(planned);
  assert.equal(automation.length, 1);
  assert.equal(automation[0].market, 'kurly');
  assert.match(runner.OASIS_MANUAL_REASON, /오아시스/);
});

test('오아시스 상품뿐이면 브라우저 없이 장볼 목록으로 준비한다 (목록 알림 모드)', async () => {
  const user = {
    userId: 990001,
    nickname: '앱버',
    items: [
      { id: 'b', market: 'oasis', productNo: 100888, name: '오아시스 유정란', unitSize: 40, unitLabel: '구', consumption: 40, price: 25000, active: true },
    ],
    recipes: [],
    recipeSettings: {},
    checklist: { checked: {} },
    checklistOnly: true,
    notification: {},
  };
  const summary = await runner.runCartForUser({ user, trigger: 'manual', logger: { info() {}, step() {}, warn() {}, error() {} } });
  assert.equal(summary.checklistMode, true);
  assert.equal(summary.checklist.count, 1);
  assert.equal(summary.checklist.reason, 'checklist_only');
  assert.equal(summary.items[0].status, 'planned');
  assert.equal(summary.items[0].market, 'oasis');
});

test('컬리 계정이 연결돼 있어도 오아시스 상품뿐이면 브라우저를 열지 않는다', async () => {
  const user = {
    userId: 990002,
    nickname: '앱버2',
    items: [
      { id: 'b', market: 'oasis', productNo: 100888, name: '오아시스 유정란', unitSize: 40, unitLabel: '구', consumption: 40, price: 25000, active: true },
    ],
    recipes: [],
    recipeSettings: {},
    checklist: { checked: {} },
    checklistOnly: false,
    // 세션이 있다고만 두면 브라우저를 열기 전에 "컬리 상품 없음" 으로 목록만 준비합니다.
    kurly: { session: 'sealed-session' },
    notification: {},
  };
  const summary = await runner.runCartForUser({ user, trigger: 'manual', logger: { info() {}, step() {}, warn() {}, error() {} } });
  assert.equal(summary.checklistMode, true);
  assert.equal(summary.checklist.reason, 'no_kurly_items');
  assert.equal(summary.error, null);
  assert.equal(summary.items[0].status, 'planned');
});
