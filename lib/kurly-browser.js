'use strict';
/**
 * Playwright 로 마켓컬리 로그인 · 장바구니 담기
 *
 * 2026-11-18 실제 페이지를 열어 확인한 구조(기존 kurly-auto-cart 검증본)를 그대로 사용합니다.
 *   · 상품 페이지      : https://www.kurly.com/goods/{상품번호}
 *   · 담기 버튼        : 버튼 이름 "장바구니 담기"
 *   · 옵션형 상품      : "상품을 선택해주세요" 버튼 → 펼쳐진 옵션 목록(li) → 옵션 클릭
 *   · 수량 조절        : aria-label="Stepper plus" / "Stepper minus"
 *   · 담기 요청        : POST https://api.kurly.com/external-cart/v2/add
 *   · 장바구니 조회    : GET  https://api.kurly.com/external-cart/v2/refresh
 *
 * 이 앱은 세션(storageState)을 사용자별로 암호화해 보관하고, 평문 비밀번호는 저장하지 않습니다.
 * 모든 함수는 storageState 객체를 받습니다(파일 경로를 쓰지 않음).
 */
const { KURLY_WEB, USER_AGENT } = require('./kurly-api');
const { envBool } = require('./env');

const CART_URL = `${KURLY_WEB}/cart`;
const LOGIN_URL = `${KURLY_WEB}/member/login`;
const ADD_BUTTON = '장바구니 담기';
const OPTION_TRIGGERS = [/상품을\s*선택해주세요/, /상품을\s*선택/, /옵션\s*선택/];

class ItemError extends Error {
  constructor(message, code = 'ITEM_ERROR') {
    super(message);
    this.name = 'ItemError';
    this.code = code;
  }
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const compact = (s) => norm(s).replace(/\s/g, '');

let playwrightModule = null;
function loadPlaywright() {
  if (playwrightModule) return playwrightModule;
  try {
    // eslint-disable-next-line global-require
    playwrightModule = require('playwright');
  } catch {
    throw new Error(
      'playwright 패키지를 찾을 수 없습니다. `npm install` 후 `npx playwright install chromium` 을 실행해 주세요.'
    );
  }
  return playwrightModule;
}

function launchArgs() {
  const args = ['--disable-dev-shm-usage', '--disable-gpu'];
  if (envBool('BROWSER_NO_SANDBOX', false)) args.push('--no-sandbox', '--disable-setuid-sandbox');
  const extra = String(process.env.BROWSER_ARGS || '').trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
  return args;
}

/**
 * 브라우저 + 컨텍스트 + 페이지를 만듭니다.
 * @param {{headless?:boolean, storageState?:object|null}} opts
 */
async function launchBrowser({ headless = true, storageState = null } = {}) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless, args: launchArgs() });
  const contextOptions = {
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 960 },
  };
  if (storageState && Array.isArray(storageState.cookies)) contextOptions.storageState = storageState;
  const context = await browser.newContext(contextOptions);
  context.setDefaultTimeout(Number(process.env.BROWSER_TIMEOUT_MS) || 20000);
  const page = await context.newPage();
  return { browser, context, page };
}

/* ─────────────── 로그인 ─────────────── */

/** 로그인 상태 추정 (헤더에 로그아웃/마이컬리가 보이면 로그인) */
async function isLoggedIn(page) {
  await page.goto(KURLY_WEB, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  const logout = await page.getByText('로그아웃', { exact: false }).count();
  const mykurly = await page.getByText('마이컬리', { exact: false }).count();
  if (logout > 0 || mykurly > 0) return true;
  return false;
}

/** 아이디/비밀번호로 로그인하고 성공 여부를 돌려줍니다. (비밀번호는 저장하지 않습니다) */
async function loginWithPassword(page, id, pw, logger = null) {
  if (!id || !pw) throw new ItemError('컬리 아이디와 비밀번호를 모두 입력해 주세요.', 'LOGIN_INPUT');
  if (logger) logger.step('컬리 로그인 시도');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);

  const idField = page.locator('input[name="id"]').first();
  if (!(await idField.count())) {
    if (await isLoggedIn(page)) return true;
    throw new ItemError('컬리 로그인 입력창을 찾지 못했습니다. 컬리 로그인 화면이 바뀌었을 수 있습니다.', 'LOGIN_FORM');
  }
  await idField.fill(id);
  const pwField = page.locator('input[name="password"]').first();
  await pwField.fill(pw);

  const submit = page
    .locator('form button[type="submit"], button:has-text("로그인")')
    .filter({ hasNotText: '카카오' })
    .filter({ hasNotText: '네이버' })
    .last();
  await submit.click({ timeout: 10000 });

  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(1500);
    const currentUrl = page.url();
    if (!currentUrl.includes('/member/login')) {
      if (await isLoggedIn(page)) return true;
    }
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
    if (/비밀번호가 (일치|틀|다릅)|아이디 또는 비밀번호|일치하지 않습니다|존재하지 않는/.test(body)) {
      throw new ItemError('컬리 아이디 또는 비밀번호가 맞지 않습니다.', 'LOGIN_REJECTED');
    }
    if (/자동입력|보안\s*문자|인증\s*번호|캡차|captcha/i.test(body)) {
      throw new ItemError(
        '컬리가 추가 인증(보안문자·인증번호)을 요구합니다. 잠시 후 다시 시도하거나, 컬리 앱에서 로그인 확인 후 다시 연결해 주세요.',
        'LOGIN_CHALLENGE'
      );
    }
  }
  if (await isLoggedIn(page)) return true;
  throw new ItemError('컬리 로그인에 실패했습니다. 아이디·비밀번호를 확인해 주세요.', 'LOGIN_FAILED');
}

