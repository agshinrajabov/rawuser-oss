/**
 * Every install state on screen (docs/specs/install-friction.md, dashboard
 * pass 1 to 7; mock design/mock/sales-readiness/install-friction.html,
 * approved 2026-10-04): the tag line and its box in each state, the
 * platform steps for every platform, the 45-second box, the /apply read
 * lines and done screen, and the two Pages card lines. Rendered to markup,
 * no network.
 */
import "../identity/example";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import { DoneScreen } from "../../src/components/apply/ApplyFlow";
import { TagStatusView, conditionMeta } from "../../src/components/onboard/TagStatus";
import { PagesCard, fixStillNeeded } from "../../src/components/start/PagesCard";
import { PlatformSteps } from "../../src/components/start/PlatformSteps";
import { WaitBox } from "../../src/components/start/WaitBox";
import { TINT } from "../../src/components/start/tones";
import { readRefusal, readingLine } from "../../src/lib/apply";
import {
  type TagCondition,
  conditionLines,
  conditionWhere,
  connectSteps,
  donePolicy,
  keepsChecking,
  policyNotes,
  tagCondition,
  tagIsOn,
  waitLine,
} from "../../src/lib/install";
import { buildSnippet } from "../../src/lib/snippet-tag";
import type { InstallFacts, InstallPlatform, ProbeResponse } from "../../src/types/api";
import {
  BRISK,
  CUSTOMER,
  DEGRADES,
  DEGRADES_NONCE,
  DEGRADES_NONCE_NEXT,
  DEGRADES_NONCE_NO_LINE,
  HASH,
  HASH_ONLY,
  NEEDS_NONCE_NEXT,
  NEEDS_NONCE_PLAIN,
  REPORT_ONLY,
  install,
  probe,
} from "../install-fixtures";

const TAG = buildSnippet("brisk");
const EDGE = "https://edge.example.com";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The tag line and its box for one probe answer, as TagStatus draws it. */
function tagView(r: ProbeResponse, domain = "brisk.test"): { c: TagCondition; html: string } {
  const c = tagCondition(r, domain);
  const html = renderToStaticMarkup(
    h(TagStatusView, {
      condition: c,
      install: r.install ?? null,
      tag: TAG,
      meta: conditionMeta(c, false, Date.now()),
      showAgain: false,
    }),
  );
  return { c, html };
}

const NO_DASH = /[–—]/;

