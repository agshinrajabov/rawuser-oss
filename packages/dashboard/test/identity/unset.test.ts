/**
 * A build that was given none of the six values (src/lib/identity.ts): every
 * sentence that would name the operator or an address still reads whole, no
 * mail link is drawn, and where a tag would be one line says the edge
 * address is not configured. Nothing falls back to an address of anyone's.
 */
import "./unset";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DoneScreen, InviteMessage } from "../../src/components/apply/ApplyFlow";
import { AuditEndedView, AuditStatusView } from "../../src/components/audit/AuditPage";
import {
  PrivacyLine,
  SignupScreenView,
  linkGoneLine,
} from "../../src/components/audit/AuditSignup";
import { ReportView } from "../../src/components/audit/ReportView";
import { LedgerInline } from "../../src/components/audit/ledger";
import { SnippetHandoff, buildEmail } from "../../src/components/onboard/SnippetHandoff";
import { TagCopy } from "../../src/components/onboard/TagCopy";
import { TagStatusView, conditionMeta } from "../../src/components/onboard/TagStatus";
import { LateTagNote } from "../../src/components/start/PagesCard";
import { PlatformSteps } from "../../src/components/start/PlatformSteps";
import { Help } from "../../src/components/v2/Help";
import { auditPageView, pilotMailto } from "../../src/lib/audit";
import * as identity from "../../src/lib/identity";
import { doneLede, donePolicyStep, lovableSwapMessage, tagCondition } from "../../src/lib/install";
import { afterLine } from "../../src/lib/proof";
import { headlineFor } from "../../src/lib/results";
import { EDGE_MARK, buildSnippet, isTag } from "../../src/lib/snippet-tag";
import { REPORTS } from "../analytics/proof-fixtures";
import { FULL, STATUS } from "../audit/audit-fixtures";
import { BRISK, CUSTOMER, HASH_ONLY, install, probe } from "../install-fixtures";

const NOT_SET = "The edge address is not configured.";
const noop = () => {};

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

/** What no screen of such a build may hold: a mail link, an address, a hole. */
function whole(html: string) {
  expect(html).not.toContain("mailto:");
  expect(html).not.toMatch(/href=""/);
  expect(html).not.toMatch(/\bundefined\b|\bnull\b/);
  // Inline tags dropped without a space, so a sentence set in parts reads as one.
  const t = text(html.replace(/<\/?(?:a|span|code|strong|em|b)\b[^>]*>/g, ""));
  expect(t).not.toMatch(/\S@\S/);
  // A word dropped from a sentence leaves two spaces, or a space before a stop.
  expect(t).not.toMatch(/ [.,;:!?](?:\s|$)/);
  expect(t).not.toMatch(/\b(?:to|for|ask|then|and) [.,]/i);
}

describe("the module", () => {
  it("holds nothing", () => {
    expect(identity.EDGE_ORIGIN).toBeNull();
    expect(identity.EDGE_HOST).toBeNull();
    expect(identity.APP_ORIGIN).toBeNull();
    expect(identity.DPA_URL).toBeNull();
    expect(identity.OPERATOR_NAME).toBeNull();
    expect(identity.OPERATOR_EMAIL).toBeNull();
    expect(identity.SUPPORT_EMAIL).toBeNull();
    expect(identity.PRIVACY_EMAIL).toBeNull();
  });

  it("an empty value is an unset one, and an origin loses its last slash", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_OPERATOR_NAME", "  ");
    vi.stubEnv("NEXT_PUBLIC_EDGE_ORIGIN", "https://edge.example.com/");
    try {
      const again = await import("../../src/lib/identity");
      expect(again.OPERATOR_NAME).toBeNull();
      expect(again.EDGE_ORIGIN).toBe("https://edge.example.com");
      expect(again.EDGE_HOST).toBe("edge.example.com");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(process.env.NEXT_PUBLIC_EDGE_ORIGIN).toBeUndefined();
  });

  it("no mail link without an address", () => {
    expect(identity.mailto(null)).toBeNull();
    expect(identity.mailto(null, "A subject")).toBeNull();
    expect(identity.mailto("sam@example.com", "A pilot for acme.example")).toBe(
      "mailto:sam@example.com?subject=A%20pilot%20for%20acme.example",
    );
  });
});

