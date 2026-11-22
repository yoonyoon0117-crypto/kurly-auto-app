'use strict';
/**
 * 정기 장바구니 — 화면 로직
 *  · 로그인/회원가입(초대 코드) → 계획 · 실행 · 설정 3개 탭
 *  · 계획은 "1주 소비량 → 담을 수량" 자동 계산, 저장 버튼으로 서버에 반영
 *  · 실행 화면은 지금 담기 / 미리보기 / 실행 기록, 진행 상황은 /api/status 폴링
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  user: null,
  plan: null,
  summary: null,
  runs: [],
  tab: 'plan',
  mode: 'login',
  dirty: false,
  saving: false,
  busy: false,
  status: null,
  wasActive: false,
  pollTimer: null,
  pollUntil: 0,
  search: { results: [], shown: 8, q: '', market: 'kurly' },
  editing: null,
  overrideOpen: new Set(),
  // 요리 탭 — 편집 중인 요리와 그 안의 재료 검색 결과
  editingRecipe: null,
  recipeSaving: false,
  recipeSearch: { results: [], q: '', market: 'kurly' },
  // 이번 주 장볼 목록 (컬리 로그인 없이)
  checklist: null,
  checklistSaving: false,
  // 장볼 목록에서 지금 보고 있는 마켓 (컬리 | 오아시스)
  checklistMarket: 'kurly',
  // 계획 탭에서 지금 보고 있는 마켓 (컬리 | 오아시스)
  planMarket: 'kurly',
  // 사용자가 계획 탭에서 마켓 pill 을 직접 눌렀는지 — 그 전에는 빈 마켓을 건너뜁니다.
  planMarketTouched: false,
};

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const MARKET_LABEL = { kurly: '컬리', oasis: '오아시스' };
const MARKET_SEARCH_PLACEHOLDER = {
  kurly: '컬리 상품 검색 (예: 유정란, 사과)',
  oasis: '오아시스 상품 검색 (예: 유정란, 사과)',
};
const BASE_FACTOR = { g: 1, kg: 1000, ml: 1, l: 1000 };
const STATUS_TEXT = { added: '담음', merged: '합산', planned: '예정', skipped: '건너뜀', failed: '실패' };
const STATUS_MARK = { added: '✅', merged: '➕', planned: '•', skipped: '⏭', failed: '❌', pending: '•' };

/* ─────────────── 작은 도우미 ─────────────── */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (v === null || v === undefined) return;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

const won = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;

/** 상품·재료·목록 항목의 마켓 (없으면 컬리 — 예전에 저장한 데이터 그대로) */
function marketOf(entity) {
  return entity?.market === 'oasis' ? 'oasis' : 'kurly';
}

/** 마켓별 상품 페이지 (예전 저장값에 url 이 없을 때) */
function productPageUrl(market, productNo) {
  const no = Number(productNo);
  return market === 'oasis'
    ? `https://m.oasis.co.kr/product/detail/${no}`
    : `https://www.kurly.com/goods/${no}`;
}

/** 휴대폰(아이폰·아이패드·안드로이드)에서 열었는지 — 앱 딥링크는 여기서만 씁니다 */
function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // 최신 아이패드는 사파리에서 데스크톱(Macintosh)으로 보이므로 터치 여부로 함께 판단합니다.
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

/** 아이폰·아이패드인지 — iOS 는 /appLink 화면을 거치지 않고 oasiskr:// 로 바로 보냅니다 */
function isIOSDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // 아이패드OS 는 사파리에서 Macintosh 로 보이므로 터치 여부로 함께 판단합니다.
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

/** 오아시스 상품 페이지 주소에서 '/product/detail/{번호}' 경로만 뽑습니다 */
function oasisDetailPath(webUrl, productNo) {
  try {
    const parsed = new URL(String(webUrl || ''), 'https://m.oasis.co.kr');
    if (/(^|\.)oasis\.co\.kr$/i.test(parsed.hostname) && /^\/product\/detail\/\d+/.test(parsed.pathname)) {
      return parsed.pathname;
    }
  } catch {
    /* 주소를 읽을 수 없으면 상품번호로 만듭니다 */
  }
  if (productNo === undefined || productNo === null || productNo === '') return '';
  return `/product/detail/${Number(productNo) || productNo}`;
}

/**
 * 오아시스 앱 딥링크의 v= 값 — 오아시스 /appLink 화면이 매번 새로 넣는 7자리 숫자입니다.
 * 앱이 이미 열려 있을 때 같은 주소를 다시 넘기면 앱이 지금 화면에 그대로 머무르므로,
 * 주소가 매번 달라지도록 이 값을 새로 만듭니다.
 */
function oasisDeeplinkVersion() {
  return Math.floor(1000000 + Math.random() * 9000000);
}

/**
 * 오아시스 앱 딥링크(oasiskr://) — m.oasis.co.kr/appLink 화면이 앱에 넘기는 주소 그대로입니다.
 *   oasiskr://deeplink?menu=page&nextUrl={경로를 두 번 인코딩}&loginyn=N&v={7자리}&data=
 */
function oasisIOSAppUrl(webUrl, productNo, version = oasisDeeplinkVersion()) {
  const path = oasisDetailPath(webUrl, productNo);
  if (!path) return null;
  return `oasiskr://deeplink?menu=page&nextUrl=${encodeURIComponent(encodeURIComponent(path))}&loginyn=N&v=${version}&data=`;
}

/**
 * oasiskr:// 링크의 v= 를 누를 때마다 새로 만듭니다.
 * 목록을 다시 그리지 않고 같은 링크를 두 번 누르거나(또는 앞서 누른 상품이 앱에 열려 있는 채로
 * 다른 상품을 눌러도) 오아시스 앱이 예전 화면에 머무르지 않도록, 손가락이 닿는 순간 주소를 바꿔 둡니다.
 */
function attachFreshDeepLink(link, webUrl, productNo) {
  const refresh = () => {
    const fresh = oasisIOSAppUrl(webUrl, productNo);
    if (fresh && fresh !== link.getAttribute('href')) link.setAttribute('href', fresh);
  };
  ['pointerdown', 'touchstart', 'mousedown', 'click'].forEach((type) =>
    link.addEventListener(type, refresh, { passive: true })
  );
}

/**
 * 오아시스 앱 링크(/appLink) — 앱이 없는 안드로이드에서 안내 화면을 거쳐 intent:// 로 넘어갑니다.
 */
function oasisAppLinkUrl(webUrl, productNo) {
  const path = oasisDetailPath(webUrl, productNo);
  return path ? `https://m.oasis.co.kr/appLink?r=${encodeURIComponent(path)}` : null;
}

/**
 * 오아시스 앱으로 열기 — 오아시스는 유니버설 링크(apple-app-site-association)가 없어
 * 상품 주소를 직접 열면 사파리에 머뭅니다.
 *  · 아이폰: /appLink 화면은 5초 뒤 무조건 App Store 로 넘어가 앱과 함께 App Store 가
 *    중복으로 열리므로, 그 화면이 앱에 넘기는 oasiskr:// 딥링크를 바로 씁니다.
 *  · 안드로이드: /appLink?r=... 를 거쳐 intent:// 로 앱을 엽니다.
 *  · PC: 앱 링크가 의미 없으므로 null (상품 웹 페이지 그대로).
 */
function oasisAppOpenUrl(webUrl, productNo) {
  if (isIOSDevice()) return oasisIOSAppUrl(webUrl, productNo);
  if (isMobileDevice()) return oasisAppLinkUrl(webUrl, productNo);
  return null;
}

/** oasiskr:// 같은 앱 전용 스킴인지 (새 탭을 열면 빈 탭만 남습니다) */
function isAppSchemeUrl(href) {
  return /^oasiskr:\/\//i.test(String(href || ''));
}

/** 컬리/오아시스 배지 — 목록·카드에서 어느 마켓 상품인지 바로 보이게 */
function marketBadge(market, extraClass = '') {
  const m = market === 'oasis' ? 'oasis' : 'kurly';
  return el('span', {
    class: `market-badge ${m}${extraClass ? ` ${extraClass}` : ''}`,
    text: MARKET_LABEL[m],
  });
}

/** 상품 이름에서 한 단위 크기를 추정합니다. (오아시스 상세에는 용량 항목이 없어 이름으로 추정) */
const UNIT_PATTERN = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|구|입|개|팩|봉|미|마리|장|병|캔|봉지|포)/i;
function guessUnit(...candidates) {
  for (const raw of candidates) {
    if (!raw) continue;
    const m = String(raw).match(UNIT_PATTERN);
    if (!m) continue;
    const size = Number(m[1]);
    if (!Number.isFinite(size) || size <= 0) continue;
    let label = m[2];
    const lower = label.toLowerCase();
    if (lower === 'l') label = 'L';
    else if (lower !== 'kg' && lower !== 'g' && lower !== 'ml') label = label === '봉지' ? '봉' : label === '포' ? '팩' : label;
    return { unitSize: size, unitLabel: label };
  }
  return { unitSize: 1, unitLabel: '개' };
}

function toBase(amount, label) {
  const f = BASE_FACTOR[String(label ?? '').toLowerCase()];
  return Number(amount) * (f ?? 1);
}

function computeQuantity(item) {
  const override = Number(item.quantityOverride);
  if (Number.isFinite(override) && override > 0) return Math.min(99, Math.max(1, Math.round(override)));
  const unit = Number(item.unitSize);
  const cons = Number(item.consumption);
  if (!(unit > 0) || !(cons > 0)) return 1;
  const ratio = toBase(cons, item.unitLabel) / toBase(unit, item.unitLabel);
  return Math.min(99, Math.max(1, Math.ceil(ratio - 1e-9)));
}

function unitText(size, label) {
  const n = Number(size);
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
  return `${s}${label}`;
}

function qtyLabel(item, qty) {
  const unit = String(item.unitLabel || '');
  const pack = unit === 'g' || unit === 'kg' ? '팩' : unit === 'ml' || unit === 'L' ? '병' : '개';
  return `${qty}${pack}`;
}

/** 지금 설정된 주기(주) — 소비량 라벨에 씁니다. 기본값은 1주 */
function intervalWeeksNow() {
  return Math.max(1, Math.round(Number(state.plan?.schedule?.intervalWeeks) || 1));
}

/** "1주 소비량" 처럼 주기를 붙인 문구 */
function weekText(suffix) {
  return `${intervalWeeksNow()}주 ${suffix}`;
}