describe("the tag line, every state", () => {
  it("found: green, one line, no box", () => {
    const { c, html } = tagView(probe());
    expect(c).toMatchObject({ kind: "found", tone: "ok", line: "Tag found on brisk.test." });
    expect(html).toContain("text-state-success");
    expect(html).not.toContain("rounded-md px-3.5");
    expect(tagIsOn(c)).toBe(true);
    expect(keepsChecking(c)).toBe(false);
  });

  it("found at the top of the body (Webflow free)", () => {
    const { c } = tagView(
      probe({ install: install({ platform: "webflow", tag_position: "body_top" }) }),
      "first-site.webflow.io",
    );
    expect(c.line).toBe("Tag found on first-site.webflow.io, at the top of the body.");
  });

  it("missing: amber, checking again", () => {
    const { c, html } = tagView(
      probe({
        status: "removed",
        reason: "Snippet tag not found in page HTML",
        tag_runs: false,
        install: install({ tag_position: "not_found" }),
      }),
    );
    expect(c).toMatchObject({ kind: "missing", tone: "warn", line: "Not on brisk.test yet." });
    expect(text(html)).toContain("Checking again in 10 seconds.");
    expect(conditionMeta(c, true, 0)).toBe("Paused.");
  });

  it("runs: green when the tag reached us though the HTML does not show it", () => {
    const { c, html } = tagView(
      probe({
        status: "removed",
        reason: "Snippet tag not found in page HTML",
        install: install({ tag_position: "not_found" }),
      }),
    );
    expect(c).toMatchObject({ kind: "runs", tone: "ok" });
    expect(text(html)).toContain("Not in the page's HTML, but it reached Rawuser.");
  });

  it("other customer's tag: red", () => {
    const { c } = tagView(
      probe({ status: "removed", reason: "Snippet tag found, but with another customer id" }),
    );
    expect(c).toMatchObject({ kind: "other_customer", tone: "err" });
  });

  it("unreachable: amber, the site may be down", () => {
    const { c, html } = tagView(
      probe({
        status: "unknown",
        read: "failed",
        tag_runs: false,
        install: null,
        reason: "Probe fetch failed; status unknown",
      }),
    );
    expect(c).toMatchObject({ kind: "unreachable", line: "Could not read brisk.test." });
    expect(text(html)).toContain("Is the site public and up?");
  });

  it("off_host: its own line, not 'is the site up'", () => {
    const r = probe({
      status: "unknown",
      read: "off_host",
      tag_runs: false,
      install: null,
      reason: "The page redirects to another host. Rawuser reads only the site's own addresses.",
    });
    const { c, html } = tagView(r);
    expect(c).toMatchObject({
      kind: "off_host",
      tone: "warn",
      line: "brisk.test redirects to another site.",
    });
    expect(text(html)).toContain("Rawuser reads only your own addresses.");
    expect(text(html)).not.toContain("public and up");
    expect(tagIsOn(c)).toBe(false);
    expect(waitLine(r, "brisk.test").kind).toBe("off_host");
    // The capture is proof: once the tag ran, green.
    expect(tagCondition({ ...r, tag_runs: true }, "brisk.test").kind).toBe("runs");
  });

  it("bot protection: amber with the note, then green once the capture landed", () => {
    const r = probe({ status: "unknown", read: "bot_protection", tag_runs: false, install: null });
    const { c, html } = tagView(r);
    expect(c.kind).toBe("bot_protection");
    expect(text(html)).toContain("Your site's bot protection turned our check away.");
    expect(text(html)).toContain("If the tag runs, this turns green.");
    expect(conditionMeta(c, false, 0)).toBeNull();
    expect(tagView({ ...r, tag_runs: true }).c).toMatchObject({
      kind: "runs",
      line: "Tag runs on brisk.test. Your page reached Rawuser.",
    });
  });

  it("blocked (brisk.test): red, the two exact lines, where, Copy, frames behind a disclosure", () => {
    const { c, html } = tagView(probe({ install: BRISK }));
    expect(c).toMatchObject({ kind: "blocked", tone: "err", found: true });
    const t = text(html);
    expect(t).toContain("Tag found on brisk.test, but your site's security policy blocks it.");
    expect(t).toContain("Add Rawuser's address to two lines of the policy.");
    expect(t).toContain("Most likely in next.config.js , inside async headers() .");
    expect(t).toContain("Two lines for your policy");
    expect(t).toContain("Copy");
    expect(t).toContain("script-src 'self' 'unsafe-inline' https://edge.example.com");
    expect(t).toContain(
      "connect-src 'self' https://*.posthog.com https://vitals.vercel-insights.com https://edge.example.com",
    );
    expect(t).toContain("Not in next.config.js?");
    expect(t).toContain("This turns green within 10 seconds of your deploy.");
    // The frames caveat sits behind a disclosure.
    expect(html).toMatch(/<details[^>]*>.*More on your policy, nothing to add/s);
    expect(t).toContain("It blocks frames");
    expect(html).toContain("text-state-err");
    expect(tagIsOn(c)).toBe(false);
  });

  it("blocked before the tag is on: the lines anyway", () => {
    const { c } = tagView(
      probe({
        status: "removed",
        reason: "Snippet tag not found in page HTML",
        tag_runs: false,
        install: { ...BRISK, tag_position: "not_found" },
      }),
    );
    expect(c).toMatchObject({
      kind: "blocked",
      found: false,
      line: "Not on brisk.test yet, and your site's security policy would block it.",
    });
  });

  it("hash only: red, write to us, no wrong line", () => {
    const { c, html } = tagView(probe({ install: HASH_ONLY }));
    expect(c.kind).toBe("hash_only");
    expect(html).toContain('href="mailto:sam@example.com"');
    expect(conditionLines(c, HASH_ONLY.csp, TAG)).toEqual([]);
    expect(text(html)).not.toContain("for your policy");
  });

  it("needs a nonce on Next.js: the tag for app/layout.tsx", () => {
    const { c, html } = tagView(probe({ install: NEEDS_NONCE_NEXT }));
    expect(c.kind).toBe("needs_nonce");
    const t = text(html);
    expect(t).toContain("Tag with your nonce");
    expect(t).toContain("nonce={nonce}");
    expect(t).toContain("In app/layout.tsx , read the nonce");
  });

  it("needs a nonce on a plain site: the placeholder, and the policy line", () => {
    const { c, html } = tagView(probe({ install: NEEDS_NONCE_PLAIN }));
    const t = text(html);
    expect(t).toContain("Tag with your nonce, and the policy line");
    expect(conditionWhere(c, NEEDS_NONCE_PLAIN, 2)).toBe(
      "Put your page's nonce in place of `YOUR-PAGE-NONCE`, and add the policy line.",
    );
    expect(t).not.toContain("Change these lines");
  });

  it("report-only: amber, the three lines in _headers, the hash line explained", () => {
    const { c, html } = tagView(probe({ install: REPORT_ONLY }));
    expect(c).toMatchObject({ kind: "report_only", tone: "warn" });
    const t = text(html);
    expect(t).toContain("Three lines for your policy");
    expect(t).toContain("In _headers in your publish folder");
    expect(t).toContain(HASH);
    expect(t).toContain("The hash line lets Rawuser hide what it rewrites");
    expect(tagIsOn(c)).toBe(true);
  });

  it("degrades: amber, the hash line", () => {
    const { c, html } = tagView(probe({ install: DEGRADES }));
    expect(c).toMatchObject({ kind: "degrades", nonce: false });
    expect(text(html)).toContain("One line for your policy");
    expect(text(html)).toContain(HASH);
  });

  it("degrades on a nonce policy: the tag with the nonce slot, the caveats behind a disclosure", () => {
    const { c, html } = tagView(probe({ install: DEGRADES_NONCE }));
    expect(c).toMatchObject({ kind: "degrades", nonce: true });
    const t = text(html);
    expect(t).toContain('<script data-cfasync="false" nonce="YOUR-PAGE-NONCE"');
    expect(t).toContain("Tag with your nonce");
    expect(t).toContain("Put your page's nonce in place of YOUR-PAGE-NONCE .");
    expect(conditionLines(c, DEGRADES_NONCE.csp, TAG)).toEqual(DEGRADES_NONCE.csp.lines);
    expect(policyNotes(DEGRADES_NONCE.csp)).toHaveLength(2);
    expect(t).toContain("Trusted Types");
  });

  it("degrades on a nonce policy from an older worker (no line): the same tag, built here", () => {
    const { c } = tagView(probe({ install: DEGRADES_NONCE_NO_LINE }));
    expect(c).toMatchObject({ kind: "degrades", nonce: true });
    expect(conditionLines(c, DEGRADES_NONCE_NO_LINE.csp, TAG)).toEqual(DEGRADES_NONCE.csp.lines);
  });

  it("degrades on a nonce policy on Next.js: the JSX tag, in app/layout.tsx", () => {
    const { c, html } = tagView(probe({ install: DEGRADES_NONCE_NEXT }));
    expect(c).toMatchObject({ kind: "degrades", nonce: true });
    const t = text(html);
    expect(t).toContain("nonce={nonce}");
    expect(t).toContain("In app/layout.tsx , read the nonce");
    expect(t).not.toContain("YOUR-PAGE-NONCE");
  });

  const late: [string, Partial<InstallFacts>, Partial<ProbeResponse>, string][] = [
    [
      "older",
      { platform: "lovable", tag_flags: ["async"] },
      { tag_form: "generic" },
      "Message for Lovable",
    ],
    ["async", { tag_flags: ["async"] }, {}, "Tag, first line inside <head>"],
    ["defer", { tag_flags: ["defer"] }, {}, "Tag, first line inside <head>"],
    ["module", { tag_flags: ["module"] }, {}, "Tag, first line inside <head>"],
    [
      "gtm",
      { tag_position: "not_found", tag_flags: ["gtm"] },
      { status: "removed", reason: "Snippet tag not found in page HTML" },
      "Tag, first line inside <head>",
    ],
    ["rocket_loader", { tag_flags: ["rocket_loader"] }, {}, 'data-cfasync="false"'],
    ["body_late", { tag_position: "body_late" }, {}, "first inside <head>"],
    [
      "blocking_script_before",
      { tag_position: "head_late", tag_flags: ["blocking_script_before"] },
      {},
      "Move the tag above it.",
    ],
  ];
  for (const [cause, facts, over, shows] of late) {
    it(`late, ${cause}: amber, the page stays as built, the fix`, () => {
      const { c, html } = tagView(probe({ install: install(facts), ...over }));
      expect(c).toMatchObject({ kind: "late", tone: "warn", cause });
      expect(text(html)).toContain(shows);
      expect(tagIsOn(c)).toBe(true);
      expect(text(html)).toMatch(/as you built it/);
      expect(text(html)).not.toMatch(/then the version|before the version/);
    });
  }

  it("late at the end of a Webflow page moves the Embed, not a head line", () => {
    const { html } = tagView(
      probe({ install: install({ platform: "webflow", tag_position: "body_late" }) }),
    );
    expect(text(html)).toContain("Move the Code Embed to the very top of the body.");
  });

  it("no state writes a dash", () => {
    const states = [
      probe(),
      probe({ install: BRISK }),
      probe({ install: HASH_ONLY }),
      probe({ install: NEEDS_NONCE_NEXT }),
      probe({ install: NEEDS_NONCE_PLAIN }),
      probe({ install: REPORT_ONLY }),
      probe({ install: DEGRADES }),
      probe({ install: DEGRADES_NONCE }),
      probe({ status: "unknown", read: "off_host", tag_runs: false, install: null }),
      probe({ status: "unknown", read: "bot_protection", tag_runs: false, install: null }),
    ];
    for (const r of states) {
      expect(text(tagView(r).html)).not.toMatch(NO_DASH);
      expect(waitLine(r, "brisk.test").text).not.toMatch(NO_DASH);
    }
  });
});

