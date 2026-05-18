#!/usr/bin/env python3
"""
Regression suite for scripts/jit_load.py — T-009 install-time risk-symbol
scan and confirmation flow.

Zero-dependency: uses only stdlib `unittest` + `subprocess` + `tempfile`, so
it runs in the same minimal environment as the script itself. No pytest, no
mocks. Same shape as test_intent_detect.py.

Two test surfaces:

  1. `_scan_for_risky_symbols(target_dir)` — invoked in-process so we can
     introspect Finding tuples directly. Covers the happy-path detection
     matrix.

  2. `jit_load.py <slug> --no-download` — invoked via subprocess so we
     exercise the real CLI plumbing: --no-warn, stdin handling, exit codes,
     and the rollback of `<target_dir>.previous` on decline.

Run:
    cd base-skill/skillhub
    python3 -m unittest tests.test_jit_load_scan -v
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
SCRIPT = SCRIPT_DIR / "jit_load.py"


def _load_jit_load_module():
    """Import jit_load.py as a module without depending on PYTHONPATH.

    The script imports identity.py via a sys.path tweak; we replay that
    here so the import works whatever the test cwd is. We also register
    the module in sys.modules BEFORE exec_module() because Python 3.14's
    dataclass decorator does forward-reference resolution via
    sys.modules[cls.__module__] and falls over otherwise.
    """
    if str(SCRIPT_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPT_DIR))
    name = "jit_load_under_test"
    spec = importlib.util.spec_from_file_location(name, SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


jit_load = _load_jit_load_module()


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _run_subprocess(
    target_dir: Path,
    slug: str,
    stdin_input: str | None,
    extra_args: list[str] | None = None,
    close_stdin: bool = False,
) -> subprocess.CompletedProcess:
    """Exec jit_load.py through the normal download path, with the download
    and unzip steps monkey-patched to no-ops so we exercise the real
    scan-and-prompt code under test.

    The launcher script:
      1. Imports jit_load.
      2. Repoints INSTALLED_ROOT / INSTALLED_INDEX at a sandbox dir so we
         never touch ~/.claude.
      3. Stubs load_identity, _resolve_and_download, and _unzip_skill so the
         CLI behaves as if it successfully downloaded and unzipped a skill
         that is ALREADY present at target_dir (laid down by the test).
      4. Invokes main() and returns its exit code.

    This is intentionally NOT using --no-download. We want the scan to run,
    and the scan is gated on the download path because that's where the
    "newly landed code" threat applies.
    """
    launcher = (
        "import sys, pathlib\n"
        f"sys.path.insert(0, {str(SCRIPT_DIR)!r})\n"
        "import jit_load\n"
        f"jit_load.INSTALLED_ROOT = pathlib.Path({str(target_dir.parent)!r})\n"
        f"jit_load.INSTALLED_INDEX = pathlib.Path({str(target_dir.parent / '.installed.json')!r})\n"
        # Stub out network + filesystem mutators so the test fixture stands in
        # for a real downloaded+unzipped skill.
        "jit_load.load_identity = lambda: {'api_key': 'test', 'base_url': 'https://example.invalid'}\n"
        # Use a real, empty file so the `zip_path.unlink()` cleanup in main()
        # is a no-op (the surrounding try/except OSError also handles missing
        # files, but it's cleaner to give it a real path to delete).
        f"_stub_zip = pathlib.Path({str(target_dir.parent / '_stub.skill')!r})\n"
        "_stub_zip.touch()\n"
        "jit_load._resolve_and_download = lambda *a, **kw: (_stub_zip, 'sk_test', '1.0.0')\n"
        "jit_load._unzip_skill = lambda zip_path, td: None\n"
        f"sys.argv = ['jit_load.py', {slug!r}, '--no-print']\n"
    )
    if extra_args:
        launcher += f"sys.argv.extend({extra_args!r})\n"
    launcher += "sys.exit(jit_load.main())\n"

    if close_stdin:
        return subprocess.run(
            [sys.executable, "-c", launcher],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=15,
        )
    return subprocess.run(
        [sys.executable, "-c", launcher],
        input=stdin_input or "",
        capture_output=True,
        text=True,
        timeout=15,
    )


# ---------------------------------------------------------------------------
# Direct-function tests for _scan_for_risky_symbols
# ---------------------------------------------------------------------------

class ScanFunctionTests(unittest.TestCase):
    """Drive _scan_for_risky_symbols(target_dir) directly."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_empty_target_returns_empty(self) -> None:
        # T-009 DoD: empty target dir → returns []
        findings = jit_load._scan_for_risky_symbols(self.root)
        self.assertEqual(findings, [])

    def test_nonexistent_target_returns_empty(self) -> None:
        # Defensive: a missing dir is treated like an empty one. main() ensures
        # the unzip happened before we get here, so this is mostly future-proofing.
        findings = jit_load._scan_for_risky_symbols(self.root / "does-not-exist")
        self.assertEqual(findings, [])

    def test_no_risky_symbols_returns_empty(self) -> None:
        # T-009 DoD case 1
        _write(self.root / "SKILL.md", "# Safe skill\nJust docs.\n")
        _write(self.root / "scripts" / "hello.py", "def greet():\n    return 'hi'\n")
        _write(self.root / "scripts" / "tool.sh", "#!/bin/sh\necho hello\n")
        findings = jit_load._scan_for_risky_symbols(self.root)
        self.assertEqual(findings, [])

    def test_os_system_in_py_flagged(self) -> None:
        # T-009 DoD case 2 — os.system on a known line
        _write(
            self.root / "scripts" / "bad.py",
            "import os\n"
            "os.system('rm -rf /tmp/x')\n",
        )
        findings = jit_load._scan_for_risky_symbols(self.root)
        self.assertEqual(len(findings), 1)
        f = findings[0]
        self.assertEqual(f.file, "scripts/bad.py")
        self.assertEqual(f.line, 2)
        self.assertEqual(f.pattern_label, "shells out via os.system")
        self.assertIn("os.system", f.snippet)

    def test_multiple_findings_across_two_files(self) -> None:
        # T-009 DoD case 3
        _write(
            self.root / "a.py",
            "import subprocess\n"
            "subprocess.run(['ls'])\n",
        )
        _write(
            self.root / "b.py",
            "eval('1+1')\n"
            "exec('print(1)')\n",
        )
        findings = jit_load._scan_for_risky_symbols(self.root)
        labels = {f.pattern_label for f in findings}
        files = {f.file for f in findings}
        self.assertEqual(files, {"a.py", "b.py"})
        # subprocess.run, eval, exec — at minimum
        self.assertIn("shells out via subprocess", labels)
        self.assertIn("dynamic code execution (eval)", labels)
        self.assertIn("dynamic code execution (exec)", labels)
        self.assertGreaterEqual(len(findings), 3)

    def test_all_ten_patterns_each_trigger(self) -> None:
        # Belt-and-suspenders — make sure every documented pattern actually fires.
        # If someone tightens a regex and silently breaks coverage, this catches it.
        content = (
            "import os, socket, subprocess, urllib.request\n"   # 1
            "os.system('x')\n"                                   # 2
            "subprocess.run(['x'])\n"                            # 3
            "exec('x')\n"                                        # 4
            "eval('x')\n"                                        # 5
            "__import__('os')\n"                                 # 6
            "socket.socket()\n"                                  # 7
            "open('out.txt', 'w')\n"                             # 8
            "urllib.request.urlopen('https://x')\n"              # 9
            "os.environ['SECRET']\n"                             # 10
            "open('/etc/passwd')\n"                              # 11
        )
        _write(self.root / "everything.py", content)
        findings = jit_load._scan_for_risky_symbols(self.root)
        labels = {f.pattern_label for f in findings}
        # All ten T-009 pattern labels must appear at least once.
        expected = {
            "shells out via os.system",
            "shells out via subprocess",
            "dynamic code execution (exec)",
            "dynamic code execution (eval)",
            "dynamic import (__import__)",
            "raw socket / network",
            "writes to a file (possibly outside skill dir)",
            "outbound HTTP from script (allowed but flagged)",
            "reads environment variables (possibly secrets)",
            "absolute / parent-dir path access",
        }
        missing = expected - labels
        self.assertFalse(
            missing,
            f"missing labels: {missing}; got {labels}",
        )

    def test_non_executable_extensions_skipped(self) -> None:
        # Markdown/JSON should NOT be scanned — sanitize.py covers those.
        _write(
            self.root / "README.md",
            "Example: `os.system('echo hi')` (just a doc snippet)\n",
        )
        _write(
            self.root / "config.json",
            '{"cmd": "os.system(\'ls\')"}\n',
        )
        findings = jit_load._scan_for_risky_symbols(self.root)
        self.assertEqual(findings, [])

    def test_snippet_truncated_to_80_chars(self) -> None:
        long_line = "os.system('" + ("x" * 200) + "')"
        _write(self.root / "long.py", long_line + "\n")
        findings = jit_load._scan_for_risky_symbols(self.root)
        self.assertEqual(len(findings), 1)
        self.assertLessEqual(len(findings[0].snippet), 80)


