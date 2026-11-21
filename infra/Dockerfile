FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /uvx /bin/

WORKDIR /app
COPY packages/python-sdk/pyproject.toml packages/python-sdk/README.md packages/python-sdk/uv.lock ./packages/python-sdk/
COPY packages/python-sdk/src ./packages/python-sdk/src

RUN cd packages/python-sdk && uv sync --frozen --no-dev --extra server --no-cache

RUN groupadd --system agentgate \
    && useradd --system --gid agentgate --create-home agentgate \
    && mkdir -p /app/data \
    && chown -R agentgate:agentgate /app

USER agentgate

EXPOSE 8000
CMD ["uv", "run", "--project", "packages/python-sdk", "--no-sync", "uvicorn", "agentgate.api:create_app_from_env", "--factory", "--host", "0.0.0.0", "--port", "8000"]