/** 화면용 다음 실행 시각 (서버와 같은 규칙을 미리 계산해 즉시 보여줍니다) */
function nextRunLabelFor(schedule) {
  if (!schedule) return '—';
  const [h, m] = String(schedule.time || '21:00').split(':').map(Number);
  const anchor = Date.parse(
    `${schedule.anchorDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`
  );
  if (!Number.isFinite(anchor)) return '—';
  const interval = Math.max(1, Number(schedule.intervalWeeks) || 1) * 7 * 86400000;
  const now = Date.now();
  let at = anchor;
  if (now > anchor) at = anchor + Math.ceil((now - anchor) / interval) * interval;
  let guard = 0;
  while (at <= now && guard < 1000) {
    at += interval;
    guard += 1;
  }
  const d = new Date(at + 9 * 3600000);
  const week = ['일', '월', '화', '수', '목', '금', '토'][d.getUTCDay()];
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} (${week}) ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = isError ? 'toast error' : 'toast';
  node.hidden = false;
  clearTimeout(toast._t);
  // 실패 사유는 길어서(HTTP 상태·컬리 안내 문구) 짧게 지나가면 읽을 수 없습니다.
  const shownMs = isError && message.length > 120 ? 15000 : 3600;
  toast._t = setTimeout(() => {
    node.hidden = true;
  }, shownMs);
}

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  if (opts.body) opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 401) {
    showAuth();
    throw new Error(body?.error || '로그인이 필요합니다.');
  }
  if (!res.ok || body?.ok === false) {
    const err = new Error(body?.error || `요청에 실패했어요 (HTTP ${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* ─────────────── 화면 전환 ─────────────── */

function showAuth() {
  $('#boot').hidden = true;
  $('#appView').hidden = true;
  $('#authView').hidden = false;
  stopPolling();
}

function enterApp(user, plan) {
  state.user = user;
  $('#boot').hidden = true;
  $('#authView').hidden = true;
  $('#appView').hidden = false;
  $('#meNickname').textContent = user.nickname;
  const created = user.createdAt ? new Date(user.createdAt) : null;
  $('#meSince').textContent = created
    ? `가입 ${created.getFullYear()}.${String(created.getMonth() + 1).padStart(2, '0')}.${String(created.getDate()).padStart(2, '0')}`
    : '';
  if (plan) setPlan(plan);
  setTab(location.hash.replace('#', '') || 'plan', { push: false });
  registerServiceWorker();
  maybeShowInstallHint();
  refreshRuns();
  refreshChecklist();
  pollStatus().catch(() => {});
  // 설정 탭에 들어가기 전에도 푸시 상태를 미리 채워 둡니다(아이폰에서 '확인 중…' 으로 남지 않도록).
  refreshPushUI().catch(() => {});
}

function setTab(tab, { push = true } = {}) {
  const allowed = ['plan', 'recipes', 'run', 'settings'];
  const next = allowed.includes(tab) ? tab : 'plan';
  state.tab = next;
  $$('.screen').forEach((node) => {
    node.hidden = node.dataset.screen !== next;
  });
  $$('.tabbar button').forEach((btn) => {
    const active = btn.dataset.tab === next;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  if (push && location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
  if (next === 'plan') renderSummary();
  if (next === 'recipes') renderRecipes();
  if (next === 'run') {
    renderRun();
    refreshChecklist();
    pollStatus().catch(() => {});
  }
  if (next === 'settings') {
    renderKurlyCard();
    refreshPushUI();
    renderChecklistOnly();
  }
}

/* ─────────────── 계획 ─────────────── */

function activeItems() {
  return (state.plan?.items || []).filter((i) => i.active !== false);
}

function clientSummary() {
  const items = activeItems();
  return {
    activeCount: items.length,
    itemCount: state.plan?.items?.length || 0,
    estimatedTotal: items.reduce((sum, i) => sum + (Number(i.price) || 0) * computeQuantity(i), 0),
    nextRunLabel: state.summary?.nextRunLabel || '—',
    scheduleLabel: state.summary?.scheduleLabel || '',
  };
}

function setPlan(plan) {
  state.plan = plan;
  state.summary = plan.summary || state.summary;
  renderPlan();
  renderSettings();
  renderSummary();
  renderRecipes();
  renderRun();
  refreshChecklist();
  setDirty(false);
}

function renderSummary() {
  if (!state.plan) return;
  const client = clientSummary();
  $('#nextRunLabel').textContent = nextRunLabelFor(state.plan.schedule);
  $('#scheduleLabel').textContent = client.scheduleLabel || `${state.plan.schedule?.intervalWeeks || 1}주마다 ${WEEKDAY[state.plan.schedule?.weekday ?? 5]}요일 ${state.plan.schedule?.time || '21:00'} (KST)`;
  $('#statItems').textContent = `${client.activeCount}개`;
  $('#statTotal').textContent = won(client.estimatedTotal);
  $('#statEnabled').textContent = (state.plan.schedule?.enabled !== false) ? '켜짐' : '꺼짐';
  renderMixLines();
}

function renderPlan() {
  const list = $('#planList');
  list.textContent = '';
  const items = state.plan?.items || [];
  const counts = { kurly: 0, oasis: 0 };
  items.forEach((item) => {
    counts[marketOf(item)] += 1;
  });

  // 처음 불러왔을 때 고른 마켓이 비어 있고 다른 마켓에 상품이 있으면 그쪽을 보여 줍니다.
  // (pill 을 직접 누른 뒤에는 고른 마켓을 그대로 두고 안내 문구를 보여 줍니다.)
  if (!state.planMarketTouched && counts[state.planMarket] === 0) {
    const other = state.planMarket === 'oasis' ? 'kurly' : 'oasis';
    if (counts[other] > 0) state.planMarket = other;
  }
  const market = state.planMarket === 'oasis' ? 'oasis' : 'kurly';

  const filterCard = $('#planFilterCard');
  if (filterCard) filterCard.hidden = items.length === 0;
  $('#planEmpty').hidden = items.length > 0;

  const kCount = $('#planKurlyCount');
  const oCount = $('#planOasisCount');
  if (kCount) kCount.textContent = String(counts.kurly);
  if (oCount) oCount.textContent = String(counts.oasis);
  $$('#planMarketPills .market-pill').forEach((btn) => {
    const active = btn.dataset.market === market;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  // 고른 마켓의 품목만 보여 줍니다. (요약 카드의 합계는 두 마켓 전체)
  const visible = items.filter((item) => marketOf(item) === market);
  const subtotal = visible
    .filter((item) => item.active !== false)
    .reduce((sum, item) => sum + (Number(item.price) || 0) * computeQuantity(item), 0);
  const meta = $('#planMarketMeta');
  if (meta) {
    meta.textContent = visible.length
      ? `${MARKET_LABEL[market]} ${visible.length}개 · ${won(subtotal)}`
      : `${MARKET_LABEL[market]} 0개`;
  }

  const marketEmpty = $('#planMarketEmpty');
  if (marketEmpty) {
    marketEmpty.hidden = items.length === 0 || visible.length > 0;
    if (!marketEmpty.hidden) {
      $('#planMarketEmptyText').textContent = `${MARKET_LABEL[market]} 정기 품목이 아직 없어요.`;
    }
  }

  visible.forEach((item) => {
    const qty = computeQuantity(item);
    const price = (Number(item.price) || 0) * qty;
    const thumb = item.imageUrl
      ? el('img', {
          class: 'plan-thumb',
          src: item.imageUrl,
          alt: '',
          decoding: 'async',
          onerror: (e) => {
            // 이미지 CDN 이 막혔을 때는 회색 자리로 대체합니다.
            const img = e.target;
            const box = document.createElement('div');
            box.className = 'plan-thumb';
            box.textContent = '🧺';
            img.replaceWith(box);
          },
        })
      : el('div', { class: 'plan-thumb', text: '🧺' });

    const consumptionInput = el('input', {
      type: 'number',
      min: '0',
      step: 'any',
      inputmode: 'decimal',
      value: item.consumption,
      class: 'plan-consumption-input',
      'data-name': item.name,
      'aria-label': `${item.name} ${weekText('소비량')}`,
      onchange: (e) => {
        const v = Number(e.target.value);
        item.consumption = Number.isFinite(v) && v >= 0 ? v : 0;
        item.quantityOverride = null;
        markDirty();
      },
    });

    const controls = el('div', { class: 'plan-controls' }, [
      el('label', { class: 'plan-consumption-label', text: weekText('소비량') }),
      consumptionInput,
      el('span', { text: item.unitLabel }),
      el('span', { class: 'plan-qty', text: qtyLabel(item, qty) }),
    ]);

    if (state.overrideOpen.has(item.id) || item.quantityOverride) {
      controls.appendChild(
        el('input', {
          type: 'number',
          min: '1',
          max: '99',
          inputmode: 'numeric',
          class: 'override-input',
          value: item.quantityOverride ?? '',
          placeholder: '직접',
          'aria-label': '수동 수량',
          onchange: (e) => {
            const v = Number(e.target.value);
            item.quantityOverride = e.target.value === '' || !Number.isFinite(v) || v <= 0 ? null : Math.round(v);
            markDirty();
          },
        })
      );
    } else {
      controls.appendChild(
        el('button', {
          type: 'button',
          class: 'link-btn',
          text: '수량 직접',
          onclick: () => {
            state.overrideOpen.add(item.id);
            renderPlan();
          },
        })
      );
    }

    const toggle = el('input', {
      type: 'checkbox',
      'aria-label': `${item.name} 포함`,
      onchange: (e) => {
        item.active = e.target.checked;
        markDirty();
      },
    });
    toggle.checked = item.active !== false;

    const meta = `한 단위 ${unitText(item.unitSize, item.unitLabel)} · ${won(item.price)}${item.unitPriceText ? ` · ${item.unitPriceText}` : ''}`;

    list.appendChild(
      el('article', { class: `plan-item${item.active === false ? ' inactive' : ''}` }, [
        thumb,
        el('div', { class: 'plan-main' }, [
          el('p', { class: 'plan-name' }, [
            marketBadge(marketOf(item), 'sm'),
            document.createTextNode(' '),
            el('a', {
              href: item.url || productPageUrl(marketOf(item), item.productNo),
              target: '_blank',
              rel: 'noopener noreferrer',
              text: item.name,
            }),
          ]),
          el('p', { class: 'plan-meta', text: meta }),
          controls,
        ]),
        el('div', { class: 'plan-side' }, [
          el('span', { class: 'plan-price', text: won(price) }),
          el('div', { class: 'plan-actions' }, [
            el('label', { class: 'switch', title: '포함' }, [toggle, el('i')]),
            el('button', {
              type: 'button',
              class: 'btn btn-danger-ghost',
              text: '삭제',
              onclick: () => {
                state.plan.items = state.plan.items.filter((i) => i.id !== item.id);
                markDirty();
              },
            }),
          ]),
        ]),
      ])
    );
  });
}

function setDirty(value) {
  state.dirty = Boolean(value);
  updateSaveBar();
}

function markDirty() {
  state.dirty = true;
  renderPlan();
  renderSummary();
  renderRun();
  updateSaveBar();
}

function updateSaveBar() {
  const bar = $('#saveBar');
  bar.hidden = !state.dirty;
  $('#saveHint').textContent = state.saving ? '저장 중…' : '저장하지 않은 변경이 있어요';
  $('#saveBtn').disabled = state.saving;
}

async function savePlan() {
  if (state.saving || !state.plan) return;
  state.saving = true;
  updateSaveBar();
  try {
    const data = await api('/api/plan', {
      method: 'POST',
      body: {
        items: state.plan.items,
        schedule: state.plan.schedule,
        notification: state.plan.notification,
      },
    });
    state.saving = false;
    setPlan(data.plan);
    toast('저장했어요. 이 계획대로 담아드릴게요.');
  } catch (err) {
    state.saving = false;
    updateSaveBar();
    toast(err.message, true);
  }
}

/* ─────────────── 요리 (좋아하는 메뉴 · 필수재료) ─────────────── */

function recipeList() {
  return Array.isArray(state.plan?.recipes) ? state.plan.recipes : [];
}

function recipeSettingsClient() {
  return { mergeWithRegularPlan: true, clearSelectedAfterRun: true, ...(state.plan?.recipeSettings || {}) };
}

function selectedRecipesClient() {
  return recipeList().filter((r) => r.selectedForNextRun === true);
}

const ingQty = (ingredient) => Math.min(99, Math.max(1, Math.round(Number(ingredient?.quantity) || 1)));

/** 화면에서 미리 계산하는 요리 요약 (서버의 summarizeRecipes 와 같은 규칙) */
function clientRecipeSummary() {
  const all = recipeList();
  const selected = selectedRecipesClient();
  let includedIngredientCount = 0;
  let skippedCount = 0;
  let recipeEstimatedTotal = 0;
  selected.forEach((recipe) => {
    (recipe.ingredients || []).forEach((ingredient) => {
      if (ingredient.skippedThisWeek) {
        skippedCount += 1;
        return;
      }
      includedIngredientCount += 1;
      recipeEstimatedTotal += (Number(ingredient.price) || 0) * ingQty(ingredient);
    });
  });
  return {
    recipeCount: all.length,
    selectedCount: selected.length,
    selectedNames: selected.map((r) => r.name),
    includedIngredientCount,
    skippedCount,
    recipeEstimatedTotal,
  };
}

/** 이번 실행에 실제로 담기는 상품 종류 수 — 같은 상품은 한 번만 셉니다. */
function mergedPlannedCount({ includeRecipes = null } = {}) {
  const withRecipes =
    includeRecipes === null ? recipeSettingsClient().mergeWithRegularPlan !== false : includeRecipes;
  const keys = new Set();
  activeItems().forEach((item) => keys.add(`${marketOf(item)}:${item.productNo}`));
  if (withRecipes) {
    selectedRecipesClient().forEach((recipe) => {
      (recipe.ingredients || []).forEach((ingredient) => {
        if (!ingredient.skippedThisWeek) keys.add(`${marketOf(ingredient)}:${ingredient.productNo}`);
      });
    });
  }
  return keys.size;
}

/** 계획·실행 화면의 "정기 4개 + 이번 주 요리 2개(재료 5개)" 줄 */
function renderMixLines() {
  const recipe = clientRecipeSummary();
  const settings = recipeSettingsClient();
  const regular = activeItems().length;
  const merged = settings.mergeWithRegularPlan !== false;

  const planLine = $('#planRecipeLine');
  if (planLine) {
    if (!recipe.selectedCount) {
      planLine.hidden = true;
      planLine.textContent = '';
    } else {
      const parts = [];
      if (regular && merged) parts.push(`정기 품목 ${regular}개`);
      parts.push(`이번 주 요리 ${recipe.selectedCount}개(재료 ${recipe.includedIngredientCount}개)`);
      planLine.hidden = false;
      planLine.textContent = merged
        ? `${parts.join(' + ')} · 겹치는 상품은 한 번만 담아요`
        : `이번 주 요리 ${recipe.selectedCount}개(재료 ${recipe.includedIngredientCount}개)는 요리 탭에서 따로 담아요`;
    }
  }

  const runLine = $('#runRecipeLine');
  if (runLine) {
    if (!recipe.selectedCount) {
      runLine.hidden = true;
      runLine.textContent = '';
    } else {
      const parts = [];
      if (regular && merged) parts.push(`정기 ${regular}개`);
      parts.push(`이번 주 요리 ${recipe.selectedCount}개(재료 ${recipe.includedIngredientCount}개)`);
      runLine.hidden = false;
      runLine.textContent = merged
        ? `이번 실행: ${parts.join(' + ')} → ${mergedPlannedCount()}개 상품`
        : `지금 담기에 요리는 포함되지 않아요 · 요리 탭에서 따로 담기`;
    }
  }
}

function renderRecipes() {
  const listNode = $('#recipeList');
  if (!listNode) return;
  const recipes = recipeList();
  const selected = selectedRecipesClient();
  const summary = clientRecipeSummary();
  const settings = recipeSettingsClient();

  $('#mergeWithPlanToggle').checked = settings.mergeWithRegularPlan !== false;
  $('#clearAfterRunToggle').checked = settings.clearSelectedAfterRun !== false;

  $('#recipeSelectedLabel').textContent = selected.length ? selected.map((r) => r.name).join(' · ') : '선택한 요리 없음';
  $('#recipeTotalLabel').textContent = selected.length
    ? `담을 재료 ${summary.includedIngredientCount}개 · 예상 ${won(summary.recipeEstimatedTotal)}${summary.skippedCount ? ` · 이번 주 제외 ${summary.skippedCount}개` : ''}`
    : '요리를 고르면 재료를 한 번에 담아드려요.';
  $('#recipeStatSelected').textContent = `${selected.length}개`;
  $('#recipeStatIngredients').textContent = `${summary.includedIngredientCount}개`;
  $('#recipeStatTotal').textContent = won(summary.recipeEstimatedTotal);
  $('#recipeRunBtn').disabled = !selected.length || summary.includedIngredientCount === 0 || state.busy;

  listNode.textContent = '';
  $('#recipeEmpty').hidden = recipes.length > 0;
  recipes.forEach((recipe) => listNode.appendChild(recipeCard(recipe)));

  renderMixLines();
}

function recipeCard(recipe) {
  const selected = recipe.selectedForNextRun === true;
  const ingredients = recipe.ingredients || [];
  const included = ingredients.filter((i) => !i.skippedThisWeek);
  const skippedCount = ingredients.length - included.length;
  const total = included.reduce((sum, i) => sum + (Number(i.price) || 0) * ingQty(i), 0);

  const toggle = el('input', {
    type: 'checkbox',
    'aria-label': `${recipe.name} 이번 주 담기`,
    onchange: async (event) => {
      const checked = event.target.checked;
      recipe.selectedForNextRun = checked;
      renderRecipes();
      await saveRecipes();
      toast(
        checked
          ? `${recipe.name} 재료를 이번 주에 함께 담을게요.`
          : `${recipe.name}을(를) 이번 주 담기에서 뺐어요.`
      );
    },
  });
  toggle.checked = selected;

  const ingList = el('ul', { class: 'recipe-ing-chips' });
  if (!ingredients.length) {
    ingList.appendChild(el('li', { class: 'recipe-ing muted', text: '재료를 아직 넣지 않았어요. [수정]에서 추가해 주세요.' }));
  }
  ingredients.forEach((ingredient) => {
    const skipped = ingredient.skippedThisWeek === true;
    const children = [
      marketBadge(marketOf(ingredient), 'sm'),
      el('span', { class: 'name', text: ingredient.name }),
      el('span', { class: 'qty', text: `×${ingQty(ingredient)}` }),
      el('span', { class: 'price', text: won((Number(ingredient.price) || 0) * ingQty(ingredient)) }),
    ];
    if (selected) {
      children.push(
        el('button', {
          type: 'button',
          class: `skip-btn${skipped ? ' on' : ''}`,
          text: skipped ? '제외됨' : '집에 있음',
          'aria-pressed': skipped ? 'true' : 'false',
          onclick: async () => {
            ingredient.skippedThisWeek = !skipped;
            renderRecipes();
            await saveRecipes();
          },
        })
      );
    }
    ingList.appendChild(el('li', { class: `recipe-ing${skipped ? ' skipped' : ''}` }, children));
  });

  return el('article', { class: `recipe-card${selected ? ' selected' : ''}` }, [
    el('div', { class: 'recipe-head' }, [
      el('div', { class: 'recipe-title-box' }, [
        el('p', { class: 'recipe-name', text: recipe.name }),
        recipe.note ? el('p', { class: 'recipe-note', text: recipe.note }) : null,
      ]),
      el('label', { class: 'switch', title: '이번 주 담기' }, [toggle, el('i')]),
    ]),
    el('p', { class: 'recipe-meta' }, [
      el('b', { text: selected ? '이번 주 담기' : '이번 주 쉼' }),
      document.createTextNode(
        ` · 재료 ${ingredients.length}개${skippedCount ? `(${skippedCount}개 제외)` : ''} · ${won(total)}`
      ),
    ]),
    ingList,
    el('div', { class: 'recipe-actions' }, [
      el('button', { type: 'button', class: 'btn btn-ghost', text: '수정', onclick: () => openRecipeEditor(recipe) }),
      el('button', {
        type: 'button',
        class: 'btn btn-danger-ghost',
        text: '삭제',
        onclick: async () => {
          if (!confirm(`'${recipe.name}' 요리를 삭제할까요?`)) return;
          state.plan.recipes = recipeList().filter((r) => r.id !== recipe.id);
          renderRecipes();
          renderSummary();
          renderRun();
          await saveRecipes();
          toast(`${recipe.name}을(를) 삭제했어요.`);
        },
      }),
    ]),
  ]);
}

/** 요리 목록·설정을 서버에 저장합니다. (토글도 바로 저장) */
async function saveRecipes({ toastMessage = null } = {}) {
  if (!state.plan) return null;
  if (state.recipeSaving) return null;
  state.recipeSaving = true;
  try {
    const data = await api('/api/recipes', {
      method: 'PUT',
      body: { recipes: state.plan.recipes || [], recipeSettings: recipeSettingsClient() },
    });
    state.plan.recipes = data.recipes || [];
    state.plan.recipeSettings = data.recipeSettings || state.plan.recipeSettings;
    if (data.plan) {
      state.plan.items = data.plan.items;
      state.plan.summary = data.plan.summary;
      state.plan.recipeSummary = data.plan.recipeSummary;
      state.summary = data.plan.summary;
    }
    renderPlan();
    renderSummary();
    renderRecipes();
    renderRun();
    refreshChecklist();
    if (toastMessage) toast(toastMessage);
    return data;
  } catch (err) {
    toast(err.message, true);
    return null;
  } finally {
    state.recipeSaving = false;
  }
}

/* ── 요리 편집 시트 ── */

function openRecipeEditor(recipe = null) {
  state.editingRecipe = recipe
    ? JSON.parse(JSON.stringify(recipe))
    : { id: null, name: '', note: '', selectedForNextRun: true, ingredients: [] };
  state.recipeSearch = { results: [], q: '', market: state.recipeSearch?.market || 'kurly' };
  $('#recipeSheetTitle').textContent = recipe ? '요리 수정' : '새 요리';
  $('#recipeName').value = state.editingRecipe.name || '';
  $('#recipeNote').value = state.editingRecipe.note || '';
  $('#recipeSearchInput').value = '';
  $('#recipeSearchStatus').hidden = true;
  $('#recipeSearchResults').textContent = '';
  applyMarketUI();
  renderRecipeEdit();
  $('#recipeSheet').hidden = false;
  setTimeout(() => $('#recipeName').focus(), 150);
}

function closeRecipeEditor() {
  $('#recipeSheet').hidden = true;
  state.editingRecipe = null;
  state.recipeSearch = { results: [], q: '', market: state.recipeSearch?.market || 'kurly' };
}

function renderRecipeEdit() {
  const draft = state.editingRecipe;
  const listNode = $('#recipeIngEdit');
  if (!draft || !listNode) return;
  const ingredients = draft.ingredients || [];
  listNode.textContent = '';
  $('#recipeIngEmpty').hidden = ingredients.length > 0;
  $('#recipeIngCount').textContent = `${ingredients.length}개`;

  ingredients.forEach((ingredient) => {
    const thumb = ingredient.imageUrl
      ? el('img', { src: ingredient.imageUrl, alt: '', loading: 'lazy' })
      : el('div', { class: 'thumb' });
    const minus = el('button', {
      type: 'button',
      'aria-label': `${ingredient.name} 수량 줄이기`,
      text: '−',
      onclick: () => {
        const next = ingQty(ingredient) - 1;
        if (next < 1) return;
        ingredient.quantity = next;
        renderRecipeEdit();
      },
    });
    const plus = el('button', {
      type: 'button',
      'aria-label': `${ingredient.name} 수량 늘리기`,
      text: '+',
      onclick: () => {
        ingredient.quantity = Math.min(99, ingQty(ingredient) + 1);
        renderRecipeEdit();
      },
    });
    listNode.appendChild(
      el('li', { class: 'recipe-ing-row' }, [
        thumb,
        el('div', { class: 'info' }, [
          el('p', { class: 'nm' }, [marketBadge(marketOf(ingredient), 'sm'), document.createTextNode(ingredient.name)]),
          el('p', { class: 'pr', text: `${won(ingredient.price)} · ${ingredient.volume || `${MARKET_LABEL[marketOf(ingredient)]} 상품`}` }),
          el('div', { class: 'qty-stepper' }, [minus, el('span', { text: String(ingQty(ingredient)) }), plus]),
        ]),
        el('button', {
          type: 'button',
          class: 'rm',
          text: '빼기',
          'aria-label': `${ingredient.name} 빼기`,
          onclick: () => {
            draft.ingredients = (draft.ingredients || []).filter((i) => i.id !== ingredient.id);
            renderRecipeEdit();
            renderRecipeResults();
          },
        }),
      ])
    );
  });
}

function recipeHasProduct(market, productNo) {
  return (state.editingRecipe?.ingredients || []).some(
    (i) => marketOf(i) === market && Number(i.productNo) === Number(productNo)
  );
}

function addIngredientFromProduct(product) {
  const draft = state.editingRecipe;
  if (!draft) return;
  const market = marketOf(product);
  const existing = (draft.ingredients || []).find(
    (i) => marketOf(i) === market && Number(i.productNo) === Number(product.no)
  );
  if (existing) {
    existing.quantity = Math.min(99, ingQty(existing) + 1);
    renderRecipeEdit();
    renderRecipeResults();
    toast(`${product.name} 수량을 늘렸어요.`);
    return;
  }
  draft.ingredients = [
    ...(draft.ingredients || []),
    {
      id: `ing-${market}-${product.no}-${Date.now().toString(36)}`,
      market,
      productNo: product.no,
      dealProductNo: null,
      name: product.name,
      price: Number(product.price) || 0,
      imageUrl: product.imageUrl || null,
      url: product.url || productPageUrl(market, product.no),
      volume: product.shortDescription || null,
      quantity: 1,
      skippedThisWeek: false,
    },
  ];
  renderRecipeEdit();
  renderRecipeResults();
  toast(`${product.name} 재료로 추가했어요.`);
}

function renderRecipeResults() {
  const box = $('#recipeSearchResults');
  if (!box) return;
  box.textContent = '';
  const results = (state.recipeSearch.results || []).slice(0, 8);
  results.forEach((product) => {
    const market = marketOf(product);
    const added = recipeHasProduct(market, product.no);
    const thumb = product.imageUrl
      ? el('img', { class: 'product-thumb', src: product.imageUrl, alt: '', loading: 'lazy' })
      : el('div', { class: 'product-thumb' });
    const addBtn = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: product.soldOut ? '품절' : added ? '추가됨 (+)' : '+ 재료로 추가',
      onclick: () => addIngredientFromProduct(product),
    });
    addBtn.disabled = Boolean(product.soldOut);
    box.appendChild(
      el('article', { class: 'product-card compact' }, [
        thumb,
        el('div', { class: 'product-body' }, [
          el('p', { class: 'product-name' }, [marketBadge(market, 'sm'), document.createTextNode(product.name)]),
          product.shortDescription ? el('p', { class: 'product-desc', text: product.shortDescription }) : null,
          el('p', { class: 'product-price', text: won(product.price) }),
          addBtn,
        ]),
      ])
    );
  });
}

async function doRecipeSearch(keyword) {
  const q = String(keyword ?? '').trim();
  if (!q) return;
  const market = state.recipeSearch.market;
  state.recipeSearch.q = q;
  const status = $('#recipeSearchStatus');
  status.hidden = false;
  status.className = 'search-status';
  status.textContent = `${MARKET_LABEL[market]}에서 재료를 찾는 중…`;
  $('#recipeSearchBtn').disabled = true;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&market=${market}`);
    if (state.recipeSearch.market !== market || state.recipeSearch.q !== q) return;
    state.recipeSearch.results = data.products || [];
    renderRecipeResults();
    status.textContent = state.recipeSearch.results.length
      ? `${MARKET_LABEL[market]} ‘${q}’ 검색 결과 ${state.recipeSearch.results.length}개`
      : `${MARKET_LABEL[market]} ‘${q}’ 검색 결과가 없어요. 다른 재료명이나 다른 마켓으로 찾아보세요.`;
  } catch (err) {
    state.recipeSearch.results = [];
    renderRecipeResults();
    status.className = 'search-status error';
    status.textContent = err.message;
  } finally {
    $('#recipeSearchBtn').disabled = false;
  }
}

