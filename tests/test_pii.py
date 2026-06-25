#!/usr/bin/env python3
"""PII regression — unit tests for .github/pii_check.py (CI scan is the pii-check job)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".github"))

from pii_check import check_diff, load_patterns, parse_patterns  # noqa: E402

SAMPLE_PATTERNS = "example-agent-name\nexample-hostname\nexample\\.host\\.example\n"


def test_example_agent_name_is_registered_pii_pattern():
    os.environ["PII_PATTERNS"] = SAMPLE_PATTERNS
    patterns = load_patterns()
    assert "example-agent-name" in patterns


def test_pii_check_catches_example_agent_name_in_added_line():
    diff = "\n".join(
        [
            "diff --git a/example.md b/example.md",
            "+++ b/example.md",
            "+export TELL_OUTBOX_DIR=/var/mailboxes/example-agent-name/.outbox",
        ]
    )
    hits = check_diff(diff, parse_patterns(SAMPLE_PATTERNS))
    assert any(p == "example-agent-name" for p, _ in hits)


def test_pii_check_ignores_example_com_addresses():
    diff = "\n".join(
        [
            "diff --git a/a8s/tests/test.js b/a8s/tests/test.js",
            "+++ b/a8s/tests/test.js",
            "+  assertEqual(result.args[0], 'alice@example.com', 'parseCommand: first arg');",
        ]
    )
    hits = check_diff(diff, parse_patterns(SAMPLE_PATTERNS))
    assert hits == []


def test_load_patterns_requires_env_or_local_file():
    os.environ.pop("PII_PATTERNS", None)
    local = Path(__file__).resolve().parents[1] / ".github" / "pii-patterns.local.txt"
    if local.is_file():
        return
    try:
        load_patterns()
        raise AssertionError("expected FileNotFoundError")
    except FileNotFoundError:
        pass


def main():
    os.environ["PII_PATTERNS"] = SAMPLE_PATTERNS
    test_example_agent_name_is_registered_pii_pattern()
    test_pii_check_catches_example_agent_name_in_added_line()
    test_pii_check_ignores_example_com_addresses()
    test_load_patterns_requires_env_or_local_file()
    print("4 tests passed")


if __name__ == "__main__":
    main()
