#!/usr/bin/env python3
"""Create a portable, safe-to-share Agent K Skill archive."""
from __future__ import annotations

import argparse
from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZipFile

EXCLUDED_NAMES = {".git", ".DS_Store", "node_modules", "__pycache__"}
EXCLUDED_SUFFIXES = {".env", ".pem", ".key", ".pfx", ".pyc"}


def included(path: Path, root: Path) -> bool:
    relative = path.relative_to(root)
    if any(part in EXCLUDED_NAMES or part.startswith(".env") for part in relative.parts):
        return False
    return path.suffix.lower() not in EXCLUDED_SUFFIXES


def main() -> int:
    parser = argparse.ArgumentParser(description="Package an Agent K Skill directory")
    parser.add_argument("skill_directory", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.skill_directory.resolve()
    skill = root / "SKILL.md"
    if not root.is_dir() or not skill.is_file():
        parser.error("skill_directory must contain SKILL.md")
    source = skill.read_text(encoding="utf-8")
    if not source.startswith("---\n") or "\nname:" not in source or "\ndescription:" not in source:
        parser.error("SKILL.md must contain name and description frontmatter")
    output = (args.output or root.parent / f"{root.name}.agentk-skill.zip").resolve()
    if output.exists() and output.samefile(root):
        parser.error("output cannot be the skill directory")
    files = sorted((path for path in root.rglob("*") if path.is_file() and included(path, root)), key=lambda path: path.as_posix())
    if not files:
        parser.error("no package files found")
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, path.relative_to(root).as_posix())
    print(f"Created {output}")
    for path in files:
        print(f"  {path.relative_to(root).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
