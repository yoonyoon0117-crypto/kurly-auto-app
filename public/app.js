'use strict';
/**
 * 컬리 정기 장바구니 — 화면 로직
 *  · 로그인/회원가입(초대 코드) → 계획 · 실행 · 설정 3개 탭
 *  · 계획은 "2주 소비량 → 담을 수량" 자동 계산, 저장 버튼으로 서버에 반영
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
  search: { results: [], shown: 8, q: '' },
  editing: null,
  overrideOpen: new Set(),
};

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
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

/** 화면용 다음 실행 시각 (서버와 같은 규칙을 미리 계산해 즉시 보여줍니다) */
function nextRunLabelFor(schedule) {
  if (!schedule) return '—';
  const [h, m] = String(schedule.time || '21:00').split(':').map(Number);
  const anchor = Date.parse(
    `${schedule.anchorDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`
  );
  if (!Number.isFinite(anchor)) return '—';
  const interval = Math.max(1, Number(schedule.intervalWeeks) || 2) * 7 * 86400000;
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
  toast._t = setTimeout(() => {
    node.hidden = true;
  }, 3600);
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
  pollStatus().catch(() => {});
}

function setTab(tab, { push = true } = {}) {
  const allowed = ['plan', 'run', 'settings'];
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
  if (next === 'run') {
    renderRun();
    pollStatus().catch(() => {});
  }
  if (next === 'settings') renderKurlyCard();
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
  renderRun();
  setDirty(false);
}

function renderSummary() {
  if (!state.plan) return;
  const client = clientSummary();
  $('#nextRunLabel').textContent = nextRunLabelFor(state.plan.schedule);
  $('#scheduleLabel').textContent = client.scheduleLabel || `${state.plan.schedule?.intervalWeeks || 2}주마다 ${WEEKDAY[state.plan.schedule?.weekday ?? 5]}요일 ${state.plan.schedule?.time || '21:00'} (KST)`;
  $('#statItems').textContent = `${client.activeCount}개`;
  $('#statTotal').textContent = won(client.estimatedTotal);
  $('#statEnabled').textContent = (state.plan.schedule?.enabled !== false) ? '켜짐' : '꺼짐';
}