/** 컬리 계정에 로그인해서 세션(storageState)을 얻습니다. */
async function loginAndCapture({ kurlyId, kurlyPassword, logger = null, headless = true }) {
  const { browser, context, page } = await launchBrowser({ headless });
  try {
    await loginWithPassword(page, kurlyId, kurlyPassword, logger);
    const storageState = await context.storageState();
    const account = kurlyId.replace(/(.{2}).*(@.*)?$/, (m, a, domain) => `${a}***${domain || ''}`);
    return { storageState, account };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 저장된 세션이 아직 살아 있는지 확인합니다. */
async function verifySession(storageState, { headless = true } = {}) {
  const { browser, page } = await launchBrowser({ headless, storageState });
  try {
    return await isLoggedIn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ─────────────── 상품 페이지 조작 ─────────────── */

async function openGoods(page, productNo, logger = null) {
  const url = `${KURLY_WEB}/goods/${productNo}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
      await page.waitForTimeout(1200);
      return url;
    } catch (err) {
      lastErr = err;
      if (logger) logger.warn(`상품 페이지 접속 재시도 (${attempt}/2): ${err.message}`);
      await page.waitForTimeout(1500);
    }
  }
  throw new ItemError(`상품 페이지를 열지 못했습니다: ${lastErr?.message ?? ''}`, 'PAGE_ERROR');
}

async function detectSoldOut(page) {
  const addButton = page.getByRole('button', { name: ADD_BUTTON }).first();
  if (!(await addButton.count())) return true;
  const disabled = await addButton.isDisabled().catch(() => false);
  if (disabled) return true;
  const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
  return /일시\s*품절|품절된 상품|판매\s*종료/.test(body);
}

function pickOptionIndex(labels, item) {
  const wanted = compact(item.optionName || '');
  const name = compact(item.name || '');
  const usable = labels.map((t, i) => ({ t, i })).filter(({ t }) => !/품절|판매종료/.test(t));

  if (wanted) {
    const exact = usable.find(({ t }) => compact(t).startsWith(wanted));
    if (exact) return exact.i;
    const partial = usable.find(({ t }) => compact(t).includes(wanted));
    if (partial) return partial.i;
  }
  const plain = usable.find(({ t }) => compact(t).includes(name) && !/컬리멤버스|멤버스\]/.test(t));
  if (plain) return plain.i;
  const anyName = usable.find(({ t }) => compact(t).includes(name));
  if (anyName) return anyName.i;
  return usable.length ? usable[0].i : -1;
}

async function selectOptionIfNeeded(page, item, logger = null) {
  let trigger = null;
  for (const re of OPTION_TRIGGERS) {
    const btn = page.getByRole('button', { name: re }).first();
    if (await btn.count()) {
      trigger = btn;
      break;
    }
  }
  if (!trigger) return { selected: false, optionLabel: null };

  await trigger.click().catch(() => {});
  await page.waitForTimeout(700);

  const lists = ['[class*="e10mqgq14"] > li', 'ul[class*="option" i] > li', 'ul[class*="Option"] > li'];
  for (const sel of lists) {
    const rows = page.locator(sel);
    const count = await rows.count();
    if (!count) continue;
    const labels = [];
    for (let i = 0; i < count; i += 1) labels.push(norm(await rows.nth(i).innerText().catch(() => '')));
    const idx = pickOptionIndex(labels, item);
    if (idx >= 0) {
      await rows.nth(idx).click();
      await page.waitForTimeout(700);
      if (logger) logger.info(`옵션 선택: ${labels[idx].slice(0, 60)}`);
      return { selected: true, optionLabel: labels[idx] };
    }
    throw new ItemError(
      `옵션을 고르지 못했습니다. 페이지 옵션: ${labels.map((l) => l.slice(0, 40)).join(' | ')}`,
      'OPTION_NOT_FOUND'
    );
  }

  const target = item.optionName || item.name;
  const byText = page.getByText(target, { exact: true });
  if (await byText.count()) {
    await byText.first().click();
    await page.waitForTimeout(700);
    if (logger) logger.info(`옵션 선택(텍스트): ${target}`);
    return { selected: true, optionLabel: target };
  }
  throw new ItemError('옵션 목록을 찾지 못했습니다.', 'OPTION_NOT_FOUND');
}

async function setQuantity(page, quantity, logger = null) {
  const target = Math.max(1, Math.min(99, Number(quantity) || 1));
  if (target === 1) return 1;
  const plus = page.locator('[aria-label="Stepper plus"], button[aria-label*="plus" i]').first();
  if (!(await plus.count())) {
    if (logger) logger.warn(`수량 조절 버튼이 없어 1개로 담습니다 (요청 ${target}개)`);
    return 1;
  }
  for (let i = 1; i < target; i += 1) {
    await plus.click({ timeout: 8000 });
    await page.waitForTimeout(120);
  }
  if (logger) logger.info(`수량 ${target}개 설정`);
  return target;
}

/**
 * 상품 1개를 장바구니에 담습니다.
 * @returns {Promise<{status:'added'|'merged', quantity:number, cartCount:number|null, optionLabel:string|null}>}
 */
async function addItemToCart(page, item, { quantity, logger = null } = {}) {
  const qty = Math.max(1, Math.min(99, Number(quantity) || 1));
  await openGoods(page, item.productNo, logger);

  if (await detectSoldOut(page)) {
    throw new ItemError('품절이거나 판매가 중지된 상품입니다.', 'SOLD_OUT');
  }

  const option = await selectOptionIfNeeded(page, item, logger);
  await setQuantity(page, qty, logger);

  const addButton = page.getByRole('button', { name: ADD_BUTTON }).first();
  if (!(await addButton.count())) throw new ItemError('장바구니 담기 버튼을 찾지 못했습니다.', 'NO_ADD_BUTTON');

  const responsePromise = page
    .waitForResponse((r) => /external-cart\/v2\/add/.test(r.url()) && r.request().method() === 'POST', {
      timeout: 25000,
    })
    .catch(() => null);

  await addButton.click({ timeout: 15000 });
  const response = await responsePromise;
  if (!response) {
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
    if (/로그인이 필요|로그인 후|로그인해\s*주세요/.test(body)) {
      throw new ItemError('컬리 로그인이 풀렸습니다. 설정에서 컬리 계정을 다시 연결해 주세요.', 'LOGIN_REQUIRED');
    }
    throw new ItemError('담기 요청이 전송되지 않았습니다. 잠시 후 다시 시도해 주세요.', 'NO_RESPONSE');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* 응답 본문을 못 읽어도 상태 코드로 판단 */
  }

  if (!response.ok() || payload?.success === false) {
    const message = payload?.message || payload?.error?.message || `HTTP ${response.status()}`;
    if (/로그인|인증/.test(String(message))) {
      throw new ItemError('컬리 로그인이 풀렸습니다. 설정에서 컬리 계정을 다시 연결해 주세요.', 'LOGIN_REQUIRED');
    }
    throw new ItemError(`컬리가 담기를 거부했습니다: ${message}`, 'ADD_REJECTED');
  }

  const cartItem =
    payload?.data?.cartItems?.find((c) => c.dealProductNo === Number(item.dealProductNo)) ??
    payload?.data?.cartItems?.[0] ??
    null;

  return {
    status: payload?.data?.meta?.isInCart ? 'merged' : 'added',
    quantity: cartItem?.quantity ?? qty,
    cartCount: payload?.data?.meta?.count ?? null,
    optionLabel: option.optionLabel,
  };
}

/** 장바구니 화면을 열어 실제 상태(건수, 담긴 상품/수량)를 읽습니다. */
async function readCart(page) {
  let body = null;
  const onResponse = async (res) => {
    if (/external-cart\/v2\/refresh/.test(res.url())) {
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
    }
  };
  page.on('response', onResponse);
  try {
    await page.goto(CART_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
  } catch {
    return null;
  } finally {
    page.off('response', onResponse);
  }
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    const data = json?.data ?? {};
    return {
      totalCount: typeof data.totalCount === 'number' ? data.totalCount : null,
      items: Array.isArray(data.cartItems) ? data.cartItems : [],
    };
  } catch {
    return null;
  }
}

module.exports = {
  CART_URL,
  LOGIN_URL,
  ItemError,
  launchBrowser,
  isLoggedIn,
  loginWithPassword,
  loginAndCapture,
  verifySession,
  openGoods,
  addItemToCart,
  readCart,
  pickOptionIndex,
};
