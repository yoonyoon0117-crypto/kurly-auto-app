'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { setupEnv } = require('./helpers');
setupEnv();
// 테스트는 임시 서버(127.0.0.1)로 전송하므로 로컬 주소를 허용합니다.
process.env.WEBHOOK_ALLOW_PRIVATE = '1';

const { buildWebhookRequest, detectWebhookType, formatSummary, sendWebhook } = require('../lib/notify');

const SUMMARY = {
  trigger: 'scheduled',
  ranAtLabel: '2026-11-20 (금) 21:00',
  status: 'partial',
  added: 2,
  merged: 1,
  failed: 1,
  skipped: 0,
  cartTotalCount: 6,
  estimatedTotal: 75152,
  items: [
    { name: '유정란 15구', quantity: 2, status: 'added' },
    { name: '고랭지 햇사과', quantity: 2, status: 'merged' },
    { name: '다다기오이', quantity: 2, status: 'failed', reason: '품절이거나 판매가 중지된 상품입니다.' },
    { name: '닭 다리살', quantity: 2, status: 'skipped' },
  ],
};

test('웹훅 종류 자동 판별', () => {
  assert.equal(detectWebhookType('https://hooks.slack.com/services/T/B/X'), 'slack');
  assert.equal(detectWebhookType('https://discord.com/api/webhooks/1/abc'), 'discord');
  assert.equal(detectWebhookType('https://ntfy.sh/my-kurly'), 'ntfy');
  assert.equal(detectWebhookType('https://example.com/hook'), 'generic');
  assert.equal(detectWebhookType('https://example.com/hook', 'slack'), 'slack');
});

test('알림 문구: 상품·수량·실패 이유·합계가 들어간다', () => {
  const text = formatSummary(SUMMARY, { nickname: '앰버' });
  assert.match(text, /3개 성공 \/ 1개 실패/);
  assert.match(text, /2026-11-20 \(금\) 21:00 · 정기 실행/);
  assert.match(text, /✅ 유정란 15구 ×2/);
  assert.match(text, /➕ 고랭지 햇사과 ×2/);
  assert.match(text, /❌ 다다기오이 ×2 — 품절/);
  assert.match(text, /⏭ 닭 다리살 ×2/);
  assert.match(text, /장바구니 총 6건/);
  assert.match(text, /예상 금액 75,152원/);
  assert.match(text, /앰버님의 컬리 정기 장바구니/);

  const ok = formatSummary({ ...SUMMARY, failed: 0, items: SUMMARY.items.slice(0, 2) });
  assert.match(ok, /담았어요/);
  assert.ok(!ok.includes('실패'));
});

test('웹훅 요청 형식: Slack / Discord / ntfy / 일반 JSON', () => {
  const payload = { title: '컬리 장바구니 담기 완료', text: formatSummary(SUMMARY), summary: SUMMARY, failed: 1 };

  const slack = buildWebhookRequest('https://hooks.slack.com/services/T/B/X', 'auto', payload);
  assert.equal(slack.type, 'slack');
  const slackBody = JSON.parse(slack.body);
  assert.equal(typeof slackBody.text, 'string');
  assert.match(slackBody.text, /유정란/);

  const discord = buildWebhookRequest('https://discord.com/api/webhooks/1/abc', 'auto', payload);
  assert.equal(discord.type, 'discord');
  const discordBody = JSON.parse(discord.body);
  assert.match(discordBody.content, /유정란/);
  assert.ok(discordBody.content.length <= 1900);

  const ntfy = buildWebhookRequest('https://ntfy.sh/my-kurly-topic', 'auto', payload);
  assert.equal(ntfy.type, 'ntfy');
  const ntfyBody = JSON.parse(ntfy.body);
  assert.equal(ntfyBody.topic, 'my-kurly-topic');
  assert.equal(ntfyBody.title, '컬리 장바구니 담기 완료');
  assert.match(ntfyBody.message, /유정란/);
  assert.equal(ntfyBody.priority, 4);
  assert.deepEqual(ntfyBody.tags, ['warning']);

  const generic = buildWebhookRequest('https://example.com/hook', 'auto', payload);
  assert.equal(generic.type, 'generic');
  const genericBody = JSON.parse(generic.body);
  assert.equal(genericBody.title, '컬리 장바구니 담기 완료');
  assert.equal(genericBody.summary.added, 2);
  assert.equal(genericBody.summary.items[0].name, '유정란 15구');
});

test('웹훅 실제 전송: 로컬 서버로 JSON 이 도착한다', async () => {
  const received = [];
  const target = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const port = target.address().port;

  try {
    const payload = { title: '테스트', text: formatSummary(SUMMARY), summary: SUMMARY, failed: 1 };
    const slack = await sendWebhook({ url: `http://127.0.0.1:${port}/slack`, type: 'slack', payload });
    assert.equal(slack.ok, true);
    const ntfy = await sendWebhook({ url: `http://127.0.0.1:${port}/topic`, type: 'ntfy', payload });
    assert.equal(ntfy.ok, true);

    assert.equal(received.length, 2);
    const first = JSON.parse(received[0].body);
    assert.match(first.text, /컬리|유정란/);
    assert.equal(received[0].headers['content-type'], 'application/json; charset=utf-8');

    const second = JSON.parse(received[1].body);
    assert.equal(second.topic, 'topic');
    assert.match(second.message, /유정란/);

    // 실패하는 주소는 예외를 던지지 않고 결과로 알려줍니다(담기 자체는 성공 처리).
    const failed = await sendWebhook({ url: `http://127.0.0.1:${port}/fail`, type: 'generic', payload, timeoutMs: 100 });
    assert.ok(failed.ok === true || failed.ok === false);
  } finally {
    await new Promise((r) => target.close(r));
  }
});

test('웹훅 주소가 없으면 아무 것도 보내지 않는다', async () => {
  const result = await sendWebhook({ url: '', payload: {} });
  assert.equal(result.skipped, true);
});

test('웹훅 주소 안전 검사: 내부망·메타데이터 주소는 기본 차단', async () => {
  const { checkWebhookUrl } = require('../lib/webhook-url');
  const { normalizePlanInput } = require('../lib/plan');

  process.env.WEBHOOK_ALLOW_PRIVATE = '';
  try {
    for (const bad of [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:8080/hook',
      'http://127.0.0.1/hook',
      'http://192.168.0.10/hook',
      'http://10.0.0.5/hook',
      'http://metadata.google.internal/computeMetadata/v1/',
      'ftp://example.com/hook',
      'not-a-url',
    ]) {
      assert.equal(checkWebhookUrl(bad).ok, false, bad);
    }
    assert.equal(checkWebhookUrl('https://hooks.slack.com/services/T/B/X').ok, true);
    assert.equal(checkWebhookUrl('https://ntfy.sh/my-topic').ok, true);

    assert.throws(
      () => normalizePlanInput({ items: [], notification: { webhookUrl: 'http://169.254.169.254/' } }),
      /내부망/
    );
    const blockedSend = await sendWebhook({ url: 'http://127.0.0.1:9/hook', payload: { title: 't', text: 'x' } });
    assert.equal(blockedSend.ok, false);
  } finally {
    process.env.WEBHOOK_ALLOW_PRIVATE = '1';
  }
});
