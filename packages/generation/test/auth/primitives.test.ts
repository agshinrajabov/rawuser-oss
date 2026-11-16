/**
 * The building blocks of two-step sign-in and the failed sign-in limit
 * (docs/specs/security-hardening.md §1.2, §1.4): RFC 4226 and RFC 6238
 * vectors, the secret box, recovery codes, and the account counter on
 * real SQL.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_FAILURE_LIMIT,
  ACCOUNT_WINDOW_MS,
  LOGIN_LIMIT_PER_MINUTE,
  accountKey,
  accountLockMessage,
  accountRetryAfter,
  clearFailures,
  ipAllowed,
  recordFailure,
  windowStart,
} from "../../src/auth/login-limit.ts";
import {
  newRecoveryCodes,
  normalizeRecoveryCode,
  recoveryCodeHash,
} from "../../src/auth/recovery-codes.ts";
import { importBoxKey, openSecret, sealSecret } from "../../src/auth/secret-box.ts";
import {
  base32Decode,
  base32Encode,
  hotp,
  matchTotp,
  otpauthUri,
  totpAt,
  totpCounter,
} from "../../src/auth/totp.ts";
import { makeSqliteD1 } from "../admin/sqlite-d1.ts";

const RFC_SECRET = new TextEncoder().encode("12345678901234567890");

describe("HOTP (RFC 4226, appendix D)", () => {
  it("matches the ten published values", async () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    for (let c = 0; c < expected.length; c++) {
      expect(await hotp(RFC_SECRET, c)).toBe(expected[c]);
    }
  });
});

describe("TOTP (RFC 6238, appendix B, SHA-1)", () => {
  it("matches the published 8-digit values, counters past 2^32 included", async () => {
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, code] of vectors) {
      expect(await totpAt(RFC_SECRET, t * 1000, 8)).toBe(code);
    }
  });

  it("accepts one step of drift either way, not two", async () => {
    const now = 1_760_000_000_000;
    const step = totpCounter(now);
    for (const d of [-1, 0, 1]) {
      const code = await hotp(RFC_SECRET, step + d);
      expect(await matchTotp(RFC_SECRET, code, now, null)).toBe(step + d);
    }
    const far = await hotp(RFC_SECRET, step + 2);
    const farBack = await hotp(RFC_SECRET, step - 2);
    // A far code could collide with a near one by chance; these do not.
    if (far !== (await hotp(RFC_SECRET, step)) && far !== (await hotp(RFC_SECRET, step + 1))) {
      expect(await matchTotp(RFC_SECRET, far, now, null)).toBeNull();
    }
    if (farBack !== (await hotp(RFC_SECRET, step - 1))) {
      expect(await matchTotp(RFC_SECRET, farBack, now, null)).toBeNull();
    }
  });

  it("refuses a code at or below the last accepted step (one use)", async () => {
    const now = 1_760_000_000_000;
    const step = totpCounter(now);
    const code = await hotp(RFC_SECRET, step);
    expect(await matchTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(await matchTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
  });

  it("refuses anything but six digits, and ignores spaces", async () => {
    const now = 1_760_000_000_000;
    const code = await totpAt(RFC_SECRET, now);
    expect(await matchTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now, null)).toBe(
      totpCounter(now),
    );
    expect(await matchTotp(RFC_SECRET, "12345", now, null)).toBeNull();
    expect(await matchTotp(RFC_SECRET, "abcdef", now, null)).toBeNull();
  });

  it("round-trips Base32 and writes the otpauth URI the apps read", () => {
    const b32 = base32Encode(RFC_SECRET);
    expect(b32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(b32.toLowerCase())).toEqual(RFC_SECRET);
    expect(base32Decode("not base32!")).toBeNull();
    const uri = otpauthUri(b32, "founder@example.com");
    expect(uri).toBe(
      "otpauth://totp/Rawuser:founder%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Rawuser&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("the secret box (AES-256-GCM, the user id as additional data)", () => {
  const keyB64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

  it("opens what it sealed, for the same user only", async () => {
    const key = await importBoxKey(keyB64);
    expect(key).not.toBeNull();
    const sealed = await sealSecret(key as CryptoKey, RFC_SECRET, "user-1");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(base32Encode(RFC_SECRET));
    expect(await openSecret(key as CryptoKey, sealed, "user-1")).toEqual(RFC_SECRET);
    expect(await openSecret(key as CryptoKey, sealed, "user-2")).toBeNull();
  });

  it("refuses another key, a damaged box and a key that is not 32 bytes", async () => {
    const key = (await importBoxKey(keyB64)) as CryptoKey;
    const other = (await importBoxKey(
      Buffer.from(new Uint8Array(32).fill(9)).toString("base64"),
    )) as CryptoKey;
    const sealed = await sealSecret(key, RFC_SECRET, "u");
    expect(await openSecret(other, sealed, "u")).toBeNull();
    expect(await openSecret(key, `${sealed.slice(0, -2)}AA`, "u")).toBeNull();
    expect(await openSecret(key, "v2.x.y", "u")).toBeNull();
    expect(await importBoxKey(undefined)).toBeNull();
    expect(await importBoxKey(Buffer.from(new Uint8Array(16)).toString("base64"))).toBeNull();
  });
});

describe("recovery codes", () => {
  it("are ten, 16 Crockford characters in four groups, all different", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(new Set(codes).size).toBe(10);
  });

  it("forgive case, spaces, dashes and O, I, L", () => {
    expect(normalizeRecoveryCode("abcd-ef01-2345-6789")).toBe("ABCDEF0123456789");
    expect(normalizeRecoveryCode("oil1 ABCD efgh 2345")).toBe("0111ABCDEFGH2345");
    expect(normalizeRecoveryCode("ABCD-EFGH")).toBeNull();
    expect(normalizeRecoveryCode("UUUU-UUUU-UUUU-UUUU")).toBeNull();
  });

  it("hash per user, so one code is not another user's", async () => {
    const a = await recoveryCodeHash("u1", "ABCDEF0123456789");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await recoveryCodeHash("u2", "ABCDEF0123456789")).not.toBe(a);
  });
});

describe("the account counter (real SQL)", () => {
  const T0 = 1_760_000_100_000;

  it("keys an email by its lowercased hash, never the email", async () => {
    const k = await accountKey(" Founder@Example.com ");
    expect(k).toBe(await accountKey("founder@example.com"));
    expect(k).toMatch(/^acct:[0-9a-f]{64}$/);
    expect(k).not.toContain("founder");
  });

  it("locks at 10 across two windows and lifts within 15 to 30 minutes", async () => {
    const { d1, db } = makeSqliteD1();
    const key = await accountKey("a@b.c");
    const cur = windowStart(T0);
    for (let i = 0; i < ACCOUNT_FAILURE_LIMIT - 1; i++) {
      const r = await recordFailure(d1, key, T0);
      expect(r.justLocked).toBe(false);
    }
    expect(await accountRetryAfter(d1, key, T0)).toBe(0);
    const tenth = await recordFailure(d1, key, T0);
    expect(tenth).toMatchObject({ total: 10, justLocked: true });
    // All ten in the current window: locked until it stops being the previous one.
    const retry = await accountRetryAfter(d1, key, T0);
    expect(retry).toBe(Math.ceil((cur + 2 * ACCOUNT_WINDOW_MS - T0) / 1000));
    expect(retry).toBeGreaterThan(15 * 60);
    expect(retry).toBeLessThanOrEqual(30 * 60);
    expect(await accountRetryAfter(d1, key, cur + ACCOUNT_WINDOW_MS + 1)).toBeGreaterThan(0);
    expect(await accountRetryAfter(d1, key, cur + 2 * ACCOUNT_WINDOW_MS)).toBe(0);
    // Rows hold the hash, a window and a count, nothing else.
    const rows = db.prepare("SELECT * FROM auth_failures").all();
    expect(Object.keys(rows[0] as object).sort()).toEqual(["failures", "key", "window_start"]);
  });

  it("counts the previous window: five then five locks until the first drops out", async () => {
    const { d1 } = makeSqliteD1();
    const key = await accountKey("x@y.z");
    const prev = windowStart(T0) - ACCOUNT_WINDOW_MS;
    for (let i = 0; i < 5; i++) await recordFailure(d1, key, prev + 1000);
    for (let i = 0; i < 5; i++) await recordFailure(d1, key, T0);
    const retry = await accountRetryAfter(d1, key, T0);
    expect(retry).toBe(Math.ceil((windowStart(T0) + ACCOUNT_WINDOW_MS - T0) / 1000));
  });

  it("clears on success and sums the burst across accounts", async () => {
    const { d1 } = makeSqliteD1();
    const a = await accountKey("a@a.a");
    const b = await accountKey("b@b.b");
    await recordFailure(d1, a, T0);
    const r = await recordFailure(d1, b, T0);
    expect(r.burst).toBe(2);
    await clearFailures(d1, a);
    expect((await recordFailure(d1, a, T0)).total).toBe(1);
  });

  it("says the minutes plainly", () => {
    expect(accountLockMessage(30)).toBe("Too many failed sign-ins. Try again in 1 minute.");
    expect(accountLockMessage(61)).toBe("Too many failed sign-ins. Try again in 2 minutes.");
  });
});

describe("the per-IP limit", () => {
  const req = (ip?: string) =>
    new Request("https://api.test/admin/login", {
      method: "POST",
      headers: ip ? { "CF-Connecting-IP": ip } : {},
    });

  it("keys on the client address and fails open without a binding, an address or a working binding", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    expect(await ipAllowed({ limit }, req("203.0.113.9"))).toBe(false);
    expect(limit).toHaveBeenCalledWith({ key: "ip:203.0.113.9" });
    expect(await ipAllowed(undefined, req("203.0.113.9"))).toBe(true);
    expect(await ipAllowed({ limit }, req())).toBe(true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      limit: async () => {
        throw new Error("down");
      },
    };
    expect(await ipAllowed(broken, req("203.0.113.9"))).toBe(true);
    errSpy.mockRestore();
  });

  it("wrangler.toml declares LOGIN_LIMITER in both sections at the code's limit per 60 s", () => {
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    const blocks = [
      ...toml.matchAll(
        /\[\[(env\.production\.)?ratelimits\]\]\s*\nname = "LOGIN_LIMITER"\s*\nnamespace_id = "(\d+)"\s*\nsimple = \{ limit = (\d+), period = (\d+) \}/g,
      ),
    ];
    expect(blocks).toHaveLength(2);
    expect(new Set(blocks.map((b) => b[2])).size).toBe(2);
    for (const b of blocks) {
      expect(Number(b[3])).toBe(LOGIN_LIMIT_PER_MINUTE);
      expect(Number(b[4])).toBe(60);
    }
  });
});
