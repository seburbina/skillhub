/**
 * Unit tests for the typosquat Levenshtein distance helper.
 *
 * The full `checkTyposquat` function requires a DB connection, so we only
 * test the pure `levenshtein()` function here. Integration tests for the
 * full check should be added once a test DB harness is available.
 */
import { describe, it, expect } from "vitest";
import { levenshtein } from "@/lib/typosquat";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("pdf", "pdf")).toBe(0);
  });

  it("returns string length for empty vs non-empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("hello", "")).toBe(5);
  });

  it("computes single-char edit", () => {
    expect(levenshtein("pdf", "pdd")).toBe(1); // substitution
    expect(levenshtein("pdf", "pd")).toBe(1);  // deletion
    expect(levenshtein("pdf", "pdfs")).toBe(1); // insertion
  });

  it("computes multi-char edits", () => {
    expect(levenshtein("pdf", "pf")).toBe(1);
    expect(levenshtein("pdf", "pdff")).toBe(1);
    expect(levenshtein("commit", "comit")).toBe(1);
    // "commit" → "comitt" is distance 2 (delete 'm', insert 't')
    expect(levenshtein("commit", "comitt")).toBe(2);
  });

  it("handles typosquat-style names", () => {
    // "pd" is distance 1 from "pdf" — suspicious
    expect(levenshtein("pd", "pdf")).toBe(1);
    // "pfd" is distance 2 from "pdf" (transposition = 2 in Levenshtein)
    expect(levenshtein("pfd", "pdf")).toBe(2);
    // "xlsx" vs "xlxs" — transposition
    expect(levenshtein("xlxs", "xlsx")).toBe(2);
  });

  it("returns correct distance for completely different strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("is symmetric", () => {
    expect(levenshtein("abc", "ab")).toBe(levenshtein("ab", "abc"));
    expect(levenshtein("test", "tent")).toBe(levenshtein("tent", "test"));
  });
});
