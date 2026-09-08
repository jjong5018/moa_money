# 종환님이 해야 할 일

봇을 실제로 쓰기까지 순서대로 진행하시면 됩니다.

## 1. KIS API 키 발급

- [X] 한국투자증권 계좌 준비 (없으면 개설)
- [X] [KIS Developers 포털](https://apiportal.koreainvestment.com) 가입
- [X] **모의투자용** APP KEY / APP SECRET 발급 (처음엔 이것만 있으면 됨)
- [X] 실전투자용 APP KEY / APP SECRET은 나중에 (5번 단계에서) 발급

## 2. 설정 파일 만들기

- [X] 프로젝트 루트에서 `.env.example`을 복사해 `.env` 파일 생성
- [X] `.env`에 `KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_ACCOUNT_NO`, `KIS_ACCOUNT_PRODUCT_CD` 입력
- [X] `TRADING_MODE=paper`로 되어 있는지 확인 (모의투자, 실제 돈 안 나감)

## 3. 로컬에서 실행해보기

```bash
python -m venv .venv        # 이미 만들어져 있으면 생략
source .venv/bin/activate
pip install -r requirements.txt
python -m bot.main
```

- [ ] 위 명령어로 실행해서 에러 없이 로그가 찍히는지 확인
- [ ] `bot/main.py`의 `WATCHLIST`를 원하는 종목코드(6자리)로 수정 (기본값: 삼성전자 `005930`)

## 4. 모의투자로 검증

- [ ] 며칠~몇 주 정도 모의투자로 돌려보며 로그 확인
- [ ] 매수/매도 판단이 이동평균 골든크로스/데드크로스 로직대로 나오는지 확인
- [ ] 이상하다 싶으면 실전 전환 전에 반드시 다시 점검

## 5. 실전 전환 (실제 돈이 움직이는 단계)

- [ ] KIS Developers 포털에서 실전투자용 APP KEY / APP SECRET 발급
- [ ] `.env`의 키를 실전용으로 교체
- [ ] `.env`의 `TRADING_MODE=real`로 변경
- [ ] 소액으로 먼저 테스트

## 6. 계속 돌리기 (선택)

터미널을 꺼두면 봇도 멈추므로, 계속 운영하려면 아래 중 하나 선택:

- [ ] 컴퓨터를 항상 켜두고 실행 (가장 간단, 비용 없음)
- [ ] 클라우드 서버(AWS EC2, 오라클 클라우드 무료 티어 등)에 배포해 24시간 실행
- [ ] 서버에 올릴 경우 `systemd`나 `pm2` 등으로 프로세스 자동 재시작 설정
