# Moa Money

한국투자증권(KIS) Open API 기반의 국내·미국주식 자동매매 프로젝트입니다. Cloudflare 대시보드에서 국내/미국과 모의/실전을 선택하고, 주문 한도와 이동평균 교차 전략의 실행 상태를 확인합니다. Python 로컬 실행판은 국내 모의투자 전용입니다.

## 현재 기능

- KIS 모의투자 계좌 인증, 잔고 조회, 현재가 조회, 현금 주문
- 단기·장기 이동평균 골든크로스 매수 및 데드크로스 매도 전략
- Cloudflare 국내·미국주식 대시보드와 국내 모의투자 전용 로컬 대시보드
- 로컬 운영용 로그인 화면과 12시간 로그인 세션
- Cloudflare Access로 보호되는 Worker 배포
- Cloudflare 대시보드의 모의·실전 전환 버튼, 모드별 계좌와 일일 한도 분리, 실전 시작 확인
- 미국 NASDAQ·NYSE·AMEX 시세·잔고·매수가능수량·지정가 주문·체결 확인 (예: `NASD:AAPL, NYSE:IBM, AMEX:SPY`)
- 국내 원화 / 미국 달러 설정 분리. 미국은 뉴욕 정규장, 1달러 이상 종목·정수 수량 지원. 시장 하나씩 실행
- 해외 미체결·부분체결·응답 미확인 시 중지 및 재시작 차단. KIS 앱에서 체결·취소를 확인한 후 화면에서 확인 완료 처리
- 감시 종목, 1회·일일 매수 한도, 일일 주문 횟수, 이동평균 기간, 조회 주기 설정
- 대시보드 주문의 일일 매수 금액 및 주문 횟수 제한 (국내: 한국 자정, 미국: 뉴욕 자정)
- 실행 기록, 현재가, 보유 수량 확인

## 시작하기

Python 3.9 이상과 KIS Developers의 모의투자 App Key, App Secret, 모의투자 계좌가 필요합니다.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

`.env`에는 모의투자용 값을 입력하고 `TRADING_MODE=paper`를 유지합니다.

```dotenv
KIS_APP_KEY=
KIS_APP_SECRET=
KIS_ACCOUNT_NO=
KIS_ACCOUNT_PRODUCT_CD=01
TRADING_MODE=paper
DASHBOARD_USERNAME=owner
DASHBOARD_PASSWORD=16자_이상의_비밀번호
DASHBOARD_SESSION_SECRET=32자_이상의_무작위_문자열
```

`DASHBOARD_*` 값은 로컬에서는 선택 사항입니다. 세 값을 설정하면 로그인 화면이 활성화되며, 운영 환경에서는 모두 필수입니다. 세션 비밀값은 `python -c "import secrets; print(secrets.token_urlsafe(32))"`로 만들 수 있습니다.

웹 대시보드를 실행합니다.

```bash
python -m bot.dashboard
```

브라우저에서 `http://127.0.0.1:5000`을 열고 설정을 저장한 후 시작합니다. 이 대시보드는 실전투자 모드에서 실행을 차단합니다.

`일일 최대 매수 금액`은 매수 주문에만 적용되며, `일일 최대 주문 횟수`는 매수와 매도 모두에 적용됩니다. 주문 시도는 KIS 응답이 불확실해도 보수적으로 한도에 포함됩니다. 대시보드를 재시작해도 당일 집계는 유지됩니다.

## Cloudflare 배포

운영 환경은 Cloudflare Worker와 Durable Object를 사용합니다. Cloudflare에서는 자체 아이디·비밀번호 대신 허용된 이메일만 통과시키는 Cloudflare Access로 로그인합니다. KIS 비밀값 등록과 Access 설정은 [배포 안내](DEPLOYMENT.md)를 확인하세요.

국내 감시 종목은 이름이나 6자리 코드로 검색해 선택할 수 있습니다. 검색 목록은 KIS의 코스피·코스닥·코넥스 종목 마스터 파일을 사용하며, 목록을 갱신할 때는 `npm run update:stocks`를 실행한 뒤 배포합니다. 선택한 종목은 설정 저장을 눌러야 적용됩니다.

```bash
npm install
npm run test:cloudflare
npm run typecheck
npm run deploy
```

## 테스트 실행

```bash
pytest tests/ -q
```

## 프로젝트 구조

```text
bot/
  config.py             환경변수와 투자 모드 설정
  kis_client.py         KIS REST API 클라이언트
  dashboard.py          웹 대시보드와 모의투자 실행기
  strategies/           매매 전략
  static/               대시보드 CSS와 JavaScript
  templates/            대시보드 HTML
tests/                  단위 테스트
cloudflare/             Worker, Durable Object, 정적 배포 파일
wrangler.jsonc          Cloudflare 리소스와 배포 설정
```

## 보안

- API Key, Secret, 계좌번호는 `.env`에만 저장하며 Git에 추가하지 않습니다.
- `.env.example`에는 비어 있는 변수명만 유지합니다.
- `.env`, 토큰 캐시, 대시보드 설정 파일, 로그는 `.gitignore`에 포함되어 있습니다.
- 커밋 전 민감 파일과 채워진 KIS Key를 검사하려면 한 번만 아래 명령을 실행합니다.

```bash
git config core.hooksPath .githooks
```

이미 원격 저장소에 올라간 Key는 즉시 KIS Developers에서 폐기하고 재발급해야 합니다.
