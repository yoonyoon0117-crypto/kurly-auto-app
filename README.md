# 🛒 컬리 정기 장바구니 (kurly-auto-app)

[![tests](https://github.com/yoonyoon0117-crypto/kurly-auto-app/actions/workflows/test.yml/badge.svg)](https://github.com/yoonyoon0117-crypto/kurly-auto-app/actions/workflows/test.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

마켓컬리에서 **2주마다 정해진 요일·시각에, 2주 소비량만큼만 장바구니에 담아주는** 웹 앱입니다.
이번 버전은 **여러 명(초대받은 지인)이 각자 계정으로 쓰는 PWA**이고, **도커로 작은 클라우드 서버에 올려
아이폰 "홈 화면에 추가"로 앱처럼** 쓸 수 있게 만든 버전입니다.

> ⚠️ **담기만 합니다. 주문·결제는 절대 하지 않습니다.**
> 결제는 언제나 직접 컬리 앱/웹에서 장바구니를 확인하고 진행하세요.
>
> ⚠️ 컬리 웹 화면을 브라우저 자동화(Playwright)로 조작합니다. 컬리 공식 API 가 아니므로
> 화면이 바뀌면 선택자를 고쳐야 할 수 있고, 계정 이용 정책에 따라 제한될 수 있습니다.
> **본인 계정, 소규모 지인용**으로만 쓰세요.

---

## 화면 미리보기 (아이폰 390×844)

<img src="docs/screens/03-plan-starter-items-390x844.png" width="250" alt="계획 탭 — 기본 4개 상품과 다음 정기 실행">
<img src="docs/screens/09-run-tab-390x844.png" width="250" alt="실행 탭 — 지금 담기·미리보기·실행 기록">
<img src="docs/screens/10-settings-390x844.png" width="250" alt="설정 탭 — 정기 실행과 컬리 계정 연결">

왼쪽부터 **계획 탭**(기본 4개 상품·예상 금액·다음 정기 실행) · **실행 탭**(지금 담기·미리보기·실행 기록) ·
**설정 탭**(주기·요일·시각, 컬리 계정 연결). 모두 테스트 계정(`앰버`)으로 찍은 화면입니다.

---

## 1. 이번 버전에서 달라진 점

이 저장소는 초대받은 지인들이 **각자 계정으로 쓰는 멀티유저 PWA(v2)** 입니다.
처음에 만든 1인용 버전(내 컴퓨터에서만 돌던 스크립트)과 비교하면 다음과 같습니다.

| | 1인용 버전(초기) | 이 버전(`kurly-auto-app` v2) |
|---|---|---|
| 사용자 | 1명 (내 컴퓨터) | 여러 명 (초대 코드 + 닉네임/비밀번호) |
| 데이터 | `config/cart-plan.json` 한 파일 | `DATA_DIR/users/{userId}.json` 사용자별 완전 분리 |
| 컬리 로그인 | 내 컴퓨터의 세션 파일 | 사용자마다 화면에서 연결 → 세션을 **AES-256-GCM** 으로 암호화해 보관 |
| 화면 | 데스크톱 웹 | **아이폰 우선 PWA** (홈 화면 추가, 오프라인 껍데기) |
| 정기 실행 | 내 PC에서 `npm run schedule` | 서버 안 **내장 스케줄러**(60초마다 점검, 동시 실행 1개 큐) |
| 배포 | 없음 | **Dockerfile + docker-compose** (Railway / Fly.io / Oracle Cloud) |
| 실행 기록·알림 | 파일 + 데스크톱 알림 | 사용자별 실행 기록 + **Slack/Discord/ntfy 웹훅** |

---

## 2. 5분 안에 로컬에서 실행

준비물: **Node.js 20 이상**, 인터넷.

```bash
cd kurly-auto-app
npm install
cp .env.example .env

# .env 를 열어 두 값을 꼭 바꾸세요
#   INVITE_CODE = 지인에게 알려줄 초대 코드 (예: kurly-2026)
#   APP_SECRET  = 세션·암호화 키, 16자 이상 (예: openssl rand -hex 32)

npx playwright install chromium   # 처음 한 번만 (약 150MB)
npm start
```

→ 브라우저에서 **http://localhost:3000** 접속 → 회원가입(초대 코드) → 사용.

> 로컬(`localhost`)은 HTTPS 없이도 동작합니다. 휴대폰에서 접속하려면 같은 Wi‑Fi 에서
> `http://내PC아이피:3000` 으로 열 수 있지만, **홈 화면 추가(standalone)와 서비스 워커는 HTTPS 에서만** 동작합니다.
> 아이폰에서 진짜 앱처럼 쓰려면 아래 7~8장(도커·클라우드)처럼 HTTPS 주소로 올리세요.

---

## 3. 사용 흐름 (아이폰 기준)

1. **회원가입** — 초대 코드 + 닉네임 + 비밀번호(6자 이상).
   가입할 때 **"기본 4개 상품으로 시작하기"** 를 체크하면 아래 4개가 바로 담깁니다.
   | 상품 | 상품번호 | 한 단위 | 2주 소비량 | 담을 수량 | 가격(2026-11-18 기준) |
   |---|---|---|---|---|---|
   | [Kurly's] 동물복지 유정란 15구 | 5029849 | 15구 | 30구 | 2팩 | 8,290원 |
   | 고랭지 햇사과 1.3kg (4~6입) | 5061259 | 1.3kg | 2.6kg | 2봉 | 12,900원 |
   | [제각각] 다다기오이 5입 | 1002030322 | 5입 | 10입 | 2봉 | 5,990원 |
   | [자연실록] 무항생제 닭 다리살 500g | 5090273 | 500g | 1,000g | 2팩 | 10,396원 |
   합계 예상 **75,152원**. 가격·재고는 컬리에서 수시로 바뀝니다.
   비워두고 직접 검색해 담아도 됩니다.
2. **계획 탭** — 상품 검색(실제 컬리 검색) → `계획에 추가` → 한 단위 크기와 **2주 소비량** 입력.
   `담을 수량 = 올림(2주 소비량 ÷ 한 단위)` 로 자동 계산됩니다. 수량을 직접 정하고 싶으면 `수량 직접`.
3. **설정 탭 → 컬리 계정 연결** — 컬리 아이디·비밀번호로 **한 번만** 연결.
4. **설정 탭 → 정기 실행** — 주기(기본 2주)·요일(기본 금요일)·시각(기본 21:00)·기준일(첫 실행일).
5. **알림(선택)** — Slack / Discord / ntfy 웹훅 주소를 넣으면 담기 결과가 전송됩니다.
6. **실행 탭 → 지금 담기** 로 미리 연습 → 컬리 앱에서 장바구니 확인 → 직접 결제.
7. **아이폰 홈 화면 추가** — Safari 로 접속 → 공유(⬆️) → **홈 화면에 추가**.
   이후에는 주소창 없는 전체 화면 앱으로 열립니다.

---

## 4. 수량 계산 규칙

```
담을 수량 = ceil(2주 소비량 ÷ 한 단위 크기)     (최소 1, 최대 99)
```

| 예시 | 계산 | 결과 |
|---|---|---|
| 계란 15구, 2주에 30구 | 30 ÷ 15 = 2 | 2팩 |
| 사과 1.3kg, 2주에 2.6kg | 2.6 ÷ 1.3 = 2 | 2봉 |
| 닭다리 500g, 2주에 700g | 1.4 → 올림 | 2팩 |

- 상품마다 단위를 하나 고릅니다(예: `g`, `kg`, `구`, `입`, `ml`, `개`).
- **포함** 토글을 끄면 그 상품은 자동 실행에서 빠집니다.
- 옵션이 여러 개인 상품은 추가할 때 옵션을 고르고, 그 옵션으로 담습니다.

---

## 5. 정기 실행 방식 (2주 주기)

- **기준일(anchorDate)부터 정확히 주기(기본 14일) 간격**입니다. "매월 1·3주 금요일" 같은 달력 규칙이 아니라
  14일 주기가 계속 유지됩니다.
- 서버 안 스케줄러가 **60초마다** 사용자별로 실행 시점인지 확인합니다.
- 실행 시각이 지난 뒤 **6시간 안**(`RUN_GRACE_HOURS`)이면 따라잡습니다. 서버가 잠깐 재시작돼도 놓치지 않습니다.
- **멱등성**: 슬롯마다 `기준일#회차` 키를 사용자 파일에 먼저 적고 큐에 넣습니다.
  같은 슬롯에서는 서버가 재시작되거나 점검이 겹쳐도 **한 번만** 담습니다.
- **동시 실행 1개**: 어떤 사용자의 작업이든 큐에 줄을 서서 하나씩 실행합니다.
  512MB~1GB 컨테이너에서 Chromium 이 여러 개 떠 OOM 나는 것을 막기 위해서입니다.
- 서버가 꺼져 있으면 실행되지 않습니다 → **항상 켜져 있는 클라우드 서버**에 올리세요(7~8장).
- 예약만 되고 실행 기록이 없으면(큐를 처리하기 전에 서버가 재시작된 경우) 다음 점검에서 **자동으로 다시 예약**합니다.

---

## 6. 컬리 계정 연결의 원리와 한계

1. 설정 탭에서 컬리 아이디·비밀번호를 입력하면 서버가 Playwright 로 컬리 로그인을 시도합니다.
2. 로그인에 성공하면 브라우저의 **로그인 세션(storageState: 쿠키·로컬스토리지)** 만 받아
   **AES-256-GCM**(키는 `APP_SECRET` 에서 유도)으로 암호화해 그 사용자 파일에 저장합니다.
3. **비밀번호는 저장하지 않습니다.** 저장 직후 메모리에서도 버립니다.
4. 이후 자동 실행은 이 세션으로 로그인 화면을 건너뜁니다.

한계와 주의:

- **세션은 몇 주 지나면 만료됩니다.** 그러면 실행 탭 배지가 `만료됨` 으로 바뀌고 실행 결과에
  "다시 연결해 주세요"가 남습니다. 설정에서 다시 연결하면 됩니다.
- **카카오·네이버 간편로그인만 쓰는 계정**은 아이디·비밀번호가 없어 이 방식으로 연결할 수 없습니다.
  컬리에 아이디/비밀번호 로그인을 함께 설정해 두어야 합니다.
- **해외·클라우드 서버 IP에서는 컬리의 봇 차단에 걸려, 비밀번호가 맞아도 "아이디 또는 비밀번호를 확인해주세요"(HTTP 422 · S001)로 거절될 수 있습니다.**
  2026-11-19 실제 확인: 로그인 화면에는 구글 reCAPTCHA Enterprise(보이지 않는 방식)가 붙어 있고, 로그인 응답에도 `isCaptchaRequired: true`가 함께 옵니다.
  이때 앱은 일반 문구 대신 **컬리가 실제로 돌려준 HTTP 상태·errorCode·안내 문구**를 설정 화면과 알림에 그대로 표시합니다(예: `컬리가 로그인을 거부했습니다 — "아이디 또는 비밀번호를 확인해주세요." (HTTP 422 · S001)`).
- **로그인 시 보안문자·추가 인증**이 뜨면 자동 로그인이 실패할 수 있습니다. 잠시 후 다시 시도하거나,
  컬리 앱에서 로그인 확인 후 다시 연결해 보세요.
- `APP_SECRET` 을 바꾸면 **모든 로그인 세션과 저장된 컬리 세션이 무효**가 됩니다(다시 연결 필요).
- 실행 중 로그인이 풀리면 그 실행은 중단되고 나머지 상품은 `건너뜀` 으로 기록됩니다.
- 한 번 실행할 때 상품마다 상품 페이지를 열어 옵션·수량을 고르고 담습니다(상품 4개면 1~2분).

---

## 7. Docker 로 실행

```bash
cd kurly-auto-app
cp .env.example .env      # INVITE_CODE, APP_SECRET 채우기
docker compose up -d --build
docker compose logs -f    # 로그 보기 (Ctrl+C 로 빠져나옴)
```

- 접속: **http://서버주소:3000**
- 사용자 데이터는 `./data` 볼륨에 남습니다. 컨테이너를 새로 만들어도 유지됩니다.
- 이미지: `mcr.microsoft.com/playwright:v1.65.1-jammy` (amd64·arm64 모두 지원, Chromium 포함)

자주 쓰는 명령:

```bash
docker compose ps                  # 상태
docker compose restart             # 재시작
docker compose down                # 중지 (데이터는 유지)
docker compose up -d --build       # 코드 수정 후 재빌드
docker compose exec kurly-auto-app npm test    # 컨테이너 안에서 테스트
```

**백업**: `data/` 폴더와 `.env` 의 `APP_SECRET` 을 함께 보관하세요.
`APP_SECRET` 이 없으면 백업한 컬리 세션을 복호화할 수 없습니다.

**업데이트**: 코드를 바꾼 뒤 `docker compose up -d --build`. `data/` 는 그대로입니다.

---

## 8. 클라우드 배포

### 8-1. Railway (가장 쉬움)

1. 이 폴더를 GitHub 저장소에 올립니다(`data/`, `.env` 는 `.gitignore` 로 제외됨).
2. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → 저장소 선택.
   Dockerfile 을 자동으로 인식합니다.
3. **Variables** 에 추가:
   - `INVITE_CODE` = 원하는 초대 코드
   - `APP_SECRET` = `openssl rand -hex 32` 결과
   - `DATA_DIR` = `/data`
   - (`PORT` 는 Railway 가 자동으로 넣어주며 앱이 그 값을 따릅니다)
4. **Volumes → Add Volume**, mount path **`/data`** (1GB면 충분).
5. **Settings → Networking → Generate Domain** → 나온 `https://...up.railway.app` 주소로 접속.
6. 아이폰 Safari 로 열고 **홈 화면에 추가**.

> 재배포해도 볼륨(`/data`)은 유지됩니다. 단, 볼륨을 지우면 사용자·컬리 연결이 모두 사라집니다.

### 8-2. Fly.io

```bash
fly auth login
cd kurly-auto-app
fly launch --no-deploy        # Dockerfile 감지, 앱 이름·지역(예: nrt) 선택
fly volumes create kurly_data --size 1 --region nrt
fly secrets set INVITE_CODE=내초대코드 APP_SECRET=$(openssl rand -hex 32)
fly deploy
```

`fly.toml` 은 아래처럼 맞춰 주세요(특히 **auto_stop_machines = false**, **머신 1대**):

```toml
app = "내-앱-이름"
primary_region = "nrt"

[build]

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false     # 정기 실행 시각에 서버가 잠들면 안 됩니다
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  memory = "1gb"
  cpu_kind = "shared"
  cpus = 1

[mounts]
  source = "kurly_data"
  destination = "/data"
```

- `auto_stop_machines = true` 면 트래픽이 없을 때 머신이 꺼져 **정기 실행을 놓칩니다.**
- 머신을 2대 이상으로 늘리면 스케줄러가 중복 실행될 수 있습니다. **1대**로 두세요.
- 주소: `https://내-앱-이름.fly.dev`

### 8-3. Oracle Cloud Always Free

1. **인스턴스 만들기**: Compute → Instance.
   - 이미지: Ubuntu 22.04 (또는 24.04)
   - Shape: **VM.Standard.A1.Flex (Ampere, arm64)** — Always Free 로 4 OCPU/24GB 가능. **권장**
     (AMD `VM.Standard.E2.1.Micro` 1GB 는 Chromium 에 빠듯합니다.)
2. SSH 접속 후 Docker 설치:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER
# 다시 로그인(또는 newgrp docker)
```

3. 앱 올리기 (git 또는 scp):

```bash
git clone <내-저장소> kurly-auto-app && cd kurly-auto-app
cp .env.example .env
nano .env            # INVITE_CODE, APP_SECRET
docker compose up -d --build
```

4. **포트 열기**
   - Oracle 콘솔: VCN → Security Lists → Default Security List → **Ingress Rule 추가**
     `0.0.0.0/0`, TCP, 목적지 포트 `80,443` (테스트용으로 `3000` 도)
   - Ubuntu 방화벽을 켰다면: `sudo ufw allow 80,443/tcp`

5. **HTTPS (아이폰 PWA·보안 쿠키에 필수)** — 무료 도메인(DuckDNS 등) + Caddy:

```bash
# DuckDNS 에서 서브도메인 발급 후 공인 IP 등록 (예: mykurly.duckdns.org)
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
mykurly.duckdns.org {
    reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl restart caddy
```

6. `https://mykurly.duckdns.org` 접속 → 회원가입 → **홈 화면에 추가**.
   Caddy 가 `X-Forwarded-Proto: https` 를 보내므로 세션 쿠키가 자동으로 `Secure` 로 설정됩니다.

### 배포 공통 체크리스트

- [ ] `INVITE_CODE` 를 추측하기 어렵게 (지인에게만 공유)
- [ ] `APP_SECRET` 16자 이상, 절대 외부 노출 금지
- [ ] **HTTPS** (홈 화면 추가·서비스 워커·Secure 쿠키)
- [ ] **컨테이너·머신 1대** (스케줄러 중복 방지)
- [ ] `data/` 볼륨 + `APP_SECRET` 함께 백업
- [ ] 메모리 **1GB 권장** (512MB 도 단일 실행은 가능하지만 빠듯)
- [ ] 서버 시간대와 무관하게 동작합니다(앱이 Asia/Seoul 기준으로 계산).

---

## 9. 아이폰 "홈 화면에 추가"

1. **Safari** 로 사이트 접속 (크롬 앱에서는 홈 화면 추가가 제한적입니다)
2. 하단 **공유** 버튼 → 아래로 스크롤 → **홈 화면에 추가**
3. 이름 확인 → **추가**
4. 홈 화면 아이콘으로 실행 → 주소창 없는 전체 화면(standalone)

- 앱 첫 화면에 iOS 사용자에게만 "공유 → 홈 화면에 추가" 안내가 뜹니다(닫으면 다시 안 뜸).
- 오프라인에서는 앱 껍데기(화면)만 열리고, 데이터는 서버 연결이 필요합니다.
- 아이폰 웹 푸시 알림은 이 버전에서 지원하지 않습니다. 알림은 **웹훅**(Slack/Discord/ntfy)으로 받으세요.

---

## 10. 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 서버 포트 (Railway 등은 자동 주입) |
| `INVITE_CODE` | 없음 | 회원가입 초대 코드. **비우면 신규 가입이 막힙니다.** |
| `APP_SECRET` | 없음 | 세션 서명 + 컬리 세션 암호화 키(16자 이상). 운영에서는 **필수** |
| `DATA_DIR` | `./data` | 사용자 데이터 위치. 도커에서는 `/data` |
| `SCHEDULER` | `on` | `off` 면 정기 실행 없이 수동 실행만 |
| `RUN_GRACE_HOURS` | `6` | 실행 시각이 지난 뒤 몇 시간까지 따라잡을지 |
| `SCHEDULER_INTERVAL_SECONDS` | `60` | 스케줄러 점검 주기 |
| `MAX_CONCURRENT_RUNS` | `1` | 동시에 띄울 브라우저 수 (작은 서버는 1 유지) |
| `COOKIE_SECURE` | `auto` | `auto` 면 `X-Forwarded-Proto`/HTTPS 를 따름 |
| `TRUST_PROXY` | `1` | 프록시 뒤에서 `X-Forwarded-For` 신뢰 |
| `REGISTER_RATE_LIMIT` | `20` | IP 당 시간당 가입 시도 제한 |
| `LOGIN_RATE_LIMIT` | `10` | IP+닉네임 당 15분 로그인 시도 제한 |
| `WEBHOOK_ALLOW_PRIVATE` | `0` | `1` 이면 localhost·내부망 웹훅 허용(기본은 SSRF 차단) |
| `BROWSER_ARGS` | `--disable-dev-shm-usage` | Chromium 추가 인자 |
| `BROWSER_NO_SANDBOX` | `0` | `1` 이면 `--no-sandbox` (일부 호스팅 환경) |
| `BROWSER_TIMEOUT_MS` | `20000` | 브라우저 기본 타임아웃 |
| `LOG_REQUESTS` | `0` | `1` 이면 요청 로그 기록 |
| `NODE_ENV` | — | `production` 이면 `APP_SECRET` 없이 시작 불가 |

---

## 11. 폴더 구조

```
kurly-auto-app/
├── server.js                # HTTP 서버 + API + 정적 파일(PWA)
├── lib/
│   ├── env.js               # .env 로더
│   ├── paths.js             # DATA_DIR 등 경로
│   ├── http.js              # JSON·쿠키·정적파일·보안 헤더
│   ├── passwords.js         # scrypt 해시(사용자별 salt)
│   ├── sessions.js          # HMAC 서명 세션 쿠키 + sessionEpoch
│   ├── crypto-box.js        # AES-256-GCM (컬리 세션 암호화)
│   ├── store.js             # 사용자별 JSON 원자적 저장·직렬화 쓰기
│   ├── plan.js              # 수량 계산·2주 주기·다음 실행·due 계산
│   ├── kurly-api.js         # 컬리 검색/상품 상세 (읽기 전용)
│   ├── kurly-browser.js     # Playwright 로그인·옵션선택·담기·장바구니 확인
│   ├── runner.js            # 실행 1회 오케스트레이션 + 기록
│   ├── queue.js             # 동시 1개 순차 큐
│   ├── scheduler.js         # 60초 점검 + 멱등 예약
│   ├── notify.js            # 웹훅(Slack/Discord/ntfy/generic)
│   ├── webhook-url.js       # 웹훅 주소 SSRF 검사
│   ├── seeds.js             # 기본 4개 상품
│   └── logger.js
├── public/                  # PWA 화면
│   ├── index.html · app.js · styles.css
│   ├── manifest.json · sw.js
│   └── icons/ (192·512·maskable·apple-touch)
├── test/                    # node:test (48개)
├── scripts/
│   ├── make-icons.mjs       # 아이콘 PNG 생성기 (외부 라이브러리 없음)
│   ├── ui-test.mjs          # iPhone 390×844 Playwright 점검·스크린샷
│   └── check-kurly-selectors.mjs  # 컬리 화면 선택자 진단(수동, 비회원 장바구니)
├── docs/screens/            # README 에 쓰는 화면 캡처 (아이폰 390×844)
├── .github/workflows/
│   └── test.yml             # GitHub Actions — push·PR 마다 단위 테스트
├── Dockerfile · docker-compose.yml · .dockerignore
├── .env.example · .gitignore · LICENSE
└── package.json
```

데이터(실행하면 생김):

```
data/
├── users-index.json         # 닉네임 ↔ userId
├── users/{userId}.json      # 계획·일정·알림·암호화된 컬리 세션·실행 기록 (권한 600)
└── logs/{날짜}.log
```

---

## 12. API 요약

모든 `/api/*` 는 `HttpOnly` 세션 쿠키가 필요합니다(공개: health, config, auth).

| 메서드 · 경로 | 설명 |
|---|---|
| `POST /api/auth/register` | `{inviteCode, nickname, password, loadStarter}` → 가입 + 로그인 |
| `POST /api/auth/login` | `{nickname, password}` |
| `POST /api/auth/logout` | 세션 무효화(모든 기기) |
| `GET /api/auth/session` | 로그인 상태(비로그인도 200, `user:null`) |
| `GET /api/auth/me` | 내 정보(비로그인 401) |
| `GET/POST /api/plan` | 내 계획 읽기/저장(검증 실패 400) |
| `POST /api/items/starter` | 기본 4개 상품 불러오기(중복 제외) |
| `GET /api/search?q=` | 실제 컬리 상품 검색 |
| `GET /api/product?no=` | 상품 상세(단위·옵션·품절) |
| `POST /api/kurly/connect` | `{kurlyId, kurlyPassword}` → 큐에서 로그인, 세션 암호화 저장 |
| `POST /api/kurly/verify` | 저장된 세션 유효성 확인 |
| `POST /api/kurly/disconnect` | 연결 해제(세션 삭제) |
| `GET /api/kurly/status` | 연결 상태(연결됨/만료됨/미연결) |
| `GET /api/cart/preview` | 무엇을 몇 개 담을지 계산만 |
| `POST /api/cart/run-now` | 지금 담기(큐) → `202 {job}` |
| `GET /api/runs?limit=` | 내 실행 기록 |
| `GET /api/status` | 다음 실행·큐 진행·컬리 상태 |
| `GET /api/health` | 상태 확인(도커 HEALTHCHECK) |

---

## 13. 보안·개인정보

- **비밀번호**: `crypto.scryptSync` + 사용자별 salt, `timingSafeEqual` 비교. 평문 저장 없음.
- **세션 쿠키**: HMAC-SHA256 서명, `HttpOnly`, `SameSite=Lax`, 30일, HTTPS 에서 `Secure`.
  로그아웃 시 `sessionEpoch` 를 올려 **이전 쿠키 전부 무효화**.
- **컬리 세션**: AES-256-GCM(IV·인증태그 포함), `APP_SECRET` 에서 유도한 키.
- **파일 권한** `600`, 임시 파일 → `rename` 원자적 쓰기, 사용자별 쓰기 직렬화(동시 갱신 유실 방지).
- **사용자 격리**: 다른 사용자의 계획·기록·세션에 접근하는 API 경로 없음(모든 조회가 세션 사용자 기준).
- **CSRF 보조**: 상태 변경 요청의 `Origin` 검사 + `SameSite=Lax` 쿠키.
- **레이트리밋**: 가입·로그인·컬리 연결 시도 제한.
- **CSP·nosniff·프레임 차단** 등 보안 헤더 기본 적용.
- **웹훅 SSRF 차단**: localhost·사설망·클라우드 메타데이터(169.254.169.254) 주소 기본 거부.
- 서버 운영자(=초대한 사람)는 `data/` 파일을 열람할 수 있습니다. **지인 소규모용**으로만 운영하세요.
- 알림에는 상품명·수량·금액만 담기며 계정 정보는 보내지 않습니다.

---

## 14. 테스트 · 검증 결과 (2026-11-19, 실제 실행)

### `npm test` — 48개 통과 (실패 0, 건너뜀 0)

| 영역 | 확인한 내용 |
|---|---|
| 수량·일정 계산 | 올림 계산, 최소 1/최대 99, 2주 간격 다음 실행, 기준일·요일 기본값, 요약 금액 |
| 실행 창·멱등성 | 실행 시각 ±, 6시간 유예, 14일 뒤 새 슬롯, 꺼진 일정·미래 기준일 제외 |
| 스케줄러 | 같은 슬롯 반복 점검에도 1회만 예약, 사용자 여러 명 동시 예약, 멱등 키 저장 |
| 큐 | 순차 실행(동시 1), 진행 메시지, 작업 실패 격리, `dedupeKey` 중복 방지 |
| 저장소 | 원자적 쓰기, 20개 동시 갱신 유실 없음, 파일 권한 600 |
| 보안 | scrypt 해시/검증, 세션 HMAC 위조·만료, AES-256-GCM 변조·다른 키 거부 |
| 인증 API | 초대 코드 오류 403, 짧은 비밀번호·잘못된 닉네임 400, 중복 닉네임 409, 로그인 401/200, 로그아웃 후 401, 변조 쿠키 401 |
| 격리 | A 의 계획·기록이 B 에게 안 보임, 사용자 파일 분리, 평문 비밀번호 없음 |
| 실행 API | 미연결 상태 실행 → 실패 기록, 중복 실행 409, 미리보기는 기록 없음 |
| 웹훅 | Slack/Discord/ntfy/generic 형식, 실제 로컬 수신, 문구(✅➕❌⏭·금액), SSRF 차단 |
| **실제 컬리** | `/api/search` 검색 24건 수신, `/api/product?no=5029849` → 유정란 15구·8,290원·15구 파싱 |
| **담기 동작(비회원)** | `node scripts/check-kurly-selectors.mjs` → 상품 페이지 열기 → **담기 성공(added)** → 장바구니 1건 확인 |
| PWA | 매니페스트·아이콘 PNG 크기·서비스 워커 범위·CSP·경로 탈출 차단 |

### `npm run test:ui` — iPhone 390×844, 34개 체크 전부 통과

가입(초대 코드) → 기본 4개 상품(수량 2개씩 자동) → 실제 컬리 검색 → 계획 추가 → 저장 →
**새로고침 후 5개 유지** → 미리보기 → 설정 기본값 → 서비스 워커 활성화 → **콘솔 오류 0건**.

스크린샷: README 에 쓰는 3장은 `docs/screens/` 에 있습니다. `npm run test:ui` 를 돌리면 단계별 01~11 캡처와
`ui-test-report.json` 이 생깁니다(기본 `../downloads/kurly-auto-app-screens/`, `SHOT_DIR=/원하는/경로` 로 바꿀 수 있음).

### GitHub Actions — push·PR 마다 자동 검사

`.github/workflows/test.yml` 이 Node 20 에서 `npm ci` 후 두 job 을 돌립니다.

| job | 내용 | CI 통과 조건 |
|---|---|---|
| 단위·API 테스트 | `npm run test:unit` — 45개, 실제 컬리 접속 없음 | **필수** (실패하면 빨간불) |
| 실제 컬리 연결 점검 | `npm run test:live` — 3개, 실제 컬리 검색·상품 상세 | 정보용 — 컬리 쪽 차단·점검으로 실패해도 CI 는 통과하되 로그에 그대로 남음 |

> 실제 컬리 점검은 컬리 서버 사정(해외 IP 차단·점검)에 좌우되므로 필수 조건에서 빼두었습니다.
> 대신 `npm test` 는 로컬에서 두 묶음을 모두 돌립니다(48개).

### 아직 확인하지 못한 것 (정직하게)

- **실제 컬리 계정 로그인**: 이 작업 환경에 컬리 계정이 없어 **로그인까지는** 실행하지 못했습니다.
  다만 담기 쪽은 2026-11-19 실제 컬리에서 다시 확인했습니다 —
  `scripts/check-kurly-selectors.mjs` 로 상품 페이지 → 담기 → 장바구니 1건 확인(비회원 장바구니).
  로그인 화면 선택자(`input[name=id]`, `input[name=password]`, `로그인` 버튼)는 기존 프로젝트에서 확인한 값입니다.
  계정을 연결한 뒤 실행 탭 **[지금 담기]** 로 한 번 확인해 주세요.
- **Docker 이미지 빌드**: 이 환경에는 Docker 가 없어 실제 빌드는 못 했습니다.
  공식 이미지 태그(`mcr.microsoft.com/playwright:v1.65.1-jammy`, amd64/arm64)가 존재하는 것과
  `package.json` 의 playwright 버전 일치(1.65.1)는 확인했습니다.
- **아이폰 실기기**: Playwright 의 iPhone 뷰포트로 확인했고, 실제 Safari 홈 화면 추가는 직접 해보셔야 합니다.

---

## 15. 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| `APP_SECRET 이 없습니다` 로 시작 실패 | 운영(`NODE_ENV=production`)에서는 필수. `.env` 에 16자 이상 넣기 |
| 가입이 안 됨 ("초대 코드가 설정되지 않아") | 서버 `.env` 의 `INVITE_CODE` 확인 후 재시작 |
| 초대 코드가 틀렸다고 나옴 | 대소문자·공백 포함 정확히 입력 (서버 값 그대로) |
| 로그인 만료 배지 | 설정 → 컬리 계정 다시 연결 |
| 연결 시 "추가 인증(보안문자)" | 컬리 앱에서 로그인 확인 후 잠시 뒤 재시도 |
| 연결 시 "컬리가 로그인을 거부했습니다 — 아이디 또는 비밀번호를 확인해주세요. (HTTP 422 · S001)" | 비밀번호가 맞아도 클라우드 서버 IP + 자동화 브라우저를 컬리 보안 서비스(reCAPTCHA)가 봇으로 판단하면 같은 문구가 나옵니다. (1) 아이디 형식(아이디 vs 이메일)·카카오/네이버 간편가입 계정 여부 확인 (2) 시크릿 창에서 같은 값으로 로그인되는지 확인 (3) 계속되면 집 PC에서 직접 실행하거나, 집 브라우저에서 로그인한 세션 쿠키를 옮겨 연결 |
| "옵션을 고르지 못했습니다" | 컬리 화면 개편. 상품을 다시 추가해 옵션명 갱신. `node scripts/check-kurly-selectors.mjs` 로 현재 화면 확인 |
| 담기 버튼을 찾지 못함 | 컬리 화면 개편 가능성. 같은 진단 스크립트를 실행해 어느 단계에서 멈추는지 확인 |
| 품절 상품 | 그 상품만 실패로 기록되고 나머지는 담깁니다. 계획에서 교체 |
| 정기 실행이 안 됨 | (1) 설정의 "정기 실행 사용" (2) 서버가 켜져 있는지 (3) 기준일·요일·시각 (4) Fly.io `auto_stop_machines=false` |
| 실행이 두 번 담김 | 서버·컨테이너를 2대 이상 띄우지 마세요 (스케줄러 중복) |
| 메모리 부족/OOM | `MAX_CONCURRENT_RUNS=1`, 메모리 1GB, `shm_size: 1gb` 유지 |
| 홈 화면 추가가 안 보임 | HTTPS + **Safari** 인지 확인 (크롬 앱은 제한) |
| 세션이 자꾸 풀림 | `APP_SECRET` 을 바꾸면 전부 무효. 서버를 여러 대로 늘리면 쿠키 서명은 같아도 `data` 공유 필요 |
| 웹훅이 안 옴 | 주소 형식, Slack/Discord 채널 권한. 로컬 주소면 `WEBHOOK_ALLOW_PRIVATE=1` |
| 데이터 초기화 | `data/` 폴더 삭제(모든 사용자·계획·연결 삭제). 되돌릴 수 없으니 백업 |

---

## 16. 장차 "일반 사용자용"으로 키우려면

지금 구조는 **지인 소규모**에 맞춰 파일 저장 + 단일 프로세스로 단순하게 만들었습니다.
사용자가 수백~수천 명이 되면 아래 순서로 바꾸는 것을 권합니다.

1. **DB**: `DATA_DIR/users/*.json` → **PostgreSQL**
   `users`, `plans`, `plan_items`, `kurly_sessions`, `runs`, `run_items` 테이블로 분리.
   JSON 컬럼 대신 정규화하면 통계·검색이 쉬워집니다.
2. **큐**: 내장 `JobQueue` → **Redis + BullMQ**
   재시도·우선순위·동시성·작업 유실 방지. 실행 워커를 별도 프로세스/컨테이너로 분리.
3. **스케줄러 분리**: 웹과 분리된 **단일 스케줄러** + DB 어드바이저리 락(또는 Redis 락)으로
   1대만 예약하도록. (지금은 파일의 `lastDueKey` 가 그 역할)
4. **세션 저장소**: 세션을 Redis/DB 로 옮기고 로테이션·강제 로그아웃 지원.
   컬리 세션 암호화 키는 KMS/Secrets Manager 로 관리하고 정기 교체.
5. **계정 기능**: 이메일 인증·비밀번호 재설정·2단계 인증, 초대 코드 대신 초대 링크/승인제.
6. **관측성**: 구조화 로그, Sentry, 실행 성공률·소요시간 메트릭, 실패 알림.
7. **비용·한도**: 사용자별 실행 횟수/상품 수 제한, 유료 플랜, 브라우저 워커 오토스케일.
8. **법적·정책**: 컬리 이용약관과 자동화 허용 범위 확인, 개인정보 처리방침, 탈퇴 시 데이터 삭제.
   (가능하면 컬리 공식 제휴/API 가 있는지 먼저 확인하세요.)
9. **모바일 앱(선택)**: PWA 로 충분하지만, iOS 푸시 알림이 필요하면 APNs 푸시를 붙인 래퍼 앱을 고려.

---

## 17. 라이선스·면책

**MIT License** (`LICENSE`) — Copyright (c) 2026 yoonyoon0117-crypto. 고치고, 나눠주고, 상업적으로 써도 됩니다.

개인용으로 만든 도구입니다. 컬리와 무관하며, 사용으로 인한 계정·주문·데이터 문제의 책임은 사용자에게 있습니다.
**주문·결제 기능은 없고, 앞으로도 넣지 않는 것을 권합니다.**
