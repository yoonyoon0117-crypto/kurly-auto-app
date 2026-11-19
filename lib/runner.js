'use strict';
/**
 * 한 사용자의 "장바구니 담기" 실행 1회.
 *   · 계획(active 상품)을 수량으로 환산 → Playwright 로 담기 → 장바구니 확인 → 기록·알림
 *   · 컬리 세션이 만료됐으면 상태를 'expired' 로 바꾸고 다시 연결하라고 알립니다.
 *   · 주문·결제는 하지 않습니다. 오직 장바구니에 담기만 합니다.
 */
const crypto = require('crypto');
const { computeQuantity, formatKst, formatKstIso } = require('./plan');
const { openJson } = require('./crypto-box');
const store = require('./store');
const { notify } = require('./notify');
const { createLogger } = require('./logger');

const MAX_HISTORY_ITEMS = 40;

function plannedItems(user, { only = null } = {}) {
  const items = (user.items || []).filter((i) => i.active !== false);
  const filtered = only && only.length
    ? items.filter((i) => {
        const keys = only.map((k) => String(k).toLowerCase());
        return (
          keys.includes(String(i.id).toLowerCase()) ||
          keys.includes(String(i.productNo)) ||
          keys.some((k) => String(i.name || '').toLowerCase().includes(k))
        );
      })
    : items;
  return filtered.map((item) => ({
    id: item.id,
    productNo: item.productNo,
    dealProductNo: item.dealProductNo ?? null,
    name: item.name,
    optionName: item.optionName ?? null,
    unitLabel: item.unitLabel,
    unitSize: item.unitSize,
    consumption: item.consumption,
    quantity: computeQuantity(item),
    price: item.price,
  }));
}

function buildSummary({ user, trigger, dryRun, planned, startedAt }) {
  return {
    id: `run_${crypto.randomBytes(5).toString('base64url')}`,
    trigger,
    dryRun,
    ranAtMs: startedAt,
    ranAt: formatKstIso(startedAt),
    ranAtLabel: formatKst(startedAt),
    status: dryRun ? 'preview' : 'running',
    items: planned.map((p) => ({
      productNo: p.productNo,
      dealProductNo: p.dealProductNo,
      name: p.name,
      quantity: p.quantity,
      price: p.price,
      status: dryRun ? 'planned' : 'pending',
      reason: null,
      cartQuantity: null,
    })),
    added: 0,
    merged: 0,
    failed: 0,
    skipped: 0,
    estimatedTotal: planned.reduce((sum, p) => sum + (Number(p.price) || 0) * p.quantity, 0),
    cartTotalCount: null,
    cartVerified: false,
    error: null,
    errorCode: null,
    notification: null,
    durationMs: 0,
    nickname: user.nickname,
  };
}

function finalizeStatus(summary) {
  if (summary.dryRun) summary.status = 'preview';
  else if (summary.error) summary.status = 'failed';
  else if (summary.failed > 0) summary.status = 'partial';
  else summary.status = 'success';
  return summary;
}

async function markKurly(userId, patch) {
  try {
    await store.updateUser(userId, (u) => {
      u.kurly = { ...u.kurly, ...patch };
      return u;
    });
  } catch {
    /* 사용자 기록 갱신 실패는 실행 결과를 막지 않습니다 */
  }
}

/**
 * @param {object} opts
 * @param {object} opts.user 사용자 레코드
 * @param {'scheduled'|'manual'} [opts.trigger]
 * @param {boolean} [opts.dryRun] 브라우저 없이 계산만
 * @param {(msg:string)=>void} [opts.onProgress]
 * @param {object} [opts.logger]
 */
