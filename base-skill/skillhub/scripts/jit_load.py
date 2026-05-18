#!/usr/bin/env python3
"""
jit_load.py — just-in-time skill loader.

Downloads a .skill by slug + semver, unzips into
~/.claude/skills/skillhub-installed/<slug>/ (so Claude picks it up at next
session start), and prints the SKILL.md + referenced files so the agent can
"load" the skill inline into the CURRENT session without waiting for a restart.

This is the bridge between "searched and picked a skill" and "use it right now".

Usage:
    python3 jit_load.py <slug> [--version <semver>] [--no-download] [--no-print]
                              [--no-warn]

Exit codes:
    0 on success, 1 on user/config error, 2 on network/IO error,
    3 on declined install (risky-symbol scan tripped and user did not
    confirm with the verbatim 'yes-install').

T-009 (stage 1) — install-time risk-symbol scan
-----------------------------------------------
Installed skills run UNSANDBOXED in the user's shell. The publish pipeline
runs sanitize.py + an LLM review + a manual user confirmation, but a
malicious skill could still slip through. Before recording the install in
the index we scan the unzipped tree for ten high-risk Python/shell
patterns (os.system, subprocess.*, eval/exec, __import__, raw sockets,
file writes, HTTP libs, env-var reads, absolute/parent-dir paths) and, if
any are found, require an explicit 'yes-install' confirmation on stdin
before proceeding. Anything else aborts and rolls back the unzip.

The --no-warn flag skips this scan entirely. Only use it when the caller
has already done its own pre-scan; in interactive use the default is
always to scan.

Stages 2 (RestrictedPython execution) and 3 (gVisor/container) of T-009
are tracked separately under T-033 — multi-week effort. This stage 1
turns a silent install of risky code into a loud opt-in.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

try:
    from identity import load_identity, _validate_base_url, DEFAULT_BASE_URL
except ImportError:
    sys.path.insert(0, str(Path(__file__).parent))
    from identity import load_identity, _validate_base_url, DEFAULT_BASE_URL

INSTALLED_ROOT = Path.home() / ".claude" / "skills" / "skillhub-installed"
INSTALLED_INDEX = Path.home() / ".claude" / "skills" / "skillhub" / ".installed.json"
VERSION = "0.0.6"

# T-009 risk-symbol patterns. These are intentionally broad — false positives
# are fine (and expected) because they only trigger a confirmation prompt, not
# a hard block. The user gets to decide whether the flagged code is safe.
#
# Order matters only for readability; every pattern is evaluated against every
# scanned file.
_RISKY_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bos\.system\b"),
     "shells out via os.system"),
    (re.compile(r"\bsubprocess\.(?:run|Popen|call|check_output)\b"),
     "shells out via subprocess"),
    (re.compile(r"\bexec\s*\("),
     "dynamic code execution (exec)"),
    (re.compile(r"\beval\s*\("),
     "dynamic code execution (eval)"),
    (re.compile(r"\b__import__\s*\("),
     "dynamic import (__import__)"),
    (re.compile(r"\bsocket\.(?:socket|create_connection)\b"),
     "raw socket / network"),
    # Match a literal write-mode flag passed to open(). We check this BEFORE
    # the absolute/parent-dir pattern below because both can match the same
    # call; first match wins per file:line below.
    (re.compile(r"\bopen\s*\([^)]*['\"]w"),
     "writes to a file (possibly outside skill dir)"),
    (re.compile(r"\b(?:urllib\.request|requests|httpx)\s*\."),
     "outbound HTTP from script (allowed but flagged)"),
    (re.compile(r"\bos\.environ\s*\["),
     "reads environment variables (possibly secrets)"),
    (re.compile(r"""\bopen\s*\(\s*["'](?:/|~|\.\./)"""),
     "absolute / parent-dir path access"),
]

