'use strict';
/**
 * 한 사용자의 "장바구니 담기" 실행 1회.
 *   · 담을 목록(정기 품목 + 이번 주 요리 재료)을 수량으로 환산 → Playwright 로 담기 → 장바구니 확인 → 기록·알림
 *   · 어떤 결과든(성공·부분·실패·담을 것 없음·세션 만료) 푸시 알림을 보내고, 그 결과를 실행 기록에 남깁니다.
 *   · 성공하면 컬리 세션(쿠키)을 새로 받아 암호화해 저장합니다 — 컬리가 갱신한 토큰을 다음 실행으로 이어갑니다.
 *   · 컬리 세션이 만료됐으면 상태를 'expired' 로 바꾸고 다시 연결하라고 알립니다.
 *   · 주문·결제는 하지 않습니다. 오직 장바구니에 담기만 합니다.
 */
const crypto = require('crypto');
const { computeQuantity, formatKst, formatKstIso, normalizeMarket } = require('./plan');
const { openJson, sealJson } = require('./crypto-box');
const store = require('./store');
const { notify } = require('./notify');
const push = require('./webpush');
const recipes = require('./recipes');
const checklist = require('./checklist');
const { createLogger } = require('./logger');

const MAX_HISTORY_ITEMS = 40;
// 오아시스는 계정 연동이 없어 자동으로 담지 않습니다 — 장볼 목록에서 직접 담도록 안내합니다.
const OASIS_MANUAL_REASON = '오아시스 상품 — 실행 탭 장볼 목록에서 직접 담아 주세요';

/**
 * 자동 담기(Playwright)로 넘길 상품 — 컬리 상품만입니다.
 * @param {Array<{market?:string}>} items
 */
function selectAutomationItems(items) {
  return (Array.isArray(items) ? items : []).filter((item) => normalizeMarket(item?.market) === 'kurly');
}

/**
 * 이번 실행에 담을 상품 목록.
 * @param {object} user 사용자 레코드
 * @param {{mode?:'auto'|'combined'|'recipes_only'|'regular_only'}} [opts]
 */
function plannedItems(user, { mode = 'auto' } = {}) {
  const mixed = recipes.mergeForRun(user, { mode });
  return mixed.items.map((item) => ({
    id: item.id,
    market: normalizeMarket(item.market),
    productNo: item.productNo,
    dealProductNo: item.dealProductNo ?? null,
    name: item.name,
    optionName: item.optionName ?? null,
    unitLabel: item.unitLabel,
    unitSize: item.unitSize,
    consumption: item.consumption,
    quantity: item.quantity,
    price: item.price,
    imageUrl: item.imageUrl ?? null,
    volume: item.volume ?? null,
    url: item.url ?? null,
    source: item.source,
    recipeNames: item.recipeNames || [],
  }));
}

