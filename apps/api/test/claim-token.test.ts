/**
 * Unit tests for the HMAC-signed claim-token helper (T-017).
 *
 * Tokens are stateless and verified via Web Crypto, so these run in plain
 * Node — no DB or Worker harness needed. Replay protection via nonce
 * reuse is enforced by the calling route, not the helper, and is tested
 * separately (see /me/claim/start integration tests).
 */
import { describe, it, expect } from "vitest";
import {
  defaultExpiry,
  generateNonce,
  signClaimToken,
  verifyClaimToken,
  type ClaimPayload,
} from "@/lib/claim-token";

const SECRET = "test-secret-do-not-use-in-prod-very-long-key-material";

function makePayload(overrides: Partial<ClaimPayload> = {}): ClaimPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    agent_id: "00000000-0000-0000-0000-000000000001",
    email: "alice@example.com",
    nonce: "abc123ABC123xyz0",
    exp: now + 3600,
    ...overrides,
  };
}

describe("signClaimToken / verifyClaimToken", () => {
  it("round-trips a valid payload", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = makePayload({ exp: now + 60 });
    const token = await signClaimToken(payload, SECRET);
    const got = await verifyClaimToken(token, SECRET, now);
    expect(got).not.toBeNull();
    expect(got).toEqual(payload);
  });

  it("produces a token of shape <b64u(payload)>.<b64u(sig)>", async () => {
    const token = await signClaimToken(makePayload(), SECRET);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    // base64url alphabet only — no +, /, =
    for (const p of parts) {
      expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("returns null when the payload byte is altered", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signClaimToken(makePayload(), SECRET);
    const [payloadB64, sigB64] = token.split(".");
    // Flip one base64url character in the payload (still valid b64u, but
    // decodes to different bytes — signature won't match).
    const altered =
      payloadB64.slice(0, -1) +
      (payloadB64.endsWith("A") ? "B" : "A") +
      "." +
      sigB64;
    const got = await verifyClaimToken(altered, SECRET, now);
    expect(got).toBeNull();
  });

  it("returns null when the signature byte is altered", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signClaimToken(makePayload(), SECRET);
    const [payloadB64, sigB64] = token.split(".");
    // Alter the FIRST char of the signature, not the last. The last
    // char of a 32-byte HMAC's base64url encoding only carries 4 bits
    // of real data — its lower 2 bits are padding zeros that lenient
    // decoders ignore, so swapping `A`<->`B` at the tail can yield the
    // same decoded bytes and make the test pass-when-it-shouldn't.
    // Altering the first char always changes high-order bits and is
    // unambiguously a different signature.
    const altered =
      payloadB64 +
      "." +
      (sigB64[0] === "A" ? "B" : "A") +
      sigB64.slice(1);
    const got = await verifyClaimToken(altered, SECRET, now);
    expect(got).toBeNull();
  });

  it("returns null when verified with a different secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signClaimToken(makePayload(), SECRET);
    const got = await verifyClaimToken(token, SECRET + "x", now);
    expect(got).toBeNull();
  });

  it("returns null when the token is expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signClaimToken(makePayload({ exp: now - 1 }), SECRET);
    const got = await verifyClaimToken(token, SECRET, now);
    expect(got).toBeNull();
  });

  it("returns null when exp == now (boundary — not still valid)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signClaimToken(makePayload({ exp: now }), SECRET);
    const got = await verifyClaimToken(token, SECRET, now);
    expect(got).toBeNull();
  });

  it("succeeds when exp == now + 1 (boundary — still valid)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = makePayload({ exp: now + 1 });
    const token = await signClaimToken(payload, SECRET);
    const got = await verifyClaimToken(token, SECRET, now);
    expect(got).not.toBeNull();
  });

  it.each([
    ["empty string", ""],
    ["no dot", "abcdefghijk"],
    ["three dots", "a.b.c"],
    ["leading dot", ".sig"],
    ["trailing dot", "payload."],
    ["just a dot", "."],
    ["junk b64 in payload", "###.###"],
    ["valid b64 garbage", "Zm9v.YmFy"], // "foo"."bar" — won't parse JSON
  ])("returns null for malformed token: %s", async (_label, bad) => {
    const got = await verifyClaimToken(bad, SECRET, 0);
    expect(got).toBeNull();
  });

  it("rejects a payload that decodes but is missing fields", async () => {
    // Hand-craft a token where payload is `{}` — signature matches, but
    // verifyClaimToken should still reject it because required fields
    // are absent.
    const enc = new TextEncoder();
    const payloadBytes = enc.encode("{}");
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, payloadBytes);
    const b64u = (bytes: Uint8Array) => {
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const token = `${b64u(payloadBytes)}.${b64u(new Uint8Array(sigBuf))}`;
    const got = await verifyClaimToken(token, SECRET, 0);
    expect(got).toBeNull();
  });

  it("ties the signature to email — swapping email invalidates", async () => {
    // Practical CSRF check: an attacker who steals the API key can mint
    // a token, but if they only have a leaked token (not the secret),
    // they cannot rebind it to their own email.
    const now = Math.floor(Date.now() / 1000);
    const original = makePayload({ email: "victim@example.com" });
    const token = await signClaimToken(original, SECRET);
    // Decode payload, change email, re-encode without resigning.
    const [payloadB64, sigB64] = token.split(".");
    const decoded = JSON.parse(
      Buffer.from(
        payloadB64.replace(/-/g, "+").replace(/_/g, "/") +
          "==".slice(0, (4 - (payloadB64.length % 4)) % 4),
        "base64",
      ).toString("utf-8"),
    );
    decoded.email = "attacker@example.com";
    const tampered = Buffer.from(JSON.stringify(decoded), "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const forged = `${tampered}.${sigB64}`;
    const got = await verifyClaimToken(forged, SECRET, now);
    expect(got).toBeNull();
  });
});

describe("generateNonce", () => {
  it("returns a 16-char base62 string", () => {
    const n = generateNonce();
    expect(n).toHaveLength(16);
    expect(n).toMatch(/^[0-9A-Za-z]{16}$/);
  });

  it("is unlikely to collide across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateNonce());
    expect(seen.size).toBe(1000);
  });
});

describe("defaultExpiry", () => {
  it("returns now + 3600 by default", () => {
    const now = 1_700_000_000;
    expect(defaultExpiry(now)).toBe(now + 3600);
  });
});
