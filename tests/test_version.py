#!/usr/bin/env python3
"""Unit tests for .github/version_check.py."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".github"))

from version_check import (  # noqa: E402
    COMPONENTS,
    check_component,
    components_needing_bump,
    is_version_bump,
    path_requires_bump,
)

BRIDGE = COMPONENTS["bridge"]
A8S = COMPONENTS["a8s"]

BRIDGE_V210 = """\
/*
 * GAS Bridge v2.10 — Turn Google Apps Script Into a Key-Based API
 */
function _info() {
  return { version: '2.10' };
}
"""

BRIDGE_V211 = BRIDGE_V210.replace("2.10", "2.11")

A8S_V10 = """\
/*
 * A8S v1.0 — Agent messaging via Google Drive
 */
const A8S = (() => {
  const VERSION = '1.0';
  return { testConnection() {} };
})();
"""

A8S_V11 = A8S_V10.replace("1.0", "1.1")


def test_path_requires_bump_skips_readme_and_tests():
    assert path_requires_bump("a8s/Code.js")
    assert not path_requires_bump("a8s/README.md")
    assert not path_requires_bump("a8s/tests/test.js")
    assert not path_requires_bump("a8s/vendor/marked.js")


def test_components_needing_bump_only_for_deployable_changes():
    needed = components_needing_bump(["a8s/README.md", "a8s/tests/test.js"])
    assert needed == []
    needed = components_needing_bump(["a8s/Code.js", "bridge/README.md"])
    assert [c.name for c in needed] == ["a8s"]


def test_is_version_bump():
    assert is_version_bump(None, "1.0")
    assert is_version_bump("1.0", "1.1")
    assert not is_version_bump("1.1", "1.0")
    assert not is_version_bump("1.0", "1.0")


def test_bridge_requires_matching_bumped_versions():
    errors = check_component(BRIDGE, BRIDGE_V210, BRIDGE_V210)
    assert any("not bumped" in err for err in errors)

    errors = check_component(BRIDGE, BRIDGE_V210, BRIDGE_V211)
    assert errors == []


def test_a8s_requires_version_on_first_introduction():
    head = "const A8S = (() => { return {}; })();"
    errors = check_component(A8S, None, head)
    assert any("missing header version" in err for err in errors)

    errors = check_component(A8S, None, A8S_V10)
    assert errors == []


def test_mismatched_header_and_inline_fails():
    bad = A8S_V10.replace("const VERSION = '1.0';", "const VERSION = '1.1';")
    errors = check_component(A8S, None, bad)
    assert any("header v1.0" in err for err in errors)


def main():
    test_path_requires_bump_skips_readme_and_tests()
    test_components_needing_bump_only_for_deployable_changes()
    test_is_version_bump()
    test_bridge_requires_matching_bumped_versions()
    test_a8s_requires_version_on_first_introduction()
    test_mismatched_header_and_inline_fails()
    print("6 tests passed")


if __name__ == "__main__":
    main()