function buildSummary({ user, trigger, dryRun, planned, mixed, startedAt }) {
  return {
    id: `run_${crypto.randomBytes(5).toString('base64url')}`,
    trigger,
    dryRun,
    mode: mixed.mode,
    modeLabel: recipes.RUN_MODE_LABEL[mixed.mode] || mixed.mode,
    counts: mixed.counts,
    recipeNames: mixed.counts.recipeNames,
    ranAtMs: startedAt,
    ranAt: formatKstIso(startedAt),
    ranAtLabel: formatKst(startedAt),
    status: dryRun ? 'preview' : 'running',
    items: planned.map((p) => ({
      market: p.market,
      productNo: p.productNo,
      dealProductNo: p.dealProductNo,
      name: p.name,
      quantity: p.quantity,
      price: p.price,
      source: p.source,
      recipeNames: p.recipeNames,
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
    checklistMode: false,
    checklist: null,
    recipesCleared: 0,
    sessionRefreshed: false,
    durationMs: 0,
    nickname: user.nickname,
  };
}

function finalizeStatus(summary) {
  if (summary.dryRun) summary.status = 'preview';
  else if (summary.checklistMode) summary.status = 'checklist';
  else if (summary.error) summary.status = 'failed';
  else if (summary.failed > 0) summary.status = 'partial';
  else summary.status = 'success';
  return summary;
}

/**
 * 컬리 로그인 없이 "장볼 목록"만 준비할 상황인지.
 *  · 사용자가 '목록 알림만 받기'를 켰거나,
 *  · 저장된 컬리 세션이 없으면 실패가 아니라 목록 준비로 처리합니다.
 */
function shouldPrepareChecklist(user) {
  if (user?.checklistOnly === true) return true;
  return !user?.kurly?.session;
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
 * 새로 확인된 컬리 세션(쿠키)을 암호화해 사용자 레코드에 되돌려 저장합니다.
 *  · 컬리는 실행 중에 쿠키를 갱신합니다. 저장하지 않으면 다음 실행에서 예전 토큰으로 실패합니다.
 *  · 쿠키가 비어 있으면(로그아웃 상태) 저장하지 않습니다 — 멀쩡한 세션을 지우지 않기 위해서입니다.
 * @returns {Promise<boolean>} 저장했는지
 */
async function persistKurlySession(userId, page, logger = null) {
  if (!page || !page.context || typeof page.context !== 'function') return false;
  let state = null;
  try {
    state = await page.context().storageState();
  } catch (err) {
    logger?.warn?.(`컬리 세션 읽기 실패: ${err.message}`);
    return false;
  }
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  if (!cookies.length) return false;
  try {
    const sealed = sealJson({ cookies, origins: Array.isArray(state.origins) ? state.origins : [] });
    await store.updateUser(userId, (u) => {
      u.kurly = { ...u.kurly, session: sealed, sessionRefreshedAt: Date.now() };
      return u;
    });
    return true;
  } catch (err) {
    logger?.warn?.(`컬리 세션 저장 실패: ${err.message}`);
    return false;
  }
}

/**
 * 담기가 끝나면 이번 주 요리 선택을 풀어 다음 주를 깨끗하게 시작합니다.
 *  · 사용자가 '정기 실행 후 선택 해제'를 꺼 두면 아무것도 하지 않습니다.
 *  · 정기만 담은 실행(regular_only)과 실패한 실행은 건드리지 않습니다.
 */
async function resetRecipeSelection(userId, summary, logger = null) {
  if (summary.dryRun) return 0;
  if (summary.mode !== 'combined' && summary.mode !== 'recipes_only') return 0;
  if (summary.status !== 'success' && summary.status !== 'partial') return 0;
  try {
    let cleared = 0;
    await store.updateUser(userId, (u) => {
      if (u.recipeSettings?.clearSelectedAfterRun === false) return u;
      const result = recipes.resetAfterRun(u.recipes);
      u.recipes = result.recipes;
      cleared = result.cleared;
      return u;
    });
    if (cleared) logger?.info?.(`이번 주 요리 ${cleared}개 선택을 풀었습니다.`);
    return cleared;
  } catch (err) {
    logger?.warn?.(`요리 선택 해제 실패: ${err.message}`);
    return 0;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.user 사용자 레코드
 * @param {'scheduled'|'manual'} [opts.trigger]
 * @param {boolean} [opts.dryRun] 브라우저 없이 계산만
 * @param {'auto'|'combined'|'recipes_only'|'regular_only'} [opts.mode] 담을 범위
 * @param {(msg:string)=>void} [opts.onProgress]
 * @param {object} [opts.logger]
 */
async function runCartForUser({ user, trigger = 'manual', dryRun = false, mode = 'auto', onProgress, logger = null }) {
  const log = logger || createLogger(`run:${user.nickname}`);
  const startedAt = Date.now();
  const mixed = recipes.mergeForRun(user, { mode });
  const planned = plannedItems(user, { mode });
  const summary = buildSummary({ user, trigger, dryRun, planned, mixed, startedAt });
  const automation = selectAutomationItems(planned);
  const progress = (msg) => {
    if (onProgress) onProgress(msg);
  };

  const finish = async () => {
    summary.durationMs = Date.now() - startedAt;
    finalizeStatus(summary);
    if (!dryRun) {
      // 요리를 담은 실행이면, 결과를 알리기 전에 이번 주 선택을 정리합니다.
      summary.recipesCleared = await resetRecipeSelection(user.userId, summary, log);
      const notification = { webhookUrl: '', webhookType: 'auto', ...(user.notification || {}) };
      try {
        summary.notification = await notify(summary, notification, log, { nickname: user.nickname });
      } catch (err) {
        log.warn(`알림 전송 실패: ${err.message}`);
      }
      // 웹훅과 별개로, 이 사용자의 아이폰 홈 화면 앱(PWA)으로도 푸시합니다.
      // 성공·부분·실패·세션 만료·담을 것 없음 — 어떤 결과든 반드시 시도합니다.
      try {
        summary.push = await push.notifyRun(summary, { userId: user.userId, nickname: user.nickname }, log);
      } catch (err) {
        summary.push = { sent: 0, failed: 0, pruned: 0, total: 0, skipped: false, error: err.message };
        log.warn(`푸시 알림 실패: ${err.message}`);
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
    summary.error =
      summary.mode === 'recipes_only'
        ? '이번 주 담기로 선택한 요리가 없습니다. 요리 탭에서 담을 요리를 골라 주세요.'
        : '계획에 담을 상품이 없습니다. 먼저 장바구니 계획에 상품을 추가해 주세요.';
    summary.errorCode = 'NO_ITEMS';
    log.warn(summary.error);
    return finish();
  }

  if (dryRun) {
    log.info(`[미리보기] ${planned.map((p) => `${p.name} ×${p.quantity}`).join(', ')}`);
    progress('계산 완료');
    return finish();
  }

  // 컬리 로그인이 없거나 '목록 알림만 받기' 모드면, 담는 대신 이번 주 장볼 목록을 준비합니다.
  if (shouldPrepareChecklist(user)) {
    const list = checklist.buildChecklist(user, { mode });
    summary.checklistMode = true;
    summary.error = null;
    summary.errorCode = null;
    summary.checklist = {
      count: list.count,
      checkedCount: list.checkedCount,
      estimatedTotal: list.estimatedTotal,
      mixLabel: list.mixLabel,
      reason: user.checklistOnly === true ? 'checklist_only' : 'no_session',
    };
    summary.items.forEach((item) => {
      item.status = 'planned';
      item.reason = null;
    });
    log.info(
      `장볼 목록 ${list.count}개를 준비했습니다 ` +
        `(${user.checklistOnly === true ? '목록 알림 모드' : '컬리 미연결 — 로그인 없이 목록으로 안내'})`
    );
    progress('장볼 목록 준비 완료');
    return finish();
  }

  // 담을 것이 오아시스 상품뿐이면 브라우저를 열지 않고 장볼 목록으로 준비합니다.
  if (!automation.length) {
    const list = checklist.buildChecklist(user, { mode });
    summary.checklistMode = true;
    summary.error = null;
    summary.errorCode = null;
    summary.checklist = {
      count: list.count,
      checkedCount: list.checkedCount,
      estimatedTotal: list.estimatedTotal,
      mixLabel: list.mixLabel,
      reason: 'no_kurly_items',
    };
    summary.items.forEach((item) => {
      item.status = 'planned';
      item.reason = normalizeMarket(item.market) === 'oasis' ? OASIS_MANUAL_REASON : null;
    });
    log.info(`컬리 상품이 없어 장볼 목록 ${list.count}개만 준비했습니다 (오아시스 상품은 직접 담기)`);
    progress('장볼 목록 준비 완료');
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

    // 로그인이 살아 있으면 컬리가 갱신한 쿠키를 바로 저장해 둡니다.
    summary.sessionRefreshed = await persistKurlySession(user.userId, page, log);

    // 오아시스 상품은 자동으로 담지 않습니다 — 장볼 목록에서 직접 담도록 표시만 남깁니다.
    summary.items.forEach((entry, index) => {
      if (normalizeMarket(planned[index]?.market) !== 'kurly') {
        entry.status = 'skipped';
        entry.reason = OASIS_MANUAL_REASON;
        summary.skipped += 1;
      }
    });

    for (let i = 0; i < summary.items.length; i += 1) {
      const entry = summary.items[i];
      if (normalizeMarket(planned[i]?.market) !== 'kurly') continue;
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
      // 마지막 페이지 방문 뒤 갱신된 쿠키까지 저장합니다.
      if (await persistKurlySession(user.userId, page, log)) summary.sessionRefreshed = true;
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
function previewPlan(user, { mode = 'auto' } = {}) {
  const mixed = recipes.mergeForRun(user, { mode });
  return {
    mode: mixed.mode,
    modeLabel: recipes.RUN_MODE_LABEL[mixed.mode] || mixed.mode,
    counts: mixed.counts,
    mixLabel: recipes.describeRunMix(mixed.counts),
    items: mixed.items.map((p) => ({
      market: normalizeMarket(p.market),
      name: p.name,
      quantity: p.quantity,
      price: p.price,
      lineTotal: (Number(p.price) || 0) * p.quantity,
      unitLabel: p.unitLabel,
      unitSize: p.unitSize,
      consumption: p.consumption,
      source: p.source,
      recipeNames: p.recipeNames || [],
    })),
    estimatedTotal: mixed.estimatedTotal,
    count: mixed.items.length,
  };
}

module.exports = {
  OASIS_MANUAL_REASON,
  selectAutomationItems,
  runCartForUser,
  previewPlan,
  plannedItems,
  persistKurlySession,
  resetRecipeSelection,
};
