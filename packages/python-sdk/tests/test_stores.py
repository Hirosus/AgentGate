"""Tests for InMemory, SQLite, and DynamoDB IdempotencyStore adapters."""

import sqlite3
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from agentgate.seams import InMemoryIdempotencyStore
from agentgate.stores import DynamoDbIdempotencyStore, SqliteIdempotencyStore
from agentgate.types import WebhookEvent
from agentgate.webhook import ingest_webhook, sign_payload


def test_sqlite_store_claims_once_and_rejects_duplicate(tmp_path: Path) -> None:
    db_path = tmp_path / "nested" / "agentgate.db"
    raw = b'{"incident":"INC-201"}'
    event = WebhookEvent(idempotency_key="evt-201", timestamp=1_700_000_000, raw_body=raw)
    sig = sign_payload("top-secret", event.timestamp, raw, idempotency_key=event.idempotency_key)

    with SqliteIdempotencyStore(db_path=db_path, now_fn=lambda: 1_700_000_010) as store:
        assert db_path.exists()
        first = ingest_webhook(event, sig, "top-secret", store, now_timestamp=1_700_000_010)
        second = ingest_webhook(event, sig, "top-secret", store, now_timestamp=1_700_000_020)

    assert first.status == "accepted"
    assert second.status == "duplicate"


def test_sqlite_store_reclaims_at_exact_expiry_and_persists_across_reopen(tmp_path: Path) -> None:
    db_path = tmp_path / "persist.db"
    clock = [1_000]

    def now() -> int:
        return clock[0]

    with SqliteIdempotencyStore(db_path=db_path, now_fn=now) as store:
        assert store.claim("evt-ttl", ttl_seconds=60) is True
        clock[0] = 1_059
        assert store.claim("evt-ttl", ttl_seconds=60) is False

    with SqliteIdempotencyStore(db_path=db_path, now_fn=now) as reopened:
        assert reopened.claim("evt-ttl", ttl_seconds=60) is False
        clock[0] = 1_060
        assert reopened.claim("evt-ttl", ttl_seconds=60) is True
        assert reopened.claim("evt-ttl", ttl_seconds=60) is False


def test_sqlite_store_allows_only_one_winner_under_concurrent_claims(tmp_path: Path) -> None:
    db_path = tmp_path / "concurrent.db"

    with (
        SqliteIdempotencyStore(db_path=db_path, now_fn=lambda: 5_000) as shared_store,
        ThreadPoolExecutor(max_workers=16) as pool,
    ):
        shared_outcomes = list(
            pool.map(lambda _: shared_store.claim("race-shared", ttl_seconds=60), range(16))
        )
    assert sum(1 for won in shared_outcomes if won) == 1

    def claim_on_fresh_connection(_: int) -> bool:
        with SqliteIdempotencyStore(db_path=db_path, now_fn=lambda: 5_000) as conn_store:
            return conn_store.claim("race-multi-conn", ttl_seconds=60)

    with ThreadPoolExecutor(max_workers=16) as pool:
        conn_outcomes = list(pool.map(claim_on_fresh_connection, range(16)))
    assert sum(1 for won in conn_outcomes if won) == 1


def test_sqlite_store_rejects_empty_key_and_non_positive_ttl() -> None:
    with SqliteIdempotencyStore(db_path=":memory:", now_fn=lambda: 1_000) as store:
        with pytest.raises(ValueError):
            store.claim("", ttl_seconds=60)
        with pytest.raises(ValueError):
            store.claim("valid-key", ttl_seconds=0)
        with pytest.raises(ValueError):
            store.claim("valid-key", ttl_seconds=-10)


class _FakeClientError(Exception):
    def __init__(self, response: dict[str, dict[str, str]]) -> None:
        super().__init__(response.get("Error", {}).get("Code", "ClientError"))
        self.response = response


class _FakeDynamoDbTable:
    def __init__(self, fail_with_code: str | None = None) -> None:
        self.items: dict[str, dict[str, str | int]] = {}
        self.fail_with_code = fail_with_code

    def put_item(
        self,
        *,
        Item: Mapping[str, str | int],
        ConditionExpression: str,
        ExpressionAttributeNames: Mapping[str, str],
        ExpressionAttributeValues: Mapping[str, int],
    ) -> object:
        if self.fail_with_code is not None:
            raise _FakeClientError({"Error": {"Code": self.fail_with_code}})

        assert ConditionExpression == "attribute_not_exists(#pk) OR #exp <= :now"
        assert ExpressionAttributeNames == {"#pk": "idempotency_key", "#exp": "expires_at"}
        now = ExpressionAttributeValues[":now"]

        key = Item["idempotency_key"]
        expires_at = Item["expires_at"]
        assert isinstance(key, str)
        assert isinstance(expires_at, int)

        existing = self.items.get(key)
        if existing is not None:
            existing_exp = existing["expires_at"]
            assert isinstance(existing_exp, int)
            if existing_exp > now:
                raise _FakeClientError({"Error": {"Code": "ConditionalCheckFailedException"}})

        self.items[key] = {"idempotency_key": key, "expires_at": expires_at}
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}

    def delete_item(self, *, Key: Mapping[str, str]) -> object:
        if self.fail_with_code is not None:
            raise _FakeClientError({"Error": {"Code": self.fail_with_code}})
        self.items.pop(Key["idempotency_key"], None)
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}


