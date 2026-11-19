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

/* ─────────────── 로그인 실패 원인 수집 ─────────────── */
/*
 * 컬리가 로그인을 거부하면 숨은 이유를 알려 주지 않고 화면에 "아이디·비밀번호를 확인해 주세요" 만 띄우는 경우가 많습니다.
 * 실제로는 인증 API(auth.kurly.com)가 HTTP 상태·errorCode·displayMessage 를 돌려주거나, 로그인 화면에 모달/토스트를 띄웁니다.
 * 아래 도우미들은 그 응답과 화면 문구만 모아(요청 본문=비밀번호는 절대 읽지 않음) 실패 원인을 사람이 읽을 수 있게 정리합니다.
 */
const LOGIN_RELATED_RE = /login|signin|auth|member|token|oauth|password/i;
const LOGIN_ENDPOINT_RE = /login|signin/i;
const FAILURE_SNIPPET_MAX = 240;
const BLOCK_PATTERN = /비정상적인\s*접근|차단|S0\d\d|forbidden|too\s*many\s*requests|캡차|captcha/i;

function isLoginRelatedUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (!/(^|\.)kurly\.com$/.test(host)) return false;
  if (host === 'auth.kurly.com') return true;
  return LOGIN_RELATED_RE.test(parsed.pathname);
}

/** 비밀번호 같은 비밀값이 본문에 섞여 있어도 남기지 않도록 가립니다. */
function redactSecrets(text, secrets = []) {
  let out = String(text || '');
  for (const secret of secrets) {
    const value = String(secret || '');
    if (value.length >= 4) out = out.split(value).join('***');
  }
  return out;
}

function pickString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 응답 1건에서 상태·errorCode·title/message 를 안전하게 뽑습니다. */
async function readLoginFailureResponse(res, secrets = []) {
  const detail = {
    url: String(res.url() || '').split('?')[0].slice(0, 200),
    status: Number(res.status()) || 0,
    method: '',
    title: null,
    message: null,
    errorCode: null,
    captchaRequired: false,
    snippet: null,
  };
  try {
    detail.method = res.request?.().method?.() || '';
  } catch {
    /* ignore */
  }
  try {
    const contentType = String(res.headers?.()?.['content-type'] || '').toLowerCase();
    if (/json|text/.test(contentType)) {
      const text = redactSecrets(await res.text(), secrets).replace(/\s+/g, ' ').trim();
      if (text) {
        detail.snippet = text.slice(0, FAILURE_SNIPPET_MAX);
        try {
          const json = JSON.parse(text);
          detail.errorCode = pickString(json.errorCode) || pickString(json.code) || pickString(json.data?.errorCode);
          detail.title = pickString(json.displayMessage?.title) || pickString(json.title);
          detail.message =
            pickString(json.displayMessage?.message) ||
            pickString(json.message) ||
            pickString(json.error?.message) ||
            pickString(json.data?.displayMessage?.message) ||
            pickString(json.data?.message) ||
            pickString(json.data?.errors?.[0]?.message);
          detail.captchaRequired = json.isCaptchaRequired === true;
        } catch {
          /* JSON 이 아니면 본문 일부만 보관 */
        }
      }
    }
  } catch {
    /* 본문을 못 읽어도 상태 코드로 판단 */
  }
  return detail;
}

/** 로그인 화면에 떠 있는 모달·알림(토스트) 문구를 읽습니다. */
async function readLoginModalMessages(page) {
  const selectors = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '.ReactModal__Content',
    '[class*="toast" i]',
    '[class*="alert" i]',
  ];
  const found = [];
  for (const selector of selectors) {
    try {
      const texts = await page.locator(selector).filter({ visible: true }).allInnerTexts();
      for (const raw of texts) {
        const line = norm(raw).slice(0, 200);
        if (line && !found.includes(line)) found.push(line);
      }
    } catch {
      /* 해당 요소 없음 또는 페이지 이동 중 */
    }
  }
  return found;
}

/**
 * 모아 둔 컬리 응답·모달 문구로 실패 원인 문장을 만듭니다.
 * @returns {{code:string, message:string, decisive:boolean}|null} 단서가 없으면 null
 */