async function saveRecipeEditor() {
  const draft = state.editingRecipe;
  if (!draft) return;
  const name = $('#recipeName').value.trim();
  if (!name) {
    toast('요리 이름을 입력해 주세요.', true);
    $('#recipeName').focus();
    return;
  }
  if (!(draft.ingredients || []).length) {
    toast('필수재료를 하나 이상 추가해 주세요.', true);
    return;
  }
  const now = Date.now();
  const recipe = {
    ...draft,
    name,
    note: $('#recipeNote').value.trim(),
    ingredients: draft.ingredients,
    updatedAt: now,
  };
  const existingIndex = recipeList().findIndex((r) => r.id === recipe.id);
  if (!recipe.id) {
    recipe.id = `recipe-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    recipe.createdAt = now;
  }
  const next = recipeList().slice();
  if (existingIndex >= 0) next[existingIndex] = recipe;
  else next.push(recipe);
  state.plan.recipes = next;
  closeRecipeEditor();
  renderRecipes();
  renderSummary();
  renderRun();
  const saved = await saveRecipes();
  if (saved) toast(existingIndex >= 0 ? `${name}을(를) 수정했어요.` : `${name}을(를) 추가했어요.`);
}

/** 선택한 요리 재료만 지금 담기 */
async function runRecipesOnly() {
  if (state.busy) return;
  const summary = clientRecipeSummary();
  if (!summary.selectedCount) {
    toast('먼저 이번 주에 담을 요리를 선택해 주세요.', true);
    return;
  }
  if (!summary.includedIngredientCount) {
    toast('담을 재료가 없어요. [집에 있음]으로 뺀 재료를 확인해 주세요.', true);
    return;
  }
  const kurly = state.status?.kurly || { status: 'disconnected' };
  if (kurly.status !== 'connected' || state.plan?.checklistOnly === true) {
    toast('아래 장볼 목록의 [컬리에서 열기]·[오아시스에서 열기]로 하나씩 담아 주세요.');
    const card = $('#checklistCard');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    refreshChecklist();
    return;
  }
  setRunBusy(true, '요리 재료를 담을 준비 중…');
  try {
    await api('/api/run', { method: 'POST', body: { mode: 'recipes_only' } });
    ensurePolling(true);
    toast('선택한 요리 재료를 담기 시작했어요. 끝나면 알려드릴게요.');
    pollStatus().catch(() => {});
  } catch (err) {
    setRunBusy(false);
    if (err.status === 409) {
      ensurePolling(true);
      pollStatus().catch(() => {});
      return;
    }
    toast(err.message, true);
  }
}

/* ─────────────── 이번 주 장볼 목록 (컬리 로그인 없이) ─────────────── */

function renderChecklist() {
  const list = state.checklist;
  const box = $('#checklistList');
  if (!box) return;

  const market = state.checklistMarket === 'oasis' ? 'oasis' : 'kurly';
  const items = list?.items || [];
  const counts = list?.marketCounts || {
    kurly: items.filter((i) => marketOf(i) === 'kurly').length,
    oasis: items.filter((i) => marketOf(i) === 'oasis').length,
  };
  // 마켓 pill 에 개수를 함께 보여 줍니다 (컬리 2 · 오아시스 2)
  const kCount = $('#checklistKurlyCount');
  const oCount = $('#checklistOasisCount');
  if (kCount) kCount.textContent = String(counts.kurly || 0);
  if (oCount) oCount.textContent = String(counts.oasis || 0);
  $$('#checklistMarketPills .market-pill').forEach((btn) => {
    const active = btn.dataset.market === market;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  if (!list) {
    $('#checklistMeta').textContent = '';
    return;
  }

  const meta = [`${list.count}개`];
  if (list.estimatedTotal) meta.push(`예상 ${won(list.estimatedTotal)}`);
  if (list.checkedCount) meta.push(`담음 ${list.checkedCount}`);
  $('#checklistMeta').textContent = meta.join(' · ');

  const only = state.plan?.checklistOnly === true;
  $('#checklistHint').textContent = only
    ? '목록 알림 모드예요. 정기 실행일에는 목록만 알려드려요. 다 담은 뒤 [이번 주 장보기 완료]를 누르면 체크와 이번 주 요리 선택이 함께 정리돼요.'
    : '컬리 로그인 없이도 장볼 수 있어요. [컬리에서 열기]·[오아시스에서 열기]로 상품을 열고, 담은 것은 체크해 두세요. 다 담으면 [이번 주 장보기 완료].';

  // 고른 마켓의 상품만 보여 줍니다.
  const visible = items.filter((item) => marketOf(item) === market);

  box.textContent = '';
  $('#checklistEmpty').hidden = visible.length > 0;
  $('#checklistEmpty').textContent =
    market === 'oasis'
      ? '오아시스 상품이 아직 없어요. 상품 검색에서 마켓을 [오아시스]로 바꿔 담아 보세요.'
      : '컬리 상품이 아직 없어요. 계획에 상품을 담거나 요리를 선택해 주세요.';

  visible.forEach((item) => {
    const itemMarket = marketOf(item);
    const isOasis = itemMarket === 'oasis';
    const checkbox = el('input', {
      type: 'checkbox',
      'aria-label': `${item.name} 담음`,
      onchange: (event) => toggleChecklistItem(item.productNo, event.target.checked, itemMarket),
    });
    checkbox.checked = item.checked === true;

    const nameLine = el('p', { class: 'check-name' }, [
      item.source === 'recipe' ? document.createTextNode('🍳 ') : null,
      item.source === 'both' ? document.createTextNode('🍳🧺 ') : null,
      document.createTextNode(item.name),
      el('span', { class: 'check-qty', text: `×${item.quantity}` }),
    ]);
    const subBits = [];
    if (item.lineTotal) subBits.push(won(item.lineTotal));
    if (item.recipeNames?.length) subBits.push(item.recipeNames.join(', '));
    if (item.volume) subBits.push(item.volume);

    const openHref =
      (isOasis ? oasisAppOpenUrl(item.url, item.productNo) : null) ||
      item.url ||
      productPageUrl(itemMarket, item.productNo);
    const appScheme = isOasis && isAppSchemeUrl(openHref);

    // 오아시스는 휴대폰에서만 앱으로 보냅니다 (PC 에서는 상품 페이지 그대로).
    // 아이폰 oasiskr:// 링크에는 target 을 붙이지 않습니다 — 빈 탭이 함께 열립니다.
    const openLink = el('a', {
      class: `check-open${isOasis ? ' oasis' : ''}`,
      href: openHref,
      target: appScheme ? null : '_blank',
      rel: appScheme ? null : 'noopener noreferrer',
      text: isOasis ? '오아시스에서 열기 ↗' : '컬리에서 열기 ↗',
    });
    // 앱이 이미 열려 있어도 누를 때마다 새 상품으로 이동하도록 v= 를 갱신합니다.
    if (appScheme) attachFreshDeepLink(openLink, item.url, item.productNo);

    box.appendChild(
      el('li', { class: `check-item${item.checked ? ' checked' : ''}${isOasis ? ' oasis' : ''}` }, [
        el('label', { class: 'check-box', title: '담음' }, [checkbox, el('i')]),
        el('div', { class: 'check-main' }, [
          nameLine,
          subBits.length ? el('p', { class: 'check-sub', text: subBits.join(' · ') }) : null,
          openLink,
        ]),
      ])
    );
  });

  const hasItems = list.count > 0;
  $('#checklistResetBtn').disabled = !hasItems || state.checklistSaving;
  $('#checklistDoneBtn').disabled = !hasItems || state.checklistSaving;
  $('#checklistDoneBtn').textContent = list.allChecked
    ? '이번 주 장보기 완료 ✓'
    : '이번 주 장보기 완료';
}

async function refreshChecklist() {
  if (!state.user) return;
  try {
    const data = await api('/api/checklist');
    state.checklist = data.checklist;
    if (state.plan) state.plan.checklistOnly = data.checklistOnly === true;
    // 지금 보고 있는 마켓이 비었는데 다른 마켓에 상품이 있으면, 빈 화면 대신 그쪽을 보여 줍니다.
    // (마켓 pill 을 직접 누를 때는 고른 마켓 그대로 — 비어 있으면 안내 문구를 보여 줍니다.)
    const counts = data.checklist?.marketCounts || {};
    if ((counts[state.checklistMarket] || 0) === 0) {
      const other = state.checklistMarket === 'oasis' ? 'kurly' : 'oasis';
      if ((counts[other] || 0) > 0) state.checklistMarket = other;
    }
    renderChecklist();
  } catch {
    /* 표시용이라 실패는 무시 */
  }
}

async function toggleChecklistItem(productNo, checked, market = 'kurly') {
  if (state.checklistSaving) return;
  state.checklistSaving = true;
  renderChecklist();
  try {
    const data = await api('/api/checklist/check', { method: 'POST', body: { market, productNo, checked } });
    state.checklist = data.checklist;
    if (data.plan && state.plan) state.plan.checklistSummary = data.plan.checklistSummary;
    renderChecklist();
  } catch (err) {
    toast(err.message, true);
    refreshChecklist();
  } finally {
    state.checklistSaving = false;
    renderChecklist();
  }
}

async function resetChecklist() {
  if (state.checklistSaving) return;
  state.checklistSaving = true;
  try {
    const data = await api('/api/checklist/reset', { method: 'POST', body: {} });
    state.checklist = data.checklist;
    renderChecklist();
    toast('담음 체크를 초기화했어요.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.checklistSaving = false;
    renderChecklist();
  }
}

/** 이번 주 장보기 완료 — 담음 체크를 비우고, 이번 주 요리 선택도 정리합니다. */
async function completeShopping() {
  if (state.checklistSaving) return;
  const list = state.checklist;
  const recipeCount = selectedRecipesClient().length;
  const message = recipeCount
    ? `이번 주 장보기를 마칠까요?\n\n담음 체크를 비우고, 이번 주 요리 선택(${recipeCount}개)도 해제해요.`
    : '이번 주 장보기를 마칠까요?\n\n담음 체크를 모두 비워요.';
  if (!confirm(message)) return;
  state.checklistSaving = true;
  try {
    const data = await api('/api/checklist/complete', { method: 'POST', body: {} });
    state.checklist = data.checklist;
    if (data.plan) setPlan(data.plan);
    renderChecklist();
    renderRun();
    toast(
      data.clearedRecipes
        ? `장보기 완료! 다음 주를 위해 요리 ${data.clearedRecipes}개 선택을 풀었어요.`
        : '장보기 완료! 담음 체크를 비웠어요.'
    );
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.checklistSaving = false;
    renderChecklist();
  }
}

/* ── 설정: 목록 알림만 받기 ── */

function renderChecklistOnly() {
  const toggle = $('#checklistOnlyToggle');
  if (!toggle) return;
  const only = state.plan?.checklistOnly === true;
  toggle.checked = only;
  const stateText = $('#checklistOnlyState');
  if (stateText) {
    stateText.textContent = only
      ? '켜짐 — 정기 실행에 담는 대신 장볼 목록을 알려드려요'
      : '꺼짐 — 정기 실행에 장바구니로 담아요';
  }
}

async function saveChecklistOnly(next) {
  try {
    const data = await api('/api/settings', { method: 'PUT', body: { checklistOnly: next } });
    if (state.plan) state.plan.checklistOnly = data.checklistOnly === true;
    renderChecklistOnly();
    renderChecklist();
    renderRun();
    toast(
      next
        ? '이제 정기 실행은 장바구니 대신 [이번 주 장볼 목록] 알림을 보내드려요.'
        : '이제 정기 실행에 장바구니로 담아드려요.'
    );
  } catch (err) {
    toast(err.message, true);
    renderChecklistOnly();
  }
}

/* ─────────────── 설정 ─────────────── */

function renderSettings() {
  const s = state.plan?.schedule || {};
  const n = state.plan?.notification || {};
  $('#scheduleEnabled').checked = s.enabled !== false;
  $('#scheduleWeekday').value = String(s.weekday ?? 5);
  $('#scheduleTime').value = s.time ?? '21:00';
  $('#scheduleInterval').value = String(s.intervalWeeks ?? 1);
  $('#scheduleAnchor').value = s.anchorDate ?? '';
  $('#notifyWebhook').value = n.webhookUrl ?? '';
  $('#notifyWebhookType').value = n.webhookType ?? 'auto';
  renderChecklistOnly();
  renderKurlyCard();
}

function readScheduleInputs() {
  if (!state.plan) return;
  state.plan.schedule = {
    ...(state.plan.schedule || {}),
    enabled: $('#scheduleEnabled').checked,
    weekday: Number($('#scheduleWeekday').value),
    time: $('#scheduleTime').value || '21:00',
    intervalWeeks: Number($('#scheduleInterval').value) || 1,
    anchorDate: $('#scheduleAnchor').value || state.plan.schedule?.anchorDate,
  };
  state.plan.notification = {
    ...(state.plan.notification || {}),
    webhookUrl: $('#notifyWebhook').value.trim(),
    webhookType: $('#notifyWebhookType').value,
  };
  markDirty();
  // 예상 다음 실행일을 서버 없이 미리 보여줍니다.
  refreshSummaryPreview();
}

function refreshSummaryPreview() {
  const s = state.plan?.schedule;
  if (!s) return;
  $('#nextRunLabel').textContent = nextRunLabelFor(s);
  $('#scheduleLabel').textContent = `${s.intervalWeeks}주마다 ${WEEKDAY[s.weekday]}요일 ${s.time} (KST)`;
  $('#statEnabled').textContent = s.enabled !== false ? '켜짐' : '꺼짐';
  // 주기를 바꾸면 계획 탭의 소비량 라벨도 바로 따라 바뀝니다(예: 2주 소비량).
  const label = weekText('소비량');
  $$('#planList .plan-consumption-label').forEach((node) => {
    node.textContent = label;
  });
  $$('#planList .plan-consumption-input').forEach((node) => {
    node.setAttribute('aria-label', `${node.dataset.name || '상품'} ${label}`);
  });
}

function renderKurlyCard() {
  const k = state.status?.kurly || { status: 'disconnected' };
  const map = {
    connected: { text: '연결됨', cls: 'connected' },
    expired: { text: '만료됨', cls: 'expired' },
    disconnected: { text: '미연결', cls: 'disconnected' },
  };
  const info = map[k.status] || map.disconnected;
  ['#kurlyBadge', '#kurlyBadge2'].forEach((sel) => {
    const node = $(sel);
    if (!node) return;
    node.textContent = info.text;
    node.className = `badge ${info.cls}`;
  });

  const meta = $('#kurlyMeta');
  if (meta) {
    if (k.status === 'connected') {
      meta.textContent = `${k.account || '컬리 계정'} 연결됨${k.lastVerifiedAt ? ` · 확인 ${shortDate(k.lastVerifiedAt)}` : ''}`;
    } else if (k.status === 'expired') {
      meta.textContent = k.lastError || '컬리 로그인이 만료되었어요. 다시 연결해 주세요.';
    } else if (k.lastError) {
      meta.textContent = '지난 연결에 실패했어요. 아래 사유를 확인해 주세요.';
    } else {
      meta.textContent = '계정을 연결하면 정해진 날 자동으로 담아드려요.';
    }
  }

  const stateText = $('#kurlyStateText');
  if (stateText) {
    if (k.status === 'connected') {
      stateText.textContent = `${k.account || '컬리 계정'} · ${k.connectedAt ? shortDate(k.connectedAt) + ' 연결' : '연결됨'} · 세션은 암호화해 보관합니다.`;
    } else if (k.status === 'expired') {
      stateText.textContent = k.lastError || '세션이 만료되었습니다. 아이디·비밀번호로 다시 연결해 주세요.';
    } else if (k.lastError) {
      // 컬리가 돌려준 실제 사유(HTTP 상태·errorCode·안내 문구)를 계속 보이게 둡니다.
      stateText.textContent = k.lastError;
    } else {
      stateText.textContent = '아이디·비밀번호로 한 번만 연결하면, 이후에는 암호화된 로그인 세션으로 자동 실행합니다.';
    }
  }
  $('#kurlyVerifyBtn').disabled = !k.hasSession || Boolean(state.status?.queue?.active);
  $('#kurlyDisconnectBtn').disabled = !k.hasSession;

  const active = state.status?.queue?.active;
  $('#kurlyConnectBtn').disabled = Boolean(active && active.type === 'kurly-connect');
  $('#kurlyConnectBtn').textContent = active?.type === 'kurly-connect' ? '연결하는 중…' : '연결하기';

  const importing = active?.type === 'kurly-import';
  const importBtn = $('#sessionImportBtn');
  if (importBtn) {
    importBtn.disabled = importing;
    importBtn.textContent = importing ? '세션 확인 중…' : '세션 확인 및 연결';
  }
}

function shortDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/* ─────────────── 실행 ─────────────── */

function renderRun() {
  const s = state.status || {};
  const k = s.kurly || { status: 'disconnected' };
  const planned = mergedPlannedCount();
  const connected = k.status === 'connected';
  const listOnly = !connected || state.plan?.checklistOnly === true;

  let hint = '정기 실행일을 기다리지 않고 바로 담아볼 수 있어요.';
  if (!planned) hint = '먼저 계획에 상품을 담거나 요리를 선택해 주세요.';
  else if (listOnly)
    hint = '컬리 로그인 없이도 아래 [이번 주 장볼 목록]에서 [컬리에서 열기]·[오아시스에서 열기]로 담을 수 있어요.';
  else if (state.plan?.schedule) hint = `다음 정기 실행 ${nextRunLabelFor(state.plan.schedule)}`;
  $('#runHint').textContent = hint;

  $('#previewBtn').disabled = !planned;
  $('#runNowBtn').disabled = state.busy || !planned;
  $('#runNowBtn').textContent = listOnly ? '목록으로 장보기' : '지금 담기';
  renderMixLines();
  renderRunHistory();
  renderKurlyCard();
}

function setRunBusy(busy, progressText) {
  state.busy = busy;
  $('#runProgress').hidden = !busy;
  if (busy && progressText) $('#runProgressText').textContent = progressText;
  const planned = mergedPlannedCount();
  $('#runNowBtn').disabled = busy || !planned;
  const connected = (state.status?.kurly || {}).status === 'connected';
  const listOnly = !connected || state.plan?.checklistOnly === true;
  $('#runNowBtn').textContent = busy ? '담는 중…' : listOnly ? '목록으로 장보기' : '지금 담기';
  const recipeBtn = $('#recipeRunBtn');
  if (recipeBtn) {
    recipeBtn.disabled =
      busy || !selectedRecipesClient().length || clientRecipeSummary().includedIngredientCount === 0;
    recipeBtn.textContent = busy ? '담는 중…' : '선택한 요리 재료만 담기';
  }
}

/** 실행 기록에 보여줄 푸시 결과 — "보냈는지, 안 보냈으면 왜"를 항상 보이게 합니다. */
function pushStatusOf(run) {
  const p = run?.push;
  if (!p) return null;
  if (p.skipped) return { cls: 'muted', text: '🔕 푸시: 등록된 기기 없음' };
  if (Number(p.sent) > 0) {
    const extra = [];
    if (Number(p.failed) > 0) extra.push(`${p.failed}대 실패`);
    if (Number(p.pruned) > 0) extra.push(`만료 ${p.pruned}대 정리`);
    return {
      cls: Number(p.failed) > 0 ? 'warn' : 'ok',
      text: `🔔 푸시 ${p.sent}대 전송됨${extra.length ? ` · ${extra.join(' · ')}` : ''}`,
    };
  }
  const err = p.lastError || p.error;
  if (err) return { cls: 'bad', text: `⚠️ 푸시 실패: ${String(err).slice(0, 120)}` };
  if (Number(p.pruned) > 0) return { cls: 'warn', text: '🔕 만료된 기기라 푸시를 보내지 못했어요 — 푸시를 껐다 다시 켜 주세요' };
  if (Number(p.total) === 0) return { cls: 'muted', text: '🔕 푸시: 등록된 기기 없음' };
  return { cls: 'warn', text: '⚠️ 푸시를 보내지 못했어요' };
}

function renderRunHistory() {
  const runs = state.runs || [];
  const box = $('#runHistory');
  box.textContent = '';
  $('#runEmpty').hidden = runs.length > 0;
  $('#runStats').textContent = runs.length ? `최근 ${runs.length}회` : '';

  runs.forEach((run, index) => {
    const failed = run.status === 'failed';
    const partial = run.status === 'partial';
    const checklistRun = run.status === 'checklist' || run.checklistMode === true;
    const mark = failed ? 'bad' : partial ? 'warn' : 'ok';
    const addedCount = (run.added || 0) + (run.merged || 0);
    const headline = checklistRun
      ? `장볼 목록 ${(run.items || []).length}개를 준비했어요`
      : failed
        ? '실행을 마치지 못했어요'
        : partial
          ? `${addedCount}개 담음 · ${run.failed}개 실패`
          : `장바구니에 ${addedCount}개 상품을 담았어요`;

    const details = el('details', { class: 'history-entry' });
    if (index === 0) details.open = true;

    const whenBits = [run.ranAtLabel || '', run.trigger === 'scheduled' ? '정기' : '직접'];
    if (run.mode === 'recipes_only') whenBits.push('요리만');
    else if (run.mode === 'combined') whenBits.push('정기+요리');
    if (checklistRun) whenBits.push('목록');

    details.appendChild(
      el('summary', {}, [
        el('div', {}, [
          el('div', { class: 'history-when', text: whenBits.filter(Boolean).join(' · ') }),
          el('p', { class: `history-headline ${mark}`, text: headline }),
        ]),
        el('span', { class: 'muted small', text: `${Math.max(1, Math.round((run.durationMs || 0) / 1000))}초` }),
      ])
    );

    // 요리 담기/목록 알림 실행이면 구성도 함께 보여 줍니다.
    if (checklistRun) {
      details.appendChild(
        el('p', {
          class: 'history-mix',
          text: `컬리 로그인 없이 목록으로 준비했어요 — 실행 탭에서 [컬리에서 열기]로 담아 주세요.`,
        })
      );
    } else if (run.counts?.recipeCount) {
      details.appendChild(
        el('p', {
          class: 'history-mix',
          text:
            `이번 주 요리 ${run.counts.recipeCount}개(재료 ${run.counts.recipeIngredientCount}개)` +
            (run.counts.skipped ? ` · 집에 있음 ${run.counts.skipped}개 제외` : '') +
            (run.counts.deduped ? ` · 겹친 상품 ${run.counts.deduped}줄은 한 번만` : ''),
        })
      );
    }

    const list = el('ul', { class: 'history-items' });
    (run.items || []).forEach((item) => {
      const sourceMark = item.source === 'recipe' ? '🍳 ' : item.source === 'both' ? '🍳🧺 ' : '';
      list.appendChild(
        el('li', { class: item.status === 'failed' ? 'failed' : '' }, [
          el('span', { class: 'st', text: STATUS_MARK[item.status] || '•' }),
          el('span', { text: `${sourceMark}${item.name} ×${item.quantity}${item.reason ? ` — ${item.reason}` : ''}` }),
        ])
      );
    });
    details.appendChild(list);

    // 푸시 결과는 늘 보이게 — 알림이 안 왔을 때 이유를 바로 알 수 있도록
    const pushInfo = pushStatusOf(run);
    if (pushInfo) details.appendChild(el('p', { class: `push-status ${pushInfo.cls}`, text: pushInfo.text }));

    if (run.error || run.cartTotalCount !== null) {
      const bits = [];
      if (run.error) bits.push(run.error);
      if (typeof run.cartTotalCount === 'number') bits.push(`장바구니 ${run.cartTotalCount}건`);
      details.appendChild(el('p', { class: 'history-foot', text: bits.join(' · ') }));
    }
    box.appendChild(details);
  });
}

async function refreshRuns() {
  try {
    const data = await api('/api/runs?limit=10');
    state.runs = data.runs || [];
    renderRunHistory();
  } catch {
    /* 표시용이라 실패는 무시 */
  }
}

async function refreshPlanAndRuns() {
  try {
    const planData = await api('/api/plan');
    setPlan(planData.plan);
  } catch {
    /* 무시 */
  }
  await refreshRuns();
}

async function pollStatus() {
  if (!state.user) return;
  const data = await api('/api/status');
  state.status = data;
  const active = data.queue?.active || null;

  renderRun();
  renderKurlyCard();

  if (active) {
    state.wasActive = true;
    setRunBusy(true, active.progress || (active.status === 'queued' ? '대기 중…' : '실행 중…'));
    if (active.type === 'run' && state.tab !== 'run') setTab('run', { push: false });
    ensurePolling(true);
  } else {
    setRunBusy(false);
    if (state.wasActive) {
      state.wasActive = false;
      await refreshPlanAndRuns();
      refreshChecklist();
      const last = state.status?.lastRun || state.runs[0];
      if (last) {
        if (last.status === 'checklist') {
          toast(`장볼 목록 ${(last.items || []).length}개를 준비했어요. 목록에서 상품을 열어 담아 주세요.`);
        } else if (last.status === 'success') toast(`담기 완료! ${last.added + last.merged}개 상품을 담았어요.`);
        else if (last.status === 'partial') toast(`${last.failed}개 상품은 담지 못했어요. 기록을 확인해 주세요.`, true);
        else if (last.error) toast(last.error, true);
      }
      ensurePolling(false);
    }
  }
  return data;
}

/* ─────────────── 폴링 ─────────────── */

function ensurePolling(fast) {
  const interval = fast ? 2500 : 15000;
  if (state.pollTimer && state.pollTimer.interval === interval) return;
  if (state.pollTimer) clearInterval(state.pollTimer.id);
  state.pollTimer = {
    interval,
    id: setInterval(() => {
      if (document.hidden) return;
      pollStatus().catch(() => {});
    }, interval),
  };
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer.id);
  state.pollTimer = null;
}

/* ─────────────── 검색 ─────────────── */

function openSearch(preferredMarket = null) {
  // 계획 탭에서 열면 지금 보고 있는 마켓으로 미리 골라 둡니다.
  if (preferredMarket) {
    const next = preferredMarket === 'oasis' ? 'oasis' : 'kurly';
    if (state.search.market !== next) {
      state.search.market = next;
      state.search.results = [];
      state.search.shown = 8;
      state.search.q = '';
      $('#searchResults').textContent = '';
      $('#searchInput').value = '';
      $('#searchStatus').hidden = true;
    }
  }
  $('#searchSheet').hidden = false;
  $('#searchStatus').hidden = true;
  applyMarketUI();
  setTimeout(() => $('#searchInput').focus(), 120);
}

function closeSearch() {
  $('#searchSheet').hidden = true;
}

/* ── 마켓 고르기 (컬리 | 오아시스) ── */

/** 지금 고른 마켓에 맞춰 pill·검색창 문구·버튼 색을 함께 바꿉니다. */
function applyMarketUI() {
  const s = state.search.market === 'oasis' ? 'oasis' : 'kurly';
  const r = state.recipeSearch.market === 'oasis' ? 'oasis' : 'kurly';

  $$('#searchMarketPills .market-pill').forEach((btn) => {
    const active = btn.dataset.market === s;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $$('#recipeMarketPills .market-pill').forEach((btn) => {
    const active = btn.dataset.market === r;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const searchInput = $('#searchInput');
  if (searchInput) searchInput.placeholder = MARKET_SEARCH_PLACEHOLDER[s];
  const recipeInput = $('#recipeSearchInput');
  if (recipeInput) recipeInput.placeholder = `${MARKET_LABEL[r]} 재료 검색 (예: 두부, 애호박)`;

  // 오아시스는 초록(#2D6A4F), 컬리는 보라(#5F0080) — 어느 마켓에서 찾는지 색으로도 구분합니다.
  $('#searchBtn').classList.toggle('btn-oasis', s === 'oasis');
  $('#recipeSearchBtn').classList.toggle('btn-oasis', r === 'oasis');
  $('#searchSheet').classList.toggle('market-oasis', s === 'oasis');
  $('#recipeSheet').classList.toggle('market-oasis', r === 'oasis');
}

/** 상품 검색의 마켓 바꾸기 — 검색어가 있으면 그 마켓에서 다시 찾아 줍니다. */
function switchSearchMarket(market) {
  const next = market === 'oasis' ? 'oasis' : 'kurly';
  if (state.search.market === next) return;
  state.search.market = next;
  state.search.results = [];
  state.search.shown = 8;
  renderResults();
  applyMarketUI();
  const q = $('#searchInput').value.trim() || state.search.q;
  if (q) {
    $('#searchInput').value = q;
    doSearch(q);
  } else {
    $('#searchStatus').hidden = true;
    $('#searchInput').focus();
  }
}

/** 요리 재료 검색의 마켓 바꾸기 */
function switchRecipeMarket(market) {
  const next = market === 'oasis' ? 'oasis' : 'kurly';
  if (state.recipeSearch.market === next) return;
  state.recipeSearch.market = next;
  state.recipeSearch.results = [];
  renderRecipeResults();
  applyMarketUI();
  const q = $('#recipeSearchInput').value.trim() || state.recipeSearch.q;
  if (q) {
    $('#recipeSearchInput').value = q;
    doRecipeSearch(q);
  } else {
    $('#recipeSearchStatus').hidden = true;
  }
}

function renderResults() {
  const box = $('#searchResults');
  box.textContent = '';
  const shown = state.search.results.slice(0, state.search.shown);

  shown.forEach((p) => {
    const thumb = p.imageUrl
      ? el('img', { class: 'product-thumb', src: p.imageUrl, alt: '', loading: 'lazy' })
      : el('div', { class: 'product-thumb' });

    const market = marketOf(p);
    const badges = el('div', { class: 'product-badges' }, [
      marketBadge(market),
      p.discountRate ? el('span', { class: 'badge', text: `${Math.round(p.discountRate)}% 할인` }) : null,
      p.multiplePrice ? el('span', { class: 'badge', text: '옵션 있음' }) : null,
      p.soldOut ? el('span', { class: 'badge soldout', text: '품절' }) : null,
    ]);

    const addBtn = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: p.soldOut ? '품절' : '+ 추가',
      onclick: () => openAddModal(p),
    });
    addBtn.disabled =
      Boolean(p.soldOut) ||
      (state.plan?.items || []).some((i) => marketOf(i) === market && Number(i.productNo) === Number(p.no));

    box.appendChild(
      el('article', { class: 'product-card' }, [
        thumb,
        el('div', { class: 'product-body' }, [
          el('p', { class: 'product-name', text: p.name }),
          p.shortDescription ? el('p', { class: 'product-desc', text: p.shortDescription }) : null,
          el('p', { class: 'product-price' }, [
            document.createTextNode(won(p.price)),
            p.originalPrice && p.originalPrice > p.price ? el('small', { text: won(p.originalPrice) }) : null,
          ]),
          badges,
          addBtn,
        ]),
      ])
    );
  });

  const rest = state.search.results.length - shown.length;
  const more = $('#searchMore');
  more.hidden = rest <= 0;
  more.textContent = `결과 더 보기 (${rest}개)`;
}

async function doSearch(keyword) {
  const q = String(keyword ?? '').trim();
  if (!q) return;
  const market = state.search.market;
  state.search.q = q;
  const status = $('#searchStatus');
  status.hidden = false;
  status.className = 'search-status';
  status.textContent = `${MARKET_LABEL[market]}에서 상품을 찾는 중…`;
  $('#searchBtn').disabled = true;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&market=${market}`);
    // 마켓을 바꾼 뒤 도착한 예전 응답은 버립니다.
    if (state.search.market !== market || state.search.q !== q) return;
    state.search.results = data.products || [];
    state.search.shown = 8;
    renderResults();
    status.textContent = state.search.results.length
      ? `${MARKET_LABEL[market]} ‘${q}’ 검색 결과 ${state.search.results.length}개`
      : `${MARKET_LABEL[market]} ‘${q}’ 검색 결과가 없어요. 다른 검색어나 다른 마켓으로 찾아보세요.`;
  } catch (err) {
    state.search.results = [];
    renderResults();
    status.className = 'search-status error';
    status.textContent = err.message;
  } finally {
    $('#searchBtn').disabled = false;
  }
}

