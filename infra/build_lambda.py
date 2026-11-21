"""Zero-Docker AWS Lambda x86_64 (Linux) deployment bundle builder."""

import argparse
import shutil
import subprocess
import sys
import tomllib
from collections.abc import Mapping
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_OUTPUT = _REPO_ROOT / "infra" / "build" / "lambda"
_SDK_ROOT = _REPO_ROOT / "packages" / "python-sdk"
_SDK_PYPROJECT = _SDK_ROOT / "pyproject.toml"
_SDK_PACKAGE_DIR = _SDK_ROOT / "src" / "agentgate"


def load_runtime_dependencies(pyproject_path: Path = _SDK_PYPROJECT) -> list[str]:
    """Read PEP 508 runtime dependencies from `[project].dependencies` in `pyproject_path`."""
    if not pyproject_path.is_file():
        raise FileNotFoundError(f"SDK pyproject.toml not found: {pyproject_path}")

    with pyproject_path.open("rb") as handle:
        parsed: object = tomllib.load(handle)

    if not isinstance(parsed, Mapping):
        raise ValueError(f"Invalid TOML root table in {pyproject_path}")

    project: object = parsed.get("project")
    if not isinstance(project, Mapping):
        raise ValueError(f"Missing [project] table in {pyproject_path}")

    raw_dependencies: object = project.get("dependencies")
    if not isinstance(raw_dependencies, list):
        raise ValueError(f"Missing [project].dependencies list in {pyproject_path}")

    dependencies: list[str] = []
    for entry in raw_dependencies:
        if not isinstance(entry, str) or not entry.strip():
            raise ValueError(f"Invalid dependency entry in {pyproject_path}: {entry!r}")
        dependencies.append(entry.strip())

    if not dependencies:
        raise ValueError(f"No runtime dependencies declared in {pyproject_path}")
    return dependencies


def _clean_bundle_artifacts(output_dir: Path) -> None:
    """Remove leftover `bin/` directory and `.lock` files inside `output_dir`."""
    bin_dir = output_dir / "bin"
    if bin_dir.exists():
        shutil.rmtree(bin_dir)

    for candidate in list(output_dir.rglob("*")):
        if candidate.is_file() and (candidate.name == ".lock" or candidate.suffix == ".lock"):
            candidate.unlink()


def build_lambda_bundle(
    output_dir: Path,
    pyproject_path: Path = _SDK_PYPROJECT,
) -> tuple[int, float]:
    """Install Linux x86_64 runtime wheels and copy AgentGate SDK sources into `output_dir`."""
    if not _SDK_PACKAGE_DIR.is_dir():
        raise FileNotFoundError(f"AgentGate SDK directory not found: {_SDK_PACKAGE_DIR}")

    dependencies = load_runtime_dependencies(pyproject_path)

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    uv_bin = shutil.which("uv") or "uv"
    cmd = [
        uv_bin,
        "pip",
        "install",
        "--target",
        str(output_dir),
        "--python-platform",
        "x86_64-manylinux2014",
        "--python-version",
        "3.11",
        "--only-binary=:all:",
        *dependencies,
    ]
    subprocess.run(cmd, check=True)

    target_pkg = output_dir / "agentgate"
    shutil.copytree(
        _SDK_PACKAGE_DIR,
        target_pkg,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )

    _clean_bundle_artifacts(output_dir)

    entrypoint = target_pkg / "aws_lambda.py"
    if not entrypoint.is_file():
        raise RuntimeError(f"Missing Lambda handler module: {entrypoint}")

    linux_binaries = list((output_dir / "pydantic_core").glob("_pydantic_core*.so"))
    if not linux_binaries:
        raise RuntimeError(
            "Missing Linux x86_64 pydantic_core shared library (_pydantic_core*.so)."
        )

    windows_binaries = list(output_dir.rglob("*.pyd"))
    if windows_binaries:
        names = ", ".join(str(p.relative_to(output_dir)) for p in windows_binaries[:5])
        raise RuntimeError(f"Unexpected Windows .pyd binaries found in Lambda bundle: {names}")

    files = [p for p in output_dir.rglob("*") if p.is_file()]
    total_mb = sum(p.stat().st_size for p in files) / (1024 * 1024)
    return len(files), total_mb


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint for building the Linux x86_64 AWS SAM deployment bundle."""
    parser = argparse.ArgumentParser(
        description="Build zero-Docker Linux x86_64 Lambda bundle for AWS SAM.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=_DEFAULT_OUTPUT,
        help="Destination directory for assembled Lambda bundle (default: infra/build/lambda).",
    )
    args = parser.parse_args(argv)

    try:
        file_count, total_mb = build_lambda_bundle(Path(args.output))
    except Exception as exc:
        print(f"Lambda bundle build failed: {exc}", file=sys.stderr)
        return 1

    print(
        f"Built AWS Lambda Linux x86_64 bundle at {args.output} "
        f"({file_count} files, {total_mb:.2f} MB)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
