'use strict';
/**
 * 오아시스마켓 조회 API (읽기 전용) — 로그인 없이 검색 결과만 읽습니다.
 *
 *  - 상품 검색 : GET https://m.oasis.co.kr/product/search?keyword=...&page=1
 *      → 서버가 그려 준 HTML 안의 <li class="… pListItem" data-productid="…"> 블록마다
 *        상품 하나가 들어 있습니다(상품번호·이름·가격·원가·할인율·썸네일·한 줄 설명·단위가격·품절).
 *  - 상품 상세 : GET https://m.oasis.co.kr/product/detail/{상품번호}
 *      → <h1> 이름, <h2> 한 줄 설명, oDetail_info_group_price 안의 판매가·정상가.
 *        오아시스 상세에는 용량·판매단위 항목이 없어서, 단위 크기는 상품 이름에서 추정합니다.
 *
 * 장바구니 자동 담기는 하지 않습니다(오아시스 계정 연동 없음) — 이 파일은 "무엇을 살지"만 읽습니다.
 * HTML 구조가 바뀌면 파서가 빈 목록을 돌려줄 수 있으므로, 실제 페이지로 확인하며 관리합니다.
 */
const { parseUnit } = require('./kurly-api');

const OASIS_WEB = 'https://m.oasis.co.kr';
// 모바일 페이지입니다. 데스크톱 UA 로도 같은 HTML 이 오지만, 앱과 같은 화면을 보도록 모바일 UA 를 씁니다.
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

const MAX_ITEMS = 60;

class OasisApiError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'OasisApiError';
    this.status = status;
    this.url = url;
  }
}

