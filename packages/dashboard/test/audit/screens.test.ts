/**
 * Every state of the audit screens (mock design/mock/sales-readiness/
 * ai-traffic-audit.html, approved 2026-10-06), rendered to markup: the
 * sign-up and its screens, the report in its three states and its parts,
 * the Audit page in every stage, the ended screen, the invite dialog, the
 * review and its dialogs, the Live card, the strip and the Pages card cap.
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

import { AuditInviteBody, INVITES_OFF_LINE } from "../../src/components/audit/AuditInviteDialog";
import { AuditEndedView, AuditStatusView } from "../../src/components/audit/AuditPage";
import {
  AuditReviewView,
  EndDialogBody,
  LinkDialogBody,
} from "../../src/components/audit/AuditReview";
import {
  AuditForm,
  BANNER_HELP,
  BANNER_MORE,
  DoneScreen,
  SignupScreenView,
  TERMS_LINE,
  screenForOpen,
} from "../../src/components/audit/AuditSignup";
import { AuditStrip, GoLiveAuditLine } from "../../src/components/audit/FirstRunAudit";
import { ReportScreenView } from "../../src/components/audit/ReportPage";
import { ReportView } from "../../src/components/audit/ReportView";
import {
  VisitorVersionsView,
  likelyIntent,
  sourceChips,
} from "../../src/components/audit/VisitorVersions";
import { PagesCard } from "../../src/components/start/PagesCard";
import { Dialog } from "../../src/components/ui/Dialog";
import { SHARE_LINE } from "../../src/lib/audit";
import {
  COUNTS,
  EXTENDED,
  FULL,
  NOW,
  RESULT_LINE,
  REVIEW,
  STATUS,
  TEMPLATE_SAMPLE,
  TOO_FEW,
} from "./audit-fixtures";

const noop = () => undefined;
const PRIVACY =
  "We use your name and email to run your audit and send your report. Write to privacy@example.com with a question.";

function text(html: string): string {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gs, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text with inline tags dropped without a space: a sentence split by links or spans. */
function flat(html: string): string {
  return text(html.replace(/<(a|span|em|b)\b[^>]*>|<\/(a|span|em|b)>/g, ""));
}

/** The founder's rules on every rendered string. */
function rules(html: string) {
  const t = text(html);
  expect(t).not.toMatch(/[\u2013\u2014]/);
  expect(t).not.toContain("<5");
  expect(t).not.toMatch(/\bproven\b|\bsignificant\b/i);
  expect(t).not.toMatch(/for privacy/i);
  expect(t).not.toMatch(/exempt/i);
}

function dialog(child: ReturnType<typeof h>) {
  // Radix renders the content in a portal; the bodies render on their own.
  return renderToStaticMarkup(h(Dialog, { open: true }, child));
}

// ---------------------------------------------------------------------------
// Sign-up
// ---------------------------------------------------------------------------

