'use strict';
/**
 * .env 로더 (외부 패키지 없이 동작)
 * - KEY=VALUE 형식, # 주석, 앞뒤 따옴표 제거
 * - 이미 설정된 process.env 값은 덮어쓰지 않습니다.
 */
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');

function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** .env 를 읽어 process.env 에 채웁니다. 파일이 없으면 조용히 넘어갑니다. */
function loadEnv(filePath = path.join(APP_ROOT, '.env')) {
  if (!fs.existsSync(filePath)) return {};
  const parsed = parseEnv(fs.readFileSync(filePath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
  return parsed;
}

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(v).trim());
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

module.exports = { APP_ROOT, parseEnv, loadEnv, envBool, envInt };
