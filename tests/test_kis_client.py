from unittest.mock import Mock

import pytest
import requests

from bot.config import Config
from bot.kis_client import KISClient, OrderStatusUnknownError


@pytest.fixture
def client():
    return KISClient(
        Config(
            app_key="test-key",
            app_secret="test-secret",
            account_no="12345678",
            account_product_cd="01",
            is_paper=True,
        )
    )


def response(body):
    result = Mock()
    result.json.return_value = body
    result.raise_for_status.return_value = None
    return result


def test_price_query_retries_a_read_timeout(client, monkeypatch):
    client._headers = Mock(return_value={})
    client._wait_for_request_slot = Mock()
    client._session.get = Mock(
        side_effect=[
            requests.ReadTimeout("slow KIS"),
            response({"rt_cd": "0", "output": {"stck_prpr": "253000"}}),
        ]
    )
    monkeypatch.setattr("bot.kis_client.time.sleep", Mock())

    assert client.get_current_price("005930") == {"stck_prpr": "253000"}
    assert client._session.get.call_count == 2


def test_timed_out_order_is_confirmed_without_resubmitting(client, monkeypatch):
    client._headers = Mock(return_value={})
    client._wait_for_request_slot = Mock()
    client.get_today_orders = Mock(
        side_effect=[
            [{"odno": "100"}],
            [{"odno": "101", "pdno": "005930", "ord_qty": "1"}, {"odno": "100"}],
        ]
    )
    client._session.post = Mock(side_effect=requests.ReadTimeout("order response timed out"))
    monkeypatch.setattr("bot.kis_client.time.sleep", Mock())

    result = client.place_order("005930", 1, "buy")

    assert result == {
        "order": {"odno": "101", "pdno": "005930", "ord_qty": "1"},
        "status_verified": True,
        "recovered_after_timeout": True,
    }
    assert client._session.post.call_count == 1


def test_timed_out_order_without_confirmation_is_not_resubmitted(client, monkeypatch):
    client._headers = Mock(return_value={})
    client._wait_for_request_slot = Mock()
    client.get_today_orders = Mock(return_value=[])
    client._session.post = Mock(side_effect=requests.ReadTimeout("order response timed out"))
    monkeypatch.setattr("bot.kis_client.time.sleep", Mock())

    with pytest.raises(OrderStatusUnknownError, match="Do not submit it again"):
        client.place_order("005930", 1, "buy")

    assert client._session.post.call_count == 1
