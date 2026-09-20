# Cloudflare 배포

Moa Money의 운영 배포는 Cloudflare Worker 한 개로 구성합니다. 정적 대시보드와 API는 Worker가 제공하고, Durable Object가 자동매매 실행 상태, 설정, 시세 이력, KIS 토큰, 일일 주문 한도를 보존합니다.

운영 서비스는 모의투자 전용입니다. `TRADING_MODE`를 `paper` 이외의 값으로 바꾸면 시작 요청이 차단됩니다.

## 1. 로컬 검증

Node.js 22 이상에서 의존성을 설치하고 검증합니다.

```bash
npm install
npm run test:cloudflare
npm run typecheck
npx wrangler deploy --dry-run
```

Python 로컬 실행판의 회귀 테스트도 함께 실행합니다.

```bash
.venv/bin/python -m pytest tests/ -q
```

## 2. Cloudflare 로그인과 비밀값 등록

Cloudflare 계정에 로그인합니다.

```bash
npx wrangler login
```

KIS 모의투자 값을 각각 등록합니다. 명령 실행 후 터미널이 값을 물으면 붙여넣습니다. 비밀값은 저장소나 명령행 인수에 넣지 않습니다.

```bash
npx wrangler secret put KIS_APP_KEY
npx wrangler secret put KIS_APP_SECRET
npx wrangler secret put KIS_ACCOUNT_NO
```

로컬 `.env`에 세 값이 이미 있다면 값이 출력되지 않는 업로드 스크립트를 사용할 수 있습니다.

```bash
.venv/bin/python scripts/upload_cloudflare_secrets.py
```

계좌 상품 코드는 기본값 `01`로 `wrangler.jsonc`에 설정되어 있습니다.

## 3. Worker 배포

```bash
npm run deploy
```

첫 배포에서 `TradingState` SQLite Durable Object가 생성됩니다. 새 Cloudflare 계정에 처음 배포할 때는 `wrangler.jsonc`의 `DEPLOYMENT_LOCKED`를 `true`로 설정해 `/healthz` 외의 공개 요청을 차단합니다.

## 4. Cloudflare Access 로그인 설정

Worker를 공개 상태로 운영하지 않습니다.

1. Cloudflare 대시보드의 **Workers & Pages**에서 `moa-money`를 선택합니다.
2. **Access** 탭에서 **Protect this Worker**를 선택합니다.
3. Production과 Preview 주소 보호를 활성화합니다.
4. Allow 정책에서 접속을 허용할 본인 이메일만 추가합니다.
5. 정책을 저장한 뒤 시크릿 창에서 Worker 주소를 열어 로그인 화면이 먼저 표시되는지 확인합니다.

Access 적용을 확인한 뒤 `wrangler.jsonc`의 `DEPLOYMENT_LOCKED`를 `false`로 바꾸고 다시 `npm run deploy`를 실행합니다.

대시보드의 **로그아웃** 링크는 Cloudflare Access 세션을 종료합니다.

## 운영 주의사항

- 로컬 봇과 Cloudflare Worker를 동시에 시작하지 않습니다. 같은 계좌에서 중복 주문이 발생할 수 있습니다.
- 배포 직후 자동매매는 중지 상태입니다. Access 로그인 후 설정을 확인하고 직접 시작합니다.
- Durable Object 알람은 최소 한 번 실행되는 방식입니다. 한 개의 Object가 실행과 주문 한도 예약을 직렬 처리하며, 주문 응답이 불확실하면 재주문하지 않고 KIS 주문 내역만 확인합니다.
- Worker 삭제 또는 Durable Object 마이그레이션 전에 자동매매를 중지합니다.
- `/healthz`를 공개 모니터링에 사용하려면 Access에서 해당 경로만 별도 Bypass 정책으로 지정해야 합니다.

## 공식 문서

- Workers 배포: https://developers.cloudflare.com/workers/get-started/guide/
- Durable Object 알람: https://developers.cloudflare.com/durable-objects/api/alarms/
- Worker Access 보호: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