describe("sign-up", () => {
  const invite = {
    ok: true,
    status: "invited" as const,
    invited_name: "Rina Holt",
    invited_site: "quoteloom.example",
    privacy_line: PRIVACY,
  };

  it("the form: four fields, the terms unticked, no banner sentence, the privacy line verbatim", () => {
    const html = renderToStaticMarkup(
      h(AuditForm, { token: "t", invite, onDone: noop, onUsed: noop, onExpired: noop }),
    );
    const t = text(html);
    expect(t).toContain("See where your visits come from.");
    for (const l of ["Your site", "Your name", "Your email"]) expect(t).toContain(l);
    expect(t).toContain("My site shows a cookie or consent banner.");
    expect(t).toContain("I accept the audit terms");
    expect(t).toContain(TERMS_LINE);
    expect(t).toContain("Text for your privacy notice");
    expect(flat(html)).toContain(PRIVACY);
    expect(t).not.toContain(BANNER_HELP);
    expect(t).not.toContain(BANNER_MORE);
    // Both ticks off on arrival, Send looks off until the terms are ticked.
    expect(html).not.toMatch(/\schecked=""/);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toMatch(/<button type="submit" aria-disabled="true"/);
    expect(html).toContain('href="/audit/terms/"');
    expect(html).toContain('value="quoteloom.example"');
    rules(html);
  });

  it("the banner sentence only once the prospect says there is a banner", () => {
    const t = text(
      renderToStaticMarkup(
        h(AuditForm, {
          token: "t",
          invite,
          onDone: noop,
          onUsed: noop,
          onExpired: noop,
          initial: { banner: true, terms: true },
        }),
      ),
    );
    expect(t).toContain(BANNER_HELP);
    expect(t).toContain("More");
  });

  it("refusals under Send and under the fields", () => {
    const html = renderToStaticMarkup(
      h(AuditForm, {
        token: "t",
        invite,
        onDone: noop,
        onUsed: noop,
        onExpired: noop,
        initial: {
          email: "rina@",
          errors: { email: "That email doesn't look right." },
          sendError: "quoteloom.example already has an audit or an account. Sign in instead.",
        },
      }),
    );
    const t = text(html);
    expect(t).toContain("That email doesn't look right.");
    expect(t).toContain("quoteloom.example already has an audit or an account. Sign in instead.");
    expect(html).toContain('role="alert"');
  });

  it("the open answer decides the screen", () => {
    expect(screenForOpen(200, invite).kind).toBe("form");
    expect(screenForOpen(200, { ok: true, status: "used" }).kind).toBe("used");
    expect(screenForOpen(200, { ok: true, status: "expired" }).kind).toBe("expired");
    expect(screenForOpen(404, { ok: false }).kind).toBe("expired");
    expect(screenForOpen(500, null).kind).toBe("unreachable");
  });

  it("loading, missing, used, expired, unreachable", () => {
    const t = (kind: "loading" | "missing" | "used" | "expired" | "unreachable") =>
      text(renderToStaticMarkup(h(SignupScreenView, { screen: { kind } })));
    expect(t("loading")).toContain("Opening your invite");
    expect(t("missing")).toContain("This page opens from an invite link.");
    expect(t("used")).toContain("This link was used. Sign in to see your audit.");
    expect(t("expired")).toContain("This link has expired. Reply to Sam for a new one.");
    expect(t("unreachable")).toContain("We couldn't open your invite.");
  });

  it("You're in, then the password step; the setup token never in the markup", () => {
    const done = renderToStaticMarkup(
      h(DoneScreen, { domain: "quoteloom.example", setupToken: "setup-secret" }),
    );
    expect(text(done)).toContain("Rawuser · free audit for quoteloom.example");
    expect(text(done)).toContain("You’re in. Set a password, then put the tag on your site.");
    expect(text(done)).toContain("Set your password");
    expect(done).not.toContain("setup-secret");
    const pw = renderToStaticMarkup(
      h(DoneScreen, {
        domain: "quoteloom.example",
        setupToken: "setup-secret",
        initialStep: "password",
      }),
    );
    expect(text(pw)).toContain("Set your password.");
    expect(pw).toContain('autoComplete="new-password"');
    expect(pw).not.toContain("setup-secret");
    rules(done + pw);
  });
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

describe("the report", () => {
  it("full: header, three answers, sample, groups that add up, landing, test line, last line", () => {
    const html = renderToStaticMarkup(h(ReportView, { report: FULL }));
    const t = text(html);
    expect(t).toContain("Where your visits came from");
    expect(t).toContain("quoteloom.example");
    expect(t).toContain("7 to 13 October");
    expect(t).toContain("1,240 visits");
    expect(t).toContain("AI assistants sent about 4% of your visits.");
    expect(t).toContain("52 visits. ChatGPT 31, Perplexity 9, other 12.");
    expect(t).toContain("Links opened inside apps: about 9%.");
    expect(t).toContain("61 we could name, 51 probably.");
    expect(t).toContain("71 visits came from inside an app with no referrer and no tags.");
    expect(t).toContain("Most analytics tools count these as Direct.");
    expect(t).toContain("What your visitors from ChatGPT saw");
    expect(t).toContain("Your page");
    expect(t).toContain("Their version");
    expect(t).toContain("One of 90 versions written for your site.");
    expect(html).toContain("<em");
    expect(t).not.toContain("*");
    expect(t).toContain("Where every visit came from");
    expect(t).toContain("No referrer, no tags. 51 probably a link from a phone app.");
    expect(t).toContain("All visits 1,240 100%");
    expect(t).toContain("Where they landed");
    expect(t).toContain("Inside an app, no referrer");
    expect(t).toContain("A page shows with 5 visits or more in its group.");
    expect(t).toContain(
      "Too early. The test needs about 14,400 visits with a version, about 20 weeks at this week's traffic. It keeps running in a pilot.",
    );
    expect(t).toContain(
      "589 visits saw a version made for why they came. The test keeps running in a pilot.",
    );
    expect(t).toContain("Talk about a pilot");
    expect(html).toContain("mailto:sam@example.com");
    expect(t).toContain("To talk about a pilot, reply to the email this report came with.");
    expect(t).toContain("Built 14 October.");
    // No contact anywhere in a report.
    expect(t).not.toContain("Rina");
    expect(t).not.toContain("rina@");
    rules(html);
  });

  it("the three disclosures print open and carry the banner line exactly", () => {
    const html = renderToStaticMarkup(h(ReportView, { report: FULL }));
    // Closed on screen, opened by the print stylesheet.
    expect(html.match(/hidden print:block/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("@media print");
    expect(html).toContain("counter(pages)");
    const open = flat(renderToStaticMarkup(h(ReportView, { report: FULL, openAll: true })));
    expect(open).toContain(
      "If your banner holds our tag back, only visits that accepted it are counted.",
    );
    expect(open).toContain(
      "Each share could be a little higher or lower. These are the 95% ranges.",
    );
    expect(open).toContain("AI assistants: between 3% and 6%.");
    expect(open).toContain("No source to read: between 51% and 58%.");
    expect(open).toContain("Each visit is counted once, by where it landed from.");
  });

  it("counts only: no percent, no How sure, the floors in words", () => {
    const html = renderToStaticMarkup(h(ReportView, { report: COUNTS, openAll: true }));
    const t = text(html);
    expect(t).toContain("Too few visits for shares. Here is what we saw.");
    expect(t).toContain("AI assistants sent 9 visits.");
    expect(t).toContain("ChatGPT 6, other fewer than 5.");
    expect(t).toContain("Communities fewer than 5");
    expect(t).toContain("Ads None seen");
    expect(t).not.toContain("How sure");
    expect(t).not.toMatch(/\d%/);
    expect(t).not.toContain("If your banner holds our tag back");
    expect(t).toContain("131 visits saw a version made for why they came. A pilot keeps it going");
    rules(html);
  });

  it("too few: one line, the would-see sample, no groups, the versions-at-start line", () => {
    const html = renderToStaticMarkup(h(ReportView, { report: TOO_FEW }));
    const t = text(html);
    expect(t).toContain("We saw 18 visits. Too few to say anything.");
    expect(t).toContain("What a visitor from ChatGPT would see");
    expect(t).toContain("would see");
    expect(t).not.toContain("Where every visit came from");
    expect(t).not.toContain("Where they landed");
    expect(t).toContain("64 of 90 versions were written when counting began.");
    expect(t).toContain(
      "Your versions are written and ready. A pilot keeps them going and measures what they earn.",
    );
    rules(html);
  });

  it("every test line", () => {
    for (const [line, want] of [
      [{ state: "no_button" }, "No button was counted, so there is no test yet."],
      [{ state: "off" }, "No test was running."],
      [{ state: "low_traffic" }, "Too little traffic to measure the versions within a year."],
      [{ state: "checking" }, "We are checking the test."],
      [RESULT_LINE, "Visits that saw the versions clicked Start free 25% more often."],
    ] as const) {
      const t = text(
        renderToStaticMarkup(h(ReportView, { report: { ...FULL, versions_did: line as never } })),
      );
      expect(t).toContain(want);
    }
    const r = text(
      renderToStaticMarkup(h(ReportView, { report: { ...FULL, versions_did: RESULT_LINE } })),
    );
    expect(r).toContain("+25%");
    expect(r).toContain("likely +10% to +40%");
    expect(r).toContain("Likely between 10% and 40% more than your original page.");
  });

  it("a word-split headline shows as its words, never a token", () => {
    const html = renderToStaticMarkup(
      h(ReportView, { report: { ...FULL, sample: TEMPLATE_SAMPLE } }),
    );
    const t = text(html);
    expect(t).toContain("What your visitors from search saw");
    expect(t).toContain("designers");
    expect(t).toContain("in one link");
    expect(t).toContain("signed online");
    expect(t).not.toMatch(/\{[a-z]/);
    expect(html).toContain('title="designers · studios · builders"');
  });

  it("the report page's states", () => {
    const t = (screen: Parameters<typeof ReportScreenView>[0]["screen"]) =>
      text(renderToStaticMarkup(h(ReportScreenView, { screen })));
    expect(t({ kind: "missing" })).toContain("This page opens from a report link.");
    expect(t({ kind: "gone" })).toContain("This link no longer works.");
    expect(t({ kind: "not_ready" })).toContain("Your report is not ready yet.");
    expect(t({ kind: "unreachable" })).toContain("We couldn't open this report.");
  });
});

// ---------------------------------------------------------------------------
// The Audit page, ended
// ---------------------------------------------------------------------------

describe("the Audit page", () => {
  const view = (status: (typeof STATUS)[keyof typeof STATUS], share?: { state: "copied" }) =>
    renderToStaticMarkup(
      h(AuditStatusView, {
        status,
        share,
        onShare: noop,
        reportHref: "/audit/report/",
        startHref: "/start/",
      }),
    );

  it("every stage, no number by source", () => {
    expect(text(view(STATUS.before_go_live))).toContain("Finish setup");
    expect(text(view(STATUS.writing))).toContain("64 of 90 so far.");
    const c = text(view(STATUS.counting));
    expect(c).toContain("Day 3 of 7. Your report: about 14 October.");
    expect(c).toContain("Live since 7 October · 412 visits counted");
    expect(c).toContain("Read what your visitors see");
    expect(c).toContain("The audit ends 21 October unless you start a pilot.");
    expect(c).not.toMatch(/ChatGPT|AI assistants|Search/);
    expect(text(view(EXTENDED))).toContain("Under 300 visits in the first week");
    expect(text(view(STATUS.checking))).toContain("Sam reads every report before it goes out.");
    const r = text(view(STATUS.ready));
    expect(r).toContain("Open your report");
    expect(r).toContain("Copy a share link");
    expect(r).toContain(SHARE_LINE);
    expect(text(view(STATUS.ready, { state: "copied" }))).toContain(
      "The link sent before no longer works.",
    );
    rules(view(STATUS.counting) + view(STATUS.ready));
  });

  it("ended, with and without the report", () => {
    const open = text(
      renderToStaticMarkup(
        h(AuditEndedView, { status: STATUS.ended, reportOpen: true, reportHref: "/audit/report/" }),
      ),
    );
    expect(open).toContain("Audit ended Wed 21 Oct");
    expect(open).toContain(
      "The audit ended. Your page shows as you built it. You can remove the tag.",
    );
    expect(open).toContain("Talk about a pilot");
    expect(open).toContain("Open your report");
    expect(open).toContain(
      "Your report and data are deleted on 13 December unless you start a pilot.",
    );
    const gone = text(
      renderToStaticMarkup(
        h(AuditEndedView, {
          status: STATUS.ended,
          reportOpen: false,
          reportHref: "/audit/report/",
        }),
      ),
    );
    expect(gone).not.toContain("Open your report");
    const lapsed = text(
      renderToStaticMarkup(
        h(AuditEndedView, { status: STATUS.lapsed, reportOpen: false, reportHref: "" }),
      ),
    );
    expect(lapsed).toContain("No go live within 14 days, so the audit closed.");
  });
});

// ---------------------------------------------------------------------------
// The first run
// ---------------------------------------------------------------------------

describe("the first run", () => {
  it("the strip, the line under Go live, the Pages card at its cap", () => {
    expect(text(renderToStaticMarkup(h(AuditStrip, { status: null })))).toContain(
      "Free audit · report a week after you go live",
    );
    expect(text(renderToStaticMarkup(h(AuditStrip, { status: STATUS.counting })))).toContain(
      "Free audit · report about 14 October Audit terms",
    );
    expect(text(renderToStaticMarkup(h(GoLiveAuditLine)))).toBe(
      "Your audit report counts the 7 days after this.",
    );
    const customer = {
      id: "quoteloom-example",
      slug: "quoteloom-example",
      domain: "quoteloom.example",
      plan: "audit",
      status: "active",
    } as never;
    const pages = ["/", "/pricing", "/vs-spreadsheets"].map((p) => ({
      page_path: p,
      confirmed_at: 1,
    })) as never;
    const full = text(
      renderToStaticMarkup(
        h(PagesCard, {
          customer,
          pages,
          readyByPath: { "/": 30, "/pricing": 30, "/vs-spreadsheets": 30 },
          writing: false,
          onPageAdded: noop,
          perPage: 30,
          auditFull: true,
        }),
      ),
    );
    expect(full).toContain("Three pages in the audit. A pilot has more.");
    expect(full).not.toContain("Add this page");
  });

  it("the Live card: names over the floor, the report's pick first, Likely in your report", () => {
    const b = {
      by_source: [
        {
          source_dim: "organic",
          visits: 300,
          names: [{ name: "google", label: "Google", visits: 281, conversions: 0 }],
        },
        {
          source_dim: "ai",
          visits: 40,
          names: [{ name: "chatgpt", label: "ChatGPT", visits: 31, conversions: 0 }],
        },
        {
          source_dim: "social",
          visits: 40,
          names: [{ name: "instagram", label: "Instagram", visits: 34, conversions: 0 }],
        },
      ],
      by_tuple: [
        { intent_dim: "problem", source_dim: "ai", visits: 20, conversions: 0 },
        { intent_dim: "evaluation", source_dim: "ai", visits: 9, conversions: 0 },
      ],
    } as never;
    const chips = sourceChips(b);
    expect(chips.map((c) => c.label)).toEqual(["ChatGPT", "Google", "Instagram"]);
    expect(likelyIntent(b, "ai")).toBe("problem");
    const body = (headline: string) =>
      ({
        sections: {
          hero: {
            kind: "hero",
            headline,
            body: "Pick a template.",
            cta: { label: "Pick a template" },
          },
        },
      }) as never;
    const html = renderToStaticMarkup(
      h(VisitorVersionsView, {
        chips,
        chip: 0,
        onChip: noop,
        pages: ["/", "/pricing"],
        page: "/",
        onPage: noop,
        rows: [
          { intent: "problem", body: body("Quote templates clients *sign*.") },
          { intent: "evaluation", body: body("Pick a quote tool in one *afternoon*.") },
          { intent: "competitor", body: null },
          { intent: "feature", body: body("Templates, signing and *alerts*.") },
        ],
        likely: "problem",
        open: new Set(["problem"]),
        onToggle: noop,
        onRewrite: noop,
        rewriting: null,
        refusal: "The audit's writing budget is used up.",
        expanded: false,
        onExpand: noop,
      }),
    );
    const t = text(html);
    expect(t).toContain("Read what your visitors see");
    expect(t).toContain("Your report shows one of these. Read them before it goes out.");
    expect(t).toContain("Most visits so far");
    expect(t).toContain("Likely in your report");
    expect(t).toContain("Not written yet");
    expect(t).toContain("One more.");
    expect(t).toContain("Names show after 5 visits.");
    expect(t).toContain("The audit's writing budget is used up.");
    const empty = text(
      renderToStaticMarkup(
        h(VisitorVersionsView, {
          chips: [],
          chip: 0,
          onChip: noop,
          pages: ["/"],
          page: "/",
          onPage: noop,
          rows: [],
          likely: null,
          open: new Set<string>(),
          onToggle: noop,
          onRewrite: noop,
          rewriting: null,
          refusal: null,
          expanded: false,
          onExpand: noop,
        }),
      ),
    );
    expect(empty).toContain("Until visits arrive ChatGPT");
  });
});

// ---------------------------------------------------------------------------
// Superadmin
// ---------------------------------------------------------------------------

describe("the invite dialog body", () => {
  const render = (state: Parameters<typeof AuditInviteBody>[0]["state"]) =>
    text(
      dialog(
        h(AuditInviteBody, {
          state,
          summary: { open: 5, max: 10, invites_on: true },
          onName: noop,
          onSite: noop,
          onSubmit: noop,
          onClose: noop,
        }),
      ),
    );
  it("the three states, including audit links off", () => {
    expect(render({ kind: "form", name: "", site: "" })).toContain(
      "New audit link One sign-up, 14 days. 5 of 10 audits open.",
    );
    const made = render({
      kind: "made",
      invite: {
        id: "i",
        kind: "audit",
        link: "https://app.example.com/audit/#t=q7H",
        expires_at: Date.UTC(2026, 9, 20),
      },
    });
    expect(made).toContain("Copy it now. Only its hash is stored, so it cannot be shown again.");
    expect(made).toContain("Expires 20 Oct 2026");
    expect(render({ kind: "refused", message: INVITES_OFF_LINE })).toContain(INVITES_OFF_LINE);
    expect(
      render({ kind: "refused", message: "Ten audits are open. One must end first." }),
    ).toContain("Ten audits are open. One must end first.");
  });
});

describe("the review", () => {
  const actions = {
    onRelease: noop,
    onNewLink: noop,
    onRevoke: noop,
    onEnd: noop,
    onPilotTerms: noop,
    onMakePilot: noop,
  };
  it("ready to review: Release, Make this a pilot off until the pilot terms", () => {
    const html = renderToStaticMarkup(
      h(AuditReviewView, { data: REVIEW as never, name: "Rina Holt", now: NOW, actions }),
    );
    const t = text(html);
    expect(t).toContain("quoteloom.example");
    expect(t).toContain("Audit · Rina Holt · signed up Tue 6 Oct");
    expect(t).toContain("Ready to review");
    expect(t).toContain("26 of 1,312 rows with no visit marker");
    expect(t).toContain("$0.18 of $1.00");
    expect(t).toContain("Groups add up to 1,240.");
    expect(t).toContain("Release");
    expect(t).toContain("Needs signed pilot terms.");
    expect(t).toContain("The report, as Rina will see it");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Make this a pilot/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Revoke/);
  });
  it("released, with the pilot terms signed: Make this a pilot on", () => {
    const data = {
      ...REVIEW,
      status: { ...STATUS.ready, pilot_terms_at: STATUS.pilot.pilot_terms_at },
      released_at: STATUS.ready.report_released_at,
      expires_at: Date.UTC(2027, 0, 12),
      can_make_pilot: true,
    };
    const html = renderToStaticMarkup(
      h(AuditReviewView, { data: data as never, name: "Rina Holt", now: NOW, actions }),
    );
    const t = text(html);
    expect(t).toContain("Released Wed 14 Oct");
    expect(t).toContain("Make a new link");
    expect(t).toContain("Pilot terms signed 18 Oct.");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Make this a pilot/);
  });
  it("the release dialog says where to send the link; End now gives the delete date", () => {
    const link = text(
      dialog(
        h(LinkDialogBody, {
          title: "Report released",
          link: {
            link: "https://app.example.com/audit/report/#t=Zp4",
            expires_at: Date.UTC(2027, 0, 12),
            ends_at: STATUS.ready.ends_at,
          },
          onDone: noop,
        }),
      ),
    );
    expect(link).toContain("Report released");
    expect(link).toContain("Expires 12 Jan 2027 · the audit ends Wed 21 Oct");
    expect(link).toContain("Send it in the thread your invite went to.");
    const end = text(
      dialog(h(EndDialogBody, { deleteOn: Date.UTC(2026, 11, 13), onCancel: noop, onEnd: noop })),
    );
    expect(end).toContain("End the audit now?");
    expect(end).toContain("The data is deleted on 13 Dec.");
  });
});