/* ─────────────── 상품 추가 모달 ─────────────── */

async function openAddModal(product) {
  const market = marketOf(product);
  state.editing = { product, market, detail: null, optionName: null, unitSize: 1, unitLabel: '개', consumption: 1 };
  const modal = $('#addModal');
  const body = $('#addModalBody');
  modal.hidden = false;
  body.textContent = '';
  body.appendChild(el('p', { class: 'search-status', text: '상품 정보를 불러오는 중…' }));
  $('#addModalConfirm').disabled = true;

  let detail = null;
  try {
    const data = await api(`/api/product?no=${product.no}&market=${market}`);
    detail = data.product;
  } catch (err) {
    toast('상품 상세를 불러오지 못했어요. 검색 결과 정보로 계속합니다.', true);
  }

  // 오아시스 상세에는 용량 항목이 없어 상품 이름에서 단위를 추정합니다.
  const suggestion =
    detail?.unitSuggestion || (market === 'oasis' ? guessUnit(product.name, product.shortDescription) : { unitSize: 1, unitLabel: '개' });
  const options = (detail?.options || []).filter((o) => !o.soldOut);
  const names = options.map((o) => o.name);
  const defaultOption = names.find((n) => !/컬리멤버스/.test(n)) ?? names[0] ?? null;

  state.editing = {
    product,
    market,
    detail,
    optionName: names.length > 1 ? defaultOption : null,
    unitSize: suggestion.unitSize,
    unitLabel: suggestion.unitLabel,
    consumption: suggestion.unitSize,
  };

  const e = state.editing;
  const unitSizeInput = el('input', {
    type: 'number', min: '0.01', step: 'any', inputmode: 'decimal', value: e.unitSize, 'aria-label': '한 단위 크기',
    oninput: (ev) => {
      e.unitSize = Number(ev.target.value) || 0;
      updateCalc();
    },
  });
  const unitLabelSelect = el(
    'select',
    {
      'aria-label': '단위',
      onchange: (ev) => {
        e.unitLabel = ev.target.value;
        updateCalc();
      },
    },
    ['구', 'g', 'kg', '입', '개', '팩', '봉', 'ml', 'L', '마리'].map((label) =>
      el('option', { value: label, text: label, selected: label === e.unitLabel ? 'selected' : null })
    )
  );
  const consumptionInput = el('input', {
    type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: e.consumption, 'aria-label': weekText('소비량'),
    oninput: (ev) => {
      e.consumption = Number(ev.target.value) || 0;
      updateCalc();
    },
  });
  const calcBox = el('div', { class: 'calc-box' });

  function updateCalc() {
    const qty = computeQuantity(e);
    calcBox.textContent = '';
    calcBox.append(
      el('div', { text: `담을 수량 ${qty}개 = ceil(${e.consumption}${e.unitLabel} ÷ ${e.unitSize}${e.unitLabel})` }),
      el('div', {
        class: 'calc-sub',
        text: `예상 금액 ${won((detail?.price ?? product.price ?? 0) * qty)} · 이번 ${intervalWeeksNow()}주 동안 먹을 양이에요`,
      })
    );
    $('#addModalConfirm').disabled = !(e.unitSize > 0);
  }

  body.textContent = '';
  const children = [
    el('div', { class: 'modal-product' }, [
      product.imageUrl ? el('img', { src: product.imageUrl, alt: '' }) : el('div', { class: 'product-thumb' }),
      el('div', {}, [
        el('p', { class: 'pname' }, [marketBadge(market, 'sm'), document.createTextNode(product.name)]),
        el('p', {
          class: 'pprice',
          text: `${won(detail?.price ?? product.price)}${detail?.volume ? ` · ${detail.volume}` : ''}${detail?.salesUnit ? ` · ${detail.salesUnit}` : ''}`,
        }),
      ]),
    ]),
  ];
  if (names.length > 1) {
    children.push(
      el('label', { class: 'field' }, [
        el('span', { text: '옵션 선택' }),
        el(
          'select',
          {
            onchange: (ev) => {
              e.optionName = ev.target.value;
            },
          },
          names.map((n) => el('option', { value: n, text: n, selected: n === defaultOption ? 'selected' : null }))
        ),
      ])
    );
  }
  children.push(
    el('div', { class: 'field' }, [
      el('span', { text: '한 단위 크기 (예: 15구, 500g, 1.3kg)' }),
      el('div', { class: 'unit-row' }, [unitSizeInput, el('div', { class: 'small' }, [unitLabelSelect])]),
    ]),
    el('div', { class: 'field' }, [
      el('span', { text: weekText('동안 먹는 양') }),
      el('div', { class: 'unit-row' }, [el('div', { class: 'grow' }, [consumptionInput]), el('div', { class: 'unit-chip', text: e.unitLabel })]),
    ]),
    calcBox
  );
  body.append(...children);
  updateCalc();
  $('#addModalConfirm').disabled = false;
}

