#!/usr/bin/env python3
"""
build_bundle.py — package every skill under base-skill/ into one .skill zip.

The release artifact (`skillhub.skill`) historically contained one folder
(`skillhub/`). T-008 splits the base skill into multiple narrower SKILL.md
files living in sibling directories — but users still install via a single
`curl + unzip` against one release asset. This script produces that one
asset by gathering every immediate subdirectory of `base-skill/` that has
a `SKILL.md` and zipping them all into one .skill bundle.

When `unzip skillhub.skill -d ~/.claude/skills/` runs, each skill lands
side-by-side at `~/.claude/skills/<skill>/`. The Claude Code harness
discovers each independently.

Usage:
    python3 base-skill/build_bundle.py <output.skill>

Exit codes:
    0 success
    1 missing input / no skills found
    2 zip-write failure
"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent  # base-skill/


def _discover_skills(base: Path) -> list[Path]:
    """Find every immediate subdir of `base` that contains SKILL.md."""
    skills: list[Path] = []
    for child in sorted(base.iterdir()):
        if child.is_dir() and (child / "SKILL.md").is_file():
            skills.append(child)
    return skills


def _zip_skill(zf: zipfile.ZipFile, skill_dir: Path) -> int:
    """Add every file in `skill_dir` to `zf`, preserving the skill-dir name
    as the top-level prefix. Returns the count of files added."""
    count = 0
    for path in sorted(skill_dir.rglob("*")):
        if not path.is_file():
            continue
        # Skip Python bytecode and OS junk
        if "__pycache__" in path.parts or path.name == ".DS_Store":
            continue
        arcname = path.relative_to(skill_dir.parent)
        zf.write(path, arcname)
        count += 1
    return count


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {Path(__file__).name} <output.skill>", file=sys.stderr)
        return 1

    output = Path(argv[1]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    skills = _discover_skills(BASE_DIR)
    if not skills:
        print(f"error: no skills found under {BASE_DIR}", file=sys.stderr)
        return 1

    print(f"Bundling {len(skills)} skill(s) into {output}:")
    total_files = 0
    try:
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
            for skill in skills:
                n = _zip_skill(zf, skill)
                total_files += n
                print(f"  - {skill.name}/  ({n} files)")
    except OSError as e:
        print(f"error: zip write failed: {e}", file=sys.stderr)
        return 2

    size_kb = output.stat().st_size / 1024
    print(f"OK: {total_files} files, {size_kb:.1f} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