# ---------------------------------------------------------------------------
# End-to-end CLI tests via subprocess
# ---------------------------------------------------------------------------

def _seed_skill(target_dir: Path, with_risky: bool) -> None:
    """Lay out a fake unzipped skill at `target_dir`."""
    target_dir.mkdir(parents=True, exist_ok=True)
    _write(target_dir / "SKILL.md", "# fixture\nFixture skill.\n")
    if with_risky:
        _write(
            target_dir / "scripts" / "do_things.py",
            "import os\nos.system('echo pwned')\n",
        )
    else:
        _write(
            target_dir / "scripts" / "do_things.py",
            "def greet():\n    return 'hi'\n",
        )


class CLIConfirmationFlowTests(unittest.TestCase):
    """Drive jit_load.py via subprocess to verify exit codes + rollback."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.installed_root = Path(self.tmp.name)
        self.slug = "fixture-skill"
        self.target = self.installed_root / self.slug

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_no_warn_skips_scan_even_with_risky_content(self) -> None:
        # T-009 DoD case 4
        _seed_skill(self.target, with_risky=True)
        result = _run_subprocess(
            self.target, self.slug, stdin_input="",
            extra_args=["--no-warn"],
        )
        self.assertEqual(result.returncode, 0,
                         f"stderr={result.stderr}\nstdout={result.stdout}")
        # No prompt was issued — confirm by absence of the prompt text.
        self.assertNotIn("yes-install", result.stderr)
        # Install dir still exists.
        self.assertTrue(self.target.is_dir())

    def test_stdin_closed_auto_declines(self) -> None:
        # T-009 DoD case 5 — non-interactive run with no stdin
        _seed_skill(self.target, with_risky=True)
        result = _run_subprocess(
            self.target, self.slug, stdin_input=None,
            close_stdin=True,
        )
        self.assertEqual(result.returncode, 3,
                         f"stderr={result.stderr}\nstdout={result.stdout}")
        # Rollback: target dir should be gone (no .previous existed → cleanup).
        self.assertFalse(self.target.exists())

    def test_yes_install_verbatim_confirms(self) -> None:
        # T-009 DoD case 7
        _seed_skill(self.target, with_risky=True)
        result = _run_subprocess(
            self.target, self.slug, stdin_input="yes-install\n",
        )
        self.assertEqual(result.returncode, 0,
                         f"stderr={result.stderr}\nstdout={result.stdout}")
        self.assertTrue(self.target.is_dir())
        # And the warning was actually printed.
        self.assertIn("RISKY", result.stderr)
        self.assertIn("os.system", result.stderr)

    def test_yes_alone_does_not_confirm(self) -> None:
        # T-009 DoD case 8 — must be 'yes-install' verbatim
        _seed_skill(self.target, with_risky=True)
        result = _run_subprocess(
            self.target, self.slug, stdin_input="yes\n",
        )
        self.assertEqual(result.returncode, 3,
                         f"stderr={result.stderr}\nstdout={result.stdout}")
        self.assertFalse(self.target.exists())

    def test_no_risky_content_no_prompt_no_exit3(self) -> None:
        # Sanity: clean skill installs silently without a prompt.
        _seed_skill(self.target, with_risky=False)
        result = _run_subprocess(
            self.target, self.slug, stdin_input="",
        )
        self.assertEqual(result.returncode, 0,
                         f"stderr={result.stderr}\nstdout={result.stdout}")
        self.assertNotIn("yes-install", result.stderr)
        self.assertTrue(self.target.is_dir())

    def test_decline_rolls_back_and_restores_previous(self) -> None:
        # Sets up an existing install at <target>.previous and verifies that
        # declining the new one restores it. Exercises _rollback_unzip when
        # a snapshot is present (path that .previous gets created on the
        # next install, simulated here by hand).
        previous = self.target.with_name(self.target.name + ".previous")
        previous.mkdir(parents=True)
        _write(previous / "MARKER", "previous-install\n")

        _seed_skill(self.target, with_risky=True)
        result = _run_subprocess(
            self.target, self.slug, stdin_input="no\n",
        )
        self.assertEqual(result.returncode, 3,
                         f"stderr={result.stderr}\nstdout={result.stdout}")
        # target_dir restored from .previous
        self.assertTrue(self.target.is_dir())
        self.assertTrue((self.target / "MARKER").exists())
        # .previous itself is gone (renamed back over target_dir)
        self.assertFalse(previous.exists())


if __name__ == "__main__":
    unittest.main()
