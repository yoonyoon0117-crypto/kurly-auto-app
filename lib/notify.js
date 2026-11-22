'use strict';
/**
 * 실행 결과 웹훅 알림 — Slack / Discord / ntfy / 일반 JSON 자동 판별.
 * 서버(도커)에서 도는 앱이라 데스크톱 알림은 없고, 웹훅 + 앱 안의 실행 기록으로 알립니다.
 * 웹훅이 실패해도 담기 자체는 실패로 처리하지 않습니다.
 */
const WON = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;
const { checkWebhookUrl } = require('./webhook-url');

const STATUS_MARK = {
  added: '✅',
  merged: '➕',
  planned: '•',
  skipped: '⏭',
  failed: '❌',
};

function statusHeadline(summary) {
  if (summary.dryRun) return `🧪 [미리보기] 컬리 장바구니 ${summary.items.length}개 상품 계산 결과`;
  if (summary.error) return '⚠️ 컬리 장바구니 자동 담기를 마치지 못했어요';
  if (summary.failed > 0) return `⚠️ 컬리 장바구니 담기 ${summary.added + summary.merged}개 성공 / ${summary.failed}개 실패`;
  const count = summary.added + summary.merged;
  return `🛒 컬리 장바구니에 ${count}개 상품을 담았어요`;
}

/** Slack/Discord/ntfy/일반 모두에 쓸 수 있는 한국어 요약 텍스트 */
function formatSummary(summary, { nickname } = {}) {
  const lines = [statusHeadline(summary)];
  const triggerLabel = summary.trigger === 'scheduled' ? '정기 실행' : '직접 실행';
  lines.push(`실행: ${summary.ranAtLabel} · ${triggerLabel}`);
  if (summary.error) lines.push(`⚠️ ${summary.error}`);
  for (const item of summary.items || []) {
    const mark = STATUS_MARK[item.status] || '•';
    const qty = item.quantity ? ` ×${item.quantity}` : '';
    const reason = item.reason ? ` — ${item.reason}` : '';
    const marketTag = item.market === 'oasis' ? '[오아시스] ' : '';
    lines.push(`${mark} ${marketTag}${item.name}${qty}${reason}`);
  }
  if (typeof summary.cartTotalCount === 'number') lines.push(`장바구니 총 ${summary.cartTotalCount}건`);
  if (summary.estimatedTotal) lines.push(`예상 금액 ${WON(summary.estimatedTotal)}`);
  if (summary.checklistMode || summary.status === 'checklist') {
    lines.push('앱의 실행 탭 [컬리에서 열기]·[오아시스에서 열기] 목록에서 하나씩 담아 주세요.');
  }
  if (nickname) lines.push(`— ${nickname}님의 컬리 정기 장바구니`);
  return lines.join('\n');
}

function detectWebhookType(url, requested = 'auto') {
  if (requested && requested !== 'auto') return requested;
  const u = String(url);
  if (/hooks\.slack\.com/.test(u)) return 'slack';
  if (/discord(app)?\.com\/api\/webhooks/.test(u)) return 'discord';
  if (/ntfy\./i.test(u)) return 'ntfy';
  return 'generic';
}

function ntfyTopic(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length ? decodeURIComponent(parts[parts.length - 1]) : '';
  } catch {
    return '';
  }
}

function truncate(text, max) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * 웹훅 종류에 맞는 요청(헤더+본문)을 만듭니다. (테스트에서 그대로 검사)
 * @returns {{headers:object, body:string, type:string}}
 */
function buildWebhookRequest(url, type, { title, text, summary, failed = 0 }) {
  const resolved = detectWebhookType(url, type);
  if (resolved === 'slack') {
    return {
      type: resolved,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: truncate(text, 3900) }),
    };
  }
  if (resolved === 'discord') {
    return {
      type: resolved,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ content: truncate(text, 1900) }),
    };
  }
  if (resolved === 'ntfy') {
    // ntfy 는 JSON 게시를 지원합니다. 한글 제목을 HTTP 헤더에 넣지 않아도 됩니다.
    const payload = {
      topic: ntfyTopic(url),
      title,
      message: truncate(text, 3800),
      priority: failed > 0 ? 4 : 3,
      tags: failed > 0 ? ['warning'] : ['shopping_cart'],
    };
    return {
      type: resolved,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    };
  }
  return {
    type: 'generic',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      title,
      text,
      summary: summary
        ? {
            status: summary.status,
            trigger: summary.trigger,
            ranAt: summary.ranAtLabel,
            added: summary.added,
            merged: summary.merged,
            failed: summary.failed,
            cartTotalCount: summary.cartTotalCount,
            estimatedTotal: summary.estimatedTotal,
            items: (summary.items || []).map((i) => ({
              name: i.name,
              quantity: i.quantity,
              status: i.status,
              reason: i.reason || null,
            })),
          }
        : undefined,
    }),
  };
}

async function sendWebhook({ url, type = 'auto', payload, timeoutMs = 10000 }) {
  if (!url) return { skipped: true };
  const checked = checkWebhookUrl(url);
  if (!checked.ok) return { ok: false, error: checked.reason, type: detectWebhookType(url, type) };
  const request = buildWebhookRequest(url, type, payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, type: request.type, request };
  } catch (err) {
    return {
      ok: false,
      type: request.type,
      error: err.name === 'AbortError' ? '시간 초과' : err.message,
      request,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 실행 요약을 사용자의 웹훅으로 보냅니다.
 * @param {object} summary 실행 요약
 * @param {{webhookUrl?:string, webhookType?:string}} notification 사용자 알림 설정
 */
async function notify(summary, notification = {}, logger = null, { nickname } = {}) {
  if (!notification.webhookUrl) return { webhook: null };
  const title = summary.failed > 0 || summary.error ? '컬리 장바구니: 확인이 필요해요' : '컬리 장바구니 담기 완료';
  const text = formatSummary(summary, { nickname });
  const result = await sendWebhook({
    url: notification.webhookUrl,
    type: notification.webhookType,
    payload: { title, text, summary, failed: summary.failed || 0 },
  });
  if (logger) {
    logger.info(
      result.ok
        ? `웹훅 전송 완료 (${result.type})`
        : `웹훅 전송 실패 (${result.type}): ${result.error || result.status}`
    );
  }
  return { webhook: result };
}

module.exports = { notify, formatSummary, buildWebhookRequest, sendWebhook, detectWebhookType, formatWon: WON };