def test_dynamodb_store_claims_and_rejects_duplicate_via_conditional_put() -> None:
    table = _FakeDynamoDbTable()
    store = DynamoDbIdempotencyStore(table=table, now_fn=lambda: 1_700_000_010)
    raw = b'{"incident":"INC-301"}'
    event = WebhookEvent(idempotency_key="evt-ddb-1", timestamp=1_700_000_000, raw_body=raw)
    sig = sign_payload("top-secret", event.timestamp, raw, idempotency_key=event.idempotency_key)

    first = ingest_webhook(event, sig, "top-secret", store, now_timestamp=1_700_000_010)
    second = ingest_webhook(event, sig, "top-secret", store, now_timestamp=1_700_000_020)

    assert first.status == "accepted"
    assert second.status == "duplicate"
    assert table.items["evt-ddb-1"] == {
        "idempotency_key": "evt-ddb-1",
        "expires_at": 1_700_000_010 + 86400,
    }


def test_dynamodb_store_reclaims_expired_item_at_boundary() -> None:
    table = _FakeDynamoDbTable()
    clock = [1_000]
    store = DynamoDbIdempotencyStore(table=table, now_fn=lambda: clock[0])

    assert store.claim("evt-ddb-ttl", ttl_seconds=60) is True
    clock[0] = 1_059
    assert store.claim("evt-ddb-ttl", ttl_seconds=60) is False
    clock[0] = 1_060
    assert store.claim("evt-ddb-ttl", ttl_seconds=60) is True


def test_dynamodb_store_propagates_non_conditional_errors_and_validates_inputs() -> None:
    table = _FakeDynamoDbTable(fail_with_code="ProvisionedThroughputExceededException")
    store = DynamoDbIdempotencyStore(table=table, now_fn=lambda: 1_000)

    with pytest.raises(_FakeClientError) as exc_info:
        store.claim("evt-ddb-err", ttl_seconds=60)
    assert exc_info.value.response["Error"]["Code"] == "ProvisionedThroughputExceededException"

    with pytest.raises(ValueError):
        store.claim("", ttl_seconds=60)
    with pytest.raises(ValueError):
        store.claim("evt-ddb-ok", ttl_seconds=0)
    with pytest.raises(ValueError):
        store.claim("evt-ddb-ok", ttl_seconds=-5)


def test_in_memory_store_live_clock_pruning_release_and_validation() -> None:
    clock = [100.0]
    live_store = InMemoryIdempotencyStore(now_fn=lambda: clock[0])
    assert live_store.claim("k1", ttl_seconds=10) is True
    assert live_store.claim("k1", ttl_seconds=10) is False
    clock[0] = 110.0
    assert live_store.claim("k2", ttl_seconds=10) is True
    # k1 was opportunistically pruned on claim("k2")
    assert "k1" not in live_store._claims

    live_store.release("k2")
    assert live_store.claim("k2", ttl_seconds=10) is True

    default_store = InMemoryIdempotencyStore()
    assert default_store.claim("live-key", ttl_seconds=5) is True
    assert default_store.claim("live-key", ttl_seconds=5) is False

    with pytest.raises(ValueError):
        live_store.claim("", ttl_seconds=10)
    with pytest.raises(ValueError):
        live_store.claim("k3", ttl_seconds=0)
    with pytest.raises(ValueError):
        InMemoryIdempotencyStore(current_time=10, now_fn=lambda: 10.0)


def test_sqlite_and_dynamodb_store_release_and_pruning(tmp_path: Path) -> None:
    db_path = tmp_path / "prune.db"
    clock = [1_000]
    with SqliteIdempotencyStore(db_path=db_path, now_fn=lambda: clock[0]) as store:
        assert store.claim("stale-1", ttl_seconds=10) is True
        assert store.claim("active-1", ttl_seconds=100) is True
        store.release("active-1")
        assert store.claim("active-1", ttl_seconds=100) is True

        clock[0] = 1_015
        assert store.claim("fresh-1", ttl_seconds=50) is True

    with sqlite3.connect(db_path) as conn:
        rows = conn.execute("SELECT idempotency_key FROM idempotency_claims").fetchall()
    assert {row[0] for row in rows} == {"active-1", "fresh-1"}

    table = _FakeDynamoDbTable()
    ddb = DynamoDbIdempotencyStore(table=table, now_fn=lambda: 1_000)
    assert ddb.claim("ddb-rel", ttl_seconds=60) is True
    ddb.release("ddb-rel")
    assert "ddb-rel" not in table.items
    assert ddb.claim("ddb-rel", ttl_seconds=60) is True
