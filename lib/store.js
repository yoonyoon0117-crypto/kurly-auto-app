'use strict';
/**
 * 사용자 저장소 — DATA_DIR 아래에 사용자별 JSON 한 파일씩.
 *
 *   DATA_DIR/users-index.json        { version, users:[{userId,nickname,nicknameLower,createdAt,lastLoginAt}] }
 *   DATA_DIR/users/{userId}.json     그 사용자의 계획·실행 기록·암호화된 컬리 세션 전부
 *
 *  · 쓰기는 임시 파일 → rename 으로 원자적으로 바꿉니다(중간에 죽어도 파일이 깨지지 않음).
 *  · 같은 사용자에 대한 동시 쓰기는 큐로 직렬화해서 덮어쓰기 유실을 막습니다.
 *  · 파일 권한은 0600 (비밀번호 해시와 컬리 세션이 들어 있음).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, USERS_DIR, USERS_INDEX } = require('./paths');
const { normalizeSchedule, nextWeekdayDate } = require('./plan');
const { normalizeRecipes, normalizeRecipeSettings } = require('./recipes');

const MAX_RUN_HISTORY = 30;

function ensureDirs() {
  fs.mkdirSync(USERS_DIR, { recursive: true });
  if (!fs.existsSync(USERS_INDEX)) writeJsonAtomic(USERS_INDEX, { version: 1, users: [] });
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* 일부 파일시스템(윈도우 마운트)에서는 무시 */
  }
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore */
  }
}

/* ─────────────── 쓰기 직렬화 ─────────────── */

const locks = new Map();
function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {}).then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  locks.set(key, tail);
  return run;
}

/* ─────────────── 색인 ─────────────── */

function readIndexRaw() {
  ensureDirs();
  try {
    const json = JSON.parse(fs.readFileSync(USERS_INDEX, 'utf8'));
    if (!json || !Array.isArray(json.users)) return { version: 1, users: [] };
    return json;
  } catch {
    return { version: 1, users: [] };
  }
}

function readIndex() {
  return readIndexRaw().users;
}

function writeIndex(index) {
  writeJsonAtomic(USERS_INDEX, { version: 1, users: index });
}

/* ─────────────── 사용자 ─────────────── */

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{8,40}$/;
const NICKNAME_PATTERN = /^[0-9A-Za-z가-힣_.-]{2,20}$/;

function normalizeNickname(raw) {
  return String(raw ?? '').trim();
}

function nicknameKey(nickname) {
  return normalizeNickname(nickname).toLowerCase();
}

function validateNickname(nickname) {
  const n = normalizeNickname(nickname);
  if (!NICKNAME_PATTERN.test(n)) {
    throw Object.assign(
      new Error('닉네임은 한글·영문·숫자로 2~20자 (공백 없이, _ . - 사용 가능) 입력해 주세요.'),
      { status: 400 }
    );
  }
  return n;
}

function userFile(userId) {
  if (!USER_ID_PATTERN.test(String(userId || ''))) {
    throw Object.assign(new Error('사용자 식별자가 올바르지 않습니다.'), { status: 400 });
  }
  return path.join(USERS_DIR, `${userId}.json`);
}

function defaultUser({ userId, nickname, passwordHash, nowMs = Date.now() }) {
  const schedule = normalizeSchedule({}, nowMs);
  return {
    version: 2,
    userId,
    nickname,
    nicknameLower: nicknameKey(nickname),
    password: passwordHash,
    createdAt: nowMs,
    updatedAt: nowMs,
    lastLoginAt: nowMs,
    sessionEpoch: 1,
    schedule: { ...schedule, anchorDate: nextWeekdayDate(schedule.weekday, nowMs) },
    notification: { webhookUrl: '', webhookType: 'auto' },
    kurly: {
      status: 'disconnected', // disconnected | connected | expired
      account: null,
      connectedAt: null,
      lastVerifiedAt: null,
      lastError: null,
      session: null,
    },
    items: [],
    // 좋아하는 요리(메뉴)와 그 필수재료 — 요리 탭에서 관리합니다.
    recipes: [],
    recipeSettings: normalizeRecipeSettings(),
    // 컬리 로그인 없이 쓰는 장볼 목록 — 담음 체크(productNo→true)와 마지막 완료 시각
    checklist: { checked: {}, checkedAt: null, completedAt: null },
    // '목록 알림만 받기' — 정기 실행 때 담는 대신 장볼 목록 알림을 받습니다.
    checklistOnly: false,
    // 이 사용자의 기기별 웹 푸시 구독 (endpoint·keys·deviceLabel) — 다른 사용자와 완전히 분리
    pushSubscriptions: [],
    lastRunAt: null,
    lastDueKey: null,
    lastRunStatus: null,
    runHistory: [],
    stats: { runs: 0, added: 0, failed: 0 },
  };
}

/** 저장 파일이 조금 깨져 있어도 앱 전체가 멈추지 않도록 요리 목록만 비웁니다. */
function safeRecipes(raw) {
  if (raw === undefined || raw === null) return [];
  try {
    return normalizeRecipes(raw);
  } catch {
    return [];
  }
}

function safeChecklist(raw) {
  const { sanitizeChecked } = require('./checklist');
  return {
    checked: sanitizeChecked(raw?.checked),
    checkedAt: Number(raw?.checkedAt) || null,
    completedAt: Number(raw?.completedAt) || null,
  };
}