function summarizeLoginFailure({ responses = [], modals = [], dialogs = [] } = {}) {
  const list = (Array.isArray(responses) ? responses : []).filter(Boolean);
  const failed = list.filter((d) => d.status >= 400);
  const describe = (d) => [d.title, d.message].filter(Boolean).join(' — ');
  const httpNote = (d) => `HTTP ${d.status || '?'}${d.errorCode ? ` · ${d.errorCode}` : ''}`;

  const blocked =
    failed.find((d) => d.status === 403 || d.status === 429) || failed.find((d) => BLOCK_PATTERN.test(describe(d)));
  if (blocked) {
    const reason = describe(blocked);
    const captcha = blocked.captchaRequired ? ' 컬리가 보안문자(captcha) 인증도 요구했습니다.' : '';
    return {
      code: 'LOGIN_BLOCKED',
      decisive: true,
      message:
        `컬리가 로그인을 차단했습니다${reason ? ` — "${reason}"` : ''} (${httpNote(blocked)}). ` +
        '클라우드·해외 서버(Railway 등) IP가 자동 접속으로 판단될 때 나오는 응답이라, 한국 인터넷(집·휴대폰) 환경에서 로그인해야 할 수 있습니다.' +
        captcha,
    };
  }

  const apiError = failed.find((d) => d.title || d.message);
  if (apiError) {
    const strong = /비밀번호|아이디|차단|비정상적인/.test(describe(apiError));
    let message = `컬리가 로그인을 거부했습니다 — "${describe(apiError)}" (${httpNote(apiError)}).`;
    // 컬리 로그인에는 구글 reCAPTCHA(보이지 않는 보안 서비스)가 붙어 있어, 봇으로 판단되면 비밀번호가 맞아도 같은 문구가 나옵니다.
    if (apiError.captchaRequired) {
      message +=
        ' 컬리 로그인에는 보안 서비스(reCAPTCHA)가 함께 동작해서, 자동 접속으로 판단되면 비밀번호가 맞아도 이 문구가 나올 수 있습니다.';
    }
    return {
      code: 'LOGIN_REJECTED',
      decisive: LOGIN_ENDPOINT_RE.test(apiError.url) || strong,
      message,
    };
  }

  const modal = modals.map((m) => norm(m)).filter(Boolean)[0];
  if (modal) {
    return {
      code: 'LOGIN_FAILED',
      decisive: false,
      message: `컬리 로그인 화면에 이 문구가 표시됐습니다: "${modal.slice(0, 200)}"`,
    };
  }

  const dialog = dialogs.map((d) => norm(d)).filter(Boolean)[0];
  if (dialog) {
    return { code: 'LOGIN_DIALOG', decisive: false, message: dialog.slice(0, 200) };
  }

  const other = failed[0];
  if (other) {    const snippet = other.snippet ? ` — ${other.snippet.slice(0, 120)}` : '';
    return {
      code: 'LOGIN_FAILED',
      decisive: other.status === 403 || other.status === 429,
      message: `컬리 로그인 응답이 실패했습니다: ${other.url} (${httpNote(other)})${snippet}`,
    };
  }
  return null;
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

  // 컬리는 비밀번호 오류·차단 등을 JS alert/confirm 으로 알려줄 때가 있습니다.
  // 대화상자는 자동으로 닫아(accept) 진행을 막지 않고, 문구를 그대로 보관해 두었다가 그대로 알려 줍니다.
  const secrets = [pw];
  const dialogs = [];
  const onDialog = async (dialog) => {
    let message = '';
    try {
      message = String(dialog.message() || '').trim();
    } catch {
      /* ignore */
    }
    if (message) {
      dialogs.push(message);
      if (logger) logger.warn(`컬리 알림: ${message}`);
    }
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', onDialog);
  const throwDialog = () => {
    if (dialogs.length) throw new ItemError(dialogs[0], 'LOGIN_DIALOG');
  };

  // 컬리가 실제로 돌려준 거부 사유를 모읍니다. (응답 본문만 읽고 요청 본문=비밀번호는 건드리지 않습니다)
  const responses = [];
  let pendingReads = [];
  let capturing = true;
  const onResponse = (res) => {
    if (!capturing) return;
    try {
      const status = Number(res.status()) || 0;
      const isDocument = res.request?.().resourceType?.() === 'document';
      if (!isLoginRelatedUrl(res.url()) && !(isDocument && status >= 400)) return;
      pendingReads.push(
        readLoginFailureResponse(res, secrets)
          .then((detail) => {
            responses.push(detail);
            if (logger && (detail.status >= 400 || detail.title || detail.message)) {
              const reason = [detail.title, detail.message].filter(Boolean).join(' — ');
              logger.warn(`컬리 응답 ${detail.status} ${detail.url}${reason ? ` — ${reason}` : ''}`);
            }
          })
          .catch(() => {})
      );
    } catch {
      /* ignore */
    }
  };
  page.on('response', onResponse);

  const drainReads = async () => {
    if (!pendingReads.length) return;
    const current = pendingReads;
    pendingReads = [];
    await Promise.all(current);
  };
  const collectFailure = async () => {
    await drainReads();
    const modals = await readLoginModalMessages(page).catch(() => []);
    return summarizeLoginFailure({ responses, modals, dialogs });
  };
  // 로그인 여부 확인(=홈 화면 이동) 중에 생기는 무관한 응답은 원인 수집에서 뺍니다.
  const checkLoggedIn = async () => {
    capturing = false;
    try {
      return await isLoggedIn(page);
    } finally {
      capturing = true;
    }
  };

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);

    const idField = page.locator('input[name="id"]').first();
    if (!(await idField.count())) {
      if (await checkLoggedIn()) return true;
      throw new ItemError('컬리 로그인 입력창을 찾지 못했습니다. 컬리 로그인 화면이 바뀌었을 수 있습니다.', 'LOGIN_FORM');
    }
    await idField.fill(id);
    const pwField = page.locator('input[name="password"]').first();
    await pwField.fill(pw);

    // 로그인 화면에는 submit 버튼이 여러 개일 수 있습니다(하단 푸터 등). 이름이 정확히 "로그인"인 첫 버튼이 로그인 폼입니다.
    const submit = page.getByRole('button', { name: '로그인', exact: true }).first();
    await submit.click({ timeout: 10000 });

    for (let i = 0; i < 12; i += 1) {
      await page.waitForTimeout(1500);
      const currentUrl = page.url();
      if (!currentUrl.includes('/member/login')) {
        if (await checkLoggedIn()) return true;
      }
      throwDialog();

      // 컬리가 이미 분명한 사유로 거부했다면(차단·아이디/비밀번호 오류) 더 기다리지 않고 그대로 알려 줍니다.
      const early = await collectFailure();
      if (early && early.decisive) throw new ItemError(early.message, early.code);

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
    if (await checkLoggedIn()) return true;
    throwDialog();

    const failure = await collectFailure();
    if (failure) throw new ItemError(failure.message, failure.code);
    throw new ItemError('컬리 로그인에 실패했습니다. 아이디·비밀번호를 확인해 주세요.', 'LOGIN_FAILED');
  } finally {
    page.off('dialog', onDialog);
    page.off('response', onResponse);
  }
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

/**
 * 저장된 세션이 아직 살아 있는지 확인하고, 살아 있으면 브라우저가 갱신한 쿠키까지 함께 돌려줍니다.
 * (컬리가 요청 중에 세션 쿠키를 새로 내려주므로, 가져온 세션을 그대로 쓰는 것보다 최신 상태를 보관하는 편이 좋습니다)
 * @returns {Promise<{loggedIn:boolean, storageState:object|null}>}
 */
async function verifySessionWithState(storageState, { headless = true } = {}) {
  const { browser, context, page } = await launchBrowser({ headless, storageState });
  try {
    const loggedIn = await isLoggedIn(page);
    const refreshed = loggedIn ? await context.storageState() : null;
    return { loggedIn, storageState: refreshed };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 저장된 세션이 아직 살아 있는지 확인합니다. */
async function verifySession(storageState, opts = {}) {
  const { loggedIn } = await verifySessionWithState(storageState, opts);
  return loggedIn;
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
  verifySessionWithState,
  openGoods,
  addItemToCart,
  readCart,
  pickOptionIndex,
  isLoginRelatedUrl,
  redactSecrets,
  summarizeLoginFailure,
};
