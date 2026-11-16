/**
 * An install that set none of its vars (src/install-config.ts;
 * docs/specs/open-source-release.md 6.2 and the privacy review's condition
 * 4, no call home): nothing falls back to a host, an address or a name the
 * install did not give. An endpoint that must print a tag says which var
 * is missing; a check with no address to ask is skipped; no mail goes out
 * without a sender; a sentence reads whole without the part that is not
 * there.
 */

import type { LiftReport } from "@rawuser/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleApplySubmit } from "../src/admin/apply.ts";
import { auditPrivacyLine, handleAuditSubmit } from "../src/admin/audit.ts";
import type { SessionUser } from "../src/admin/auth.ts";
import type { AdminEnv } from "../src/admin/handlers.ts";
import { handleInstallPreGet } from "../src/admin/install-pre.ts";
import { AUDIT_LINES } from "../src/audit/constants.ts";
import { probeSingleCustomer } from "../src/cron/snippet-probe.ts";
import { checkTag } from "../src/cron/snippet-probe.ts";
import {
  EDGE_ORIGIN_MISSING,
  apiOrigin,
  commaList,
  dashboardOrigin,
  dashboardPointer,
  edgeHealthUrl,
  edgeOrigin,
  edgeOriginAliases,
  edgeOrigins,
  fetcherUserAgent,
  mailSender,
  operatorName,
  originOf,
  privacyAddress,
  rememberOffAtCreation,
  rememberOptions,
  replyToAddress,
  supportAddress,
} from "../src/install-config.ts";
import { installFacts } from "../src/lib/install-facts.ts";
import { type InviteMailMessage, inviteEmail, sendInviteEmail } from "../src/lib/invite-email.ts";
import { ownHosts } from "../src/lib/own-hosts.ts";
import { dashboardLink, proofAlertText } from "../src/lib/proof-alerts.ts";
import { buildWeeklyDraft } from "../src/lib/proof-weekly.ts";
import { fetchInstallFacts } from "../src/lib/read-page.ts";
import { makeKv, makeSqliteD1 } from "./admin/sqlite-d1.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A link, an address or a leftover of a missing value: none belongs in a text with nothing set. */
const LEFTOVER = /https?:\/\/|mailto:|@|undefined|null|\s\.|:\s*$|\n\n$|\s$/;

describe("every reader, with nothing set", () => {
  it.each([{}, { EDGE_ORIGIN: "" }, { EDGE_ORIGIN: "   " }])("no edge origin: %j", (env) => {
    expect(edgeOrigin(env)).toBeNull();
    expect(edgeOrigins(env)).toEqual([]);
    expect(edgeHealthUrl(env)).toBeNull();
  });

  it("no aliases, no API origin, no own hosts", () => {
    expect(edgeOriginAliases({})).toEqual([]);
    expect(apiOrigin({})).toBeNull();
    expect(ownHosts({})).toEqual([]);
  });

  it("the fetcher names itself and no address", () => {
    expect(fetcherUserAgent({})).toBe("Rawuser/1.0");
    expect(fetcherUserAgent({ BOT_INFO_URL: "" })).toBe("Rawuser/1.0");
  });

  it("no dashboard for unset, empty or the dev wildcard: an ops line ends at its own words", () => {
    for (const env of [{}, { DASHBOARD_ORIGIN: "" }, { DASHBOARD_ORIGIN: "*" }]) {
      expect(dashboardOrigin(env)).toBeNull();
      expect(dashboardPointer(env, "/applications")).toBe("");
      expect(`New pilot application: acme.test${dashboardPointer(env, "/applications")}`).toBe(
        "New pilot application: acme.test",
      );
    }
  });

  it("no sender, reply address, privacy address, support address or operator", () => {
    expect(mailSender({})).toBeNull();
    expect(mailSender({ SENDER_NAME: "Acme" })).toBeNull();
    expect(replyToAddress({})).toBeNull();
    expect(privacyAddress({})).toBeNull();
    expect(supportAddress({})).toBeNull();
    expect(operatorName({})).toBeNull();
    expect(operatorName({ OPERATOR_NAME: "  " })).toBeNull();
  });

  it("the memory is off for a new customer and on no marked site", () => {
    expect(rememberOffAtCreation({})).toBe(1);
    expect(rememberOptions({})).toEqual({ onSensitive: false });
  });
});

