#!/usr/bin/env node
/**
 * 아이폰 크기(390×844)에서 실제 화면을 Playwright 로 조작하는 점검.
 *   회원가입(초대 코드) → 기본 8개 상품(컬리 4 + 오아시스 4) → 검색 → 추가 → 저장 → 새로고침 후 유지
 *   콘솔 오류 0건 확인 + 단계별 스크린샷 저장
 *
 *   npm run test:ui
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(ROOT, '..');
// 기본은 작업 폴더의 downloads/…, SHOT_DIR 로 바꿀 수 있습니다.
const SHOT_DIR = process.env.SHOT_DIR
  ? path.resolve(process.env.SHOT_DIR)
  : path.join(WORKSPACE, 'downloads', 'kurly-auto-app-screens');

const BROWSERS = path.join(WORKSPACE, '.tools', 'pw-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS;
}
// 이 작업 환경에는 Chromium 의존 라이브러리가 .tools/libs 에 따로 있습니다.
const EXTRA_LIBS = path.join(WORKSPACE, '.tools', 'libs');
if (fs.existsSync(EXTRA_LIBS)) {
  process.env.LD_LIBRARY_PATH = [EXTRA_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

// 서버 환경 (임시 데이터 폴더)
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kurly-ui-test-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data');
process.env.APP_SECRET = 'ui-test-secret-0123456789abcdef0123456789';
process.env.INVITE_CODE = 'UI-TEST-2026';
process.env.SCHEDULER = 'false';
process.env.NODE_ENV = 'test';
process.env.COOKIE_SECURE = 'false';
process.env.REGISTER_RATE_LIMIT = '100';
process.env.LOGIN_RATE_LIMIT = '100';

const { createApp } = require('../server');
const { chromium } = require('playwright');

const QUIET = { info() {}, step() {}, warn() {}, error() {}, file: null };

const shots = [];
const checks = [];
let failed = false;

function ok(name, detail = '') {
  checks.push({ name, ok: true, detail });
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name, detail = '') {
  failed = true;
  checks.push({ name, ok: false, detail });
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
}
function check(condition, name, detail = '') {
  if (condition) ok(name, detail);
  else bad(name, detail);
  return condition;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const app = createApp({ logger: QUIET, schedulerEnabled: false });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('requestfailed', (req) => {
    // 컬리 이미지 CDN 등 외부 요청 실패는 화면 오류가 아니므로 기록만
    if (req.url().startsWith(baseUrl)) consoleErrors.push(`request failed: ${req.url()}`);
  });

  async function waitToastGone() {
    await page
      .waitForFunction(() => document.querySelector('#toast').hidden, null, { timeout: 6000 })
      .catch(() => {});
  }

  async function shot(name) {
    const file = path.join(SHOT_DIR, name);
    await page.screenshot({ path: file, fullPage: false, animations: 'disabled' });
    shots.push(file);
    console.log(`  📸 ${file}`);
  }

  try {
    console.log('\n1) 로그인 화면');
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#authView:not([hidden])');
    check(await page.isVisible('#authNickname'), '로그인/회원가입 화면이 보인다');
    check((await page.title()) === '정기 장바구니', '페이지 제목', await page.title());
    const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
    check(manifestHref === '/manifest.json', 'PWA 매니페스트 연결', manifestHref || '');
    check(
      (await page.getAttribute('meta[name="apple-mobile-web-app-capable"]', 'content')) === 'yes',
      'iOS 홈 화면 추가 메타 태그'
    );
    check(
      (await page.getAttribute('meta[name="apple-mobile-web-app-title"]', 'content')) === 'Cart helper🤍',
      '홈 화면 추가 이름',
      (await page.getAttribute('meta[name="apple-mobile-web-app-title"]', 'content')) || ''
    );
    const authSubtitle = (await page.textContent('.auth-brand p')) || '';
    check(
      authSubtitle.includes('장바구니에 담아둘게요.') && !authSubtitle.includes('마켓컬리'),
      '로그인 화면 부제 — 마켓 이름 없이',
      authSubtitle.replace(/\s+/g, ' ').trim()
    );
    await shot('01-login-390x844.png');

    console.log('\n2) 회원가입 (초대 코드)');
    await page.fill('#authNickname', '앰버');
    await page.fill('#authPassword', 'kurly1234');
    await page.click('#authMode [data-mode="register"]');
    await page.waitForSelector('#inviteField:not([hidden])');
    await page.fill('#authInvite', 'UI-TEST-2026');
    check(await page.isChecked('#authStarter'), '기본 8개 상품 체크박스 기본 선택');
    await shot('02-register-form-390x844.png');

    await page.click('#authSubmit');
    await page.waitForSelector('#appView:not([hidden])', { timeout: 15000 });
    await page.waitForSelector('.plan-item');
    const itemsAfterRegister = await page.locator('.plan-item').count();
    check(itemsAfterRegister === 4, '가입 직후 기본 8개 중 컬리 4개가 보인다', `${itemsAfterRegister}개`);

    // 계획 탭 — [컬리 | 오아시스] 마켓 선택
    check(
      (await page.locator('#planMarketPills .market-pill').count()) === 2,
      '계획 탭에 [컬리 | 오아시스] 전환 버튼'
    );
    check(await page.isVisible('#planFilterCard'), '계획 탭 정기 품목 카드');
    const planCounts0 = await page.evaluate(() => ({
      kurly: document.querySelector('#planKurlyCount').textContent.trim(),
      oasis: document.querySelector('#planOasisCount').textContent.trim(),
      kurlyActive: document.querySelector('#planMarketPills [data-market="kurly"]').classList.contains('active'),
    }));
    check(
      planCounts0.kurly === '4' && planCounts0.oasis === '4' && planCounts0.kurlyActive,
      '계획 pill 에 마켓별 개수 (컬리 4 · 오아시스 4)',
      `컬리 ${planCounts0.kurly} · 오아시스 ${planCounts0.oasis}`
    );

    // 기본 상품의 오아시스 4개 (2026-11-22 오아시스에서 확인한 상품번호·가격·한 단위)
    await page.click('#planMarketPills [data-market="oasis"]');
    await page.waitForFunction(() => document.querySelectorAll('.plan-item').length === 4, null, { timeout: 8000 });
    const oasisSeeds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.plan-item')).map((n) => ({
        badge: n.querySelector('.market-badge')?.textContent?.trim(),
        name: n.querySelector('.plan-name a')?.textContent?.trim(),
        meta: n.querySelector('.plan-meta')?.textContent?.trim(),
        href: n.querySelector('.plan-name a')?.getAttribute('href'),
      }))
    );
    check(
      oasisSeeds.length === 4 && oasisSeeds.every((i) => i.badge === '오아시스'),
      '기본 상품에 오아시스 4개가 담겨 있다',
      oasisSeeds.map((i) => i.name).join(' / ')
    );
    check(
      oasisSeeds.some((i) => /유정란 L \(20구\.대란\)/.test(i.name) && /한 단위 20구 · 11,600원/.test(i.meta)) &&
        oasisSeeds.some((i) => /GAP 부사사과 1\.3kg/.test(i.name) && /한 단위 1\.3kg · 11,800원/.test(i.meta)) &&
        oasisSeeds.some((i) => /백오이\(2입/.test(i.name) && /한 단위 2입 · 4,620원/.test(i.meta)) &&
        oasisSeeds.some((i) => /닭다리살\) \(350g\)/.test(i.name) && /한 단위 350g · 6,950원/.test(i.meta)),
      '오아시스 4개의 이름·한 단위·가격',
      oasisSeeds.map((i) => i.meta).join(' / ')
    );
    check(
      oasisSeeds.every((i) => /^https:\/\/m\.oasis\.co\.kr\/product\/detail\/\d+$/.test(i.href || '')),
      '오아시스 품목 링크는 상품 웹 페이지',
      oasisSeeds[0]?.href || ''
    );
    check(await page.isHidden('#planMarketEmpty'), '오아시스 품목이 있으면 빈 안내는 숨는다');
    check(
      (await page.innerText('#planMarketMeta')).includes('오아시스 4개'),
      '고른 마켓의 개수·금액 표시',
      await page.innerText('#planMarketMeta')
    );
    check((await page.innerText('#statItems')).includes('8'), '요약의 담을 상품은 두 마켓 전체 8개', await page.innerText('#statItems'));
    await page.waitForTimeout(400);
    await waitToastGone();
    await shot('03-1-plan-oasis-starter-390x844.png');
    await page.click('#planMarketPills [data-market="kurly"]');
    await page.waitForFunction(() => document.querySelectorAll('.plan-item').length === 4, null, { timeout: 8000 });
    check(true, '컬리를 고르면 다시 컬리 품목 4개가 보인다');

    // 상품 이미지는 컬리 CDN 에서 옵니다. 화면 캡처 전에 로딩을 기다립니다.
    await page
      .waitForFunction(
        () => {
          const imgs = Array.from(document.querySelectorAll('.plan-thumb')).filter((n) => n.tagName === 'IMG');
          return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
        },
        null,
        { timeout: 20000 }
      )
      .catch(() => {});
    const loadedThumbs = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('.plan-thumb')).filter(
          (n) => n.tagName === 'IMG' && n.complete && n.naturalWidth > 0
        ).length
    );
    check(loadedThumbs >= 3, '상품 이미지 표시', `${loadedThumbs}개 로드`);

    const qtyTexts = await page.locator('.plan-qty').allInnerTexts();
    check(qtyTexts.length === 4 && qtyTexts.every((t) => t.startsWith('1')), '수량 자동 계산 (1개씩)', qtyTexts.join(' / '));
    const nextLabel = (await page.innerText('#nextRunLabel')).trim();
    check(/\(금\) 21:00$/.test(nextLabel), '다음 정기 실행 표시', nextLabel);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 1, '가로 스크롤 없음 (390px)', `초과 ${overflow}px`);
    await waitToastGone();
    await shot('03-plan-starter-items-390x844.png');

    console.log('\n3) 상품 검색 → 계획에 추가');
    await page.click('#openSearchBtn');
    await page.waitForSelector('#searchSheet:not([hidden])');
    await page.fill('#searchInput', '우유');
    await page.click('#searchBtn');
    await page.waitForSelector('.product-card', { timeout: 30000 });
    const resultCount = await page.locator('.product-card').count();
    check(resultCount > 0, '컬리 실시간 검색 결과', `${resultCount}개 표시`);
    const searchFit = await page.evaluate(() => {
      const btn = document.querySelector('#searchBtn').getBoundingClientRect();
      const status = document.querySelector('#searchStatus').getBoundingClientRect();
      return { btnRight: Math.round(btn.right), statusLeft: Math.round(status.left), vw: window.innerWidth };
    });
    check(searchFit.btnRight <= searchFit.vw - 8, '검색 버튼이 화면 안에 들어옴', `right ${searchFit.btnRight}/${searchFit.vw}`);
    check(searchFit.statusLeft >= 8, '검색 결과 문구가 여백 안에 있음', `left ${searchFit.statusLeft}`);
    await page.waitForTimeout(800);
    await shot('04-search-results-390x844.png');

    const addable = page.locator('.product-card button:not([disabled])').first();
    await addable.click();
    await page.waitForSelector('#addModal:not([hidden])');
    await page.waitForSelector('#addModalBody .calc-box', { timeout: 15000 });
    await page.waitForTimeout(400);
    const calcText = await page.innerText('#addModalBody .calc-box');
    check(/담을 수량/.test(calcText), '담을 수량 미리 계산', calcText.split('\n')[0].slice(0, 60));
    await waitToastGone();
    const modalText = await page.innerText('#addModalBody');
    check(!/(^|\s)null(\s|$)/.test(modalText), '추가 화면에 빈 값(null)이 보이지 않음');
    await shot('05-add-item-modal-390x844.png');
    await page.click('#addModalConfirm');
    await page.waitForFunction(() => document.querySelector('#addModal').hidden);

    const itemsAfterAdd = await page.locator('.plan-item').count();
    check(itemsAfterAdd === 5, '상품이 계획에 추가됨', `${itemsAfterAdd}개`);
    check(await page.isVisible('#saveBar'), '저장 바가 나타남');

    console.log('\n4) 저장 → 새로고침 후 유지');
    await page.click('#saveBtn');
    await page.waitForFunction(() => document.querySelector('#saveBar').hidden, null, { timeout: 15000 });
    await page.waitForTimeout(400);
    await waitToastGone();
    await shot('06-plan-saved-390x844.png');

    const beforeReload = await page.locator('.plan-item').count();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#appView:not([hidden])', { timeout: 15000 });
    await page.waitForSelector('.plan-item');
    const afterReload = await page.locator('.plan-item').count();
    check(afterReload === beforeReload, '새로고침 후 계획 유지', `${afterReload}개`);

    // 디스크에 저장됐는지도 확인
    const usersDir = path.join(process.env.DATA_DIR, 'users');
    const userFiles = fs.readdirSync(usersDir).filter((f) => f.endsWith('.json'));
    const onDisk = JSON.parse(fs.readFileSync(path.join(usersDir, userFiles[0]), 'utf8'));
    check(onDisk.items.length === 9, '서버 파일에 9개 상품 저장 (기본 8 + 추가 1)', `${userFiles[0]}`);
    check(!JSON.stringify(onDisk).includes('kurly1234'), '평문 비밀번호가 파일에 없음');
    await shot('07-after-reload-390x844.png');

    console.log('\n5) 실행 탭');
    await page.click('.tabbar [data-tab="run"]');
    await page.waitForSelector('#screen-run:not([hidden])');
    check((await page.innerText('#kurlyBadge')).includes('미연결'), '컬리 연결 상태 배지', await page.innerText('#kurlyBadge'));
    check((await page.innerText('#runHint')).length > 0, '실행 안내 문구');
    await page.click('#previewBtn');
    await page.waitForSelector('#previewModal:not([hidden])');
    const previewText = await page.innerText('#previewBody');
    check(/상품 9개/.test(previewText), '미리보기 계산', previewText.split('\n')[0].slice(0, 50));
    await page.waitForTimeout(400);
    await waitToastGone();
    await shot('08-preview-modal-390x844.png');
    await page.click('#previewOk');

    // 미리보기는 실행 기록을 남기지 않습니다.
    check(await page.isVisible('#runEmpty'), '미리보기는 실행 기록을 남기지 않음');
    await shot('09-run-tab-390x844.png');

    const tabs = await page.locator('.tabbar button').allInnerTexts();
    check(tabs.length === 4 && tabs.some((t) => t.includes('요리')), '요리 탭이 함께 있습니다', tabs.map((t) => t.trim()).join(' / '));

    console.log('\n5-2) 요리 탭 — 좋아하는 요리와 필수재료');
    await page.click('.tabbar [data-tab="recipes"]');
    await page.waitForSelector('#screen-recipes:not([hidden])');
    check(await page.isVisible('#recipeEmpty'), '처음에는 등록한 요리가 없음');
    check((await page.innerText('#recipeSelectedLabel')).includes('선택한 요리 없음'), '선택한 요리 없음 안내');
    await shot('12-recipes-empty-390x844.png');

    await page.click('#newRecipeBtn');
    await page.waitForSelector('#recipeSheet:not([hidden])');
    await page.fill('#recipeName', '된장찌개');
    await page.fill('#recipeNote', '주말 저녁');
    await page.fill('#recipeSearchInput', '두부');
    await page.click('#recipeSearchBtn');
    await page.waitForSelector('#recipeSearchResults .product-card', { timeout: 30000 });
    const ingredientResults = await page.locator('#recipeSearchResults .product-card').count();
    check(ingredientResults > 0, '요리 편집 안에서 컬리 재료 검색', `${ingredientResults}개`);
    await page.locator('#recipeSearchResults .product-card button:not([disabled])').first().click();
    await page.waitForSelector('#recipeIngEdit .recipe-ing-row');
    check((await page.locator('#recipeIngEdit .recipe-ing-row').count()) === 1, '첫 재료가 추가됨');

    await page.click('#recipeQuickKeywords [data-q="대파"]');
    // 이전 검색 결과가 남아 있으므로, 새 검색어의 결과가 도착할 때까지 기다립니다.
    await page.waitForFunction(
      () => (document.querySelector('#recipeSearchStatus')?.textContent || '').includes('‘대파’'),
      null,
      { timeout: 30000 }
    );
    await page.waitForSelector('#recipeSearchResults .product-card');
    await page.locator('#recipeSearchResults .product-card button:not([disabled])').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#recipeIngEdit .recipe-ing-row').length === 2, null, {
      timeout: 10000,
    });
    check((await page.locator('#recipeIngEdit .recipe-ing-row').count()) === 2, '두 번째 재료가 추가됨');

    // 수량 +/− 스테퍼
    await page.locator('#recipeIngEdit .qty-stepper button').nth(1).click();
    const firstQty = await page.locator('#recipeIngEdit .qty-stepper span').first().innerText();
    check(firstQty.trim() === '2', '재료 수량 늘리기', firstQty.trim());
    check((await page.innerText('#recipeIngCount')).includes('2'), '재료 개수 표시', await page.innerText('#recipeIngCount'));
    await waitToastGone();
    await page.waitForTimeout(400);
    await shot('13-recipe-editor-390x844.png');

    await page.click('#recipeSaveBtn');
    await page.waitForFunction(() => document.querySelector('#recipeSheet').hidden);
    await page.waitForSelector('.recipe-card');
    check((await page.innerText('.recipe-card .recipe-name')) === '된장찌개', '저장한 요리가 카드로 보임');
    check((await page.innerText('#recipeStatSelected')).includes('1'), '선택한 요리 1개', await page.innerText('#recipeStatSelected'));
    check((await page.innerText('#recipeStatIngredients')).includes('2'), '담을 재료 2개', await page.innerText('#recipeStatIngredients'));
    const recipeOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(recipeOverflow <= 1, '가로 스크롤 없음 (요리 탭)', `초과 ${recipeOverflow}px`);
    await waitToastGone();
    await shot('14-recipe-card-390x844.png');

    console.log('\n5-3) 이번 주 요리 — 제외·선택·미리보기');
    // '집에 있음'으로 이번 주만 빼기
    await page.locator('.recipe-card .recipe-ing .skip-btn').first().click();
    await page.waitForFunction(
      () => document.querySelector('#recipeStatIngredients')?.textContent?.includes('1'),
      null,
      { timeout: 8000 }
    );
    check((await page.locator('.recipe-card .recipe-ing.skipped').count()) === 1, '재료 하나를 이번 주만 제외');
    await waitToastGone();
    await shot('15-recipe-skip-390x844.png');
    await page.locator('.recipe-card .recipe-ing .skip-btn').first().click();
    await page.waitForFunction(
      () => document.querySelector('#recipeStatIngredients')?.textContent?.includes('2'),
      null,
      { timeout: 8000 }
    );

    // 계획 탭에도 요리가 함께 담긴다는 안내
    await page.click('.tabbar [data-tab="plan"]');
    await page.waitForSelector('#screen-plan:not([hidden])');
    check(await page.isVisible('#planRecipeLine'), '계획 화면에 요리 안내 표시');
    check((await page.innerText('#planRecipeLine')).includes('이번 주 요리 1개'), '요리 1개 안내 문구', await page.innerText('#planRecipeLine'));

    // 실행 탭 — 미리보기에 요리 재료가 함께 나오고, 같은 상품은 한 줄
    await page.click('.tabbar [data-tab="run"]');
    await page.waitForSelector('#screen-run:not([hidden])');
    check(await page.isVisible('#runRecipeLine'), '실행 화면에 이번 실행 구성 표시');
    await page.click('#previewBtn');
    await page.waitForSelector('#previewModal:not([hidden])');
    const recipePreview = await page.innerText('#previewBody');
    check(/이번 주 요리 1개/.test(recipePreview), '미리보기에 요리가 포함됨', recipePreview.split('\n')[0].slice(0, 60));
    check(/🍳/.test(recipePreview), '요리 재료 표시');
    await page.click('#previewOk');

    // 새로고침해도 요리가 남는다
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#appView:not([hidden])', { timeout: 15000 });
    await page.click('.tabbar [data-tab="recipes"]');
    await page.waitForSelector('.recipe-card');
    check((await page.innerText('.recipe-card .recipe-name')) === '된장찌개', '새로고침 후 요리 유지');
    const diskAfterRecipe = JSON.parse(
      fs.readFileSync(path.join(process.env.DATA_DIR, 'users', fs.readdirSync(path.join(process.env.DATA_DIR, 'users')).filter((f) => f.endsWith('.json'))[0]), 'utf8')
    );
    check(diskAfterRecipe.recipes?.length === 1, '서버 파일에 요리 저장', `${diskAfterRecipe.recipes?.length}개`);

    // 이번 주 담기 끄기 → 선택한 요리 없음, 요리만 담기 버튼 비활성
    await page.locator('.recipe-card .switch i').first().click();
    await page.waitForFunction(
      () => document.querySelector('#recipeSelectedLabel')?.textContent?.includes('선택한 요리 없음'),
      null,
      { timeout: 8000 }
    );
    check(await page.locator('#recipeRunBtn').isDisabled(), '요리를 고르지 않으면 담기 버튼 비활성');
    check((await page.locator('.recipe-card .skip-btn').count()) === 0, '선택 해제하면 집에 있음 버튼도 숨김');
    await waitToastGone();
    await shot('16-recipe-unselected-390x844.png');
    await page.locator('.recipe-card .switch i').first().click();
    await page.waitForFunction(
      () => document.querySelector('#recipeSelectedLabel')?.textContent?.includes('된장찌개'),
      null,
      { timeout: 8000 }
    );
    check(!(await page.locator('#recipeRunBtn').isDisabled()), '다시 고르면 담기 버튼 활성');

    console.log('\n5-4) 이번 주 장볼 목록 — 컬리 로그인 없이');
    await page.click('.tabbar [data-tab="run"]');
    await page.waitForSelector('#screen-run:not([hidden])');
    await page.waitForSelector('#checklistList .check-item');
    const checklistCount = await page.locator('#checklistList .check-item').count();
    check(checklistCount === 7, '컬리 목록: 정기 5개 + 요리 재료 2개', `${checklistCount}개`);
    check(
      (await page.innerText('#checklistMeta')).includes('11개'),
      '목록 개수는 두 마켓 전체 11개 (컬리 7 + 오아시스 4)',
      await page.innerText('#checklistMeta')
    );

    const firstOpen = page.locator('#checklistList .check-open').first();
    const openHref = await firstOpen.getAttribute('href');
    const openTarget = await firstOpen.getAttribute('target');
    const openRel = await firstOpen.getAttribute('rel');
    check(/^https:\/\/www\.kurly\.com\/goods\/\d+$/.test(openHref || ''), '상품 페이지로 가는 [컬리에서 열기] 버튼', openHref || '');
    check(openTarget === '_blank' && /noopener/.test(openRel || ''), '새 탭 + noopener 로 열린다', `${openTarget} / ${openRel}`);
    await waitToastGone();
    await shot('17-run-checklist-390x844.png');

    // 컬리 미연결 → [목록으로 장보기]는 실행 기록을 만들지 않고 목록으로 안내합니다.
    check((await page.innerText('#runNowBtn')).includes('목록으로 장보기'), '미연결이면 버튼이 [목록으로 장보기]');
    await page.click('#runNowBtn');
    await waitToastGone();
    check(await page.isVisible('#runEmpty'), '[목록으로 장보기]는 실행 기록을 만들지 않는다');
    check((await page.locator('#checklistList .check-item').count()) === 7, '목록은 그대로 유지');

    await page.locator('#checklistList .check-box i').first().click();
    await page.waitForFunction(
      () => (document.querySelector('#checklistMeta')?.textContent || '').includes('담음 1'),
      null,
      { timeout: 8000 }
    );
    check((await page.locator('#checklistList .check-item.checked').count()) === 1, '담은 상품을 체크할 수 있다');
    await waitToastGone();
    await shot('18-checklist-checked-390x844.png');

    // 새로고침해도 체크가 남는다
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#appView:not([hidden])', { timeout: 15000 });
    await page.waitForSelector('#checklistList .check-item');
    await page.waitForFunction(() => document.querySelectorAll('#checklistList .check-item.checked').length === 1, null, {
      timeout: 8000,
    });
    check(true, '새로고침 후에도 담음 체크가 유지됨');

    await page.click('#checklistResetBtn');
    await page.waitForFunction(
      () => !(document.querySelector('#checklistMeta')?.textContent || '').includes('담음'),
      null,
      { timeout: 8000 }
    );
    check((await page.locator('#checklistList .check-item.checked').count()) === 0, '체크 초기화 버튼');

    console.log('\n5-5) 오아시스마켓 — 검색 마켓 전환과 마켓별 장볼 목록');
    // 계획 탭에서 [오아시스]를 고른 뒤 [＋ 상품 검색해서 담기]를 누르면 검색도 오아시스로 열린다
    await page.click('.tabbar [data-tab="plan"]');
    await page.waitForSelector('#screen-plan:not([hidden])');
    await page.click('#planMarketPills [data-market="oasis"]');
    await page.waitForFunction(() => document.querySelectorAll('.plan-item').length === 4, null, { timeout: 8000 });
    await page.click('#openSearchBtn');
    await page.waitForSelector('#searchSheet:not([hidden])');
    check((await page.locator('#searchMarketPills .market-pill').count()) === 2, '검색에 [컬리 | 오아시스] 전환 버튼');
    const preselected = await page.evaluate(() => ({
      oasisActive: document.querySelector('#searchMarketPills [data-market="oasis"]').classList.contains('active'),
      placeholder: document.querySelector('#searchInput').placeholder,
    }));
    check(
      preselected.oasisActive && /오아시스/.test(preselected.placeholder),
      '계획에서 [오아시스]를 고르면 검색도 오아시스로 열린다',
      preselected.placeholder
    );
    await page.click('#searchMarketPills [data-market="kurly"]');
    await page.waitForFunction(
      () => document.querySelector('#searchMarketPills [data-market="kurly"]').classList.contains('active'),
      null,
      { timeout: 8000 }
    );
    check(
      (await page.evaluate(() => document.querySelector('#searchInput').placeholder)).includes('컬리'),
      '검색에서 [컬리]를 고르면 안내 문구도 컬리로 바뀐다'
    );
    await page.click('#searchMarketPills [data-market="oasis"]');
    await page.waitForFunction(
      () => document.querySelector('#searchMarketPills [data-market="oasis"]').classList.contains('active'),
      null,
      { timeout: 8000 }
    );
    const oasisUi = await page.evaluate(() => {
      const btn = document.querySelector('#searchBtn');
      const style = getComputedStyle(btn);
      return {
        placeholder: document.querySelector('#searchInput').placeholder,
        green: `${style.backgroundImage} ${style.backgroundColor}`.includes('45, 106, 79'),
        cls: btn.className,
      };
    });
    check(/오아시스/.test(oasisUi.placeholder), '오아시스에서는 검색창 안내 문구가 바뀐다', oasisUi.placeholder);
    check(oasisUi.green, '오아시스 검색 버튼은 초록(#2D6A4F)', oasisUi.cls);

    await page.fill('#searchInput', '바나나');
    await page.click('#searchBtn');
    await page.waitForFunction(
      () => (document.querySelector('#searchStatus')?.textContent || '').includes('오아시스'),
      null,
      { timeout: 30000 }
    );
    await page.waitForSelector('#searchResults .product-card');
    const oasisResults = await page.locator('#searchResults .product-card').count();
    check(oasisResults > 0, '오아시스 실시간 검색 결과', `${oasisResults}개 표시`);
    const firstBadge = (await page.locator('#searchResults .product-card .market-badge').first().innerText()).trim();
    check(firstBadge === '오아시스', '검색 결과 카드에 오아시스 배지', firstBadge);
    check(
      (await page.locator('#searchResults .product-card .btn-primary').first().innerText()).includes('+ 추가'),
      '검색 결과 카드의 [+ 추가] 버튼'
    );
    await waitToastGone();
    await shot('20-oasis-search-390x844.png');

    // 오아시스 상품을 계획에 추가
    await page.locator('#searchResults .product-card button.btn-primary:not([disabled])').first().click();
    await page.waitForSelector('#addModal:not([hidden])');
    await page.waitForSelector('#addModalBody .calc-box', { timeout: 20000 });
    const oasisModal = await page.innerText('#addModalBody');
    check(/담을 수량/.test(oasisModal), '오아시스 상품도 담을 수량을 계산한다', oasisModal.split('\n')[0].slice(0, 40));
    await page.waitForTimeout(300);
    await page.click('#addModalConfirm');
    await page.waitForFunction(() => document.querySelector('#addModal').hidden);
    await page.waitForSelector('#screen-plan:not([hidden])');

    const oasisPlanItem = page.locator('.plan-item:has(a[href^="https://m.oasis.co.kr"])');
    check((await oasisPlanItem.count()) === 5, '오아시스 상품을 하나 더 담아 5개 (기본 4 + 추가 1)', `${await oasisPlanItem.count()}개`);
    check(
      (await oasisPlanItem.locator('.market-badge').first().innerText()).trim() === '오아시스',
      '계획 상품에도 오아시스 배지'
    );
    const oasisPlanWebHref = await oasisPlanItem.locator('a[href^="https://m.oasis.co.kr"]').first().getAttribute('href');
    check(
      (await page.locator('.plan-item').count()) === 5,
      '계획 탭은 고른 마켓(오아시스) 품목만 보여 준다',
      `${await page.locator('.plan-item').count()}개`
    );
    check((await page.innerText('#statItems')).includes('10'), '요약의 담을 상품은 두 마켓 전체 10개', await page.innerText('#statItems'));
    check((await page.innerText('#planMarketMeta')).includes('오아시스 5개'), '고른 마켓의 개수·금액 표시', await page.innerText('#planMarketMeta'));
    await page.click('#saveBtn');
    await page.waitForFunction(() => document.querySelector('#saveBar').hidden, null, { timeout: 15000 });
    await waitToastGone();
    await shot('20-1-plan-market-oasis-390x844.png');
    await page.click('#planMarketPills [data-market="kurly"]');
    await page.waitForFunction(() => document.querySelectorAll('.plan-item').length === 5, null, { timeout: 8000 });
    check((await page.locator('.plan-item').count()) === 5, '컬리를 고르면 컬리 품목 5개', `${await page.locator('.plan-item').count()}개`);

    // 실행 탭 장볼 목록 — 마켓 pill 로 목록이 바뀐다
    await page.click('.tabbar [data-tab="run"]');
    await page.waitForSelector('#screen-run:not([hidden])');
    await page.waitForSelector('#checklistList .check-item');
    const counts = await page.evaluate(() => ({
      kurly: document.querySelector('#checklistKurlyCount').textContent.trim(),
      oasis: document.querySelector('#checklistOasisCount').textContent.trim(),
      kurlyItems: document.querySelectorAll('#checklistList .check-item').length,
    }));
    check(counts.kurly === '7' && counts.oasis === '5', '마켓 pill 에 상품 개수 표시 (컬리 7 · 오아시스 5)', `컬리 ${counts.kurly} · 오아시스 ${counts.oasis}`);
    check(counts.kurlyItems === 7, '처음에는 컬리 상품만 보인다', `${counts.kurlyItems}개`);
    check(
      (await page.locator('#checklistList .check-open').first().innerText()).includes('컬리에서 열기'),
      '컬리 상품은 [컬리에서 열기]'
    );

    await page.click('#checklistMarketPills [data-market="oasis"]');
    await page.waitForFunction(
      () => document.querySelectorAll('#checklistList .check-item').length === 5,
      null,
      { timeout: 8000 }
    );
    check(true, '오아시스를 고르면 오아시스 상품 5개만 보인다');
    const oasisOpen = page.locator('#checklistList .check-open').first();
    check((await oasisOpen.innerText()).includes('오아시스에서 열기'), '오아시스 상품은 [오아시스에서 열기]');
    const oasisHref = await oasisOpen.getAttribute('href');
    // 아이폰: /appLink 화면(5초 뒤 App Store 로 넘어감)을 거치지 않고 oasiskr:// 로 바로
    // 오아시스는 자기 링크에 매번 새 7자리 v= 를 붙인다 — 앱이 이미 열려 있어도 새 상품으로 넘어가는 값
    check(
      /^oasiskr:\/\/deeplink\?menu=page&nextUrl=%252Fproduct%252Fdetail%252F\d+&loginyn=N&v=\d{7}&data=$/.test(
        oasisHref || ''
      ),
      '아이폰 오아시스 상품은 v= 값이 붙은 oasiskr:// 딥링크로 연결',
      oasisHref || ''
    );
    const appLinkPath = decodeURIComponent(decodeURIComponent((oasisHref || '').split('nextUrl=')[1]?.split('&')[0] || ''));
    check(
      /^\/product\/detail\/\d+$/.test(appLinkPath) && (oasisPlanWebHref || '').endsWith(appLinkPath),
      '딥링크 경로가 계획에 담긴 그 상품의 웹 주소와 같다',
      `${appLinkPath} / ${oasisPlanWebHref}`
    );
    check(
      (await oasisOpen.getAttribute('target')) === null && (await oasisOpen.getAttribute('rel')) === null,
      '아이폰 앱 스킴 링크에는 target·rel 을 붙이지 않는다 (빈 탭 방지)'
    );

    // 누를 때마다 v= 를 새로 만든다 — 목록을 다시 그리지 않고 같은 버튼을 두 번 눌러도
    // 오아시스 앱이 앞서 연 상품(유정란)에 머물지 않고 그 상품(사과)으로 이동해야 한다.
    const deeplinkV = (href) => (String(href || '').match(/[?&]v=(\d+)&data=/) || [])[1] || '';
    const deeplinkPath = (href) =>
      decodeURIComponent(decodeURIComponent(String(href || '').split('nextUrl=')[1]?.split('&')[0] || ''));
    const taps = await page.evaluate(() => {
      const a = document.querySelector('#checklistList .check-open');
      // 테스트가 실제로 oasiskr:// 로 이동하지 않도록 기본 동작만 막는다 (앱 쪽 핸들러는 그대로 실행)
      a.addEventListener('click', (event) => event.preventDefault(), { capture: true });
      const read = () => a.getAttribute('href');
      const first = read();
      a.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      const second = read();
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const third = read();
      return { first, second, third };
    });
    check(
      /^\d{7}$/.test(deeplinkV(taps.first)) &&
        /^\d{7}$/.test(deeplinkV(taps.second)) &&
        /^\d{7}$/.test(deeplinkV(taps.third)),
      '딥링크 v= 는 7자리 숫자',
      `${deeplinkV(taps.first)} / ${deeplinkV(taps.second)} / ${deeplinkV(taps.third)}`
    );
    check(
      deeplinkV(taps.first) !== deeplinkV(taps.second) && deeplinkV(taps.second) !== deeplinkV(taps.third),
      '버튼을 누를 때마다 v= 가 새로 만들어진다',
      `${deeplinkV(taps.first)} → ${deeplinkV(taps.second)} → ${deeplinkV(taps.third)}`
    );
    check(
      [taps.first, taps.second, taps.third].every((href) => deeplinkPath(href) === appLinkPath),
      'v= 가 바뀌어도 딥링크는 같은 상품을 가리킨다',
      taps.third
    );
    check(
      /^oasiskr:\/\/deeplink\?menu=page&nextUrl=%252Fproduct%252Fdetail%252F\d+&loginyn=N&v=\d{7}&data=$/.test(
        taps.third
      ),
      '누른 뒤에도 오아시스 형식 그대로',
      taps.third
    );

    // 다른 기기: 안드로이드는 /appLink, PC 는 상품 웹 페이지 — 렌더 결과까지 확인
    async function openHrefWithUserAgent(ua) {
      return page.evaluate(async (agent) => {
        Object.defineProperty(navigator, 'userAgent', { value: agent, configurable: true });
        try {
          renderChecklist();
          const a = document.querySelector('#checklistList .check-open');
          return {
            isIOS: isIOSDevice(),
            isMobile: isMobileDevice(),
            href: a?.getAttribute('href') || '',
            target: a?.getAttribute('target'),
          };
        } finally {
          delete navigator.userAgent;
        }
      }, ua);
    }

    const androidUA =
      'Mozilla/5.0 (Linux; Android 14; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
    const androidOpen = await openHrefWithUserAgent(androidUA);
    check(
      androidOpen.isIOS === false && androidOpen.isMobile === true,
      '안드로이드는 iOS 로 보지 않는다',
      `iOS ${androidOpen.isIOS} · mobile ${androidOpen.isMobile}`
    );
    check(
      /^https:\/\/m\.oasis\.co\.kr\/appLink\?r=%2Fproduct%2Fdetail%2F\d+$/.test(androidOpen.href),
      '안드로이드는 appLink 로 연결',
      androidOpen.href
    );
    check(androidOpen.target === '_blank', '안드로이드·웹 링크는 새 탭으로 연다');

    const desktopUA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const desktopOpen = await openHrefWithUserAgent(desktopUA);
    check(
      desktopOpen.isIOS === false && desktopOpen.isMobile === false,
      'PC 는 iOS·휴대폰 모두 아니다',
      `iOS ${desktopOpen.isIOS} · mobile ${desktopOpen.isMobile}`
    );
    check(
      /^https:\/\/m\.oasis\.co\.kr\/product\/detail\/\d+$/.test(desktopOpen.href),
      'PC 에서는 상품 웹 페이지로 연결',
      desktopOpen.href
    );
    await page.evaluate(() => renderChecklist()); // 아이폰 화면으로 되돌린다
    check(
      /^oasiskr:\/\//.test((await page.locator('#checklistList .check-open').first().getAttribute('href')) || ''),
      '아이폰 화면으로 돌아오면 다시 oasiskr:// 링크'
    );
    check(
      /^https:\/\/m\.oasis\.co\.kr\/product\/detail\/\d+$/.test(oasisPlanWebHref || ''),
      '품목 이름 링크는 그대로 상품 웹 페이지',
      oasisPlanWebHref || ''
    );
    check(
      await page.evaluate(() =>
        document.querySelector('#checklistList .check-item')?.classList.contains('oasis')
      ),
      '오아시스 항목은 초록 스타일'
    );

    await page.locator('#checklistList .check-box i').first().click();
    await page.waitForFunction(
      () => (document.querySelector('#checklistMeta')?.textContent || '').includes('담음 1'),
      null,
      { timeout: 8000 }
    );
    check(true, '오아시스 상품도 [담음] 체크된다');
    await waitToastGone();
    await page.locator('#checklistCard').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot('15-oasis-checklist-390x844.png');

    // 컬리 목록은 그대로 (마켓별 체크 분리)
    await page.click('#checklistMarketPills [data-market="kurly"]');
    await page.waitForFunction(
      () => document.querySelectorAll('#checklistList .check-item').length === 7,
      null,
      { timeout: 8000 }
    );
    check(
      (await page.locator('#checklistList .check-item.checked').count()) === 0,
      '오아시스 체크는 컬리 목록에 섞이지 않는다'
    );

    // 뒷 단계(목록 알림 모드)를 위해 오아시스 상품은 계획에서 뺀다
    await page.click('#checklistMarketPills [data-market="oasis"]');
    await page.locator('#checklistList .check-box i').first().click();
    await page.waitForFunction(
      () => !(document.querySelector('#checklistMeta')?.textContent || '').includes('담음'),
      null,
      { timeout: 8000 }
    );
    await page.click('.tabbar [data-tab="plan"]');
    await page.waitForSelector('#screen-plan:not([hidden])');
    await page.click('#planMarketPills [data-market="oasis"]');
    await page.waitForSelector('.plan-item:has(a[href^="https://m.oasis.co.kr"])');
    // 기본 4개 + 검색으로 담은 1개 — 오아시스 품목을 모두 뺀다 (뒷 단계는 컬리만으로 진행)
    let oasisLeft = await page.locator('.plan-item:has(a[href^="https://m.oasis.co.kr"])').count();
    while (oasisLeft > 0) {
      await page.locator('.plan-item:has(a[href^="https://m.oasis.co.kr"]) .btn-danger-ghost').first().click();
      await page.waitForFunction(
        (n) => document.querySelectorAll('.plan-item').length === n - 1,
        oasisLeft,
        { timeout: 8000 }
      );
      oasisLeft = await page.locator('.plan-item:has(a[href^="https://m.oasis.co.kr"])').count();
    }
    await page.click('#saveBtn');
    await page.waitForFunction(() => document.querySelector('#saveBar').hidden, null, { timeout: 15000 });
    check(await page.isVisible('#planMarketEmpty'), '오아시스 품목을 비우면 안내 문구가 보인다');
    await page.click('#planMarketPills [data-market="kurly"]');
    await page.waitForFunction(() => document.querySelectorAll('.plan-item').length === 5, null, { timeout: 8000 });
    check((await page.locator('.plan-item').count()) === 5, '오아시스 상품 정리 후 계획 5개');

    // 설정 — 목록 알림만 받기
    await page.click('.tabbar [data-tab="settings"]');
    await page.waitForSelector('#screen-settings:not([hidden])');
    check(await page.isVisible('#checklistOnlyToggle'), '설정에 [목록 알림만 받기] 스위치');
    await page.locator('#checklistOnlyToggle + i').click();
    await page.waitForFunction(
      () => (document.querySelector('#checklistOnlyState')?.textContent || '').includes('켜짐'),
      null,
      { timeout: 8000 }
    );
    check(true, '목록 알림 모드 켜기');

    // 장보기 완료 — 체크와 이번 주 요리 선택을 함께 초기화
    await page.click('.tabbar [data-tab="run"]');
    await page.waitForSelector('#checklistList .check-item');
    check((await page.innerText('#checklistHint')).includes('목록 알림 모드'), '목록 알림 모드 안내 문구');
    await page.locator('#checklistList .check-box i').first().click();
    await page.waitForFunction(
      () => (document.querySelector('#checklistMeta')?.textContent || '').includes('담음 1'),
      null,
      { timeout: 8000 }
    );
    await page.click('#checklistDoneBtn');
    await page.waitForFunction(() => !(document.querySelector('#checklistMeta')?.textContent || '').includes('담음'), null, {
      timeout: 8000,
    });
    check((await page.locator('#checklistList .check-item.checked').count()) === 0, '장보기 완료 — 체크 초기화');
    const itemsAfterDone = await page.locator('#checklistList .check-item').count();
    check(itemsAfterDone === 5, '장보기 완료 — 요리 선택이 풀려 정기 5개만 남음', `${itemsAfterDone}개`);
    await waitToastGone();
    await shot('19-checklist-done-390x844.png');

    // 목록 모드 끄기 (다음 단계 기본값 유지용)
    await page.click('.tabbar [data-tab="settings"]');
    await page.waitForSelector('#screen-settings:not([hidden])');
    await page.locator('#checklistOnlyToggle + i').click();
    await page.waitForFunction(
      () => (document.querySelector('#checklistOnlyState')?.textContent || '').includes('꺼짐'),
      null,
      { timeout: 8000 }
    );
    await waitToastGone();

    console.log('\n6) 설정 탭');
    await page.click('.tabbar [data-tab="settings"]');
    await page.waitForSelector('#screen-settings:not([hidden])');
    check((await page.inputValue('#scheduleTime')) === '21:00', '기본 실행 시각 21:00');
    check((await page.inputValue('#scheduleWeekday')) === '5', '기본 요일 금요일');
    check((await page.inputValue('#scheduleInterval')) === '1', '기본 주기 1주');
    const anchor = await page.inputValue('#scheduleAnchor');
    check(/^\d{4}-\d{2}-\d{2}$/.test(anchor), '기준일 자동 입력', anchor);


    // 이 기기 푸시 알림 (iOS 홈 화면 앱 Web Push)
    await page.waitForFunction(() => {
      const el = document.querySelector('#pushStateText');
      return el && el.textContent && el.textContent !== '확인 중…';
    });
    const pushUi = await page.evaluate(() => ({
      hasToggle: !!document.querySelector('#pushToggle'),
      toggleDisabled: document.querySelector('#pushToggle')?.disabled ?? null,
      testDisabled: document.querySelector('#pushTestBtn')?.disabled ?? null,
      state: document.querySelector('#pushStateText')?.textContent?.trim(),
      hint: document.querySelector('#pushHint')?.textContent?.trim(),
    }));
    check(pushUi.hasToggle && (pushUi.toggleDisabled === false || /Safari 탭에서는/.test(pushUi.hint || '')), '이 기기 푸시 알림 스위치', pushUi.state);
    if (/Safari 탭에서는/.test(pushUi.hint || '')) {
      // 이 점검은 아이폰 UA(일반 Safari 탭)로 돌기 때문에, 홈 화면 앱에서 켜라는 안내가 맞습니다.
      check(pushUi.toggleDisabled === true && /홈 화면에 추가/.test(pushUi.hint), 'Safari 탭에서는 푸시 불가 안내', pushUi.hint);
    } else {
      check(pushUi.testDisabled === true, '구독 전 테스트 알림 버튼 비활성', pushUi.hint || '');
    }
    await shot('10-settings-390x844.png');

    // 주기를 바꾸면 계획 탭의 소비량 라벨도 함께 바뀐다 (기본 1주 → 2주 → 1주)
    await page.selectOption('#scheduleInterval', '2');
    await page.waitForFunction(
      () => (document.querySelector('#scheduleLabel')?.textContent || '').includes('2주마다'),
      null,
      { timeout: 8000 }
    );
    const labelTwoWeeks = await page.evaluate(
      () => document.querySelector('.plan-consumption-label')?.textContent || ''
    );
    check(labelTwoWeeks.includes('2주 소비량'), '주기에 맞춘 소비량 라벨 (2주)', labelTwoWeeks);
    await page.selectOption('#scheduleInterval', '1');
    await page.waitForFunction(
      () => (document.querySelector('#scheduleLabel')?.textContent || '').includes('1주마다'),
      null,
      { timeout: 8000 }
    );
    const labelOneWeek = await page.evaluate(
      () => document.querySelector('.plan-consumption-label')?.textContent || ''
    );
    check(labelOneWeek.includes('1주 소비량'), '주기에 맞춘 소비량 라벨 (1주)', labelOneWeek);

    console.log('\n7) 서비스 워커 / PWA');
    const swState = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported';
      const reg = await navigator.serviceWorker.ready;
      return reg && reg.active ? reg.active.state : 'no-active';
    });
    check(swState === 'activated', '서비스 워커 등록·활성화', swState);

    const manifest = await page.evaluate(async () => {
      const res = await fetch('/manifest.json');
      return res.ok ? res.json() : null;
    });
    check(manifest && manifest.display === 'standalone' && manifest.icons.length >= 3, '매니페스트 로드', manifest ? manifest.name : 'null');

    const offlineHtml = await page.evaluate(async () => {
      const names = await caches.keys();
      const name = names.find((n) => n.startsWith('kurly-')) || names[0];
      if (!name) return [];
      const cache = await caches.open(name);
      const keys = await cache.keys();
      return keys.map((k) => new URL(k.url).pathname);
    });
    check(offlineHtml.includes('/index.html'), '앱 껍데기 캐시(오프라인)', `${offlineHtml.length}개 파일`);

    // 데스크톱에서도 한 번 확인 (레이아웃이 깨지지 않는지)
    await context.close();
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    const dpage = await desktop.newPage();
    await dpage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await dpage.waitForSelector('#authView:not([hidden])');
    await dpage.screenshot({ path: path.join(SHOT_DIR, '11-desktop-login.png') });
    shots.push(path.join(SHOT_DIR, '11-desktop-login.png'));
    const desktopWidth = await dpage.evaluate(() => document.querySelector('.auth').getBoundingClientRect().width);
    check(desktopWidth > 380 && desktopWidth <= 500, '데스크톱에서 가운데 정렬', `${Math.round(desktopWidth)}px`);
    await desktop.close();

    console.log('\n8) 콘솔 오류');
    check(consoleErrors.length === 0, '콘솔 오류 0건', consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, '자바스크립트 예외 0건', pageErrors.slice(0, 3).join(' | '));
  } catch (err) {
    failed = true;
    console.error('\n💥 테스트 중 예외:', err.message);
    try {
      await page.screenshot({ path: path.join(SHOT_DIR, '99-failure.png') });
      shots.push(path.join(SHOT_DIR, '99-failure.png'));
    } catch {
      /* 무시 */
    }
    console.error(err.stack);
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => app.server.close(resolve));
  }

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n결과: ${passed}/${checks.length} 통과${failed ? ' — 실패 있음' : ' — 모두 통과'}`);
  console.log(`스크린샷 ${shots.length}장: ${SHOT_DIR}`);
  fs.writeFileSync(
    path.join(SHOT_DIR, 'ui-test-report.json'),
    `${JSON.stringify({ at: new Date().toISOString(), passed, total: checks.length, failed, checks, shots, consoleErrors, pageErrors }, null, 2)}\n`
  );
  if (failed) process.exitCode = 1;
}

main();
