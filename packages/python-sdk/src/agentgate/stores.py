"""Persistent IdempotencyStore adapters backed by SQLite and AWS DynamoDB."""

import sqlite3
import threading
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from types import TracebackType
from typing import Protocol, runtime_checkable


def _default_now() -> int:
    return int(time.time())


def _validate_claim_args(key: str, ttl_seconds: int) -> None:
    if not key:
        raise ValueError("idempotency key must be a non-empty string.")
    if ttl_seconds <= 0:
        raise ValueError("ttl_seconds must be a positive integer.")


class SqliteIdempotencyStore:
    """Thread-safe local SQLite IdempotencyStore adapter with atomic BEGIN IMMEDIATE claims."""

    def __init__(
        self,
        db_path: str | Path,
        now_fn: Callable[[], int] | None = None,
        busy_timeout_ms: int = 5000,
    ) -> None:
        path_str = str(db_path)
        if path_str != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)

        self._now_fn: Callable[[], int] = now_fn if now_fn is not None else _default_now
        self._lock = threading.Lock()
        self._closed = False
        self._conn = sqlite3.connect(
            path_str,
            timeout=busy_timeout_ms / 1000.0,
            isolation_level=None,
            check_same_thread=False,
        )
        self._conn.execute(f"PRAGMA busy_timeout = {int(busy_timeout_ms)}")
        if path_str != ":memory:":
            self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS idempotency_claims (
                idempotency_key TEXT PRIMARY KEY,
                expires_at INTEGER NOT NULL
            )
            """
        )
        self._conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at
            ON idempotency_claims (expires_at)
            """
        )

    def __enter__(self) -> "SqliteIdempotencyStore":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying SQLite connection idempotently."""
        with self._lock:
            if not self._closed:
                self._conn.close()
                self._closed = True

    def claim(self, key: str, ttl_seconds: int) -> bool:
        """Atomically claim `key` until `now + ttl_seconds`; return False if still active."""
        _validate_claim_args(key, ttl_seconds)
        with self._lock:
            if self._closed:
                raise RuntimeError("Cannot claim on a closed SqliteIdempotencyStore.")
            now = self._now_fn()
            expires_at = now + ttl_seconds
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                self._conn.execute(
                    "DELETE FROM idempotency_claims WHERE expires_at <= ?",
                    (now,),
                )
                cursor = self._conn.execute(
                    """
                    INSERT INTO idempotency_claims (idempotency_key, expires_at)
                    VALUES (?, ?)
                    ON CONFLICT(idempotency_key) DO UPDATE
                        SET expires_at = excluded.expires_at
                        WHERE idempotency_claims.expires_at <= ?
                    """,
                    (key, expires_at, now),
                )
                claimed = cursor.rowcount == 1
                self._conn.execute("COMMIT")
            except Exception:
                if self._conn.in_transaction:
                    self._conn.execute("ROLLBACK")
                raise
            return claimed

    def release(self, key: str) -> None:
        """Delete a claimed `key` so a failed downstream execution can be retried."""
        if not key:
            raise ValueError("idempotency key must be a non-empty string.")
        with self._lock:
            if self._closed:
                raise RuntimeError("Cannot release on a closed SqliteIdempotencyStore.")
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                self._conn.execute(
                    "DELETE FROM idempotency_claims WHERE idempotency_key = ?",
                    (key,),
                )
                self._conn.execute("COMMIT")
            except Exception:
                if self._conn.in_transaction:
                    self._conn.execute("ROLLBACK")
                raise


@runtime_checkable
class DynamoDbTableProtocol(Protocol):
    """Structural interface matching a boto3 DynamoDB Table resource's claim/delete methods."""

    def put_item(
        self,
        *,
        Item: Mapping[str, str | int],
        ConditionExpression: str,
        ExpressionAttributeNames: Mapping[str, str],
        ExpressionAttributeValues: Mapping[str, int],
    ) -> object:
        """Persist an item conditionally; raise ClientError if condition fails."""
        ...

    def delete_item(
        self,
        *,
        Key: Mapping[str, str],
    ) -> object:
        """Delete an item by primary key."""
        ...


def _is_conditional_check_failed(exc: Exception) -> bool:
    response: object = getattr(exc, "response", None)
    if not isinstance(response, Mapping):
        return False
    error: object = response.get("Error")
    if not isinstance(error, Mapping):
        return False
    return error.get("Code") == "ConditionalCheckFailedException"


class DynamoDbIdempotencyStore:
    """AWS DynamoDB IdempotencyStore adapter using conditional PutItem with TTL expiry."""

    def __init__(
        self,
        table: DynamoDbTableProtocol,
        now_fn: Callable[[], int] | None = None,
    ) -> None:
        self._table = table
        self._now_fn: Callable[[], int] = now_fn if now_fn is not None else _default_now

    def claim(self, key: str, ttl_seconds: int) -> bool:
        """Atomically claim `key` via DynamoDB conditional PutItem; return False if active."""
        _validate_claim_args(key, ttl_seconds)
        now = self._now_fn()
        try:
            self._table.put_item(
                Item={"idempotency_key": key, "expires_at": now + ttl_seconds},
                ConditionExpression="attribute_not_exists(#pk) OR #exp <= :now",
                ExpressionAttributeNames={"#pk": "idempotency_key", "#exp": "expires_at"},
                ExpressionAttributeValues={":now": now},
            )
        except Exception as exc:
            if _is_conditional_check_failed(exc):
                return False
            raise
        return True

    def release(self, key: str) -> None:
        """Delete a claimed `key` from DynamoDB so a failed delivery can be retried."""
        if not key:
            raise ValueError("idempotency key must be a non-empty string.")
        self._table.delete_item(Key={"idempotency_key": key})
