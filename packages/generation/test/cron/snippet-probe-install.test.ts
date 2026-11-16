/**
 * The probe's install facts (docs/specs/install-friction.md B, C, D, G4)
 * against the real SQL: node:sqlite with every migration applied.
 *
 *   - platform, tag position and the CSP verdict stored as closed enums,
 *     never policy text (condition 6), the lines returned and not stored;
 *   - a failed read keeps the last known facts;
 *   - bot protection is its own read outcome;
 *   - csp-blocks alerts once, when a live customer's policy turns blocking;
 *   - the probe reads the page being connected (page_path).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeSingleCustomer } from "../../src/cron/snippet-probe.ts";
import { makeSqliteD1 } from "../admin/sqlite-d1.ts";
import { INSTALL_ENV } from "../install-env.ts";

const BRISK_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.posthog.com; frame-src 'none'";
const TAG = `<script data-cfasync="false" src="https://edge.example.com/s/acme.js"></script>`;
const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="/_next/static/css/a.css">${TAG}</head><body><h1>Acme</h1></body></html>`;

let made: ReturnType<typeof makeSqliteD1>;
let site: { status: number; html: string; headers: Record<string, string> };
let fetched: string[];
let alerts: string[];

beforeEach(() => {
  made = makeSqliteD1();
  made.db
    .prepare(
      `INSERT INTO customers (id, slug, domain, plan, status, created_at) VALUES ('acme', 'acme', 'acme.example.com', 'pilot', 'active', 1)`,
    )
    .run();
  site = { status: 200, html: PAGE, headers: { server: "Vercel", "x-powered-by": "Next.js" } };
  fetched = [];
  alerts = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      if (url.hostname === "api.telegram.org") {
        alerts.push(url.searchParams.get("text") ?? "");
        return Response.json({ ok: true });
      }
      fetched.push(url.toString());
      return new Response(site.html, { status: site.status, headers: site.headers });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const env = () => ({
  DB: made.d1,
  ALERT_WEBHOOK_URL: "https://api.telegram.org/botTEST/sendMessage?chat_id=1",
  ...INSTALL_ENV,
});

function statusRow(): Record<string, unknown> {
  return made.db.prepare("SELECT * FROM snippet_status WHERE customer_id = 'acme'").get() as Record<
    string,
    unknown
  >;
}

describe("probe: install facts", () => {
  it("returns platform, position and the CSP report; stores closed enums only", async () => {
    site.headers["content-security-policy"] = BRISK_CSP;
    const r = await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(r.read).toBe("ok");
    expect(r.install?.platform).toBe("nextjs");
    expect(r.install?.tag_position).toBe("head_first");
    expect(r.install?.csp.blocks).toBe(true);
    expect(r.install?.csp.where).toBe("next_config");
    expect(r.install?.csp.lines).toEqual([
      "script-src 'self' 'unsafe-inline' https://edge.example.com",
      "connect-src 'self' https://*.posthog.com https://edge.example.com",
    ]);

    const row = statusRow();
    expect(row.platform).toBe("nextjs");
    expect(row.tag_position).toBe("head_first");
    expect(row.tag_flags).toBe("[]");
    expect(JSON.parse(row.csp_verdict as string)).toEqual({
      source: "header",
      enforced: { script: "missing_host", connect: "missing_host", style: "ok", frames: "blocked" },
      report_only: null,
      trusted_types: false,
    });
    expect(typeof row.csp_blocks_since).toBe("number");
    // No host, no source, no policy text anywhere in the row.
    const text = JSON.stringify(row);
    expect(text).not.toContain("posthog");
    expect(text).not.toContain("'self'");
    expect(text).not.toContain("edge.example.com");
  });

  it("a failed read keeps the last known facts and the blocking time", async () => {
    site.headers["content-security-policy"] = BRISK_CSP;
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    const before = statusRow();
    site.status = 500;
    const r = await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(r.read).toBe("failed");
    expect(r.install).toBeNull();
    const after = statusRow();
    expect(after.status).toBe("unknown");
    expect(after.csp_verdict).toBe(before.csp_verdict);
    expect(after.platform).toBe("nextjs");
    expect(after.csp_blocks_since).toBe(before.csp_blocks_since);
  });

  it("bot protection is its own outcome, not a missing tag", async () => {
    site.status = 403;
    site.html = "<title>Vercel Security Checkpoint</title>";
    const r = await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(r.read).toBe("bot_protection");
    expect(r.status).toBe("unknown");
    expect(r.reason).toMatch(/bot protection/);
    site.status = 200;
    site.html = "<html><head><title>Just a moment...</title></head></html>";
    const again = await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(again.read).toBe("bot_protection");
  });

  it("tag_runs: a capture landed or an event arrived (the probe is a hint, this is proof)", async () => {
    site.html = `<html><head><script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script></head><body><h1>x</h1></body></html>`;
    const first = await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(first.tag_runs).toBe(false);
    expect(first.install?.tag_flags).toEqual([]);
    made.db.prepare("UPDATE customers SET tag_seen_at = 5 WHERE id = 'acme'").run();
    const second = await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(second.tag_runs).toBe(true);
    expect(second.install?.tag_position).toBe("not_found");
    expect(second.install?.tag_flags).toEqual(["gtm"]);
  });

  it("probes the page being connected", async () => {
    const r = await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env(), {
      pagePath: "/pricing",
    });
    expect(r.page_path).toBe("/pricing");
    expect(fetched).toEqual(["https://acme.example.com/pricing"]);
    // Anything that is not a plain path probes the home page.
    for (const bad of ["pricing", "//evil.example.com/x", "/a b", "/x?y=1"]) {
      fetched.length = 0;
      await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env(), {
        pagePath: bad,
      });
      expect(fetched).toEqual(["https://acme.example.com/"]);
    }
  });
});

describe("probe: the csp-blocks alert", () => {
  it("fires once when a live customer's policy turns blocking, again only after it cleared", async () => {
    made.db.prepare("UPDATE customers SET live_at = 10 WHERE id = 'acme'").run();
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(alerts).toEqual([]);

    site.headers["content-security-policy"] = BRISK_CSP;
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/^csp-blocks: acme: /);
    expect(alerts[0]).not.toContain("acme.example.com");

    site.headers = { server: "Vercel", "x-powered-by": "Next.js" };
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(statusRow().csp_blocks_since).toBeNull();
    site.headers["content-security-policy"] = BRISK_CSP;
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(alerts).toHaveLength(2);
  });

  it("never for a customer not live yet, nor for a test customer", async () => {
    site.headers["content-security-policy"] = BRISK_CSP;
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(alerts).toEqual([]);
    made.db.prepare("DELETE FROM snippet_status").run();
    made.db.prepare("UPDATE customers SET live_at = 10, plan = 'test' WHERE id = 'acme'").run();
    await probeSingleCustomer({ id: "acme", domain: "acme.example.com" }, env());
    expect(alerts).toEqual([]);
  });
});