function renderPlan() {
  const list = $('#planList');
  list.textContent = '';
  const items = state.plan?.items || [];
  $('#planEmpty').hidden = items.length > 0;

  items.forEach((item) => {
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
      'aria-label': `${item.name} 2주 소비량`,
      onchange: (e) => {
        const v = Number(e.target.value);
        item.consumption = Number.isFinite(v) && v >= 0 ? v : 0;
        item.quantityOverride = null;
        markDirty();
      },
    });

    const controls = el('div', { class: 'plan-controls' }, [
      el('label', { text: '2주 소비량' }),
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
            el('a', {
              href: item.url || `https://www.kurly.com/goods/${item.productNo}`,
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

/* ─────────────── 설정 ─────────────── */

function renderSettings() {
  const s = state.plan?.schedule || {};
  const n = state.plan?.notification || {};
  $('#scheduleEnabled').checked = s.enabled !== false;
  $('#scheduleWeekday').value = String(s.weekday ?? 5);
  $('#scheduleTime').value = s.time ?? '21:00';
  $('#scheduleInterval').value = String(s.intervalWeeks ?? 2);
  $('#scheduleAnchor').value = s.anchorDate ?? '';
  $('#notifyWebhook').value = n.webhookUrl ?? '';
  $('#notifyWebhookType').value = n.webhookType ?? 'auto';
  renderKurlyCard();
}

function readScheduleInputs() {
  if (!state.plan) return;
  state.plan.schedule = {
    ...(state.plan.schedule || {}),
    enabled: $('#scheduleEnabled').checked,
    weekday: Number($('#scheduleWeekday').value),
    time: $('#scheduleTime').value || '21:00',
    intervalWeeks: Number($('#scheduleInterval').value) || 2,
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
    } else {
      stateText.textContent = '아이디·비밀번호로 한 번만 연결하면, 이후에는 암호화된 로그인 세션으로 자동 실행합니다.';
    }
  }
  $('#kurlyVerifyBtn').disabled = !k.hasSession || Boolean(state.status?.queue?.active);
  $('#kurlyDisconnectBtn').disabled = !k.hasSession;

  const active = state.status?.queue?.active;
  $('#kurlyConnectBtn').disabled = Boolean(active && active.type === 'kurly-connect');
  $('#kurlyConnectBtn').textContent = active?.type === 'kurly-connect' ? '연결하는 중…' : '연결하기';
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
  const items = activeItems();
  const connected = k.status === 'connected';

  let hint = '정기 실행일을 기다리지 않고 바로 담아볼 수 있어요.';
  if (!items.length) hint = '먼저 계획에 상품을 담아주세요.';
  else if (!connected) hint = '컬리 계정을 연결하면 바로 담을 수 있어요.';
  else if (state.plan?.schedule) hint = `다음 정기 실행 ${nextRunLabelFor(state.plan.schedule)}`;
  $('#runHint').textContent = hint;

  $('#previewBtn').disabled = !items.length;
  renderRunHistory();
  renderKurlyCard();
}

function setRunBusy(busy, progressText) {
  state.busy = busy;
  $('#runProgress').hidden = !busy;
  if (busy && progressText) $('#runProgressText').textContent = progressText;
  $('#runNowBtn').disabled = busy;
  $('#runNowBtn').textContent = busy ? '담는 중…' : '지금 담기';
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
    const mark = failed ? 'bad' : partial ? 'warn' : 'ok';
    const headline = failed
      ? '실행을 마치지 못했어요'
      : partial
        ? `${run.added + run.merged}개 담음 · ${run.failed}개 실패`
        : `장바구니에 ${run.added + run.merged}개 상품을 담았어요`;

    const details = el('details', { class: 'history-entry' });
    if (index === 0) details.open = true;
    details.appendChild(
      el('summary', {}, [
        el('div', {}, [
          el('div', { class: 'history-when', text: `${run.ranAtLabel || ''}${run.trigger === 'scheduled' ? ' · 정기' : ' · 직접'}` }),
          el('p', { class: `history-headline ${mark}`, text: headline }),
        ]),
        el('span', { class: 'muted small', text: `${Math.max(1, Math.round((run.durationMs || 0) / 1000))}초` }),
      ])
    );

    const list = el('ul', { class: 'history-items' });
    (run.items || []).forEach((item) => {
      list.appendChild(
        el('li', { class: item.status === 'failed' ? 'failed' : '' }, [
          el('span', { class: 'st', text: STATUS_MARK[item.status] || '•' }),
          el('span', { text: `${item.name} ×${item.quantity}${item.reason ? ` — ${item.reason}` : ''}` }),
        ])
      );
    });
    details.appendChild(list);
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
      const last = state.status?.lastRun || state.runs[0];
      if (last) {
        if (last.status === 'success') toast(`담기 완료! ${last.added + last.merged}개 상품을 담았어요.`);
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

function openSearch() {
  $('#searchSheet').hidden = false;
  $('#searchStatus').hidden = true;
  setTimeout(() => $('#searchInput').focus(), 120);
}

function closeSearch() {
  $('#searchSheet').hidden = true;
}

function renderResults() {
  const box = $('#searchResults');
  box.textContent = '';
  const shown = state.search.results.slice(0, state.search.shown);

  shown.forEach((p) => {
    const thumb = p.imageUrl
      ? el('img', { class: 'product-thumb', src: p.imageUrl, alt: '', loading: 'lazy' })
      : el('div', { class: 'product-thumb' });

    const badges = el('div', { class: 'product-badges' }, [
      p.discountRate ? el('span', { class: 'badge', text: `${Math.round(p.discountRate)}% 할인` }) : null,
      p.multiplePrice ? el('span', { class: 'badge', text: '옵션 있음' }) : null,
      p.soldOut ? el('span', { class: 'badge soldout', text: '품절' }) : null,
    ]);

    const addBtn = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: p.soldOut ? '품절' : '계획에 추가',
      onclick: () => openAddModal(p),
    });
    addBtn.disabled = Boolean(p.soldOut) || state.plan?.items?.some((i) => i.productNo === p.no);

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
  state.search.q = q;
  const status = $('#searchStatus');
  status.hidden = false;
  status.className = 'search-status';
  status.textContent = '컬리에서 상품을 찾는 중…';
  $('#searchBtn').disabled = true;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    state.search.results = data.products || [];
    state.search.shown = 8;
    renderResults();
    status.textContent = state.search.results.length
      ? `‘${q}’ 검색 결과 ${state.search.results.length}개`
      : `‘${q}’ 검색 결과가 없어요. 다른 검색어로 찾아보세요.`;
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
  state.editing = { product, detail: null, optionName: null, unitSize: 1, unitLabel: '개', consumption: 1 };
  const modal = $('#addModal');
  const body = $('#addModalBody');
  modal.hidden = false;
  body.textContent = '';
  body.appendChild(el('p', { class: 'search-status', text: '상품 정보를 불러오는 중…' }));
  $('#addModalConfirm').disabled = true;

  let detail = null;
  try {
    const data = await api(`/api/product?no=${product.no}`);
    detail = data.product;
  } catch (err) {
    toast('상품 상세를 불러오지 못했어요. 검색 결과 정보로 계속합니다.', true);
  }

  const suggestion = detail?.unitSuggestion || { unitSize: 1, unitLabel: '개' };
  const options = (detail?.options || []).filter((o) => !o.soldOut);
  const names = options.map((o) => o.name);
  const defaultOption = names.find((n) => !/컬리멤버스/.test(n)) ?? names[0] ?? null;

  state.editing = {
    product,
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
    type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: e.consumption, 'aria-label': '2주 소비량',
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
        text: `예상 금액 ${won((detail?.price ?? product.price ?? 0) * qty)} · 이번 2주 동안 먹을 양이에요`,
      })
    );
    $('#addModalConfirm').disabled = !(e.unitSize > 0);
  }

  body.textContent = '';
  const children = [
    el('div', { class: 'modal-product' }, [
      product.imageUrl ? el('img', { src: product.imageUrl, alt: '' }) : el('div', { class: 'product-thumb' }),
      el('div', {}, [
        el('p', { class: 'pname', text: product.name }),
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
      el('span', { text: '2주 동안 먹는 양' }),
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
  const item = {
    id: `item-${e.product.no}-${Date.now().toString(36)}`,
    productNo: e.product.no,
    dealProductNo: option?.dealProductNo ?? detail?.options?.[0]?.dealProductNo ?? null,
    name: e.product.name,
    shortDescription: detail?.shortDescription ?? e.product.shortDescription ?? '',
    imageUrl: e.product.imageUrl ?? null,
    price: detail?.price ?? e.product.price ?? 0,
    unitPriceText: detail?.unitPriceText ?? null,
    volume: detail?.volume ?? null,
    url: e.product.url,
    unitSize: e.unitSize,
    unitLabel: e.unitLabel,
    consumption: e.consumption,
    quantityOverride: null,
    optionName: e.optionName,
    active: true,
    note: '',
  };

  const exists = (state.plan?.items || []).some(
    (i) => i.productNo === item.productNo && (i.optionName || null) === (item.optionName || null)
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
  if (!activeItems().length) {
    toast('계획에 담을 상품이 없어요. 먼저 상품을 추가해 주세요.', true);
    return;
  }
  const kurly = state.status?.kurly || { status: 'disconnected' };
  if (kurly.status !== 'connected') {
    toast(kurly.status === 'expired' ? '컬리 로그인이 만료됐어요. 다시 연결해 주세요.' : '먼저 컬리 계정을 연결해 주세요.', true);
    setTab('settings');
    return;
  }
  setRunBusy(true, '실행을 준비하는 중…');
  try {
    await api('/api/cart/run-now', { method: 'POST', body: {} });
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
      body.appendChild(el('p', { class: 'muted', text: '계획에 담을 상품이 없어요.' }));
    } else {
      const list = el('ul', { class: 'history-items' });
      p.items.forEach((item) => {
        list.appendChild(
          el('li', {}, [
            el('span', { class: 'st', text: '•' }),
            el('span', { text: `${item.name} ×${item.quantity} — ${won(item.lineTotal)}` }),
          ])
        );
      });
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
  navigator.serviceWorker.register('/sw.js').catch(() => {});
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
  $('#openSearchBtn').addEventListener('click', openSearch);
  $('#loadStarterBtn').addEventListener('click', loadStarter);
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
  $('#kurlyVerifyBtn').addEventListener('click', verifyKurly);
  $('#kurlyDisconnectBtn').addEventListener('click', disconnectKurly);
  $('#logoutBtn').addEventListener('click', logout);
  $('#gotoConnectBtn').addEventListener('click', () => setTab('settings'));
  $('#installHintClose').addEventListener('click', () => {
    $('#installHint').hidden = true;
    localStorage.setItem('kurly.installHintDismissed', '1');
  });

  // 실행
  $('#runNowBtn').addEventListener('click', runNow);
  $('#previewBtn').addEventListener('click', openPreview);
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
    if (!$('#addModal').hidden) closeAddModal();
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