function closeAddModal() {
  $('#addModal').hidden = true;
  state.editing = null;
}

function confirmAdd() {
  const e = state.editing;
  if (!e) return;
  if (!(e.unitSize > 0)) {
    toast('한 단위 크기를 입력해 주세요.', true);
    return;
  }
  const detail = e.detail;
  const option = (detail?.options || []).find((o) => o.name === e.optionName);
  const market = e.market === 'oasis' ? 'oasis' : 'kurly';
  const item = {
    id: `item-${market}-${e.product.no}-${Date.now().toString(36)}`,
    market,
    productNo: e.product.no,
    dealProductNo: option?.dealProductNo ?? detail?.options?.[0]?.dealProductNo ?? null,
    name: e.product.name,
    shortDescription: detail?.shortDescription || e.product.shortDescription || '',
    imageUrl: e.product.imageUrl ?? null,
    price: detail?.price ?? e.product.price ?? 0,
    unitPriceText: detail?.unitPriceText ?? null,
    volume: detail?.volume ?? null,
    url: e.product.url || detail?.url,
    unitSize: e.unitSize,
    unitLabel: e.unitLabel,
    consumption: e.consumption,
    quantityOverride: null,
    optionName: e.optionName,
    active: true,
    note: '',
  };

  const exists = (state.plan?.items || []).some(
    (i) =>
      marketOf(i) === market &&
      Number(i.productNo) === Number(item.productNo) &&
      (i.optionName || null) === (item.optionName || null)
  );
  if (exists) {
    toast('이미 계획에 있는 상품이에요.', true);
    closeAddModal();
    return;
  }

  state.plan.items = [...(state.plan?.items || []), item];
  closeAddModal();
  closeSearch();
  setTab('plan', { push: false });
  markDirty();
  toast(`${item.name}을(를) 담았어요. 저장을 눌러 반영해 주세요.`);
}