# File extensions worth scanning. We intentionally keep this list narrow —
# scripts that actually execute. Markdown/JSON/yaml are scrubbed server-side
# by sanitize.py and aren't directly executable by us.
_SCANNED_EXTENSIONS = {".py", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs"}


@dataclass(frozen=True)
class Finding:
    """A single risky-symbol match found during install-time scan."""
    file: str         # path relative to the skill dir
    line: int         # 1-indexed
    pattern_label: str
    snippet: str      # up to 80 chars from the matching line, stripped


# Limit on files we inline into the conversation to avoid blowing the context
MAX_INLINE_FILES = 8
MAX_INLINE_BYTES = 120 * 1024  # 120 KiB total across all inlined files
PRINT_SEPARATOR = "\n" + ("─" * 72) + "\n"


class _StripAuthOnCrossOriginRedirect(urllib.request.HTTPRedirectHandler):
    """Drop the Authorization header when redirecting to a different host.

    The download endpoint returns 302 to a presigned R2 URL; carrying our
    `Authorization: Bearer skh_live_...` across that redirect causes R2 to
    reject the request with `Missing x-amz-content-sha256` because the
    bearer header is interpreted as an AWS-SigV4 attempt instead of using
    the query-string signature.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is None:
            return None
        old_host = urlparse(req.full_url).hostname or ""
        new_host = urlparse(new_req.full_url).hostname or ""
        if old_host != new_host:
            for header in ("Authorization", "authorization"):
                new_req.headers.pop(header, None)
                new_req.unredirected_hdrs.pop(header, None)
        return new_req


_OPENER = urllib.request.build_opener(_StripAuthOnCrossOriginRedirect())


def _get(base_url: str, path: str, api_key: str, follow_redirects: bool = True) -> bytes:
    _validate_base_url(base_url)
    url = base_url.rstrip("/") + path
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "User-Agent": f"skillhub-base-skill/{VERSION}",
        },
    )
    with _OPENER.open(req, timeout=30) as resp:
        return resp.read()


def _resolve_and_download(base_url: str, api_key: str, slug: str, version: str | None) -> tuple[Path, str, str]:
    """Resolve the skill version, download the .skill ZIP, verify content hash.

    Phase 0 §0.18 — every install verifies the server-published SHA-256 of
    the .skill bytes against a locally-computed hash. Refuses installation
    on mismatch. This is a belt-and-suspenders defense against R2 corruption,
    MITM, or (more practically) accidental bucket-level tampering.

    Returns (zip_path, skill_id, resolved_semver).
    """
    # Always fetch metadata — we need the content_hash even if the caller
    # supplied an explicit version.
    meta_bytes = _get(base_url, f"/v1/skills/{slug}", api_key)
    try:
        meta = json.loads(meta_bytes.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise RuntimeError(f"bad metadata response for {slug}: {e}") from e

    skill_id = meta.get("skill_id")
    if not skill_id:
        raise RuntimeError(f"metadata for {slug} missing skill_id")

    if version is None:
        version = meta.get("latest_version") or meta.get("current_version")
        if not version:
            raise RuntimeError(f"could not resolve latest version for {slug}")

    # Look up the expected content hash for the resolved version
    expected_hash = None
    for v in meta.get("versions", []):
        if v.get("semver") == version:
            expected_hash = v.get("content_hash")
            break
    if not expected_hash:
        # Server may be on an older deploy — warn but proceed (Phase 0 grace
        # period; Phase 2 tightens to hard refusal when every server we
        # talk to is guaranteed to emit content_hash).
        print(
            f"warning: server did not return content_hash for {slug} v{version}; "
            f"skipping integrity verification",
            file=sys.stderr,
        )

    # Download the .skill
    path = f"/v1/skills/{slug}/versions/{version}/download"
    content = _get(base_url, path, api_key)

    # Verify content hash BEFORE writing to disk — refuse to materialize a
    # tampered file even momentarily.
    if expected_hash:
        actual_hash = hashlib.sha256(content).hexdigest()
        if actual_hash != expected_hash:
            raise RuntimeError(
                f"content hash mismatch for {slug} v{version}: "
                f"expected {expected_hash}, got {actual_hash}. "
                f"Refusing to install. This may indicate R2 corruption, "
                f"MITM, or bucket tampering."
            )
        print(f"content verified: sha256:{actual_hash[:16]}...", file=sys.stderr)

    tmp = tempfile.NamedTemporaryFile(suffix=".skill", delete=False)
    tmp.write(content)
    tmp.close()
    return Path(tmp.name), skill_id, version


def _unzip_skill(zip_path: Path, target_dir: Path) -> None:
    if target_dir.exists():
        # Rollback target for safety
        rollback = target_dir.with_name(target_dir.name + ".previous")
        if rollback.exists():
            shutil.rmtree(rollback)
        target_dir.rename(rollback)

    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        # Validate no path traversal
        for name in zf.namelist():
            if name.startswith("/") or ".." in Path(name).parts:
                raise RuntimeError(f"refusing to extract suspicious path: {name}")
        zf.extractall(target_dir)


def _scan_for_risky_symbols(target_dir: Path) -> list[Finding]:
    """Walk `target_dir` and flag executable files containing risky patterns.

    Returns one Finding per (file, line, pattern_label) hit. A single line can
    produce multiple findings if it matches several patterns; that's fine — we
    want the user to see every reason a line was flagged.

    Patterns are intentionally lenient — false positives are tolerated because
    they only force a confirmation prompt, not a block. See module docstring
    and T-009 for the full design rationale.
    """
    findings: list[Finding] = []
    if not target_dir.exists() or not target_dir.is_dir():
        return findings

    for path in sorted(target_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in _SCANNED_EXTENSIONS:
            continue

        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            # Unreadable file in the install tree is itself suspicious, but the
            # scan is best-effort — let _update_installed_index proceed and let
            # later runtime errors surface it. We still want to flag it so the
            # user notices something is off.
            try:
                rel = path.relative_to(target_dir).as_posix()
            except ValueError:
                rel = str(path)
            findings.append(Finding(
                file=rel, line=0,
                pattern_label="unreadable file in skill dir",
                snippet="",
            ))
            continue

        try:
            rel = path.relative_to(target_dir).as_posix()
        except ValueError:
            rel = str(path)

        for line_no, line in enumerate(text.splitlines(), start=1):
            for pattern, label in _RISKY_PATTERNS:
                if pattern.search(line):
                    snippet = line.strip()
                    if len(snippet) > 80:
                        snippet = snippet[:77] + "..."
                    findings.append(Finding(
                        file=rel,
                        line=line_no,
                        pattern_label=label,
                        snippet=snippet,
                    ))
    return findings


def _print_findings(findings: list[Finding]) -> None:
    """Render findings to stderr in the T-009 format."""
    for f in findings:
        print(
            f"⚠️  RISKY: {f.file}:{f.line} — {f.pattern_label}",
            file=sys.stderr,
        )
        if f.snippet:
            print(f"    {f.snippet}", file=sys.stderr)


def _prompt_install_confirmation(stdin=None, stdout=None) -> bool:
    """Ask the user to type 'yes-install' verbatim to proceed.

    Returns True only on the exact string 'yes-install' (after stripping
    trailing whitespace / newline). Anything else — including 'yes', 'y',
    'ok', EOF from a closed stdin in a non-interactive context — returns
    False and the caller MUST roll back.

    `stdin` / `stdout` default to `sys.stdin` / `sys.stderr` so tests can
    inject their own streams. The prompt is written to `stdout` (which is
    sys.stderr by default, intentionally — keeping stdout reserved for the
    inlined SKILL.md so a piped consumer never sees the prompt text).
    """
    if stdin is None:
        stdin = sys.stdin
    if stdout is None:
        stdout = sys.stderr

    print(
        "\nThis skill contains code that can run shell commands, access\n"
        "environment variables, or write outside its own directory. Skills\n"
        "run unsandboxed.\n\n"
        "Install anyway? Type 'yes-install' exactly to confirm. Anything else\n"
        "aborts.\n> ",
        end="", file=stdout, flush=True,
    )

    # If stdin is closed / non-interactive / EOFs immediately, treat as decline.
    try:
        answer = stdin.readline()
    except (OSError, ValueError):
        return False
    if not answer:
        # readline() returns "" on EOF; truly empty input declines.
        return False
    return answer.rstrip("\r\n") == "yes-install"


def _rollback_unzip(target_dir: Path) -> None:
    """Undo a fresh unzip after a declined install.

    Deletes `target_dir` and, if a `<name>.previous` snapshot exists from the
    previous install (set up by `_unzip_skill`), restores it. We intentionally
    do NOT touch the installed index — if the user is declining a NEW version
    of an already-installed skill, the old version's index entry is still
    correct and pointing at the restored directory.
    """
    if target_dir.exists():
        try:
            shutil.rmtree(target_dir)
        except OSError as e:
            print(
                f"warning: failed to remove {target_dir} during rollback: {e}",
                file=sys.stderr,
            )
    rollback = target_dir.with_name(target_dir.name + ".previous")
    if rollback.exists():
        try:
            rollback.rename(target_dir)
        except OSError as e:
            print(
                f"warning: failed to restore previous install from {rollback}: {e}",
                file=sys.stderr,
            )


def _update_installed_index(slug: str, version: str, skill_id: str) -> None:
    INSTALLED_INDEX.parent.mkdir(parents=True, exist_ok=True)
    if INSTALLED_INDEX.exists():
        try:
            with INSTALLED_INDEX.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            data = {}
    else:
        data = {}
    data[slug] = {
        "version": version,
        "skill_id": skill_id,
        "auto_update_consent": data.get(slug, {}).get("auto_update_consent", False),
    }
    tmp = INSTALLED_INDEX.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    tmp.replace(INSTALLED_INDEX)


def _inline_print(skill_dir: Path) -> None:
    """Print SKILL.md + small referenced files so the agent can act on them immediately."""
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        print(f"warning: {skill_dir} has no SKILL.md", file=sys.stderr)
        return

    print("=" * 72)
    print(f"INLINED SKILL: {skill_dir.name}")
    print("The following content was just installed. Treat it as if it were a")
    print("loaded skill in the current session. Follow its instructions when")
    print("the user's request matches its triggers.")
    print("=" * 72)
    print()
    print(f"--- {skill_md.relative_to(skill_dir)} ---")
    print(skill_md.read_text(encoding="utf-8", errors="replace"))

    total_bytes = skill_md.stat().st_size
    files_printed = 1

    # Also inline any referenced references/*.md files up to the budget
    references_dir = skill_dir / "references"
    if references_dir.is_dir():
        for ref in sorted(references_dir.rglob("*.md")):
            if files_printed >= MAX_INLINE_FILES:
                break
            size = ref.stat().st_size
            if total_bytes + size > MAX_INLINE_BYTES:
                print(f"\n(skipped {ref.relative_to(skill_dir)}: would exceed inline budget)")
                continue
            print(PRINT_SEPARATOR)
            print(f"--- {ref.relative_to(skill_dir)} ---")
            print(ref.read_text(encoding="utf-8", errors="replace"))
            total_bytes += size
            files_printed += 1

    print()
    print("=" * 72)
    print(f"END INLINED SKILL ({files_printed} files, {total_bytes} bytes)")
    print(f"Persisted at: {skill_dir}")
    print(f"Next session will auto-discover this skill.")
    print("=" * 72)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Just-in-time skill loader.")
    parser.add_argument("slug", help="Skill slug to install.")
    parser.add_argument("--version", default=None, help="Specific semver (default: latest)")
    parser.add_argument(
        "--no-download", action="store_true",
        help="Skip download (assumes skill already at install location).",
    )
    parser.add_argument(
        "--no-print", action="store_true",
        help="Do not inline the SKILL.md into stdout (useful for scripted installs).",
    )
    parser.add_argument(
        "--no-warn", action="store_true",
        help=(
            "Skip the T-009 risk-symbol scan after unzip. Only use this when "
            "the caller is doing its own pre-scan (e.g. an automated pipeline "
            "that vets every installed skill); the trade-off is that any "
            "risky Python/shell symbol — os.system, subprocess.*, eval, "
            "exec, raw sockets, etc. — lands silently without user "
            "confirmation."
        ),
    )
    args = parser.parse_args(argv)

    target_dir = INSTALLED_ROOT / args.slug

    if not args.no_download:
        ident = load_identity()
        if ident is None:
            print("error: not registered. run `identity.py register` first.", file=sys.stderr)
            return 1
        base_url = ident.get("base_url", DEFAULT_BASE_URL)

        try:
            zip_path, skill_id, resolved_version = _resolve_and_download(
                base_url, ident["api_key"], args.slug, args.version
            )
        except (RuntimeError, urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"download failed: {e}", file=sys.stderr)
            return 2

        try:
            _unzip_skill(zip_path, target_dir)
        except (RuntimeError, zipfile.BadZipFile, OSError) as e:
            print(f"unzip failed: {e}", file=sys.stderr)
            return 2
        finally:
            try:
                zip_path.unlink()
            except OSError:
                pass

        # T-009 stage 1 — install-time risk-symbol scan. Runs AFTER unzip so we
        # can read the actual files the user is about to run, but BEFORE
        # _update_installed_index so a declined install never appears in the
        # index. --no-warn bypasses for automation.
        if not args.no_warn:
            findings = _scan_for_risky_symbols(target_dir)
            if findings:
                _print_findings(findings)
                if not _prompt_install_confirmation():
                    print(
                        f"\ninstall declined for '{args.slug}' "
                        f"({len(findings)} risky finding(s)); rolling back.",
                        file=sys.stderr,
                    )
                    _rollback_unzip(target_dir)
                    return 3

        _update_installed_index(args.slug, resolved_version, skill_id)
    else:
        if not target_dir.exists():
            print(f"error: {target_dir} does not exist", file=sys.stderr)
            return 1

    if not args.no_print:
        _inline_print(target_dir)

    return 0


if __name__ == "__main__":
    sys.exit(main())