async function request(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml',
        'Cache-Control': 'no-cache',
      },
    });
    const text = await res.text();
    return { res, text };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new OasisApiError(`오아시스 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다.`, { url });
    }
    throw new OasisApiError(`오아시스와 통신하지 못했습니다: ${err.message}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────── HTML 도우미 ─────────────── */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·' };

function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    const key = String(body).toLowerCase();
    if (ENTITIES[key]) return ENTITIES[key];
    if (key.startsWith('#x')) {
      const code = parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith('#')) {
      const code = Number(key.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

const stripTags = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ');

/** 태그·엔티티·줄바꿈을 걷어 낸 한 줄 텍스트 */
function cleanText(html) {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

/** "25,000" / " 9,020 원" → 25000 */
function toPrice(text) {
  const digits = String(text ?? '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function firstMatch(block, regex) {
  const m = block.match(regex);
  return m ? m[1] : null;
}

/* ─────────────── 검색 결과 파싱 ─────────────── */

const ITEM_START = /<li[^>]*class="[^"]*\bpListItem\b[^"]*"[^>]*>/g;

/** 검색 결과 전체 건수 (예: <strong class="oSearch_cnt">534건</strong>) */
function parseTotal(html) {
  const raw = firstMatch(html, /class="oSearch_cnt"[^>]*>\s*([\d,]+)\s*건/);
  if (!raw) return null;
  const n = Number(raw.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 상품 블록 하나를 앱에서 쓰기 좋은 형태로 바꿉니다.
 * @param {string} block <li class="pListItem" …> … </li> 사이의 HTML
 */
function mapSearchBlock(block) {
  const no = Number(firstMatch(block, /data-productid="(\d+)"/));
  if (!Number.isInteger(no) || no <= 0) return null;
  const name = cleanText(firstMatch(block, /class="listTit"[^>]*>([\s\S]*?)<\/a>/) || '');
  if (!name) return null;

  const price =
    toPrice(firstMatch(block, /class="price_discount"[^>]*>\s*<b>([\d,]+)<\/b>/)) ??
    toPrice(firstMatch(block, /class="cost[^"]*"[^>]*>\s*<b>([\d,]+)<\/b>/));
  const originalPrice = toPrice(firstMatch(block, /class="price_original[^"]*"[^>]*>\s*<b>([\d,]+)<\/b>/));
  const rateRaw = firstMatch(block, /class="price_discountRate[^"]*"[^>]*>\s*(\d+)\s*%/);

  const imgTag =
    firstMatch(block, /(<img[^>]*class="[^"]*swiper-lazy[^"]*"[^>]*>)/) ||
    firstMatch(block, /(<img[^>]*>)/) ||
    '';
  const imageUrl =
    firstMatch(imgTag, /data-src="([^"]+)"/) || firstMatch(imgTag, /src="([^"]+)"/) || null;

  const shortDescription =
    cleanText(firstMatch(block, /class="info_subscriptT"[^>]*>([\s\S]*?)<\/div>/) || '') ||
    cleanText(firstMatch(block, /class="info_subscript"[^>]*>([\s\S]*?)<\/div>/) || '');
  const unitPriceText = cleanText(firstMatch(block, /class="info_option"[^>]*>([\s\S]*?)<\/div>/) || '') || null;

  return {
    market: 'oasis',
    no,
    productNo: no,
    name,
    shortDescription,
    price,
    originalPrice: originalPrice && (!price || originalPrice > price) ? originalPrice : null,
    discountRate: rateRaw ? Number(rateRaw) : 0,
    imageUrl,
    unitPriceText,
    // 오아시스 검색 결과는 품절 상품도 함께 보여 줍니다 — 담기 전에 알 수 있게 표시합니다.
    soldOut: /img_soldOut|soldOutArea|class="soldOut"/.test(block),
    multiplePrice: false,
    volume: null,
    url: `${OASIS_WEB}/product/detail/${no}`,
  };
}

/**
 * 오아시스 검색 결과 HTML 을 상품 배열로 바꿉니다. (순수 함수 — 테스트에서 그대로 씁니다)
 * @param {string} html
 * @param {{limit?:number}} [opts]
 * @returns {Array<object>}
 */
function parseSearchHtml(html, { limit = 24 } = {}) {
  const source = String(html ?? '');
  const max = Math.max(1, Math.min(MAX_ITEMS, Number(limit) || 24));
  const starts = [];
  ITEM_START.lastIndex = 0;
  let match;
  while ((match = ITEM_START.exec(source)) !== null) starts.push(match.index);

  const products = [];
  for (let i = 0; i < starts.length && products.length < max; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : source.length;
    const item = mapSearchBlock(source.slice(starts[i], end));
    if (item) products.push(item);
  }
  return products;
}

/**
 * @param {string} keyword
 * @param {{page?:number, limit?:number}} [opts]
 * @returns {Promise<{market:'oasis', keyword:string, page:number, total:number|null, products:Array}>}
 */
async function searchOasisProducts(keyword, opts = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return { market: 'oasis', keyword: '', page: 1, total: 0, products: [] };
  const page = Math.max(1, Number(opts.page) || 1);
  const limit = Math.max(1, Math.min(MAX_ITEMS, Number(opts.limit) || 24));
  const url = `${OASIS_WEB}/product/search?keyword=${encodeURIComponent(kw)}&page=${page}`;

  const { res, text } = await request(url);
  if (!res.ok) {
    throw new OasisApiError(`오아시스 검색이 실패했습니다 (HTTP ${res.status}). 잠시 후 다시 시도해 주세요.`, {
      status: res.status,
      url,
    });
  }

  const products = parseSearchHtml(text, { limit });
  return {
    market: 'oasis',
    keyword: kw,
    page,
    total: parseTotal(text),
    products,
  };
}

/* ─────────────── 상품 상세 파싱 ─────────────── */

/**
 * 상품 상세 HTML → 앱이 쓰는 형태.
 *  · 오아시스 상세에는 용량 항목이 없어 이름에서 단위 크기를 추정합니다. (unitSuggestion)
 *  · 품절 여부는 상세 페이지 마크업만으로 확정할 수 없어 검색 결과 값을 그대로 씁니다. (soldOut: null)
 * @param {string} html
 * @param {number|string} productNo
 */
function parseDetailHtml(html, productNo) {
  const source = String(html ?? '');
  const no = Number(productNo);
  // 제목 영역(oDetail_info_group_title) 안의 <h1> 이름 / <h2> 한 줄 설명만 씁니다.
  // 페이지 앞쪽의 다른 <h1>·<h2>(카테고리 안내 등)를 집지 않도록 영역을 먼저 자릅니다.
  const titleStart = source.search(/class="oDetail_info_group_title"/);
  const titleBlock = titleStart >= 0 ? source.slice(titleStart, titleStart + 4000) : '';
  const name = cleanText(firstMatch(titleBlock, /<h1[^>]*>([\s\S]*?)<\/h1>/) || '');
  if (!name) {
    throw new OasisApiError('상품 정보를 찾지 못했습니다. 오아시스 페이지 구조가 바뀌었을 수 있습니다.');
  }
  const priceBlock = firstMatch(source, /class="oDetail_info_group_price"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/) || '';
  const price =
    toPrice(firstMatch(priceBlock, /class="discountPrice"[^>]*>[\s\S]*?<b>([\d,]+)<\/b>/)) ??
    toPrice(firstMatch(priceBlock, /class="cost[^"]*"[^>]*>\s*<b>([\d,]+)<\/b>/));
  const originalPrice = toPrice(firstMatch(priceBlock, /class="cost[^"]*"[^>]*>\s*<b>([\d,]+)<\/b>/));
  const rateRaw = firstMatch(priceBlock, /class="discountRate[^"]*"[^>]*>\s*<b>(\d+)\s*%<\/b>/);
  const shortDescription = cleanText(firstMatch(titleBlock, /<h2[^>]*>([\s\S]*?)<\/h2>/) || '');
  const imageUrl =
    firstMatch(source, /property="og:image"\s+content="([^"]+)"/) ||
    firstMatch(source, /property="og:image" content="([^"]+)"/) ||
    null;
  const unit = parseUnit(name, shortDescription);

  return {
    market: 'oasis',
    no,
    productNo: no,
    name,
    shortDescription,
    price,
    originalPrice: originalPrice && (!price || originalPrice > price) ? originalPrice : null,
    discountRate: rateRaw ? Number(rateRaw) : 0,
    soldOut: null,
    salesUnit: null,
    volume: null,
    unitPriceText: null,
    multiplePrice: false,
    imageUrl,
    unitSuggestion: unit,
    deliveryTypeNames: [],
    url: `${OASIS_WEB}/product/detail/${no}`,
    options: [],
  };
}

/** @param {number|string} productNo */
async function getOasisProductDetail(productNo) {
  const no = Number(productNo);
  if (!Number.isInteger(no) || no <= 0) throw new OasisApiError('상품번호가 올바르지 않습니다.');
  const url = `${OASIS_WEB}/product/detail/${no}`;
  const { res, text } = await request(url);
  if (!res.ok) {
    throw new OasisApiError(`상품 페이지를 불러오지 못했습니다 (HTTP ${res.status}).`, { status: res.status, url });
  }
  return parseDetailHtml(text, no);
}

module.exports = {
  OASIS_WEB,
  USER_AGENT,
  OasisApiError,
  decodeEntities,
  cleanText,
  parseSearchHtml,
  parseTotal,
  parseDetailHtml,
  searchOasisProducts,
  getOasisProductDetail,
};
