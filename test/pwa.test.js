'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { setupEnv, startServer, request } = require('./helpers');

setupEnv();

let server;
test.before(async () => {
  server = await startServer();
});
test.after(async () => {
  await server.close();
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function pngSize(file) {
  const buf = fs.readFileSync(file);
  const signature = buf.subarray(0, 8).toString('hex');
  assert.equal(signature, '89504e470d0a1a0a', `${file} 은 PNG 여야 합니다.`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

test('앱 껍데기(/) — iOS PWA 메타 태그와 매니페스트 링크', async () => {
  const res = await request(server.baseUrl, '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.text, /<html lang="ko">/);
  assert.match(res.text, /<title>Cart helper🤍<\/title>/);
  assert.match(res.text, /rel="manifest" href="\/manifest.json\?v=2\.3\.10"/);
  assert.match(res.text, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(res.text, /apple-mobile-web-app-title" content="Cart helper🤍"/);
  assert.match(res.text, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon.png\?v=2\.3\.10"/);
  assert.match(res.text, /rel="icon" type="image\/png" sizes="192x192" href="\/icons\/icon-192.png\?v=2\.3\.10"/);
  // 로그인 화면 부제는 마켓 이름 없이
  assert.match(res.text, /1주에 한 번, 먹을 만큼만<br \/>장바구니에 담아둘게요\./);
  assert.match(res.text, /name="theme-color" content="#5F0080"/);
  assert.match(res.text, /viewport-fit=cover/);

  // 보안 헤더
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('PWA 매니페스트 — 설치 조건(이름·standalone·192/512 아이콘)', async () => {
  const res = await request(server.baseUrl, '/manifest.json');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const manifest = JSON.parse(res.text);
  assert.equal(manifest.name, 'Cart helper🤍');
  assert.equal(manifest.short_name, 'Cart helper🤍');
  assert.equal(manifest.lang, 'ko');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.theme_color, '#5F0080');
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'));
  assert.ok(sizes.includes('512x512'));
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
});

test('아이콘 PNG — 실제 크기와 파일 존재', async () => {
  const icon192 = pngSize(path.join(PUBLIC_DIR, 'icons', 'icon-192.png'));
  assert.equal(icon192.width, 192);
  assert.equal(icon192.height, 192);
  const icon512 = pngSize(path.join(PUBLIC_DIR, 'icons', 'icon-512.png'));
  assert.equal(icon512.width, 512);
  assert.equal(icon512.height, 512);
  const apple = pngSize(path.join(PUBLIC_DIR, 'icons', 'apple-touch-icon.png'));
  assert.equal(apple.width, 180);
  assert.equal(apple.height, 180);
  const maskable = pngSize(path.join(PUBLIC_DIR, 'icons', 'maskable-512.png'));
  assert.equal(maskable.width, 512);

  const served = await request(server.baseUrl, '/icons/icon-192.png');
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.ok(Number(served.headers.get('content-length')) > 1000);
});

test('캐시 버스터(?v=)가 붙은 아이콘·매니페스트 주소도 그대로 제공된다', async () => {
  const apple = await request(server.baseUrl, '/icons/apple-touch-icon.png?v=2.3.10');
  assert.equal(apple.status, 200);
  assert.match(apple.headers.get('content-type'), /image\/png/);
  assert.ok(Number(apple.headers.get('content-length')) > 1000);

  const manifest = await request(server.baseUrl, '/manifest.json?v=2.3.10');
  assert.equal(manifest.status, 200);
  const parsed = JSON.parse(manifest.text);
  assert.equal(parsed.name, 'Cart helper🤍');
});

test('서비스 워커 — 루트 범위로 제공되고 API 는 캐시하지 않는다', async () => {
  const res = await request(server.baseUrl, '/sw.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(res.headers.get('service-worker-allowed'), '/');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.text, /addEventListener\('install'/);
  assert.match(res.text, /url\.pathname\.startsWith\('\/api\/'\)/);
});

test('API 응답은 캐시 금지, 정적 파일은 캐시 허용', async () => {
  const health = await request(server.baseUrl, '/api/health');
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const css = await request(server.baseUrl, '/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('cache-control'), /max-age/);
});

test('경로 탈출·없는 파일 처리', async () => {
  const escape = await request(server.baseUrl, '/%2e%2e%2fserver.js');
  assert.ok([403, 404].includes(escape.status), '상위 경로로 나갈 수 없어야 합니다.');
  assert.ok(!String(escape.text).includes('createApp'));

  const missing = await request(server.baseUrl, '/nope.js');
  assert.equal(missing.status, 404);

  const spa = await request(server.baseUrl, '/some/deep/link');
  assert.equal(spa.status, 200);
  assert.match(spa.text, /정기 장바구니/);
});