async function runCartForUser({ user, trigger = 'manual', dryRun = false, onProgress, logger = null }) {
  const log = logger || createLogger(`run:${user.nickname}`);
  const startedAt = Date.now();
  const planned = plannedItems(user);
  const summary = buildSummary({ user, trigger, dryRun, planned, startedAt });
  const progress = (msg) => {
    if (onProgress) onProgress(msg);
  };

  const finish = async () => {
    summary.durationMs = Date.now() - startedAt;
    finalizeStatus(summary);
    if (!dryRun) {
      const notification = { webhookUrl: '', webhookType: 'auto', ...(user.notification || {}) };
      try {
        summary.notification = await notify(summary, notification, log, { nickname: user.nickname });
      } catch (err) {
        log.warn(`알림 전송 실패: ${err.message}`);
      }
      try {
        await store.recordRun(user.userId, {
          ...summary,
          items: summary.items.slice(0, MAX_HISTORY_ITEMS),
        });
      } catch (err) {
        log.warn(`실행 기록 저장 실패: ${err.message}`);
      }
    }
    return summary;
  };

  if (!planned.length) {
    summary.error = '계획에 담을 상품이 없습니다. 먼저 장바구니 계획에 상품을 추가해 주세요.';
    summary.errorCode = 'NO_ITEMS';
    log.warn(summary.error);
    return finish();
  }

  if (dryRun) {
    log.info(`[미리보기] ${planned.map((p) => `${p.name} ×${p.quantity}`).join(', ')}`);
    progress('계산 완료');
    return finish();
  }

  let session = null;
  try {
    if (!user.kurly?.session) {
      throw Object.assign(new Error('컬리 계정이 연결되어 있지 않습니다.'), { code: 'KURLY_NOT_CONNECTED' });
    }
    session = openJson(user.kurly.session);
    if (!session || !Array.isArray(session.cookies) || !session.cookies.length) {
      throw new Error('저장된 컬리 세션이 비어 있습니다.');
    }
  } catch (err) {
    summary.error = '컬리 계정 연결이 필요합니다. 설정에서 컬리 아이디·비밀번호로 연결해 주세요.';
    summary.errorCode = 'KURLY_NOT_CONNECTED';
    log.warn(`세션 없음/복호화 실패: ${err.message}`);
    await markKurly(user.userId, { status: 'expired', lastError: '세션을 읽지 못했습니다. 다시 연결해 주세요.' });
    return finish();
  }

  const browserLib = require('./kurly-browser');
  let browser = null;
  let page = null;
  try {
    progress('브라우저 준비 중…');
    const launched = await browserLib.launchBrowser({ headless: true, storageState: session });
    browser = launched.browser;
    page = launched.page;

    progress('컬리 로그인 확인 중…');
    const loggedIn = await browserLib.isLoggedIn(page);
    if (!loggedIn) {
      summary.error = '컬리 로그인이 만료되었습니다. 설정에서 컬리 계정을 다시 연결해 주세요.';
      summary.errorCode = 'SESSION_EXPIRED';
      summary.items.forEach((item) => {
        item.status = 'skipped';
        item.reason = '로그인 만료';
      });
      summary.skipped = summary.items.length;
      await markKurly(user.userId, {
        status: 'expired',
        lastError: '컬리 로그인이 만료되었습니다. 다시 연결해 주세요.',
      });
      log.warn(summary.error);
      return finish();
    }

    for (let i = 0; i < summary.items.length; i += 1) {
      const entry = summary.items[i];
      const item = planned[i];
      progress(`${i + 1}/${planned.length} ${item.name} 담는 중…`);
      log.step(`(${i + 1}/${planned.length}) ${item.name} × ${item.quantity}`);
      try {
        const result = await browserLib.addItemToCart(page, item, { quantity: item.quantity, logger: log });
        entry.status = result.status;
        entry.cartQuantity = result.quantity;
        entry.optionLabel = result.optionLabel ?? null;
        if (result.status === 'merged') summary.merged += 1;
        else summary.added += 1;
      } catch (err) {
        entry.status = 'failed';
        entry.reason = err.message;
        summary.failed += 1;
        if (err.code === 'LOGIN_REQUIRED') {
          summary.error = '컬리 로그인이 실행 중에 풀렸습니다. 설정에서 다시 연결해 주세요.';
          summary.errorCode = 'SESSION_EXPIRED';
          summary.items.slice(i + 1).forEach((rest) => {
            if (rest.status === 'pending') {
              rest.status = 'skipped';
              rest.reason = '로그인 만료로 중단';
              summary.skipped += 1;
            }
          });
          await markKurly(user.userId, {
            status: 'expired',
            lastError: '실행 중 로그인이 풀렸습니다. 다시 연결해 주세요.',
          });
          throw err;
        }
        log.error(`담기 실패: ${err.message}`);
      }
      await page.waitForTimeout(500);
    }

    progress('장바구니 확인 중…');
    try {
      const cart = await browserLib.readCart(page);
      if (cart) {
        summary.cartVerified = true;
        summary.cartTotalCount = cart.totalCount;
        const byDeal = new Map(cart.items.map((c) => [Number(c.dealProductNo), c.quantity]));
        for (const entry of summary.items) {
          if (entry.dealProductNo && byDeal.has(Number(entry.dealProductNo))) {
            entry.cartQuantity = byDeal.get(Number(entry.dealProductNo));
          }
        }
      }
    } catch (err) {
      log.warn(`장바구니 확인 실패: ${err.message}`);
    }

    if (!summary.errorCode) {
      await markKurly(user.userId, {
        status: 'connected',
        lastVerifiedAt: Date.now(),
        lastError: null,
      });
    }
    progress('마무리 중…');
    return await finish();
  } catch (err) {
    if (!summary.error) {
      summary.error = err.message;
      summary.errorCode = err.code || 'RUN_FAILED';
    }
    summary.items.forEach((item) => {
      if (item.status === 'pending') {
        item.status = 'skipped';
        item.reason = '실행이 중단되어 시도하지 못했습니다.';
        summary.skipped += 1;
      }
    });
    summary.failed = Math.max(summary.failed, summary.items.filter((i) => i.status === 'failed').length);
    log.error(`실행 중단: ${err.message}`);
    return await finish();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** 미리보기(브라우저 없이) — 화면에서 "무엇을 몇 개 담을지" 먼저 보여줄 때 */
function previewPlan(user) {
  const planned = plannedItems(user);
  return {
    items: planned.map((p) => ({
      name: p.name,
      quantity: p.quantity,
      price: p.price,
      lineTotal: (Number(p.price) || 0) * p.quantity,
      unitLabel: p.unitLabel,
      unitSize: p.unitSize,
      consumption: p.consumption,
    })),
    estimatedTotal: planned.reduce((sum, p) => sum + (Number(p.price) || 0) * p.quantity, 0),
    count: planned.length,
  };
}

module.exports = { runCartForUser, previewPlan, plannedItems };