describe("Connect step 1, every platform", () => {
  const platforms: InstallPlatform[] = [
    "webflow",
    "framer",
    "wix",
    "squarespace",
    "shopify",
    "wordpress",
    "lovable",
    "nextjs",
    "vercel",
    "other",
  ];

  function steps(r: ProbeResponse | null): string {
    return renderToStaticMarkup(h(PlatformSteps, { probe: r, tag: TAG }, null));
  }

  for (const p of platforms) {
    it(`${p}: three short steps and the tag with data-cfasync`, () => {
      const html = steps(probe({ install: install({ platform: p, tag_position: "not_found" }) }));
      const s = connectSteps(p, "free");
      expect(s.steps).toHaveLength(3);
      for (const step of s.steps) expect(step.length).toBeLessThan(130);
      expect(text(html)).toContain('data-cfasync="false"');
      expect(text(html)).not.toMatch(NO_DASH);
    });
  }

  it("before the first probe: the generic head line", () => {
    expect(text(steps(null))).toContain(
      "First line inside the head, exactly as written, no async.",
    );
  });

  it("Webflow free: body heading, the cost, the per-page caveat behind a disclosure", () => {
    const html = steps(
      probe({
        install: install({ platform: "webflow", tag_position: "not_found" }),
        tag_runs: false,
      }),
    );
    const t = text(html);
    expect(t).toContain("1. Put this line at the top of your page's body");
    expect(t).toContain("We see a Webflow site.");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Free plan/);
    expect(t).toContain("Drag a Code Embed to the very top of the body");
    expect(t).toContain("The free plan has no head code.");
    expect(html).toMatch(/<details[^>]*>.*More than one page\?/s);
    expect(t).toContain("Not Webflow?");
  });

  it("Webflow with the tag in the head: Paid is preselected", () => {
    const html = steps(
      probe({ install: install({ platform: "webflow", tag_position: "head_first" }) }),
    );
    expect(html).toMatch(/aria-pressed="true"[^>]*>Paid site plan/);
    expect(text(html)).toContain("Paste this line into your site's <head>");
  });

  it("Next.js on Vercel names both", () => {
    const html = steps(probe({ install: BRISK }));
    expect(text(html)).toContain("We see a Next.js site on Vercel.");
    expect(text(html)).toContain("not next/script");
  });

  it("Lovable: a message to paste, with the tag in it", () => {
    const t = text(steps(probe({ install: install({ platform: "lovable" }) })));
    expect(t).toContain("Message for Lovable");
    expect(t).toContain("Add this script as the first line inside <head> in index.html");
  });
});