describe("the tag", () => {
  const TAG = buildSnippet("acme");

  it("is one line that says so, never a script", () => {
    expect(TAG).toBe(NOT_SET);
    expect(isTag(TAG)).toBe(false);
    expect(EDGE_MARK).toBe("");
  });

  it("a tag block shows the line, with nothing to copy", () => {
    const html = renderToStaticMarkup(h(TagCopy, { label: "Tag", content: TAG }));
    expect(text(html)).toBe(NOT_SET);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<pre");
  });

  it("Connect, the late-tag fix and the done screen show the line", () => {
    const connect = renderToStaticMarkup(
      h(PlatformSteps, { probe: probe({ install: install({ platform: "webflow" }) }), tag: TAG }),
    );
    const late = renderToStaticMarkup(
      h(LateTagNote, {
        line: { tone: "warn", text: "The tag runs late on 1 in 4 loads.", cause: "async" } as never,
        tag: TAG,
        defaultOpen: true,
      }),
    );
    const done = renderToStaticMarkup(
      h(DoneScreen, { kicker: "Rawuser", done: { customer_id: "acme", tag: TAG } }),
    );
    for (const html of [connect, late, done]) {
      expect(text(html)).toContain(NOT_SET);
      expect(html).toContain("data-tag-unset");
      expect(html).not.toContain("&lt;script");
      expect(html).not.toContain("/s/acme.js");
      whole(html);
    }
    expect(text(done)).not.toContain("Your tag");
  });

  it("the done screen still shows a tag the API gave", () => {
    const given = '<script data-cfasync="false" src="https://edge.example.com/s/acme.js"></script>';
    const html = renderToStaticMarkup(
      h(DoneScreen, { kicker: "Rawuser", done: { customer_id: "acme", tag: given } }),
    );
    expect(text(html)).toContain("Your tag");
    expect(text(html)).toContain(given);
    expect(html).not.toContain("data-tag-unset");
  });

  it("the handoff has no email to send without a tag", () => {
    const html = renderToStaticMarkup(
      h(SnippetHandoff, { customer: { ...(CUSTOMER as object), contact_name: null } as never }),
    );
    expect(text(html)).toContain(NOT_SET);
    expect(text(html)).not.toContain("Email template");
    whole(html);
  });

  it("the older tag is named without a host", () => {
    expect(lovableSwapMessage("TAG")).toBe(
      "In index.html, remove the script tag that loads snippet.js. Add this script as the first line inside <head>, exactly as written, without async or defer:\nTAG",
    );
  });
});

