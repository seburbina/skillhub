#!/usr/bin/env python3
"""
Regression suite for scripts/intent_detect.py.

Zero-dependency: uses only stdlib `unittest` + `subprocess` so it runs in
the same minimal environment as the script itself. No pytest, no mocks.

Run:
    python3 -m unittest base-skill.skillhub.tests.test_intent_detect

…or directly:
    cd base-skill/skillhub
    python3 -m unittest tests.test_intent_detect

The cases are split into four groups:
- True positives: clear task descriptions that SHOULD prompt.
- True negatives: Q&A / explanation / discussion that should NOT prompt.
- Edge cases: trivial / ambiguous inputs at the threshold.
- Format/lemmatization specials: regression coverage for verbs and plurals
  added in the same PR.

Each case asserts both `is_task` polarity and a confidence-bucket so future
lexicon edits can't silently flip from "barely fires" to "barely doesn't
fire" without the test catching it.
"""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "intent_detect.py"


def _run(text: str) -> dict:
    """Invoke intent_detect.py via subprocess and return its parsed JSON."""
    result = subprocess.run(
        ["python3", str(SCRIPT), text],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError(f"intent_detect exited {result.returncode}: {result.stderr}")
    return json.loads(result.stdout)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

# Each row: (label, text, expected_is_task, min_confidence)
# `min_confidence` only matters when expected_is_task is True — guards against
# accidental near-threshold demotions on lexicon edits.
TRUE_POSITIVES = [
    ("TP-1",  "extract tables from this pdf",                        True,  0.80),
    ("TP-2",  "convert csv to xlsx",                                 True,  0.80),
    ("TP-3",  "redact all emails from these docs",                   True,  0.70),
    ("TP-4",  "parse this log file",                                 True,  0.95),
    ("TP-5",  "transcribe this audio",                               True,  0.70),
    ("TP-6",  "summarize this jupyter notebook",                     True,  0.70),
    ("TP-7",  "analyze sales data in xlsx",                          True,  0.80),
    ("TP-8",  "scrape product prices from this URL",                 True,  0.50),
    ("TP-9",  "deduplicate emails in this csv",                      True,  0.95),
    ("TP-10", "translate this text from french to english",          True,  0.50),
]

TRUE_NEGATIVES = [
    ("TN-1", "what is the difference between json and yaml",         False, None),
    ("TN-2", "explain how pdf compression works",                    False, None),
    ("TN-3", "tell me about pdf signatures",                         False, None),
    ("TN-4", "why does parsing fail on this file",                   False, None),
    ("TN-5", "how do I know if a file is encrypted",                 False, None),
    ("TN-6", "what does this error mean",                            False, None),
    # Soft-question Q&A patterns added in this PR
    ("TN-7", "how would I extract pdf tables",                       False, None),
    ("TN-8", "is there a way to redact emails",                      False, None),
    ("TN-9", "should I parse json or yaml here",                     False, None),
    ("TN-10","is it possible to convert pdf to xlsx",                False, None),
    ("TN-11","can I run this through the parser",                    False, None),
    ("TN-12","do you know if this file is corrupted",                False, None),
]

EDGE_CASES = [
    ("EDGE-1", "yes",                                                False, None),  # < 3 tokens
    ("EDGE-2", "ok do it",                                           False, None),  # no verb match
    ("EDGE-3", "I have a pdf",                                       False, None),  # noun only, no verb
    ("EDGE-4", "parse and summarize this pdf",                       True,  0.85),  # multi-verb
]

# Verbs added in this PR (regression: lexicon must not lose these)
NEW_VERBS = [
    ("V-MAKE",    "make this Python code faster",                    True,  0.50),
    ("V-WRITE",   "help me write unit tests for this module",        True,  0.50),
    ("V-FIND",    "find all the duplicates in this csv",             True,  0.70),
    ("V-REMOVE",  "remove personal information from these documents",True,  0.50),
    ("V-FIX",     "fix the broken xml in this feed",                 True,  0.70),
    ("V-UPDATE",  "update the README to mention the new flag",       True,  0.50),
]

# Lemmatization (plurals) — regression for the trailing-s stripper
LEMMATIZATION = [
    ("LEM-1", "deduplicate the csvs in this folder",                 True,  0.70),
    ("LEM-2", "scrub these documents of all PII",                    True,  0.70),
    ("LEM-3", "compare commits across these branches",               True,  0.70),
]


# ---------------------------------------------------------------------------
# Boilerplate test class
# ---------------------------------------------------------------------------

class IntentDetectTests(unittest.TestCase):

    def _check(self, label, text, expected_is_task, min_conf):
        result = _run(text)
        is_task = result["is_task"]
        conf = result["confidence"]
        self.assertEqual(
            is_task, expected_is_task,
            f"[{label}] expected is_task={expected_is_task} but got {is_task} "
            f"(confidence={conf}, text={text!r})",
        )
        if expected_is_task and min_conf is not None:
            self.assertGreaterEqual(
                conf, min_conf,
                f"[{label}] confidence {conf} below floor {min_conf} (text={text!r})",
            )

    # One test method per group so failures pinpoint the category.
    def test_true_positives(self):
        for label, text, exp, mc in TRUE_POSITIVES:
            with self.subTest(label=label, text=text):
                self._check(label, text, exp, mc)

    def test_true_negatives(self):
        for label, text, exp, mc in TRUE_NEGATIVES:
            with self.subTest(label=label, text=text):
                self._check(label, text, exp, mc)

    def test_edge_cases(self):
        for label, text, exp, mc in EDGE_CASES:
            with self.subTest(label=label, text=text):
                self._check(label, text, exp, mc)

    def test_new_verbs(self):
        for label, text, exp, mc in NEW_VERBS:
            with self.subTest(label=label, text=text):
                self._check(label, text, exp, mc)

    def test_lemmatization(self):
        for label, text, exp, mc in LEMMATIZATION:
            with self.subTest(label=label, text=text):
                self._check(label, text, exp, mc)


if __name__ == "__main__":
    unittest.main()
