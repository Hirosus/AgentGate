"""Synchronous and asynchronous HTTP SDK clients for AgentGate endpoints."""

from types import TracebackType

import httpx

from agentgate.types import IntakeDecision
from agentgate.webhook import sign_payload


class AgentGateClient:
    """Synchronous HTTP client for submitting signed webhooks to an AgentGate service."""

    def __init__(
        self,
        base_url: str,
        webhook_secret: str,
        timeout_seconds: float = 10.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._secret = webhook_secret
        self._client = httpx.Client(
            base_url=base_url,
            timeout=timeout_seconds,
            transport=transport,
        )

    def __enter__(self) -> "AgentGateClient":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying connection pool cleanly."""
        self._client.close()

    def health(self) -> bool:
        """Return True iff the remote AgentGate health endpoint responds HTTP 200."""
        response = self._client.get("/health")
        return response.status_code == 200

    def send_signed_webhook(
        self,
        idempotency_key: str,
        timestamp: int,
        raw_body: bytes,
    ) -> IntakeDecision:
        """Sign and dispatch a webhook payload, parsing the typed IntakeDecision."""
        sig = sign_payload(secret=self._secret, timestamp=timestamp, raw_body=raw_body)
        response = self._client.post(
            "/webhooks/triage",
            content=raw_body,
            headers={
                "Content-Type": "application/json",
                "X-AgentGate-Timestamp": str(timestamp),
                "X-AgentGate-Idempotency-Key": idempotency_key,
                "X-AgentGate-Signature": sig,
            },
        )
        response.raise_for_status()
        return IntakeDecision.model_validate(response.json())


class AsyncAgentGateClient:
    """Asynchronous HTTP client sharing identical signing contracts with AgentGateClient."""

    def __init__(
        self,
        base_url: str,
        webhook_secret: str,
        timeout_seconds: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._secret = webhook_secret
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout_seconds,
            transport=transport,
        )

    async def __aenter__(self) -> "AsyncAgentGateClient":
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the underlying async connection pool cleanly."""
        await self._client.aclose()

    async def health(self) -> bool:
        """Return True iff the remote AgentGate health endpoint responds HTTP 200."""
        response = await self._client.get("/health")
        return response.status_code == 200

    async def send_signed_webhook(
        self,
        idempotency_key: str,
        timestamp: int,
        raw_body: bytes,
    ) -> IntakeDecision:
        """Sign and dispatch a webhook payload asynchronously."""
        sig = sign_payload(secret=self._secret, timestamp=timestamp, raw_body=raw_body)
        response = await self._client.post(
            "/webhooks/triage",
            content=raw_body,
            headers={
                "Content-Type": "application/json",
                "X-AgentGate-Timestamp": str(timestamp),
                "X-AgentGate-Idempotency-Key": idempotency_key,
                "X-AgentGate-Signature": sig,
            },
        )
        response.raise_for_status()
        return IntakeDecision.model_validate(response.json())
