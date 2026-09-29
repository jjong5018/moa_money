# Cloudflare 배포

Moa Money의 운영 배포는 Cloudflare Worker 한 개로 구성합니다. 정적 대시보드와 API는 Worker가 제공하고, Durable Object가 자동매매 실행 상태, 설정, 시세 이력, KIS 토큰, 일일 주문 한도를 보존합니다.

Cloudflare 대시보드는 모의투자/실전투자 버튼으로 전환합니다. 기본값은 모의투자이며 전환만으로 자동매매가 시작되지는 않습니다. 실행 중에는 전환이 차단됩니다. 실전 시작 시 실제 주문 확인이 필요합니다.

실전투자는 별도로 `KIS_REAL_APP_KEY`, `KIS_REAL_APP_SECRET`, `KIS_REAL_ACCOUNT_NO`(8자리), `KIS_REAL_ACCOUNT_PRODUCT_CD`(2자리)를 Worker Secrets에 등록해야 합니다. 모의투자 계좌를 실전에 재사용하는 기본값은 없습니다. 기존 비밀값 업로드 스크립트는 모의투자 값만 업로드합니다.

인증 토큰과 일일 주문 한도 집계는 모드별로 분리됩니다. 전환 시 화면의 시세·보유 수량·전략 이력을 초기화하며 일일 한도는 유지합니다. 주문 실패 또는 상태 미확인 시 자동매매를 중지합니다. 중지 요청은 진행 중인 조회/주문 처리 후 반영되며 이미 접수된 주문을 취소하지 않습니다.

주문 거래 ID는 [KIS 공식 현금 주문 예제](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/order_cash/order_cash.py)를 따릅니다. Python 로컬 대시보드는 기존 모의투자 전용입니다.

## 1. 로컬 검증

### 미국주식 사용

자동매매를 중지하고 **미국주식 · 달러**를 선택합니다. 감시 종목은 `NASD:AAPL, NYSE:IBM, AMEX:SPY`처럼 거래소와 티커를 함께 입력합니다. 한도는 USD이며 소수 둘째 자리까지 저장합니다. 기본값은 1회 $300, 일일 $900, 3회이며, 기존 국내 원화 설정과 별도로 저장됩니다. 시장 전환은 자동매매를 시작하지 않습니다.

해외 전용 API 키를 추가하지 않고 선택한 모드의 기존 KIS 키와 계좌를 사용합니다. 계좌의 해외주식 거래 가능 여부와 USD 주문가능금액은 KIS에서 확인해야 합니다. 자동 환전은 구현하지 않으며 외화 기준 최대주문가능수량으로 제한합니다.

뉴욕 시간 평일 09:30~16:00에만 조회·전략을 실행하고 주문 직전에도 시간을 확인합니다. DST는 시간대 변환으로 처리합니다. 공휴일·조기폐장 달력은 포함하지 않으며 증권사 주문 거절 시 중지합니다. 제공되는 시세는 계좌의 시세 서비스 조건에 따라 지연될 수 있습니다. 조회한 가격을 센트 단위로 반올림한 지정가 주문이며 시장가·시간외·소수점 주식·1달러 미만 종목은 지원하지 않습니다. 수수료는 설정 한도에 포함하지 않습니다.

잔고와 주문내역은 연속조회가 끝나야 사용합니다. 모의 주문내역 API는 전체 조회 후 종목·매매구분을 필터링합니다. 주문 응답의 주문번호·종목·수량과 체결 수량을 대조합니다. 전량 체결되지 않거나 응답이 불확실하면 주문 확인 표시를 영구 저장하고 중지합니다. KIS에서 체결·취소를 확인한 뒤 **주문 확인 완료**를 눌러 재시작 차단을 해제합니다. 이 버튼 자체는 주문을 취소하거나 자동매매를 시작하지 않습니다. 한도는 주문 전 예약하며 거절·취소되어도 당일 복구하지 않습니다.

미국 일일 한도는 뉴욕 날짜, 국내 한도는 한국 날짜로 집계합니다. 투자모드×시장별로 구분하고 전환 후에도 보존합니다. 주문 취소·정정 UI와 다른 국가 시장은 포함하지 않습니다.

공식 근거: [해외 주문](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/order/order.py), [주문체결내역](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/inquire_ccnl/inquire_ccnl.py), [잔고](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/inquire_balance/inquire_balance.py), [매수가능금액](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/inquire_psamount/inquire_psamount.py). 미국 모의 매도 ID는 공식 설명의 `VTTT1001U`를 명시적으로 사용합니다(실전 ID 첫 글자를 일괄 치환하지 않음).

검증은 가짜 HTTP 응답으로 수행하며 실제 계좌 주문은 보내지 않습니다. 실계좌·모의계좌의 장중 주문/체결은 별도 운영 확인이 필요합니다.

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

국내 감시종목의 주식명은 KIS 실전 서버의 주식기본조회 API에서 읽습니다. 모의투자 서버에서는 이 조회가 지원되지 않으므로, 이름 표시용 앱 키를 별도 시크릿으로 등록합니다. 이 두 값만으로는 실전 자동매매 모드를 시작할 수 없습니다.

```bash
npx wrangler secret put KIS_METADATA_APP_KEY
npx wrangler secret put KIS_METADATA_APP_SECRET
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
