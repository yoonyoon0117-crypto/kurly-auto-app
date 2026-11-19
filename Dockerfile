# Playwright 공식 이미지를 그대로 씁니다 → 컨테이너 안에 Chromium 과 의존 라이브러리가 이미 설치되어 있습니다.
# package.json 의 playwright 버전(1.65.1)과 이미지 태그를 반드시 맞추세요.
FROM mcr.microsoft.com/playwright:v1.65.1-jammy

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# 의존성 먼저 (레이어 캐시)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 앱 코드
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY test ./test
COPY scripts ./scripts

# 데이터 폴더 권한 (이미지 기본 사용자 pwuser)
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app

USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 512MB 컨테이너에서도 Chromium 이 죽지 않도록 공유 메모리 대신 /tmp 사용
ENV BROWSER_ARGS="--disable-dev-shm-usage"

CMD ["node", "server.js"]