describe("Connect step 2, after 45 seconds", () => {
  const LINK = "https://brisk.test/#rawuser_capture=abc";
  function box(r: ProbeResponse | null): string {
    return text(
      renderToStaticMarkup(
        h(WaitBox, {
          wait: waitLine(r, "brisk.test"),
          captureLink: LINK,
          domain: "brisk.test",
          onRead: () => undefined,
        }),
      ),
    );
  }

  it("blocked: names the policy, offers the read", () => {
    const t = box(probe({ install: BRISK }));
    expect(t).toContain("Your security policy blocks the tag (step 1).");
    expect(t).toContain("Read brisk.test from its address");
    expect(t).not.toContain(LINK);
  });

  it("tag not found", () => {
    const t = box(
      probe({
        status: "removed",
        reason: "x",
        tag_runs: false,
        install: install({ tag_position: "not_found" }),
      }),
    );
    expect(t).toContain("The last check did not find the tag on brisk.test.");
  });

  it("Tag Manager", () => {
    const t = box(
      probe({
        status: "removed",
        reason: "x",
        install: install({ tag_position: "not_found", tag_flags: ["gtm"] }),
      }),
    );
    expect(t).toContain("Tag Manager loads the tag late");
  });

  it("late for another cause", () => {
    expect(box(probe({ install: install({ tag_flags: ["async"] }) }))).toContain(
      "Your tag runs late",
    );
  });

  it("off host", () => {
    expect(
      box(probe({ status: "unknown", read: "off_host", tag_runs: false, install: null })),
    ).toContain("brisk.test redirects to another site");
  });

  it("tag fine, page never opened: the capture link", () => {
    const t = box(probe());
    expect(t).toContain("If your page opened, reload it once.");
    expect(t).toContain(LINK);
    expect(box(null)).toContain(LINK);
  });

  it("every line is short", () => {
    for (const r of [
      probe(),
      probe({ install: BRISK }),
      probe({ install: install({ tag_flags: ["gtm"] }) }),
    ]) {
      expect(waitLine(r, "brisk.test").text.length).toBeLessThan(140);
    }
  });
});