function hydrate(record) {
  if (!record || typeof record !== 'object') return null;
  const nowMs = Date.now();
  return {
    ...defaultUser({
      userId: record.userId,
      nickname: record.nickname,
      passwordHash: record.password,
      nowMs,
    }),
    ...record,
    schedule: normalizeSchedule(record.schedule, nowMs),
    notification: { webhookUrl: '', webhookType: 'auto', ...(record.notification || {}) },
    kurly: { status: 'disconnected', account: null, connectedAt: null, lastVerifiedAt: null, lastError: null, session: null, ...(record.kurly || {}) },
    items: Array.isArray(record.items) ? record.items : [],
    recipes: safeRecipes(record.recipes),
    recipeSettings: normalizeRecipeSettings(record.recipeSettings),
    checklist: safeChecklist(record.checklist),
    checklistOnly: record.checklistOnly === true,
    pushSubscriptions: Array.isArray(record.pushSubscriptions)
      ? record.pushSubscriptions.filter((s) => s && typeof s.endpoint === 'string' && s.keys && s.keys.p256dh && s.keys.auth)
      : [],
    runHistory: Array.isArray(record.runHistory) ? record.runHistory.slice(0, MAX_RUN_HISTORY) : [],
    stats: { runs: 0, added: 0, failed: 0, ...(record.stats || {}) },
  };
}

function getUser(userId) {
  try {
    const file = userFile(userId);
    if (!fs.existsSync(file)) return null;
    return hydrate(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function findIndexEntryByNickname(nickname) {
  const key = nicknameKey(nickname);
  return readIndex().find((u) => String(u.nicknameLower || u.nickname).toLowerCase() === key) || null;
}

function normalizeForDisk(user) {
  const copy = { ...user };
  delete copy.plainPassword;
  return copy;
}

function saveUser(user) {
  const record = { ...normalizeForDisk(user), updatedAt: Date.now() };
  writeJsonAtomic(userFile(record.userId), record);
  return record;
}

/** 새 사용자 생성 (닉네임 중복 검사 포함) */
function createUser({ nickname, passwordHash, nowMs = Date.now() }) {
  const name = validateNickname(nickname);
  return withLock(`index`, () => {
    const index = readIndexRaw().users;
    const lower = nicknameKey(name);
    if (index.some((u) => String(u.nicknameLower || u.nickname).toLowerCase() === lower)) {
      throw Object.assign(new Error('이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해 주세요.'), { status: 409 });
    }
    let userId = crypto.randomBytes(9).toString('base64url');
    while (fs.existsSync(userFile(userId))) userId = crypto.randomBytes(9).toString('base64url');

    const user = defaultUser({ userId, nickname: name, passwordHash, nowMs });
    saveUser(user);
    index.push({ userId, nickname: name, nicknameLower: lower, createdAt: nowMs, lastLoginAt: nowMs });
    writeIndex(index);
    return user;
  });
}

/**
 * 사용자 레코드를 읽어 mutator 로 고친 뒤 저장합니다.
 * 같은 사용자에 대한 동시 호출은 순서대로 처리됩니다.
 */
function updateUser(userId, mutator) {
  return withLock(`user:${userId}`, () => {
    const current = getUser(userId);
    if (!current) throw Object.assign(new Error('사용자를 찾을 수 없습니다.'), { status: 404 });
    const draft = JSON.parse(JSON.stringify(current));
    const result = mutator(draft);
    const next = result && typeof result === 'object' && result !== draft ? { ...draft, ...result } : draft;
    const saved = saveUser(next);
    return hydrate(saved);
  });
}

function touchLogin(userId, nowMs = Date.now()) {
  return withLock(`index`, () => {
    const index = readIndexRaw().users;
    const entry = index.find((u) => u.userId === userId);
    if (entry) {
      entry.lastLoginAt = nowMs;
      writeIndex(index);
    }
    return withLock(`user:${userId}`, () => {
      const user = getUser(userId);
      if (!user) return null;
      user.lastLoginAt = nowMs;
      return hydrate(saveUser(user));
    });
  });
}

function listUsers() {
  return readIndex()
    .map((entry) => getUser(entry.userId))
    .filter(Boolean);
}

function countUsers() {
  return readIndex().length;
}

/** 실행 결과를 사용자 기록에 남깁니다 (최근 30회 보관) — 푸시 결과(summary.push)도 함께 보관합니다. */
function recordRun(userId, summary) {
  const entry = { ...summary, push: summary.push ?? null };
  return updateUser(userId, (user) => {
    user.runHistory = [entry, ...(user.runHistory || [])].slice(0, MAX_RUN_HISTORY);
    user.lastRunAt = summary.ranAtMs;
    user.lastRunStatus = summary.status;
    user.stats = {
      runs: (user.stats?.runs || 0) + 1,
      added: (user.stats?.added || 0) + (summary.added || 0) + (summary.merged || 0),
      failed: (user.stats?.failed || 0) + (summary.failed || 0),
    };
    return user;
  });
}

module.exports = {
  MAX_RUN_HISTORY,
  ensureDirs,
  writeJsonAtomic,
  normalizeNickname,
  nicknameKey,
  validateNickname,
  defaultUser,
  getUser,
  saveUser,
  createUser,
  updateUser,
  touchLogin,
  listUsers,
  countUsers,
  recordRun,
  findIndexEntryByNickname,
  userFile,
  DATA_DIR,
};
