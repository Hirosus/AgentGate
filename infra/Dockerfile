FROM python:3.11-slim AS base

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /uvx /bin/

WORKDIR /app
COPY packages/python-sdk/pyproject.toml ./packages/python-sdk/
COPY packages/python-sdk/src ./packages/python-sdk/src

RUN cd packages/python-sdk && uv sync --no-dev

EXPOSE 8000
CMD ["uv", "run", "--project", "packages/python-sdk", "python", "-c", "import agentgate; print(agentgate.__all__)"]
