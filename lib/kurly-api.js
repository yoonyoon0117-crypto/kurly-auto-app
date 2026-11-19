'use strict';
/**
 * 마켓컬리 조회 API (읽기 전용)
 *
 *  - 상품 검색 : GET https://api.kurly.com/search/v4/sites/market/normal-search?keyword=...&page=1
 *      → 검색 결과는 data.listSections 안의 sectionCode === 'PRODUCT_LIST' 섹션에 담겨 옵니다.
 *  - 상품 상세 : GET https://www.kurly.com/goods/{상품번호} 의 <script id="__NEXT_DATA__"> 안 product 객체
 *      → 판매단위/용량/품절여부/옵션(dealProducts)까지 들어 있어, 담기 자동화가 참고합니다.
 *
 * 두 요청 모두 브라우저 쿠키 없이 동작하지만, User-Agent / Origin / Referer 헤더가 없으면
 * 400 응답이 오므로 반드시 함께 보냅니다. (2026-11-18 실제 호출로 확인)
 */
const KURLY_API = 'https://api.kurly.com';
const KURLY_WEB = 'https://www.kurly.com';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

class KurlyApiError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'KurlyApiError';
    this.status = status;
    this.url = url;
  }
}

async function request(url, { headers = {}, timeoutMs = 12000, method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      body,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        ...headers,
      },
    });
    const text = await res.text();
    return { res, text };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new KurlyApiError(`컬리 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다.`, { url });
    }
    throw new KurlyApiError(`컬리와 통신하지 못했습니다: ${err.message}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

function pickSection(json, code) {
  const sections = json?.data?.listSections;
  if (!Array.isArray(sections)) return null;
  const found = sections.find((s) => s?.view?.sectionCode === code);
  return found?.data ?? null;
}

/** 검색 결과 상품을 앱에서 쓰기 좋은 형태로 변환 */
function mapSearchItem(it) {
  const price = it.discountedPrice ?? it.salesPrice ?? it.basePrice ?? null;
  const originalPrice = it.salesPrice ?? it.basePrice ?? price;
  return {
    no: it.no,
    name: it.name,
    shortDescription: it.shortDescription ?? '',
    price,
    originalPrice,
    discountRate: it.discountRate ?? 0,
    imageUrl: it.listImageUrl ?? null,
    soldOut: Boolean(it.isSoldOut) || it.isPurchaseStatus === false,
    purchaseStatus: it.productViewStatus ?? null,
    multiplePrice: Boolean(it.isMultiplePrice),
    unitPriceText: it.unitPriceText ?? null,
    url: `${KURLY_WEB}/goods/${it.no}`,
  };
}

/**
 * @param {string} keyword
 * @param {{page?:number, limit?:number}} [opts]
 * @returns {Promise<{keyword:string,page:number,products:Array,total:number|null}>}
 */
async function searchProducts(keyword, opts = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return { keyword: '', page: 1, products: [], total: 0 };
  const page = Math.max(1, Number(opts.page) || 1);
  const limit = Math.max(1, Math.min(60, Number(opts.limit) || 24));
  const url =
    `${KURLY_API}/search/v4/sites/market/normal-search?keyword=${encodeURIComponent(kw)}&page=${page}`;

  const { res, text } = await request(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Origin: KURLY_WEB,
      Referer: `${KURLY_WEB}/`,
    },
  });

  if (!res.ok) {
    throw new KurlyApiError(`컬리 검색이 실패했습니다 (HTTP ${res.status}). 잠시 후 다시 시도해 주세요.`, {
      status: res.status,
      url,
    });
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new KurlyApiError('컬리 검색 응답을 해석하지 못했습니다. 사이트 구조가 바뀌었을 수 있습니다.', {
      status: res.status,
      url,
    });
  }

  const list = pickSection(json, 'PRODUCT_LIST');
  const items = Array.isArray(list?.items) ? list.items : [];
  return {
    keyword: kw,
    page,
    total: typeof list?.totalCount === 'number' ? list.totalCount : null,
    products: items.slice(0, limit).map(mapSearchItem),
  };
}

/** "15구 (780g)", "1.3kg내외", "5입", "" 등에서 단위 크기를 추정 */
const UNIT_PATTERN = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|구|입|개|팩|봉|미|마리|장|병|캔|봉지|포)/i;

function parseUnit(...candidates) {
  for (const raw of candidates) {
    if (!raw) continue;
    const m = String(raw).match(UNIT_PATTERN);
    if (!m) continue;
    const size = Number(m[1]);
    if (!Number.isFinite(size) || size <= 0) continue;
    let label = m[2];
    const lower = label.toLowerCase();
    if (lower === 'kg') label = 'kg';
    else if (lower === 'g') label = 'g';
    else if (lower === 'ml') label = 'ml';
    else if (lower === 'l') label = 'L';
    else if (label === '봉지') label = '봉';
    else if (label === '포') label = '팩';
    return { unitSize: size, unitLabel: label };
  }
  return null;
}

/**
 * 상품 상세(판매단위, 용량, 옵션, 품절여부)
 * @param {number|string} productNo
 */
async function getProductDetail(productNo) {
  const no = Number(productNo);
  if (!Number.isInteger(no) || no <= 0) throw new KurlyApiError('상품번호가 올바르지 않습니다.');
  const url = `${KURLY_WEB}/goods/${no}`;
  const { res, text } = await request(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!res.ok) {
    throw new KurlyApiError(`상품 페이지를 불러오지 못했습니다 (HTTP ${res.status}).`, { status: res.status, url });
  }
  const m = text.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) {
    throw new KurlyApiError('상품 정보를 찾지 못했습니다. 컬리 페이지 구조가 바뀌었을 수 있습니다.', { url });
  }
  let product;
  try {
    product = JSON.parse(m[1])?.props?.pageProps?.product;
  } catch {
    throw new KurlyApiError('상품 정보를 해석하지 못했습니다.', { url });
  }
  if (!product) throw new KurlyApiError('상품이 존재하지 않거나 판매가 종료되었습니다.', { url });

  const deals = Array.isArray(product.dealProducts) ? product.dealProducts : [];
  const price = product.discountedPrice ?? product.basePrice ?? null;
  const unit = parseUnit(product.volume, product.name, product.salesUnit);

  return {
    no,
    name: product.name,
    shortDescription: product.shortDescription ?? '',
    price,
    originalPrice: product.retailPrice ?? product.basePrice ?? price,
    discountRate: product.retailPrice && product.basePrice && product.retailPrice > product.basePrice
      ? Math.round((1 - product.basePrice / product.retailPrice) * 100)
      : 0,
    soldOut: Boolean(product.isSoldOut) || product.isPurchaseStatus === false,
    salesUnit: product.salesUnit ?? null,
    volume: product.volume ?? null,
    unitPriceText: product.unitPriceText ?? null,
    deliveryTypeNames: product.deliveryTypeNames ?? [],
    multiplePrice: Boolean(product.isMultiplePrice),
    unitSuggestion: unit,
    url: `${KURLY_WEB}/goods/${no}`,
    options: deals.map((d) => ({
      dealProductNo: d.no,
      name: d.name,
      price: d.discountedPrice ?? d.basePrice ?? null,
      soldOut: Boolean(d.isSoldOut),
      maxEa: d.maxEa ?? null,
    })),
  };
}

module.exports = {
  KURLY_API,
  KURLY_WEB,
  USER_AGENT,
  KurlyApiError,
  searchProducts,
  getProductDetail,
  parseUnit,
};
