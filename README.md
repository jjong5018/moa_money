# Moa Money

한국투자증권(KIS) Open API 기반의 국내주식 모의투자 자동매매 프로젝트입니다. 웹 대시보드에서 감시 종목과 1회 매수 한도를 설정하고, 이동평균 교차 전략의 실행 상태를 확인할 수 있습니다.

## 현재 기능

- KIS 모의투자 계좌 인증, 잔고 조회, 현재가 조회, 현금 주문
- 단기·장기 이동평균 골든크로스 매수 및 데드크로스 매도 전략
- 모의투자 전용 웹 대시보드
- 감시 종목, 1회 매수 한도, 이동평균 기간, 조회 주기 설정
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
```

웹 대시보드를 실행합니다.

```bash
python -m bot.dashboard
```

브라우저에서 `http://127.0.0.1:5000`을 열고 설정을 저장한 후 시작합니다. 이 대시보드는 실전투자 모드에서 실행을 차단합니다.

## 테스트

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
