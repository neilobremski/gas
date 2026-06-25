"""Require version bumps in bridge/ and a8s/ when deployable files change."""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

EXCLUDE_SUFFIXES = (
    "/README.md",
    "/THIRD_PARTY_NOTICES.md",
    "/package-lock.json",
    "/.claspignore",
    "/.gitignore",
)
EXCLUDE_PREFIXES = (
    "a8s/tests/",
    "a8s/vendor/",
    "bridge/tests/",
)


@dataclass(frozen=True)
class Component:
    name: str
    prefix: str
    code_file: str
    header_re: re.Pattern[str]
    inline_re: re.Pattern[str]
    inline_label: str


COMPONENTS: dict[str, Component] = {
    "bridge": Component(
        name="bridge",
        prefix="bridge/",
        code_file="bridge/Code.js",
        header_re=re.compile(r"GAS Bridge v(\d+\.\d+)"),
        inline_re=re.compile(r"version: '(\d+\.\d+)'"),
        inline_label="_info() version",
    ),
    "a8s": Component(
        name="a8s",
        prefix="a8s/",
        code_file="a8s/Code.js",
        header_re=re.compile(r"A8S v(\d+\.\d+)"),
        inline_re=re.compile(r"const VERSION = '(\d+\.\d+)';"),
        inline_label="VERSION constant",
    ),
}


def parse_version(version: str) -> tuple[int, int]:
    major, minor = version.split(".", 1)
    return int(major), int(minor)


def version_tuple(version: str) -> tuple[int, int]:
    return parse_version(version)


def is_version_bump(before: str | None, after: str | None) -> bool:
    if after is None:
        return False
    if before is None:
        return True
    return version_tuple(after) > version_tuple(before)


def path_requires_bump(path: str) -> bool:
    for prefix in EXCLUDE_PREFIXES:
        if path.startswith(prefix):
            return False
    for suffix in EXCLUDE_SUFFIXES:
        if path.endswith(suffix):
            return False
    return any(path.startswith(c.prefix) for c in COMPONENTS.values())


def changed_files(range_spec: str, repo_root: Path = REPO_ROOT) -> list[str]:
    proc = subprocess.run(
        ["git", "diff", "--name-only", range_spec],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return []
    return [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]


def file_at_rev(rev: str, path: str, repo_root: Path = REPO_ROOT) -> str | None:
    proc = subprocess.run(
        ["git", "show", f"{rev}:{path}"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout


def extract_versions(content: str, component: Component) -> tuple[str | None, str | None]:
    header = component.header_re.search(content)
    inline = component.inline_re.search(content)
    return (
        header.group(1) if header else None,
        inline.group(1) if inline else None,
    )


def components_needing_bump(paths: list[str]) -> list[Component]:
    names: list[str] = []
    for path in paths:
        if not path_requires_bump(path):
            continue
        for component in COMPONENTS.values():
            if path.startswith(component.prefix) and component.name not in names:
                names.append(component.name)
    return [COMPONENTS[name] for name in names]


def check_component(
    component: Component,
    base_content: str | None,
    head_content: str | None,
) -> list[str]:
    errors: list[str] = []
    if head_content is None:
        errors.append(f"{component.code_file}: missing on HEAD")
        return errors

    base_header, base_inline = (
        extract_versions(base_content, component) if base_content else (None, None)
    )
    head_header, head_inline = extract_versions(head_content, component)

    if head_header is None:
        errors.append(f"{component.code_file}: missing header version (e.g. A8S v1.0)")
    if head_inline is None:
        errors.append(
            f"{component.code_file}: missing {component.inline_label} "
            f"(match header version)"
        )
    if head_header and head_inline and head_header != head_inline:
        errors.append(
            f"{component.code_file}: header v{head_header} != "
            f"{component.inline_label} {head_inline}"
        )

    if head_header and not is_version_bump(base_header, head_header):
        before = base_header or "(none)"
        errors.append(
            f"{component.code_file}: header version not bumped ({before} -> {head_header})"
        )
    if head_inline and not is_version_bump(base_inline, head_inline):
        before = base_inline or "(none)"
        errors.append(
            f"{component.code_file}: {component.inline_label} not bumped "
            f"({before} -> {head_inline})"
        )

    return errors


def check_range(range_spec: str, repo_root: Path = REPO_ROOT) -> list[str]:
    paths = changed_files(range_spec, repo_root)
    needed = components_needing_bump(paths)
    if not needed:
        return []

    if "..." in range_spec:
        base_rev, head_rev = range_spec.split("...", 1)
    elif ".." in range_spec:
        base_rev, head_rev = range_spec.split("..", 1)
    else:
        return [f"invalid diff range: {range_spec!r}"]

    errors: list[str] = []
    for component in needed:
        base_content = file_at_rev(base_rev, component.code_file, repo_root)
        head_content = file_at_rev(head_rev, component.code_file, repo_root)
        errors.extend(check_component(component, base_content, head_content))
    return errors


def _resolve_main_ref(repo_root: Path = REPO_ROOT) -> str | None:
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Require version bumps when bridge/ or a8s/ deployable files change."
    )
    parser.add_argument(
        "--range",
        metavar="REV",
        help="git diff range (default: origin/main...HEAD)",
    )
    args = parser.parse_args(argv)

    range_spec = args.range
    if not range_spec:
        base = _resolve_main_ref()
        if base is None:
            print("Could not resolve main branch for version check.", file=sys.stderr)
            return 1
        range_spec = f"{base}...HEAD"

    errors = check_range(range_spec)
    if not errors:
        print("Version bump check passed.")
        return 0

    for err in errors:
        print(err, file=sys.stderr)
    print(
        "\nBump version in header comment and inline version when changing bridge/ or a8s/.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
