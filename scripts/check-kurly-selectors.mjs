#!/usr/bin/env node
/**
 * 선택자 점검(수동 실행) — 컬리 화면이 바뀌었는지 확인하는 진단 도구.
 *
 *   node scripts/check-kurly-selectors.mjs
 *
 * 로그인 없이(비회원 장바구니) 실제 상품 페이지를 열어
 *   "장바구니 담기" 버튼 → 옵션 선택 → 수량 조절 → 담기 요청
 * 이 지금도 동작하는지 확인합니다. 비회원 장바구니에 상품 1개가 담깁니다(계정과 무관).
 * 자동 테스트(npm test)에는 포함되지 않습니다 — 컬리에 실제 요청을 보내기 때문입니다.
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, '..', '..');

for (const [key, value] of Object.entries({
  PLAYWRIGHT_BROWSERS_PATH: path.join(WORKSPACE, '.tools', 'pw-browsers'),
  LD_LIBRARY_PATH: path.join(WORKSPACE, '.tools', 'libs'),
})) {
  if (!process.env[key] && fs.existsSync(value)) process.env[key] = value;
}

const lib = require('../lib/kurly-browser');

const ITEM = {
  productNo: 5029849,
  dealProductNo: 10029849,
  name: "[Kurly's] 동물복지 유정란 15구",
  optionName: null,
};

const logger = {
  info: (m) => console.log('  ·', m),
  step: (m) => console.log('▶', m),
  warn: (m) => console.log('  ⚠️', m),
  error: (m) => console.log('  ❌', m),
};

const { browser, page } = await lib.launchBrowser({ headless: true });
try {
  logger.step('상품 페이지 열기');
  await lib.openGoods(page, ITEM.productNo, logger);
  console.log('  상품 페이지 제목:', await page.title());

  const addButton = page.getByRole('button', { name: '장바구니 담기' }).first();
  console.log('  담기 버튼 개수:', await addButton.count());
  const soldOut = await page.evaluate(() => /일시\s*품절|품절된 상품/.test(document.body.innerText));
  console.log('  품절 표시:', soldOut);

  logger.step('옵션/수량 확인');
  const result = await lib.addItemToCart(page, ITEM, { quantity: 1, logger });
  console.log('  담기 결과:', result);

  logger.step('장바구니 확인');
  const cart = await lib.readCart(page);
  console.log('  장바구니:', cart ? { totalCount: cart.totalCount, items: cart.items.length } : null);

  if (!cart || !cart.totalCount) {
    console.error('\n⚠️ 장바구니 확인에 실패했습니다. 컬리 화면 구조가 바뀌었을 수 있습니다.');
    process.exitCode = 2;
  } else {
    console.log('\n✅ 컬리 선택자 정상 동작 (담기 + 장바구니 확인)');
  }
} catch (err) {
  console.error('\n❌ 실패:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