describe("the readers, with values", () => {
  it("an origin is read without its path or a trailing slash; anything else is no origin", () => {
    expect(originOf("https://edge.example.com/")).toBe("https://edge.example.com");
    expect(originOf(" https://Edge.Example.com/s/ ")).toBe("https://edge.example.com");
    expect(originOf("http://localhost:8787")).toBe("http://localhost:8787");
    for (const v of ["edge.example.com", "ftp://edge.example.com", "not a url", ""]) {
      expect(originOf(v)).toBeNull();
    }
  });

  it("aliases: a comma list, each an origin, the current origin first and each once", () => {
    const env = {
      EDGE_ORIGIN: "https://edge.example.com",
      EDGE_ORIGIN_ALIASES: " https://edge-old.example.com/ , nonsense,https://edge.example.com",
    };
    expect(edgeOriginAliases(env)).toEqual([
      "https://edge-old.example.com",
      "https://edge.example.com",
    ]);
    expect(edgeOrigins(env)).toEqual(["https://edge.example.com", "https://edge-old.example.com"]);
    expect(commaList(" a, ,b ,")).toEqual(["a", "b"]);
  });

  it("the health address: the override, else the edge's /health", () => {
    expect(edgeHealthUrl({ EDGE_ORIGIN: "https://edge.example.com/" })).toBe(
      "https://edge.example.com/health",
    );
    expect(
      edgeHealthUrl({
        EDGE_ORIGIN: "https://edge.example.com",
        EDGE_HEALTH_URL: "https://status.example.com/edge",
      }),
    ).toBe("https://status.example.com/edge");
    expect(edgeHealthUrl({ EDGE_HEALTH_URL: "https://status.example.com/edge" })).toBe(
      "https://status.example.com/edge",
    );
  });

  it("the sender's name defaults to the product's", () => {
    expect(mailSender({ SENDER_ADDRESS: "pilots@example.com" })).toEqual({
      email: "pilots@example.com",
      name: "Rawuser",
    });
    expect(mailSender({ SENDER_ADDRESS: "pilots@example.com", SENDER_NAME: "Acme" })).toEqual({
      email: "pilots@example.com",
      name: "Acme",
    });
  });

  it("the pointer names the dashboard without its scheme", () => {
    expect(
      dashboardPointer({ DASHBOARD_ORIGIN: "https://app.example.com/" }, "/applications"),
    ).toBe(" · app.example.com/applications");
  });
});

