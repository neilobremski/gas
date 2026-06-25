"""Scan git diffs for PII patterns from PII_PATTERNS env or a local patterns file."""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_PATTERNS_FILE = Path(__file__).resolve().parent / "pii-patterns.local.txt"
EXAMPLE_PATTERNS_FILE = Path(__file__).resolve().parent / "pii-patterns.example.txt"


def parse_patterns(text: str) -> list[str]:
    return [
        ln.strip()
        for ln in text.splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]


def load_patterns() -> list[str]:
    env = os.environ.get("PII_PATTERNS", "").strip()
    if env:
        return parse_patterns(env)
    if LOCAL_PATTERNS_FILE.is_file():
        return parse_patterns(LOCAL_PATTERNS_FILE.read_text(encoding="utf-8"))
    raise FileNotFoundError(
        "PII patterns not configured.\n"
        f"  Local: copy {EXAMPLE_PATTERNS_FILE.name} to {LOCAL_PATTERNS_FILE.name}\n"
        "  CI: set GitHub Actions secret PII_PATTERNS"
    )


def _resolve_main_ref(repo_root: Path) -> str | None:
    for ref in ("origin/main", "main"):
        proc = subprocess.run(
            ["git", "rev-parse", "--verify", ref],
            cwd=repo_root,
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0:
            return ref
    return None


def diff_range(range_spec: str, repo_root: Path | None = None) -> str:
    root = repo_root or REPO_ROOT
    proc = subprocess.run(
        ["git", "diff", range_spec, "--", "."],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.stdout if proc.returncode == 0 else ""


def diff_vs_main(repo_root: Path | None = None) -> str:
    root = repo_root or REPO_ROOT
    base = _resolve_main_ref(root)
    if base is None:
        return ""
    return diff_range(f"{base}...HEAD", root)


def added_lines(diff: str) -> list[str]:
    return [
        ln[1:]
        for ln in diff.splitlines()
        if ln.startswith("+") and not ln.startswith("+++")
    ]


def find_violations(diff: str, patterns: list[str]) -> list[tuple[str, str]]:
    hits: list[tuple[str, str]] = []
    for line in added_lines(diff):
        for pattern in patterns:
            if re.search(pattern, line, re.IGNORECASE):
                hits.append((pattern, line))
                break
    return hits


def check_diff(diff: str, patterns: list[str] | None = None) -> list[tuple[str, str]]:
    pats = patterns if patterns is not None else load_patterns()
    return find_violations(diff, pats)


def check_branch(repo_root: Path | None = None, range_spec: str | None = None) -> list[tuple[str, str]]:
    root = repo_root or REPO_ROOT
    diff = diff_range(range_spec, root) if range_spec else diff_vs_main(root)
    return check_diff(diff)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check a git diff for PII patterns.")
    parser.add_argument(
        "--range",
        metavar="REV",
        help="git diff range to scan (default: origin/main...HEAD or main...HEAD)",
    )
    args = parser.parse_args(argv)
    try:
        patterns = load_patterns()
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1
    violations = check_branch(range_spec=args.range)
    if not violations:
        print("No PII patterns found in diff.")
        return 0
    for pattern, line in violations[:20]:
        print(f"PII pattern {pattern!r}: {line}", file=sys.stderr)
    print(
        f"\nRemove PII before merging. {len(patterns)} pattern(s) loaded.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
