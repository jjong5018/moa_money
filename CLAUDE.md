# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 이 프로젝트는

한국투자증권(KIS) Open API를 이용한 파이썬 자동매매 봇입니다. 감시 종목(watchlist)의 시세를
주기적으로 조회하고, 교체 가능한 `Strategy`에게 매수/매도/보유 판단을 물어본 뒤, KIS를 통해 주문을
넣습니다. 모의투자(paper)와 실전투자(real) 모두 동일한 코드 경로로 동작하며, 환경변수 하나로
전환됩니다.

## 명령어

```bash
# 초기 설정
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 이후 KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCOUNT_NO 입력

# 봇 실행 (기본값은 모의투자)
python -m bot.main

# 테스트
pytest tests/ -q
pytest tests/test_moving_average.py::test_buys_on_golden_cross_when_flat -q  # 테스트 하나만 실행
```

lint/format 도구는 아직 설정되어 있지 않습니다.

## 아키텍처

**`bot/config.py`** — 필수 환경변수(`KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_ACCOUNT_NO`,
`KIS_ACCOUNT_PRODUCT_CD`, `TRADING_MODE`)를 읽고 검증해 불변(`frozen`) `Config` 객체로 만듭니다.
`TRADING_MODE`(`paper` 또는 `real`)가 `Config.base_url`을 결정하는데, 모의투자 도메인
(`openapivts...`)과 실전투자 도메인(`openapi...`)을 이 값 하나로 나눕니다. "실행해도 안전한지"와
"실제 돈이 움직이는지"를 가르는 유일한 스위치이므로, 어떤 코드 경로를 건드리든 이 플래그가 어느
쪽인지 먼저 확인해야 합니다.

**`bot/kis_client.py`** — KIS REST API를 감싸는 얇은 래퍼입니다. OAuth2 토큰 발급(`base_url`별로
캐시 키를 나눠 `.token_cache.json`에 저장하므로 모의/실전 토큰이 섞이지 않음), 시세 조회, 잔고
조회, 현금 주문(매수/매도)을 담당합니다. KIS는 엔드포인트마다 모의/실전용 `tr_id` 헤더 값이
다른데(예: 매수 주문은 `VTTC0802U` vs `TTTC0802U`), `KISClient`는 `config.is_paper` 값으로 알맞은
값을 골라 씁니다. KIS 응답은 HTTP 에러와 별개로 `rt_cd != "0"`로 API 레벨 에러를 표시하는데, 모든
메서드가 이를 확인해 `RuntimeError`로 다시 던집니다.

**`bot/strategies/base.py`** — `Strategy` 인터페이스입니다. `decide(stock_code, quote, position) ->
Decision`이 매 폴링 틱마다 감시 종목별로 한 번씩 호출됩니다. `quote`는 KIS 시세 응답 원본(가격은
`quote["stck_prpr"]`에 있음)이고, `position`은 잔고 조회 결과에서 매칭되는 항목이거나 보유하고
있지 않으면 `None`입니다(수량은 `position["hldg_qty"]`). 새 전략을 만들 때는 이 인터페이스를
구현하면 됩니다.

**`bot/strategies/moving_average.py`** — 현재 기본 전략인 `MovingAverageCrossStrategy`입니다.
`decide()`는 틱마다 시세 하나만 받기 때문에, 종목별 가격 이력을 전략 내부에 직접 누적합니다
(`stock_code`별 `deque`). 틱마다 단기/장기 이동평균을 비교해 골든크로스(매수, 보유 중이 아닐 때만)
/ 데드크로스(전량 매도, 보유 중일 때만)를 판단합니다. 틱 간 이력이 필요한 전략을 새로 만들 때도
이 패턴(상태를 `self`에 `stock_code`로 키를 나눠 저장)을 따르면 됩니다 — `main.py`가 `Strategy`
인스턴스 하나를 실행 내내 계속 재사용하기 때문입니다.

**`bot/main.py`** — 폴링 루프(`run()`)입니다. 틱마다 잔고를 한 번 조회한 뒤, 감시 종목마다 시세를
조회하고 `strategy.decide()`를 호출해서 신호가 BUY/SELL이면 주문을 넣습니다. 틱 도중 발생한
예외는 잡아서 로그만 남기고 넘어가므로, 한 틱이 실패해도 프로세스 전체가 죽지 않고
`POLL_INTERVAL_SECONDS` 뒤에 다시 시도합니다. `WATCHLIST`와 `POLL_INTERVAL_SECONDS`는 설정 파일이
아니라 모듈 상단의 상수로 관리됩니다.

## 참고

- `index.html`은 봇과 무관한 빈 보일러플레이트 파일입니다.
- `~/.codex/config.toml`에 OpenAI Codex 설정이 있습니다(프로젝트가 아닌 사용자 레벨). 여기서
  가져올 게 있는지 확인하려면 `/import`라고 답해 주세요.
