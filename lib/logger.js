'use strict';
/** 콘솔 + 파일 로그. 실행 기록은 DATA_DIR/logs/{YYYY-MM-DD}.log 에 쌓입니다. */
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('./paths');
const { formatKst } = require('./plan');

function createLogger(scope = 'app', { quiet = false } = {}) {
  const date = formatKst(Date.now()).slice(0, 10);
  const file = path.join(LOG_DIR, `${date}.log`);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* 로그 디렉터리를 못 만들어도 서비스는 계속 */
  }

  const write = (level, message) => {
    const line = `[${formatKst(Date.now())}] [${level}] [${scope}] ${message}`;
    if (!quiet) {
      const out = level === 'ERROR' || level === 'WARN' ? console.error : console.log;
      out(line);
    }
    try {
      fs.appendFileSync(file, `${line}\n`, 'utf8');
    } catch {
      /* 로그 파일 실패는 무시 */
    }
  };

  return {
    file,
    info: (m) => write('INFO', m),
    step: (m) => write('STEP', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}

module.exports = { createLogger, LOG_DIR };