/* ─────────────── 실행 / 미리보기 ─────────────── */

async function runNow() {
  if (state.busy) return;
  if (!mergedPlannedCount()) {
    toast('담을 상품이 없어요. 계획에 상품을 담거나 요리를 선택해 주세요.', true);
    return;
  }
  const kurly = state.status?.kurly || { status: 'disconnected' };
  if (kurly.status !== 'connected' || state.plan?.checklistOnly === true) {
    // 컬리 로그인이 없거나 '목록 알림만 받기' 모드면 담는 대신 장볼 목록으로 안내합니다.
    toast('아래 장볼 목록의 [컬리에서 열기]·[오아시스에서 열기]로 하나씩 담아 주세요.');
    const card = $('#checklistCard');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    refreshChecklist();
    return;
  }
  setRunBusy(true, '실행을 준비하는 중…');
  try {
    // auto — '정기 실행에 함께 담기'가 켜져 있고 이번 주 요리가 있으면 정기+요리로 담습니다.
    await api('/api/cart/run-now', { method: 'POST', body: { mode: 'auto' } });
    ensurePolling(true);
    toast('담기를 시작했어요. 끝나면 알려드릴게요.');
    pollStatus().catch(() => {});
  } catch (err) {
    setRunBusy(false);
    if (err.status === 409 && err.body?.job) {
      ensurePolling(true);
      pollStatus().catch(() => {});
      return;
    }
    toast(err.message, true);
  }
}

async function openPreview() {
  try {
    const data = await api('/api/cart/preview');
    const p = data.preview;
    const body = $('#previewBody');
    body.textContent = '';
    if (!p.count) {
      body.appendChild(el('p', { class: 'muted', text: '담을 상품이 없어요.' }));
    } else {
      const list = el('ul', { class: 'history-items' });
      p.items.forEach((item) => {
        const sourceMark = item.source === 'recipe' ? '🍳 ' : item.source === 'both' ? '🍳🧺 ' : '';
        const recipeTag = item.recipeNames?.length ? ` (${item.recipeNames.join(', ')})` : '';
        list.appendChild(
          el('li', {}, [
            el('span', { class: 'st', text: '•' }),
            el('span', { text: `${sourceMark}${item.name}${recipeTag} ×${item.quantity} — ${won(item.lineTotal)}` }),
          ])
        );
      });
      if (p.mixLabel) {
        body.appendChild(el('p', { class: 'mix-line', text: `${p.mixLabel} · 겹치는 상품은 한 번만 담아요` }));
      }
      body.append(
        el('p', { class: 'muted small', text: `상품 ${p.count}개 · 예상 금액 ${won(p.estimatedTotal)}` }),
        list,
        el('p', { class: 'hint', text: '미리보기는 아무것도 담지 않아요. 실제로 담으려면 실행 탭의 [지금 담기]를 눌러 주세요.' })
      );
    }
    $('#previewModal').hidden = false;
  } catch (err) {
    toast(err.message, true);
  }
}

/* ─────────────── 컬리 연결 ─────────────── */