describe("/apply", () => {
  it("the read line over time", () => {
    expect(readingLine(0)).toBe("Reading your page…");
    expect(readingLine(1)).toBe(
      "Reading your site. Sites built in the browser take up to half a minute.",
    );
    expect(readingLine(2)).toBe("Still reading. This can take up to a minute.");
  });

  it("each 422 has its own line, and each says the read did not count", () => {
    const lines = ["bot_protection", "render_failed", "client_rendered", "off_host", undefined].map(
      readRefusal,
    );
    expect(lines[0]).toContain("bot protection turned our reader away");
    expect(lines[1]).toContain("We couldn't read that page just now.");
    expect(lines[2]).toContain("builds its page in the browser");
    expect(lines[3]).toContain("redirects to another site");
    for (const l of lines) {
      expect(l).toMatch(/This read did not count\.$/);
      expect(l).not.toMatch(NO_DASH);
    }
  });

  function done(installFacts: InstallFacts | null): string {
    return renderToStaticMarkup(
      h(DoneScreen, {
        kicker: "Rawuser · pilot for Brisk",
        done: { customer_id: "brisk", tag: TAG, install: installFacts },
      }),
    );
  }

  it("done, nothing read: the general step and one tag", () => {
    const t = text(done(null));
    expect(t).toContain("You’re in.");
    expect(t).toContain("Put the tag on, and Sam sets up your first versions with you.");
    expect(t).toContain("On Webflow's free plan, use a Code Embed");
    expect(t).not.toContain("Your security policy");
  });

  it("done, Webflow: both plans in one step", () => {
    const t = text(done(install({ platform: "webflow", tag_position: "not_found" })));
    expect(t).toContain("Your site runs on Webflow.");
    expect(t).toContain("On the free plan, a Code Embed as the first element of the body");
    expect(t).not.toContain("02");
  });

  it("done, brisk.test: two numbered changes, the exact lines", () => {
    const html = done(BRISK);
    const t = text(html);
    expect(t).toContain("Your site runs on Next.js. Two changes on your side");
    expect(t).toContain("01 The tag");
    expect(t).toContain("02 Your security policy");
    expect(t).toContain(
      "In next.config.js , inside async headers() , change these lines and keep the rest.",
    );
    expect(t).toContain(
      "connect-src 'self' https://*.posthog.com https://vitals.vercel-insights.com https://edge.example.com",
    );
    expect(html).toContain(`text-[#9fd3b5]">${EDGE}`);
    expect(t).toContain("If your policy lives in middleware.ts, change it there.");
  });

  it("done, hash only: a word with us instead of a wrong line", () => {
    expect(donePolicy(HASH_ONLY)).toBe("write");
    const html = done(HASH_ONLY);
    expect(text(html)).toContain("02 Your security policy");
    expect(text(html)).toContain("Write to Sam");
    expect(html).toContain('href="mailto:sam@example.com"');
  });

  it("done, a nonce policy on Next.js: the tag for the layout", () => {
    expect(donePolicy(NEEDS_NONCE_NEXT)).toBe("lines");
    expect(text(done(NEEDS_NONCE_NEXT))).toContain("nonce={nonce}");
  });

  it("done, report-only or a blocked style only: one step, the policy waits for Connect", () => {
    expect(donePolicy(REPORT_ONLY)).toBeNull();
    expect(donePolicy(DEGRADES)).toBeNull();
    expect(text(done(REPORT_ONLY))).not.toContain("02");
  });
});