describe("an endpoint that must print a tag", () => {
  /** Fails the test when the handler reaches storage: the answer comes first. */
  const never = () => {
    throw new Error("storage must not be reached");
  };
  const env = {
    DB: { prepare: never },
    VARIANTS: { get: never, put: never, delete: never },
    ENVIRONMENT: "test",
    DASHBOARD_ORIGIN: "https://app.example.com",
  } as unknown as AdminEnv;
  const post = (path: string, body: unknown) =>
    new Request(`https://api.example.com${path}`, { method: "POST", body: JSON.stringify(body) });
  const full = {
    t: "token",
    product: "p",
    icp: "i",
    name: "Ada",
    email: "ada@example.com",
    url: "acme.test",
  };

  it("the message names the var and no host", () => {
    expect(EDGE_ORIGIN_MISSING).toContain("EDGE_ORIGIN");
    expect(EDGE_ORIGIN_MISSING).not.toMatch(/https?:\/\//);
  });

  it("the apply submit: 503, nothing created, the invite not used", async () => {
    const res = await handleApplySubmit(post("/admin/apply/submit", full), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: EDGE_ORIGIN_MISSING });
  });

  it("the audit submit: 503, nothing created, the invite not used", async () => {
    const res = await handleAuditSubmit(
      post("/admin/audit/submit", { ...full, terms: true, banner: true }),
      env,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: EDGE_ORIGIN_MISSING });
  });

  it("the two-part paste: 503 before the page is read", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const res = await handleInstallPreGet(
      new Request("https://api.example.com/admin/install/pre?customer_id=acme"),
      env,
      { id: "u", email: "a@example.com", role: "superadmin", customer_id: null } as SessionUser,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: EDGE_ORIGIN_MISSING });
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe("the probe and the install facts", () => {
  const WORKERS_DEV =
    '<script src="https://rawuser-edge-production.some-account.workers.dev/s/acme.js"></script>';
  const CUSTOM = '<script src="https://edge.example.com/s/acme.js"></script>';
  const page = (tag: string) => `<html><head>${tag}</head><body><h1>Hello</h1></body></html>`;

  it("only the edge worker's own workers.dev tag is recognised", () => {
    expect(checkTag(page(WORKERS_DEV), "acme", [])).toBe("found");
    expect(checkTag(page(CUSTOM), "acme", [])).toBe("missing");
    expect(checkTag(page(CUSTOM), "acme", ["https://edge.example.com"])).toBe("found");
  });

  it("no facts when there is no tag on the page and no origin to judge the policy against", () => {
    const input = {
      headers: new Headers({ "content-security-policy": "script-src 'self'" }),
      pageUrl: new URL("https://acme.test/"),
      customerId: "acme",
      edgeOrigins: [],
    };
    expect(installFacts({ ...input, html: page("") })).toBeNull();
    expect(installFacts({ ...input, html: page(CUSTOM) })).toBeNull();
    // A tag that is there says where it loads from: the lines name that origin.
    const found = installFacts({ ...input, html: page(WORKERS_DEV) });
    expect(found?.csp.lines).toEqual([
      "script-src 'self' https://rawuser-edge-production.some-account.workers.dev",
    ]);
  });

  it("the facts read goes out under the bare agent and gives nothing", async () => {
    const agents: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        agents.push(new Headers(init?.headers).get("user-agent") ?? "");
        return new Response(page(""), { status: 200 });
      }),
    );
    expect(await fetchInstallFacts(new URL("https://8.8.8.8/"), "acme", {})).toBeNull();
    expect(agents).toEqual(["Rawuser/1.0"]);
  });

  it("the probe: the bare agent, the page read, no facts, nothing of anyone's in the row", async () => {
    const agents: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        agents.push(new Headers(init?.headers).get("user-agent") ?? "");
        return new Response(page(CUSTOM), {
          status: 200,
          headers: { "content-security-policy": "script-src 'self'" },
        });
      }),
    );
    const { d1, db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at) VALUES ('acme', 'acme', 'acme.test', 'active', 1)",
    ).run();
    const r = await probeSingleCustomer({ id: "acme", domain: "acme.test" }, { DB: d1 });
    expect(agents).toEqual(["Rawuser/1.0"]);
    expect(r.read).toBe("ok");
    expect(r.status).toBe("removed");
    expect(r.install).toBeNull();
    const row = db.prepare("SELECT * FROM snippet_status WHERE customer_id = 'acme'").get();
    expect(row).toMatchObject({ snippet_in_html: 0, csp_verdict: null, platform: null });
    expect(JSON.stringify({ r, row })).not.toMatch(/https?:\/\//);
  });
});

describe("mail", () => {
  const mailer = () => {
    const sent: InviteMailMessage[] = [];
    return {
      sent,
      EMAIL: {
        send: async (m: InviteMailMessage) => {
          sent.push(m);
          return { messageId: "m" };
        },
      },
    };
  };
  const input = { link: "https://app.example.com/apply/#t=abc", expiresAt: Date.UTC(2026, 10, 9) };

  it("no sender: nothing is sent and the attempt is not counted", async () => {
    const m = mailer();
    const kv = makeKv();
    const r = await sendInviteEmail(
      { EMAIL: m.EMAIL, VARIANTS: kv as unknown as KVNamespace },
      "account-1",
      "ada@example.com",
      input,
    );
    expect(r).toEqual({ emailed: false, email_error: "sender" });
    expect(m.sent).toHaveLength(0);
    expect(kv.store.size).toBe(0);
  });

  it("a sender alone: sent from it, with no reply-to header and no privacy address", async () => {
    const m = mailer();
    const r = await sendInviteEmail(
      {
        EMAIL: m.EMAIL,
        VARIANTS: makeKv() as unknown as KVNamespace,
        SENDER_ADDRESS: "pilots@example.com",
      },
      "account-1",
      "ada@example.com",
      input,
    );
    expect(r).toEqual({ emailed: true });
    const msg = m.sent[0] as InviteMailMessage;
    expect(msg.from).toEqual({ email: "pilots@example.com", name: "Rawuser" });
    expect(msg).not.toHaveProperty("replyTo");
    expect(msg.text.trimEnd().endsWith("Sent by Rawuser.")).toBe(true);
    expect(msg.html).toContain(">Sent by Rawuser.</p>");
    expect(msg.html).not.toContain("mailto:");
    expect(`${msg.text}${msg.html}`).not.toMatch(/Privacy|undefined|null/);
  });

  it("an install with its own sender name speaks under it, never under ours", () => {
    const msg = inviteEmail({ ...input, senderName: "Northwind" });
    expect(msg.subject).toBe("Your Northwind pilot");
    expect(msg.text).toContain("start the Northwind pilot");
    expect(msg.text.trimEnd().endsWith("Sent by Northwind.")).toBe(true);
    expect(msg.html).toContain("<title>Your Northwind pilot</title>");
    expect(`${msg.subject}${msg.text}${msg.html}`).not.toContain("Rawuser");
    // A name is text, never markup.
    expect(inviteEmail({ ...input, senderName: "A <b>&</b> B" }).html).not.toContain("<b>");
  });

  it("the message without a privacy address has one link, the invite's", () => {
    const msg = inviteEmail(input);
    const hrefs = [...msg.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["https://app.example.com/apply/#t=abc"]);
    expect(msg.text).not.toContain("@");
  });
});