async function connectKurly(event) {
  event.preventDefault();
  const kurlyId = $('#kurlyId').value.trim();
  const kurlyPassword = $('#kurlyPw').value;
  if (!kurlyId || !kurlyPassword) {
    toast('컬리 아이디와 비밀번호를 모두 입력해 주세요.', true);
    return;
  }
  const btn = $('#kurlyConnectBtn');
  btn.disabled = true;
  btn.textContent = '연결하는 중…';
  try {
    await api('/api/kurly/connect', { method: 'POST', body: { kurlyId, kurlyPassword } });
    $('#kurlyPw').value = '';
    toast('컬리 로그인을 확인하고 있어요. 잠시만 기다려 주세요.');
    ensurePolling(true);
    pollStatus().catch(() => {});
    let waited = 0;
    const timer = setInterval(async () => {
      waited += 2500;
      try {
        const data = await pollStatus();
        const active = data.queue?.active;
        if (!active) {
          clearInterval(timer);
          if (data.kurly?.status === 'connected') toast('컬리 계정을 연결했어요!');
          else toast(data.kurly?.lastError || '연결하지 못했어요. 아이디·비밀번호를 확인해 주세요.', true);
        } else if (waited > 90000) {
          clearInterval(timer);
          toast('연결 확인이 오래 걸리고 있어요. 잠시 뒤 연결 상태를 확인해 주세요.', true);
        }
      } catch {
        clearInterval(timer);
      }
    }, 2500);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '연결하기';
  }
}

async function verifyKurly() {
  try {
    await api('/api/kurly/verify', { method: 'POST', body: {} });
    toast('컬리 로그인 상태를 확인하고 있어요.');
    ensurePolling(true);
    pollStatus().catch(() => {});
  } catch (err) {
    toast(err.message, true);
  }
}

async function disconnectKurly() {
  if (!confirm('컬리 계정 연결을 해제할까요? 저장된 로그인 세션이 삭제됩니다.')) return;
  try {
    const data = await api('/api/kurly/disconnect', { method: 'POST', body: {} });
    if (state.status) state.status.kurly = data.kurly;
    renderKurlyCard();
    renderRun();
    toast('연결을 해제했어요.');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ─────────────── 컬리 세션 직접 가져오기 ─────────────── */

function setImportMsg(message, isError = false) {
  const box = $('#sessionImportMsg');
  if (!box) return;
  box.hidden = !message;
  box.textContent = message || '';
  box.className = isError ? 'hint import-msg error' : 'hint import-msg';
}

async function readSessionFile(file) {
  if (!file) return '';
  if (file.size > 400 * 1024) throw new Error('세션 파일이 너무 큽니다(400KB 이하).');
  return await file.text();
}

/** 세션 붙여넣기/파일로 컬리를 연결합니다. (connectKurly 와 같은 /api/status 폴링) */
async function importKurlySession() {
  const btn = $('#sessionImportBtn');
  const raw = $('#sessionRaw').value.trim();
  const label = $('#sessionLabel').value.trim();
  if (!raw) {
    setImportMsg('세션을 먼저 붙여넣거나 파일을 올려 주세요.', true);
    toast('세션을 먼저 붙여넣거나 파일을 올려 주세요.', true);
    return;
  }
  btn.disabled = true;
  btn.textContent = '확인 중…';
  setImportMsg('');
  try {
    const data = await api('/api/kurly/import-session', { method: 'POST', body: { session: raw, label } });
    const warning = (data.session?.warnings || [])[0];
    if (warning) setImportMsg(warning, true);
    toast('가져온 세션으로 컬리 로그인을 확인하고 있어요. 잠시만 기다려 주세요.');
    ensurePolling(true);
    pollStatus().catch(() => {});

    let waited = 0;
    const timer = setInterval(async () => {
      waited += 2500;
      try {
        const status = await pollStatus();
        const active = status.queue?.active;
        if (active) {
          if (waited > 90000) {
            clearInterval(timer);
            setImportMsg('세션 확인이 오래 걸리고 있어요. 잠시 뒤 연결 상태를 확인해 주세요.', true);
          }
          return;
        }
        clearInterval(timer);
        if (status.kurly?.status === 'connected') {
          $('#sessionRaw').value = '';
          $('#sessionFile').value = '';
          $('#sessionFileInfo').textContent = 'kurly-state.json · storage-state.json';
          setImportMsg(`세션을 연결했어요${status.kurly?.account ? ` (${status.kurly.account})` : ''}. 이제 정기 실행이 가능해요.`);
          toast('컬리 세션을 가져왔어요!');
        } else {
          setImportMsg(status.kurly?.lastError || '유효한 컬리 로그인 세션을 확인하지 못했습니다. 로그인된 상태에서 다시 복사해 주세요.', true);
          toast(status.kurly?.lastError || '세션을 확인하지 못했어요.', true);
        }
      } catch {
        clearInterval(timer);
      }
    }, 2500);
  } catch (err) {
    setImportMsg(err.message, true);
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '세션 확인 및 연결';
  }
}

async function loadStarter() {
  try {
    const data = await api('/api/items/starter', { method: 'POST', body: {} });
    setPlan(data.plan);
    toast(data.added ? `기본 상품 ${data.added}개를 담았어요.` : '이미 기본 상품이 담겨 있어요.');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ─────────────── 인증 ─────────────── */

function setAuthMode(mode) {
  state.mode = mode;
  $$('#authMode button').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $('#inviteField').hidden = mode !== 'register';
  $('#starterField').hidden = mode !== 'register';
  $('#authSubmit').textContent = mode === 'register' ? '회원가입' : '로그인';
  $('#authPassword').setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
  $('#authError').hidden = true;
}

async function submitAuth(event) {
  event.preventDefault();
  const nickname = $('#authNickname').value.trim();
  const password = $('#authPassword').value;
  const errorBox = $('#authError');
  errorBox.hidden = true;

  if (!nickname || !password) {
    errorBox.textContent = '닉네임과 비밀번호를 입력해 주세요.';
    errorBox.hidden = false;
    return;
  }

  const btn = $('#authSubmit');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = state.mode === 'register' ? '가입하는 중…' : '로그인 중…';
  try {
    const path = state.mode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const body =
      state.mode === 'register'
        ? { nickname, password, inviteCode: $('#authInvite').value.trim(), loadStarter: $('#authStarter').checked }
        : { nickname, password };
    const data = await api(path, { method: 'POST', body });
    $('#authPassword').value = '';
    enterApp(data.user, data.plan);
    toast(state.mode === 'register' ? `${data.user.nickname}님, 환영해요!` : `${data.user.nickname}님, 안녕하세요!`);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch {
    /* 무시 */
  }
  state.user = null;
  state.plan = null;
  state.status = null;
  state.dirty = false;
  $('#saveBar').hidden = true;
  showAuth();
  toast('로그아웃했어요.');
}

/* ─────────────── PWA ─────────────── */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker
    .register('/sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      pushState.registration = reg;
    })
    .catch(() => {});
}

/* ─────────────── 웹 푸시 (아이폰 홈 화면 앱) ─────────────── */

const pushState = { registration: null, subscription: null, busy: false, syncing: null };

function isStandaloneMode() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function isIOSDevice() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** 이 브라우저·화면에서 푸시를 켤 수 있는지, 안 되면 그 이유 */
function pushSupport() {
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!secure) return { ok: false, reason: '푸시 알림은 https 주소에서만 동작해요.' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return {
      ok: false,
      reason: isIOSDevice()
        ? '아이폰은 iOS 16.4 이상에서 홈 화면에 추가한 앱에서만 푸시를 받을 수 있어요. Safari 공유(⬆️) → 홈 화면에 추가 후, 그 앱에서 켜 주세요.'
        : '이 브라우저는 푸시 알림을 지원하지 않아요.',
    };
  }
  if (isIOSDevice() && !isStandaloneMode()) {
    return { ok: false, reason: '아이폰은 Safari 탭에서는 알림이 오지 않아요. 공유(⬆️) → 홈 화면에 추가로 연 앱에서 켜 주세요.' };
  }
  if (Notification.permission === 'denied') {
    return {
      ok: false,
      reason: isIOSDevice()
        ? '알림이 차단되어 있어요. 아이폰 설정 > 알림 > 정기 장바구니에서 허용으로 바꿔 주세요.'
        : '브라우저 설정에서 이 사이트의 알림을 허용해 주세요.',
    };
  }
  return { ok: true, reason: '' };
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = String(base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function pushRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  if (pushState.registration && pushState.registration.active) return pushState.registration;

  // 이미 활성화된 서비스 워커가 있으면 바로 씁니다.
  // (아이폰 홈 화면 앱에서는 ready 가 끝없이 기다리는 경우가 있어 먼저 확인합니다.)
  try {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing && existing.active) {
      pushState.registration = existing;
      return existing;
    }
  } catch {
    /* getRegistration 을 못 쓰는 환경은 아래 ready 로 넘어갑니다 */
  }

  // ready 가 늦어지면 화면이 '확인 중…' 에 멈추지 않도록 3.5초만 기다립니다.
  const ready = navigator.serviceWorker.ready.catch(() => null);
  const reg = await Promise.race([
    ready,
    new Promise((resolve) => setTimeout(() => resolve(null), 3500)),
  ]);
  if (reg) {
    pushState.registration = reg;
    return reg;
  }
  // 늦게라도 준비되면 다음 호출에서 바로 쓸 수 있게 기억해 둡니다.
  ready.then((late) => {
    if (late && late.active && !pushState.registration) pushState.registration = late;
  });
  return null;
}

function deviceLabel() {
  if (isIOSDevice()) return isStandaloneMode() ? '아이폰 · 홈 화면 앱' : '아이폰 · Safari';
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return '안드로이드 · 브라우저';
  if (/Macintosh/.test(ua)) return '맥 · 브라우저';
  if (/Windows/.test(ua)) return '윈도우 · 브라우저';
  return '이 기기';
}

function renderPushUI() {
  const toggle = $('#pushToggle');
  const testBtn = $('#pushTestBtn');
  const stateText = $('#pushStateText');
  const hint = $('#pushHint');
  if (!toggle || !testBtn || !stateText || !hint) return;

  const support = pushSupport();
  const subscribed = Boolean(pushState.subscription) && support.ok && Notification.permission === 'granted';

  if (!support.ok) {
    toggle.checked = false;
    toggle.disabled = true;
    testBtn.disabled = true;
    stateText.textContent = '이 기기에서는 지금 켤 수 없어요.';
    hint.hidden = false;
    hint.textContent = support.reason;
    return;
  }

  toggle.disabled = pushState.busy;
  toggle.checked = subscribed;
  testBtn.disabled = pushState.busy || !subscribed;
  stateText.textContent = subscribed
    ? '켜짐 — 이 기기 알림으로 보내드려요.'
    : '꺼짐 — 켜면 담기 결과를 잠금화면 알림으로 알려드려요.';
  hint.hidden = false;
  hint.textContent = isIOSDevice()
    ? '아이폰은 홈 화면에 추가한 앱에서만 알림이 와요. 알림이 안 보이면 설정 > 알림에서 이 앱이 허용되어 있는지 확인해 주세요.'
    : '브라우저 알림 권한을 허용해야 알림이 와요.';
}

/* ── 푸시 구독 자동 동기화 ──
 * 켜 둔 푸시가 어느 날부터 오지 않아 '스위치를 껐다 켜기'를 해야 하는 문제를 없앱니다.
 * 원인은 두 가지였습니다: ① 배포·볼륨 초기화로 서버에서 구독 기록이 사라짐
 * ② 서버 VAPID 공개키가 바뀌어 이 기기 구독이 옛 키로 남아 있음(애플이 거부).
 * 화면을 열 때·테스트 알림을 보낼 때 이 함수가 조용히 다시 맞춥니다. */

/** 이 기기 구독이 만들어진 VAPID 공개키가 지금 서버 키와 같은지 (바이트 비교) */
function sameApplicationServerKey(existing, expected) {
  if (!existing || !expected) return true; // 브라우저가 키를 안 보여 주면 건드리지 않습니다.
  let bytes = null;
  try {
    if (ArrayBuffer.isView(existing)) {
      bytes = new Uint8Array(existing.buffer, existing.byteOffset, existing.byteLength);
    } else if (typeof existing.byteLength === 'number') {
      // 아이폰·다른 창에서 온 ArrayBuffer 도 같은 방식으로 읽습니다.
      bytes = new Uint8Array(typeof existing.slice === 'function' ? existing.slice(0) : existing);
    }
  } catch {
    bytes = null;
  }
  if (!bytes) return true;
  if (bytes.length !== expected.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] !== expected[i]) return false;
  return true;
}

/** 이 기기 구독을 서버에 등록(같은 endpoint 는 갱신) */
async function postPushSubscription(sub) {
  const json = sub.toJSON();
  await api('/api/push/subscribe', {
    method: 'POST',
    body: { endpoint: json.endpoint, keys: json.keys, deviceLabel: deviceLabel() },
  });
  pushState.subscription = sub;
  return sub;
}

/** 이 기기를 지금 서버 키로 다시 구독합니다. (기존 구독을 해지하고 새로 만든 뒤 등록) */
async function resubscribePush(reg, publicKey) {
  const current = await reg.pushManager.getSubscription();
  if (current) {
    try {
      await current.unsubscribe();
    } catch {
      /* 이미 만료된 구독이면 그대로 진행합니다 */
    }
  }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  return postPushSubscription(sub);
}

/**
 * 이 기기 구독을 서버 상태에 맞춰 조용히 동기화합니다. (실패해도 화면에 알리지 않음)
 *  · 로컬 구독이 없으면 아무 것도 하지 않습니다(사용자가 켜면 등록).
 *  · 서버 키가 바뀌었으면 구독을 새로 만들어 다시 등록합니다.
 *  · 서버에 이 endpoint 기록이 없으면(볼륨 초기화·재배포) 다시 등록만 합니다.
 * @returns {Promise<PushSubscription|null>}
 */
async function syncPushSubscriptionIfNeeded() {
  if (pushState.syncing) return pushState.syncing;
  pushState.syncing = (async () => {
    const support = pushSupport();
    if (!support.ok || Notification.permission !== 'granted') return null;
    const reg = await pushRegistration();
    if (!reg) return null;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return null;

    const data = await api(`/api/push/vapid-key?endpoint=${encodeURIComponent(sub.endpoint)}`);
    if (!data || !data.publicKey) return sub;

    if (!sameApplicationServerKey(sub.options ? sub.options.applicationServerKey : null, urlBase64ToUint8Array(data.publicKey))) {
      console.info('푸시 키가 바뀌어 이 기기 구독을 새로 만듭니다.');
      return resubscribePush(reg, data.publicKey);
    }
    if (data.registered !== true) {
      console.info('서버에 이 기기 푸시 기록이 없어 다시 등록합니다.');
      return postPushSubscription(sub);
    }
    pushState.subscription = sub;
    return sub;
  })()
    .catch((err) => {
      console.warn('푸시 구독 자동 동기화 실패:', (err && err.message) || err);
      return null;
    })
    .finally(() => {
      pushState.syncing = null;
    });
  return pushState.syncing;
}

async function refreshPushUI() {
  if (!$('#pushToggle')) return;
  const support = pushSupport();
  if (!support.ok) {
    pushState.subscription = null;
    renderPushUI();
    return;
  }
  // 서비스 워커 준비를 기다리기 전에 현재 상태로 먼저 그립니다.
  // (아이폰에서 ready 가 늦어도 '확인 중…' 에 멈추지 않게)
  renderPushUI();
  try {
    const reg = await pushRegistration();
    pushState.subscription = reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    pushState.subscription = null;
  }
  // 켜 둔 푸시가 어느 날부터 오지 않을 때 사용자가 스위치를 껐다 켜지 않아도 되도록,
  // 이 기기 구독을 서버 기록·서버 VAPID 키와 조용히 맞춰 둡니다. (실패는 화면에 알리지 않음)
  if (pushState.subscription && Notification.permission === 'granted') {
    await syncPushSubscriptionIfNeeded();
  }
  renderPushUI();
}

async function enablePush() {
  const support = pushSupport();
  if (!support.ok) {
    renderPushUI();
    toast(support.reason, true);
    return;
  }
  pushState.busy = true;
  renderPushUI();
  try {
    const permission =
      Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('알림을 허용해야 푸시를 받을 수 있어요. 아이폰 설정 > 알림에서 허용할 수 있어요.', true);
      return;
    }
    const reg = await pushRegistration();
    if (!reg) throw new Error('서비스 워커를 준비하지 못했어요. 앱을 다시 열어 주세요.');
    const data = await api('/api/push/vapid-key');
    if (!data.publicKey) throw new Error('서버의 푸시 키를 받지 못했어요.');
    const current = await reg.pushManager.getSubscription();
    if (current && !sameApplicationServerKey(current.options ? current.options.applicationServerKey : null, urlBase64ToUint8Array(data.publicKey))) {
      // 예전 키로 만들어진 구독은 그대로 등록하면 애플이 거부합니다. 새 키로 다시 만듭니다.
      await resubscribePush(reg, data.publicKey);
    } else if (current) {
      await postPushSubscription(current);
    } else {
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.publicKey),
      });
      await postPushSubscription(sub);
    }
    toast('이 기기 푸시 알림을 켰어요. 테스트 알림으로 확인해 보세요.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    pushState.busy = false;
    await refreshPushUI();
  }
}