describe("the sentences that would name the operator", () => {
  it("the apply door", () => {
    const t = (kind: "missing" | "expired" | "used") => {
      const html = renderToStaticMarkup(h(InviteMessage, { kind, kicker: "Rawuser" }));
      whole(html);
      return text(html);
    };
    expect(t("missing")).toBe(
      "Rawuser This page opens from an invite link. Ask whoever invited you for one, and it will bring you straight here.",
    );
    expect(t("expired")).toBe(
      "Rawuser This link has expired. Ask whoever invited you for a new one.",
    );
    expect(t("used")).toBe(
      "Rawuser This invite was already used. If you need your tag again, whoever invited you can send it to you.",
    );
  });

  it("the audit door", () => {
    const t = (kind: "missing" | "expired") => {
      const html = renderToStaticMarkup(h(SignupScreenView, { screen: { kind } }));
      whole(html);
      return text(html);
    };
    expect(t("missing")).toContain(
      "Ask whoever invited you for one, and it will bring you straight here.",
    );
    expect(t("expired")).toContain(
      "This link has expired. Reply to whoever invited you for a new one.",
    );
    expect(linkGoneLine()).toBe(
      "This link no longer works. Reply to whoever invited you for a new one.",
    );
  });

  it("the done screen", () => {
    expect(doneLede(null)).toBe("Put the tag on, and we set up your first versions with you.");
    expect(doneLede(BRISK)).toBe(
      "Your site runs on Next.js. Two changes on your side, then we set up your first versions with you.",
    );
    expect(donePolicyStep(HASH_ONLY)).toBe(
      "Your policy runs only scripts it knows by hash, which cannot cover Rawuser's tag. Write to us and we find the way in with you.",
    );
  });

  it("a policy that knows scripts by hash: the sentence, and no address under it", () => {
    const c = tagCondition(probe({ install: HASH_ONLY }), "acme.example");
    expect(c).toMatchObject({
      kind: "hash_only",
      body: "A hash cannot cover Rawuser's tag, because it changes each time you confirm a page. Write to us and we find the way in with you.",
    });
    const connect = renderToStaticMarkup(
      h(TagStatusView, {
        condition: c,
        install: HASH_ONLY,
        tag: buildSnippet("acme"),
        meta: conditionMeta(c, false, Date.now()),
        showAgain: false,
      }),
    );
    const done = renderToStaticMarkup(
      h(DoneScreen, {
        kicker: "Rawuser",
        done: { customer_id: "acme", tag: buildSnippet("acme"), install: HASH_ONLY },
      }),
    );
    for (const html of [connect, done]) {
      expect(text(html)).toContain("Write to us and we find the way in with you.");
      whole(html);
    }
  });

  it("a test that lost, one being checked, an audit being checked", () => {
    expect(afterLine(REPORTS.negative, false)).toBe("We will write to you today.");
    expect(headlineFor(REPORTS.held_back).tail).toBe("We will write to you.");
    expect(auditPageView(STATUS.checking).s2).toBe("We read every report before it goes out.");
    const html = renderToStaticMarkup(
      h(AuditStatusView, {
        status: STATUS.checking,
        onShare: noop,
        reportHref: "/audit/report/",
        startHref: "/start/",
      }),
    );
    expect(text(html)).toContain("We read every report before it goes out.");
    whole(html);
  });

  it("the handoff email ends without a name", () => {
    const email = buildEmail({ ...(CUSTOMER as object), contact_name: null } as never, "TAG");
    expect(email.endsWith("at the end of week 1.\n\nThanks.")).toBe(true);
    expect(identity.signOff()).toBe("Thanks.");
  });
});

describe("where a mail link would be", () => {
  it("Talk about a pilot: no button, and the report says how instead", () => {
    expect(pilotMailto("acme.example")).toBeNull();
    const report = renderToStaticMarkup(h(ReportView, { report: FULL }));
    expect(text(report)).not.toContain("Talk about a pilot");
    expect(report).toContain(
      '<p class="mt-2.5 text-[13px] text-[#525252]">To talk about a pilot, reply to the email this report came with.</p>',
    );
    expect(report).not.toContain("mailto:");
    const ended = renderToStaticMarkup(
      h(AuditEndedView, { status: STATUS.ended, reportOpen: true, reportHref: "/audit/report/" }),
    );
    expect(text(ended)).not.toContain("Talk about a pilot");
    expect(text(ended)).toContain("Open your report");
    whole(ended);
  });

  it("help: one line, no card", () => {
    expect(identity.helpLine()).toBe("Ask whoever runs this install");
    const html = renderToStaticMarkup(h(Help));
    expect(text(html)).toBe("Help Ask whoever runs this install");
    whole(html);
  });

  it("a sentence that holds an address is drawn as written", () => {
    const line = "Write to privacy@example.com with a question.";
    expect(renderToStaticMarkup(h(PrivacyLine, { text: line }))).toBe(line);
    expect(renderToStaticMarkup(h(LedgerInline, { text: `**Bold** and ${line}` }))).toBe(
      `<strong class="font-medium text-[#171717]">Bold</strong><span> and ${line}</span>`,
    );
  });
});