describe("messages and lines", () => {
  const report = (over: Record<string, unknown>) =>
    ({
      customer_id: "acme",
      state: "interim",
      verdict: null,
      metric: { kind: "cta_clicks", labels: ["Start free"] },
      sentence: "So far the versions lead by 12%. It is too early to say.",
      limits: "Counted on clicks of Start free. Late visits are in the test.",
      test: { day: 9, weeks_total: 6, read_date: "2026-12-01" },
      lift: { value: 0.12, low: -0.02, high: 0.3, interim: true },
      ...over,
    }) as unknown as LiftReport;
  const STATES = [
    report({ state: "off", test: null }),
    report({ state: "not_enough" }),
    report({ state: "interim" }),
    report({ state: "held_back" }),
    report({ state: "result", verdict: "positive" }),
    report({ state: "result", verdict: "negative" }),
    report({ state: "ended", verdict: "no_difference" }),
  ];

  it("the weekly draft without a dashboard or an operator: no link, no signature, nothing dangling", () => {
    for (const r of STATES) {
      for (const origin of [undefined, "", "*"]) {
        const d = buildWeeklyDraft(r, "acme.test", "2026-11-08", origin, null);
        expect(d.text, `${r.state} ${r.verdict}`).not.toMatch(LEFTOVER);
        expect(d.text).not.toMatch(/The card/);
        expect(d.text).not.toMatch(/\n\n\n/);
        expect(d.subject).not.toMatch(LEFTOVER);
      }
    }
  });

  it("each part comes back with its own var", () => {
    const r = STATES[2] as LiftReport;
    const signed = buildWeeklyDraft(r, "acme.test", "2026-11-08", undefined, "Sam");
    expect(signed.text.endsWith("\n\nSam")).toBe(true);
    expect(signed.text).not.toMatch(/The card/);
    const linked = buildWeeklyDraft(r, "acme.test", "2026-11-08", "https://app.example.com", null);
    expect(linked.text).toContain(
      "The card with the counts: https://app.example.com/analytics?customer_id=acme\n\n",
    );
    expect(linked.text.endsWith("Counted on clicks of Start free.")).toBe(true);
  });

  it("a proof alert without a dashboard: the code and the customer", () => {
    for (const origin of [undefined, "", "*"]) {
      expect(dashboardLink(origin, "acme")).toBeNull();
      expect(proofAlertText("lift-negative", "acme", origin)).toBe(
        "[rawuser ops] lift-negative · acme",
      );
    }
    expect(proofAlertText("lift-negative", "acme", "https://app.example.com/")).toBe(
      "[rawuser ops] lift-negative · acme · https://app.example.com/analytics?customer_id=acme",
    );
  });

  it("the audit's lines read whole", () => {
    expect(auditPrivacyLine(null)).not.toMatch(LEFTOVER);
    expect(auditPrivacyLine(null).endsWith("unless you start a pilot.")).toBe(true);
    expect(AUDIT_LINES.audits_full_signup(null)).not.toMatch(LEFTOVER);
  });
});