describe("the Pages card lines", () => {
  const pages = ["/", "/pricing"].map((p) => ({ page_path: p, confirmed_at: 1 })) as never;
  const site = {
    probed_at: 1,
    csp_blocks: true,
    csp_blocks_since: null,
    csp_degrades: false,
    csp_report_only_blocks: false,
    platform: "nextjs" as const,
    tag_position: "head_first" as const,
    tag_flags: [],
  };

  function card(health: unknown): string {
    return renderToStaticMarkup(
      h(PagesCard, {
        customer: CUSTOMER,
        pages,
        readyByPath: { "/": 30, "/pricing": 30 },
        writing: false,
        onPageAdded: () => undefined,
        perPage: 30,
        health: health as never,
      }),
    );
  }

  it("the policy line is amber, once under the intro, and opens the lines in place", () => {
    const html = card({ customer_id: "brisk", hours: 24, since: 0, loads: 0, pages: [], site });
    const t = text(html);
    expect(t).toContain(
      "Your site's security policy now blocks Rawuser, so visitors see your pages as built.",
    );
    expect(t).toContain("See the lines");
    expect(html).toContain(TINT.warn.split(" ")[0]);
    expect(html).not.toContain(TINT.err.split(" ")[0]);
    expect(html.indexOf("See the lines")).toBeLessThan(html.indexOf("homepage"));
  });

  it("no policy line when it does not block", () => {
    const t = text(
      card({
        customer_id: "brisk",
        hours: 24,
        since: 0,
        loads: 0,
        pages: [],
        site: { ...site, csp_blocks: false },
      }),
    );
    expect(t).not.toContain("security policy");
  });

  it("the late-tag line sits under its page and opens the fix in place", () => {
    const html = card({
      customer_id: "brisk",
      hours: 24,
      since: 0,
      loads: 212,
      pages: [
        {
          page_path: "/pricing",
          loads: 212,
          issues: [{ code: "late_tag", count: 31, share: 0.146, slot: null }],
        },
      ],
      site: { ...site, csp_blocks: false },
    });
    const t = text(html);
    expect(t).toContain(
      "On 15% of visits in the last 24 h, your tag ran after the page appeared, so those visitors saw your page as you built it. How to move it",
    );
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>How to move it<\/button>/);
    expect(html).not.toMatch(/<a[^>]*>How to move it/);
    expect(html.indexOf("How to move it")).toBeGreaterThan(html.indexOf("/pricing"));
  });

  it("a fresh probe decides whether the fix still shows", () => {
    const blocked = tagCondition(probe({ install: BRISK }), "brisk.test");
    const late = tagCondition(probe({ install: install({ tag_flags: ["async"] }) }), "brisk.test");
    const fine = tagCondition(probe(), "brisk.test");
    expect(fixStillNeeded("policy", blocked)).toBe(true);
    expect(fixStillNeeded("policy", fine)).toBe(false);
    expect(fixStillNeeded("late", late)).toBe(true);
    expect(fixStillNeeded("late", fine)).toBe(false);
  });
});
