#!/usr/bin/env node
/**
 * 아이폰 크기(390×844)에서 실제 화면을 Playwright 로 조작하는 점검.
 *   회원가입(초대 코드) → 기본 4개 상품 → 검색 → 추가 → 저장 → 새로고침 후 유지
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
    await page.screenshot({ path: file, fullPage: false });
    shots.push(file);
    console.log(`  📸 ${file}`);
  }

  try {
    console.log('\n1) 로그인 화면');
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#authView:not([hidden])');
    check(await page.isVisible('#authNickname'), '로그인/회원가입 화면이 보인다');
    check((await page.title()) === '컬리 정기 장바구니', '페이지 제목', await page.title());
    const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
    check(manifestHref === '/manifest.json', 'PWA 매니페스트 연결', manifestHref || '');
    check(
      (await page.getAttribute('meta[name="apple-mobile-web-app-capable"]', 'content')) === 'yes',
      'iOS 홈 화면 추가 메타 태그'
    );
    await shot('01-login-390x844.png');

    console.log('\n2) 회원가입 (초대 코드)');
    await page.fill('#authNickname', '앰버');
    await page.fill('#authPassword', 'kurly1234');
    await page.click('#authMode [data-mode="register"]');
    await page.waitForSelector('#inviteField:not([hidden])');
    await page.fill('#authInvite', 'UI-TEST-2026');
    check(await page.isChecked('#authStarter'), '기본 4개 상품 체크박스 기본 선택');
    await shot('02-register-form-390x844.png');

    await page.click('#authSubmit');
    await page.waitForSelector('#appView:not([hidden])', { timeout: 15000 });
    await page.waitForSelector('.plan-item');
    const itemsAfterRegister = await page.locator('.plan-item').count();
    check(itemsAfterRegister === 4, '가입 직후 기본 4개 상품', `${itemsAfterRegister}개`);

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
    check(qtyTexts.length === 4 && qtyTexts.every((t) => t.startsWith('2')), '수량 자동 계산 (2개씩)', qtyTexts.join(' / '));
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
    check(onDisk.items.length === 5, '서버 파일에 5개 상품 저장', `${userFiles[0]}`);
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
    check(/상품 5개/.test(previewText), '미리보기 계산', previewText.split('\n')[0].slice(0, 50));
    await page.waitForTimeout(400);
    await waitToastGone();
    await shot('08-preview-modal-390x844.png');
    await page.click('#previewOk');

    // 미리보기는 실행 기록을 남기지 않습니다.
    check(await page.isVisible('#runEmpty'), '미리보기는 실행 기록을 남기지 않음');
    await shot('09-run-tab-390x844.png');

    console.log('\n6) 설정 탭');
    await page.click('.tabbar [data-tab="settings"]');
    await page.waitForSelector('#screen-settings:not([hidden])');
    check((await page.inputValue('#scheduleTime')) === '21:00', '기본 실행 시각 21:00');
    check((await page.inputValue('#scheduleWeekday')) === '5', '기본 요일 금요일');
    check((await page.inputValue('#scheduleInterval')) === '2', '기본 주기 2주');
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