async function disablePush() {
  pushState.busy = true;
  renderPushUI();
  try {
    const reg = await pushRegistration();
    const sub = pushState.subscription || (reg ? await reg.pushManager.getSubscription() : null);
    if (sub) {
      try {
        await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
      } catch {
        /* 서버 기록이 없어도 기기 구독은 해지합니다 */
      }
      await sub.unsubscribe().catch(() => {});
    }
    pushState.subscription = null;
    toast('이 기기 푸시 알림을 껐어요.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    pushState.busy = false;
    await refreshPushUI();
  }
}

async function sendTestPush() {
  const btn = $('#pushTestBtn');
  btn.disabled = true;
  const send = () => api('/api/push/test', { method: 'POST', body: {} });
  try {
    // 보내기 전에 이 기기 구독을 서버 기록·서버 키와 조용히 맞춥니다.
    // (스위치를 직접 껐다 켜지 않아도 되도록)
    await syncPushSubscriptionIfNeeded();
    let result;
    try {
      result = await send();
    } catch (err) {
      // 서버 쪽 기록이 사라졌다면(볼륨 초기화 등) 이 기기 구독을 다시 등록하고 한 번 더 시도합니다.
      if (err.status !== 400 || !pushState.subscription) throw err;
      await postPushSubscription(pushState.subscription);
      result = await send();
    }
    // 한 대도 전달되지 않았으면(만료 정리·푸시 서버 거부) 구독을 새로 만들어 한 번 더 시도합니다.
    if (result.sent === 0) {
      const reg = await pushRegistration();
      const data = await api('/api/push/vapid-key');
      if (reg && data && data.publicKey) {
        await resubscribePush(reg, data.publicKey);
        const retry = await send();
        if (retry.sent > 0) {
          toast('테스트 알림을 보냈어요. 이 기기 푸시를 새로 연결했으니 잠시 뒤 알림을 확인해 주세요.');
          return;
        }
        result = retry;
      }
    }
    // 푸시 서버가 거부한 이유(HTTP 상태·애플 응답)를 숨기지 않고 보여 줍니다.
    const detail = result.lastError ? ` — ${String(result.lastError).slice(0, 160)}` : '';
    if (result.sent > 0) toast('테스트 알림을 보냈어요. 잠시 뒤 알림이 오는지 확인해 주세요.');
    else if (result.pruned > 0) toast(`만료된 구독을 정리하고 새 구독으로 다시 연결했습니다. [테스트 알림 보내기]를 한 번 더 눌러 주세요.${detail}`, true);
    else toast(`알림을 보내지 못했어요.${detail}`, true);
  } catch (err) {
    toast(err.message, true);
  } finally {
    await refreshPushUI();
  }
}

function maybeShowInstallHint() {
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (standalone) return;
  if (localStorage.getItem('kurly.installHintDismissed') === '1') return;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIOS) return;
  $('#installHint').hidden = false;
}

/* ─────────────── 이벤트 연결 ─────────────── */

function bindEvents() {
  // 로그인 / 회원가입
  $('#authMode').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn) setAuthMode(btn.dataset.mode);
  });
  $('#authForm').addEventListener('submit', submitAuth);

  // 탭
  $$('.tabbar button').forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
  window.addEventListener('hashchange', () => setTab(location.hash.replace('#', ''), { push: false }));

  // 계획
  $('#openSearchBtn').addEventListener('click', () => openSearch(state.planMarket));
  $('#loadStarterBtn').addEventListener('click', loadStarter);
  $('#planMarketPills').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-market]');
    if (!btn) return;
    const next = btn.dataset.market === 'oasis' ? 'oasis' : 'kurly';
    state.planMarketTouched = true;
    if (state.planMarket === next) return;
    state.planMarket = next;
    renderPlan();
  });
  $('#saveBtn').addEventListener('click', savePlan);
  $('#refreshBtn').addEventListener('click', async () => {
    try {
      await pollStatus();
      await refreshPlanAndRuns();
      toast('새로고침했어요.');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 설정
  ['#scheduleEnabled', '#scheduleWeekday', '#scheduleTime', '#scheduleInterval', '#scheduleAnchor', '#notifyWebhook', '#notifyWebhookType'].forEach(
    (sel) => $(sel).addEventListener('change', readScheduleInputs)
  );
  $('#kurlyForm').addEventListener('submit', connectKurly);
  $('#sessionImportBtn').addEventListener('click', importKurlySession);
  $('#sessionFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $('#sessionFileInfo').textContent = file.name;
    try {
      const text = await readSessionFile(file);
      $('#sessionRaw').value = text.trim();
      setImportMsg(`${file.name} 을(를) 읽었어요. [세션 확인 및 연결] 을 눌러 주세요.`);
    } catch (err) {
      setImportMsg(err.message, true);
      toast(err.message, true);
    }
  });
  $('#kurlyVerifyBtn').addEventListener('click', verifyKurly);
  $('#kurlyDisconnectBtn').addEventListener('click', disconnectKurly);
  $('#pushToggle').addEventListener('change', (e) => {
    if (e.target.checked) enablePush();
    else disablePush();
  });
  $('#pushTestBtn').addEventListener('click', sendTestPush);
  $('#logoutBtn').addEventListener('click', logout);
  $('#gotoConnectBtn').addEventListener('click', () => setTab('settings'));
  $('#installHintClose').addEventListener('click', () => {
    $('#installHint').hidden = true;
    localStorage.setItem('kurly.installHintDismissed', '1');
  });

  // 마켓 고르기 (컬리 | 오아시스)
  $('#searchMarketPills').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-market]');
    if (btn) switchSearchMarket(btn.dataset.market);
  });
  $('#recipeMarketPills').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-market]');
    if (btn) switchRecipeMarket(btn.dataset.market);
  });
  $('#checklistMarketPills').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-market]');
    if (!btn) return;
    state.checklistMarket = btn.dataset.market === 'oasis' ? 'oasis' : 'kurly';
    renderChecklist();
  });

  // 실행
  $('#runNowBtn').addEventListener('click', runNow);
  $('#previewBtn').addEventListener('click', openPreview);

  // 이번 주 장볼 목록 (컬리 로그인 없이)
  $('#checklistResetBtn').addEventListener('click', resetChecklist);
  $('#checklistDoneBtn').addEventListener('click', completeShopping);
  $('#checklistOnlyToggle').addEventListener('change', (e) => saveChecklistOnly(e.target.checked));

  // 요리
  $('#newRecipeBtn').addEventListener('click', () => openRecipeEditor(null));
  $('#newRecipeEmptyBtn').addEventListener('click', () => openRecipeEditor(null));
  $('#recipeRunBtn').addEventListener('click', runRecipesOnly);
  $('#mergeWithPlanToggle').addEventListener('change', async (e) => {
    state.plan.recipeSettings = { ...recipeSettingsClient(), mergeWithRegularPlan: e.target.checked };
    renderRecipes();
    renderSummary();
    renderRun();
    await saveRecipes();
    toast(e.target.checked ? '정기 실행에 요리 재료도 함께 담을게요.' : '정기 실행은 정기 품목만 담을게요.');
  });
  $('#clearAfterRunToggle').addEventListener('change', async (e) => {
    state.plan.recipeSettings = { ...recipeSettingsClient(), clearSelectedAfterRun: e.target.checked };
    await saveRecipes();
    toast(e.target.checked ? '담은 뒤 이번 주 요리 선택을 풀어둘게요.' : '담아도 요리 선택을 그대로 둘게요.');
  });
  $('#recipeCloseBtn').addEventListener('click', closeRecipeEditor);
  $('#recipeSaveBtn').addEventListener('click', saveRecipeEditor);
  $('#recipeName').addEventListener('input', (e) => {
    if (state.editingRecipe) state.editingRecipe.name = e.target.value;
  });
  $('#recipeSearchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    doRecipeSearch($('#recipeSearchInput').value);
  });
  $('#recipeQuickKeywords').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-q]');
    if (!chip) return;
    $('#recipeSearchInput').value = chip.dataset.q;
    doRecipeSearch(chip.dataset.q);
  });
  $('#previewClose').addEventListener('click', () => { $('#previewModal').hidden = true; });
  $('#previewOk').addEventListener('click', () => { $('#previewModal').hidden = true; });
  $('#previewModal').addEventListener('click', (e) => {
    if (e.target.id === 'previewModal') $('#previewModal').hidden = true;
  });

  // 검색
  $('#closeSearchBtn').addEventListener('click', closeSearch);
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    doSearch($('#searchInput').value);
  });
  $('#quickKeywords').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-q]');
    if (!chip) return;
    $('#searchInput').value = chip.dataset.q;
    doSearch(chip.dataset.q);
  });
  $('#searchMore').addEventListener('click', () => {
    state.search.shown += 8;
    renderResults();
  });

  // 상품 추가 모달
  $('#addModalClose').addEventListener('click', closeAddModal);
  $('#addModalCancel').addEventListener('click', closeAddModal);
  $('#addModalConfirm').addEventListener('click', confirmAdd);
  $('#addModal').addEventListener('click', (e) => {
    if (e.target.id === 'addModal') closeAddModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#recipeSheet').hidden) closeRecipeEditor();
    else if (!$('#addModal').hidden) closeAddModal();
    else if (!$('#previewModal').hidden) $('#previewModal').hidden = true;
    else if (!$('#searchSheet').hidden) closeSearch();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.user) pollStatus().catch(() => {});
  });
}

/* ─────────────── 시작 ─────────────── */

async function boot() {
  bindEvents();
  setAuthMode('login');
  try {
    const config = await fetch('/api/config', { credentials: 'same-origin' })
      .then((r) => r.json())
      .catch(() => null);
    if (config?.version) $('#appVersion').textContent = config.version;
  } catch {
    /* 무시 */
  }
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      if (data.user) {
        enterApp(data.user, data.plan);
        return;
      }
    }
  } catch {
    /* 네트워크 오류 → 로그인 화면 */
  }
  showAuth();
}

boot();
