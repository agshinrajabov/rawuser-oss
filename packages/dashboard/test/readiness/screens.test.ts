/**
 * The readiness screens, every state the mock draws (design/mock/
 * sales-readiness/readiness-check.html, approved as drawn 2026-10-14):
 * Look all ready and folded (A1 to A3), Look with things to fix (A4 to
 * A6), the question on Connect in each state (A7 to A12), the block
 * (A13), the day-3 traffic line (A14 to A16), the superadmin's list and
 * the customers column (A18 to A20), the phone (A21, A22), and an older
 * worker with no answer (the screens as before). Rendered to markup, no
 * network.
 */
import "../identity/example";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import { ProofCard } from "../../src/components/analytics/ProofCard";
import { ResultsAdmin } from "../../src/components/analytics/ResultsAdmin";
import { DoneScreen } from "../../src/components/apply/ApplyFlow";
import {
  BeforeGoLive,
  CountWords,
  ReadinessList,
  actionFor,
} from "../../src/components/readiness/ReadinessList";
import {
  AnsweredRow,
  ConnectQuestion,
  HeldBox,
  QuestionRow,
} from "../../src/components/readiness/SpecialCategory";
import { TrafficLine } from "../../src/components/readiness/TrafficLine";
import { PlatformSteps } from "../../src/components/start/PlatformSteps";
import {
  ANSWER_FIRST,
  AS_CUSTOMER_SEES,
  GENERIC_ASK,
  HIDE,
  NO_TAG_UNTIL_MARKED,
  QUESTION,
  READY_LINE,
  SHOW_CHECKS,
  SUPERADMIN_ONLY,
  TAG_WITH_NOTE,
  TRAFFIC_WHY_DIRECTION,
  TRAFFIC_WHY_OK,
  WHAT_MEAN,
  WHY_LINES,
  WHY_WE_ASK,
  YES_HELD_LINE,
  connectCategory,
  visibleChecks,
} from "../../src/lib/readiness";
import { buildSnippet } from "../../src/lib/snippet-tag";
import { REPORTS } from "../analytics/proof-fixtures";
import {
  ANSWER,
  ASK_US,
  BUTTONS_GREY,
  CATEGORY_MARKED,
  CATEGORY_NO,
  CATEGORY_YES,
  CHANGE,
  COUNTED_SAME_SITE,
  MARK_IT,
  MEDORA,
  MEDORA_LOOK,
  READY,
  START_20,
  TAG_BODY,
  TAG_DAY3,
  TAG_FIRST,
  TAG_LATE,
  TAG_NONE,
  TERMS_NONE,
  TERMS_OK,
  TRAFFIC_DAY3_DIRECTION,
  TRAFFIC_DAY3_OK,
  YES_UNMARKED,
  check,
} from "./fixtures";

const TAG = buildSnippet("medora");
/** The tag as markup escapes it. */
const TAG_SRC = "edge.example.com/s/medora.js";
const NO_DASH = /[–—]/;

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

const noop = () => undefined;

// ---------------------------------------------------------------------------
// 01: Look, all ready
// ---------------------------------------------------------------------------

describe("Look, before Go live: all ready (A1 to A3)", () => {
  it("A1: every line green folds to one line, closed, with Show the checks", () => {
    const html = renderToStaticMarkup(h(BeforeGoLive, { checks: READY }));
    expect(text(html)).toContain("Before you go live");
    expect(text(html)).toContain(READY_LINE);
    expect(html).toContain(SHOW_CHECKS);
    expect(html).toContain(HIDE);
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    // The green rows sit inside the disclosure, drawn but closed.
    expect(text(html)).toContain(TAG_FIRST);
    expect(html).toContain('data-dot="green"');
  });

  it("A2: Show the checks opens five green rows, no actions but the API's Change", () => {
    const html = renderToStaticMarkup(h(BeforeGoLive, { checks: READY, defaultOpen: true }));
    expect(html).toMatch(/<details[^>]*\sopen/);
    expect(html.match(/data-dot="green"/g)).toHaveLength(6); // the summary's dot and five rows
    for (const c of READY) expect(text(html)).toContain(c.line);
    expect(html).toContain('href="/start"');
    expect(text(html)).toContain("Change");
  });

  it("A3: a grey line (buttons off by default) keeps Ready to go live", () => {
    const checks = [
      ...READY.slice(0, 3),
      check("buttons", "grey", BUTTONS_GREY, { label: "Parts of the page", href: "/start" }),
    ];
    const html = renderToStaticMarkup(h(BeforeGoLive, { checks, defaultOpen: true }));
    expect(text(html)).toContain(READY_LINE);
    expect(html).toContain('data-dot="grey"');
    expect(text(html)).toContain(`${BUTTONS_GREY} Parts of the page`);
    // A grey line reads muted.
    expect(html).toMatch(/data-state="grey"[^>]*>.*?text-fg-muted/s);
  });

  it("no list from the API: nothing is drawn", () => {
    expect(renderToStaticMarkup(h(BeforeGoLive, { checks: [] }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 02: Look, things to fix
// ---------------------------------------------------------------------------

describe("Look, things to fix: the Medora case (A4 to A6)", () => {
  it("A4: open by itself, red first, then amber, green, grey; every sentence as written", () => {
    const checks = visibleChecks(MEDORA_LOOK, false);
    const html = renderToStaticMarkup(h(BeforeGoLive, { checks }));
    expect(html).not.toMatch(/<details/);
    expect(text(html)).not.toContain(READY_LINE);
    const states = [...html.matchAll(/data-state="(\w+)"/g)].map((m) => m[1]);
    expect(states).toEqual(["red", "amber", "amber", "amber", "green", "grey", "grey"]);
    for (const c of MEDORA_LOOK) expect(text(html)).toContain(c.line);
    expect(text(html)).toContain(`${TAG_BODY} Move it first in the head`);
    expect(text(html)).toContain(
      `${COUNTED_SAME_SITE} Count the contact, signup or purchase button instead`,
    );
    expect(text(html)).toContain("Count it on every page");
    // No action on the language and traffic lines, as the spec says.
    expect(html).toMatch(/data-check="language"[^>]*>(?:(?!<a |<button)[\s\S])*?<\/li>/);
  });

  it("A4: the action is a quiet link that stays whole when the line wraps (A21)", () => {
    const html = renderToStaticMarkup(h(BeforeGoLive, { checks: MEDORA_LOOK }));
    expect(html).toMatch(
      /<a[^>]*whitespace-nowrap[^>]*href="\/conversions"[^>]*>Count it on every page<\/a>/,
    );
    expect(html).toMatch(/decoration-dotted/);
  });

  it("A5: Move it first in the head opens the tag with Copy under the line, in place, and reads Hide", () => {
    const inPlace = (c: { id: string }) => (c.id === "tag" ? noop : null);
    const closed = renderToStaticMarkup(h(BeforeGoLive, { checks: MEDORA_LOOK, inPlace }));
    expect(closed).toMatch(
      /<button[^>]*aria-expanded="false"[^>]*>Move it first in the head<\/button>/,
    );
    expect(closed).not.toContain(TAG_SRC);
    const open = renderToStaticMarkup(
      h(BeforeGoLive, {
        checks: MEDORA_LOOK,
        inPlace,
        openId: "tag",
        openContent: h("pre", { "data-tag": true }, TAG),
      }),
    );
    expect(open).toMatch(/<button[^>]*aria-expanded="true"[^>]*>Hide<\/button>/);
    expect(open).toContain(TAG_SRC);
    // Under the tag line, before the next line.
    expect(open.indexOf("data-tag")).toBeGreaterThan(open.indexOf('data-check="tag"'));
    expect(open.indexOf("data-tag")).toBeLessThan(open.indexOf('data-check="counted"'));
  });

  it("A6: the other tag states and the traffic estimate, every sentence from the API", () => {
    const checks = [
      check("tag", "amber", TAG_LATE, { label: "Move it first in the head", href: "/start" }),
      check("tag", "red", TAG_NONE, { label: "Move it first in the head", href: "/start" }),
      check("counted", "red", "No button is counted yet.", {
        label: "Pick it on your page",
        href: "/conversions",
      }),
      check("traffic", "green", "A 20% test would read in about 6 weeks."),
      check("traffic", "amber", "At this traffic a test shows a direction, not a proof."),
    ];
    const html = renderToStaticMarkup(h(ReadinessList, { checks }));
    for (const c of checks) expect(text(html)).toContain(c.line);
    expect(text(html)).toContain("No button is counted yet. Pick it on your page");
  });

  it("actionFor: the screen's handler, else the API's href, else none; the label is the API's", () => {
    const c = check("tag", "red", TAG_BODY, { label: "Move it first in the head", href: "/start" });
    expect(actionFor(c)).toEqual({
      kind: "href",
      label: "Move it first in the head",
      href: "/start",
    });
    const handled = actionFor(c, () => noop);
    expect(handled?.kind).toBe("click");
    expect(handled?.label).toBe("Move it first in the head");
    expect(actionFor(c, () => noop, true)?.label).toBe(HIDE);
    expect(actionFor(check("language", "amber", "x"))).toBeNull();
    expect(actionFor({ ...c, action: { label: "Mark it", href: null } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 03: the question
// ---------------------------------------------------------------------------

describe("the special-category question (A7 to A12)", () => {
  const unanswered = (line = GENERIC_ASK) =>
    connectCategory(
      ANSWER([check("category", "amber", line, { label: "Answer", href: "/start" })], {
        special_category: null,
        tag_withheld: true,
      }),
    );

  it("A7: unanswered: the question first, No and Yes, Why we ask closed; the tag block waits with one line", () => {
    const q = renderToStaticMarkup(
      h(ConnectQuestion, {
        customerId: "medora",
        category: unanswered(),
        asking: false,
        onAsk: noop,
        onAnswered: noop,
      }),
    );
    expect(text(q)).toContain(QUESTION);
    expect(q).toMatch(/<button[^>]*>No<\/button>/);
    expect(q).toMatch(/<button[^>]*>Yes<\/button>/);
    expect(q).toContain(WHY_WE_ASK);
    expect(q).not.toMatch(/<details[^>]*\sopen/);
    expect(q).not.toContain("state-warn");
    const tag = renderToStaticMarkup(
      h(PlatformSteps, { probe: null, tag: TAG, held: h(HeldBox, null, ANSWER_FIRST) }),
    );
    expect(text(tag)).toContain("1. Paste this line into your site's <head>");
    expect(text(tag)).toContain(ANSWER_FIRST);
    expect(tag).not.toContain(TAG_SRC);
    expect(tag).toContain('data-step="tag-held"');
    expect(tag).toContain("text-fg-faint");
  });

  it("A8: answered No: one green line with Change; the tag block shows as today", () => {
    const category = connectCategory(
      ANSWER([check("category", "green", CATEGORY_NO, CHANGE)], { special_category: false }),
    );
    const row = renderToStaticMarkup(
      h(ConnectQuestion, {
        customerId: "medora",
        category,
        asking: false,
        onAsk: noop,
        onAnswered: noop,
      }),
    );
    expect(text(row)).toBe(`${CATEGORY_NO} Change`);
    expect(row).toContain('data-state="green"');
    const tag = renderToStaticMarkup(h(PlatformSteps, { probe: null, tag: TAG }));
    expect(tag).toContain(TAG_SRC);
    expect(tag).not.toContain("tag-held");
    // Change brings the question back.
    const again = renderToStaticMarkup(
      h(ConnectQuestion, {
        customerId: "medora",
        category,
        asking: true,
        onAsk: noop,
        onAnswered: noop,
      }),
    );
    expect(text(again)).toContain(QUESTION);
  });

  it("A9: answered Yes, not marked: one red line, no Change, no tag, the note", () => {
    const category = connectCategory(
      ANSWER([check("category", "red", CATEGORY_YES, null, { blocks: true })], {
        special_category: true,
        tag_withheld: true,
      }),
    );
    expect(category).toEqual({ kind: "yes-held", line: YES_HELD_LINE, held: TAG_WITH_NOTE });
    const row = renderToStaticMarkup(
      h(ConnectQuestion, {
        customerId: "medora",
        category,
        asking: false,
        onAsk: noop,
        onAnswered: noop,
      }),
    );
    expect(text(row)).toBe(YES_HELD_LINE);
    expect(row).toContain('data-state="red"');
    expect(row).not.toContain("Change");
    const tag = renderToStaticMarkup(
      h(PlatformSteps, { probe: null, tag: TAG, held: h(HeldBox, null, TAG_WITH_NOTE) }),
    );
    expect(text(tag)).toContain(TAG_WITH_NOTE);
    expect(tag).not.toContain(TAG_SRC);
  });

  it("A10: unanswered, prompted by a page read: the API's amber line over the question, never a word from the page", () => {
    const line = "Your page reads like a health site. Tell us if it is.";
    const category = unanswered(line);
    expect(category.kind === "ask" && category.prompt).toBe(line);
    const q = renderToStaticMarkup(
      h(ConnectQuestion, {
        customerId: "medora",
        category,
        asking: false,
        onAsk: noop,
        onAnswered: noop,
      }),
    );
    expect(text(q)).toMatch(
      new RegExp(`^${line.replace(/[.?]/g, "\\$&")} ${QUESTION.replace("?", "\\?")}`),
    );
    expect(q).toContain("state-warn");
    expect(q).toContain('data-dot="amber"');
  });

  it("the plain ask is not printed over the question (it is the question)", () => {
    const q = renderToStaticMarkup(
      h(ConnectQuestion, {
        customerId: "medora",
        category: unanswered(),
        asking: false,
        onAsk: noop,
        onAnswered: noop,
      }),
    );
    expect(text(q)).not.toContain(GENERIC_ASK);
  });

  it("A11: Why we ask open: two lines, nothing more", () => {
    const q = renderToStaticMarkup(
      h(QuestionRow, { customerId: "medora", onAnswered: noop, whyOpen: true }),
    );
    expect(q).toMatch(/<details[^>]*\sopen/);
    for (const l of WHY_LINES) expect(text(q)).toContain(l);
    expect(q.match(/<li>/g)).toHaveLength(2);
  });

  it("A12: on Look, the answer as a row: No with Change, or Yes and marked", () => {
    const checks = [
      check("category", "green", CATEGORY_NO, CHANGE),
      check("category", "green", CATEGORY_MARKED),
    ];
    const html = renderToStaticMarkup(
      h(ReadinessList, {
        checks,
        inPlace: (c: { id: string }) => (c.id === "category" ? noop : null),
      }),
    );
    expect(text(html)).toContain(`${CATEGORY_NO} Change`);
    expect(text(html)).toContain(CATEGORY_MARKED);
    expect(html).toMatch(/<button[^>]*>Change<\/button>/);
    // Yes and marked: the row and the marked sentence, no action.
    const marked = connectCategory(
      ANSWER([check("category", "green", CATEGORY_MARKED)], { special_category: true }),
    );
    expect(marked).toEqual({ kind: "yes-marked", line: CATEGORY_MARKED });
    const row = renderToStaticMarkup(
      h(ConnectQuestion, {
        customerId: "medora",
        category: marked,
        asking: false,
        onAsk: noop,
        onAnswered: noop,
      }),
    );
    expect(text(row)).toBe(CATEGORY_MARKED);
    expect(row).not.toContain("Change");
  });

  it("A13: changed to Yes on Look: red, blocks, the sentence under the closed button", () => {
    const checks = visibleChecks(YES_UNMARKED, false);
    expect(checks).toHaveLength(1);
    const html = renderToStaticMarkup(h(BeforeGoLive, { checks }));
    expect(html).not.toMatch(/<details/);
    expect(text(html)).toContain(CATEGORY_YES);
    expect(html).toContain('data-state="red"');
  });

  it("the answered rows: AA ink, a dot, no dash", () => {
    const red = renderToStaticMarkup(h(AnsweredRow, { state: "red", line: YES_HELD_LINE }));
    expect(red).toContain("var(--state-err)_85%,black");
    expect(red).not.toMatch(NO_DASH);
    const green = renderToStaticMarkup(
      h(AnsweredRow, { state: "green", line: CATEGORY_NO, onChange: noop }),
    );
    expect(green).toContain("text-fg");
    expect(text(green)).toBe(`${CATEGORY_NO} Change`);
  });

  it("A22: on a phone the question's buttons drop under the question", () => {
    const q = renderToStaticMarkup(h(QuestionRow, { customerId: "medora", onAnswered: noop }));
    expect(q).toMatch(/flex-col[^"]*sm:flex-row/);
  });
});

// ---------------------------------------------------------------------------
// 04: day 3, the traffic line
// ---------------------------------------------------------------------------

describe("after go live, day 3: the traffic line (A14 to A16)", () => {
  const ok = check("traffic", "green", TRAFFIC_DAY3_OK, null, { known: "after_day_3" });
  const direction = check("traffic", "amber", TRAFFIC_DAY3_DIRECTION, ASK_US, {
    known: "after_day_3",
  });

  it("A14: enough traffic: a green dot, the sentence, nothing to do, What does that mean? closed", () => {
    const html = renderToStaticMarkup(h(TrafficLine, { check: ok }));
    expect(html).toContain('data-dot="green"');
    expect(text(html)).toContain(TRAFFIC_DAY3_OK);
    expect(html).not.toMatch(/<a |<button/);
    expect(text(html)).toContain(WHAT_MEAN);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    const open = renderToStaticMarkup(h(TrafficLine, { check: ok, whyOpen: true }));
    for (const l of TRAFFIC_WHY_OK) expect(text(open)).toContain(l);
  });

  it("A15: too little traffic: amber, the API's action as a small secondary button to its href", () => {
    const html = renderToStaticMarkup(h(TrafficLine, { check: direction }));
    expect(html).toContain('data-dot="amber"');
    expect(text(html)).toContain(TRAFFIC_DAY3_DIRECTION);
    expect(html).toMatch(
      /<a[^>]*href="mailto:help@example\.com\?subject=Direction%20test"[^>]*>Ask us to start a direction test<\/a>/,
    );
    expect(html).toContain("bg-surface-muted");
  });

  it("A16: What does that mean? open, the second case: two lines", () => {
    const html = renderToStaticMarkup(h(TrafficLine, { check: direction, whyOpen: true }));
    for (const l of TRAFFIC_WHY_DIRECTION) expect(text(html)).toContain(l);
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it("the superadmin's action is the API's own label; a screen handler makes it a button", () => {
    const admin = check("traffic", "amber", TRAFFIC_DAY3_DIRECTION, START_20);
    const html = renderToStaticMarkup(h(TrafficLine, { check: admin, onAction: noop }));
    expect(html).toMatch(/<button[^>]*>Start at 20% as a direction<\/button>/);
  });

  it("on the test card: under the counted buttons, before the numbers (A14)", () => {
    const html = renderToStaticMarkup(
      h(ProofCard, {
        report: REPORTS.interim,
        superadmin: false,
        counted: [
          { id: "ct_1", label: "Göndər", where: "on the homepage", group: false, site: false },
        ],
        traffic: ok,
      }),
    );
    expect(html).toContain('data-line="traffic"');
    expect(html.indexOf('data-line="traffic"')).toBeGreaterThan(
      html.indexOf('data-list="counted"'),
    );
    expect(text(html)).toContain(TRAFFIC_DAY3_OK);
  });

  it("without the line the card is as it was", () => {
    const html = renderToStaticMarkup(h(ProofCard, { report: REPORTS.interim, superadmin: false }));
    expect(html).not.toContain('data-line="traffic"');
    expect(html).not.toContain(WHAT_MEAN);
  });
});

// ---------------------------------------------------------------------------
// 05: the superadmin's view
// ---------------------------------------------------------------------------

describe("the superadmin's view (A18 to A20)", () => {
  const proof = { report: null, control: null, state: "ready" as const, reload: noop, apply: noop };

  it("A18: Admin shows the full list with the superadmin lines, red first, and the note", () => {
    const html = renderToStaticMarkup(
      h(ResultsAdmin, {
        customerId: "medora",
        domain: "medora.test",
        proof,
        afterAdvanced: true,
        readiness: ANSWER(MEDORA, { special_category: true }),
        defaultOpen: true,
      }),
    );
    expect(text(html)).toContain("Readiness");
    const states = [...html.matchAll(/data-state="(\w+)"/g)].map((m) => m[1]);
    expect(states).toEqual([
      "red",
      "red",
      "amber",
      "amber",
      "amber",
      "amber",
      "green",
      "grey",
      "grey",
    ]);
    expect(text(html)).toContain(`${TERMS_NONE} ${SUPERADMIN_ONLY} Record the terms`);
    expect(text(html)).toContain(`${TAG_DAY3} Move it first in the head`);
    expect(text(html)).toContain(`${TRAFFIC_DAY3_DIRECTION} Start at 20% as a direction`);
    expect(text(html)).toContain(AS_CUSTOMER_SEES);
    // The superadmin mark sits on the terms line only.
    expect(html.match(new RegExp(SUPERADMIN_ONLY, "g"))).toHaveLength(1);
    expect(html).not.toContain(NO_TAG_UNTIL_MARKED);
  });

  it("A20: a Yes waiting to be marked: the red line, no tag until marked, Mark it, Terms on record", () => {
    const html = renderToStaticMarkup(
      h(ResultsAdmin, {
        customerId: "novbe",
        domain: "queue.test",
        proof,
        afterAdvanced: true,
        readiness: ANSWER(
          [
            check("category", "red", CATEGORY_YES, MARK_IT, { blocks: true }),
            check("terms", "green", TERMS_OK, null, { superadmin_only: true }),
          ],
          { special_category: true, tag_withheld: true },
        ),
        defaultOpen: true,
      }),
    );
    expect(text(html)).toContain(`${CATEGORY_YES} ${NO_TAG_UNTIL_MARKED} Mark it`);
    expect(html).toMatch(/<a[^>]*href="\/analytics"[^>]*>Mark it<\/a>/);
    expect(text(html)).toContain(`${TERMS_OK} ${SUPERADMIN_ONLY}`);
  });

  it("no answer (an older worker): no Readiness row", () => {
    const html = renderToStaticMarkup(
      h(ResultsAdmin, {
        customerId: "medora",
        domain: "medora.test",
        proof,
        afterAdvanced: true,
        defaultOpen: true,
      }),
    );
    expect(text(html)).not.toContain("Readiness");
    expect(text(html)).toContain("Test size");
  });

  it("A19: the customers list's one column: the count of red and amber, red first, else Ready", () => {
    const medora = renderToStaticMarkup(h(CountWords, { checks: MEDORA }));
    expect(text(medora)).toBe("2 red 4 amber");
    expect(medora.indexOf('data-dot="red"')).toBeLessThan(medora.indexOf('data-dot="amber"'));
    const novbe = renderToStaticMarkup(h(CountWords, { checks: YES_UNMARKED }));
    expect(text(novbe)).toBe("1 red");
    const lumera = renderToStaticMarkup(h(CountWords, { checks: READY }));
    expect(text(lumera)).toBe("Ready");
    expect(lumera).toContain('data-dot="green"');
  });

  it("a customer session's list never carries a superadmin line even if the answer did", () => {
    const html = renderToStaticMarkup(h(BeforeGoLive, { checks: visibleChecks(MEDORA, false) }));
    expect(text(html)).not.toContain(TERMS_NONE);
    expect(html).not.toContain(SUPERADMIN_ONLY);
  });
});

// ---------------------------------------------------------------------------
// The apply door
// ---------------------------------------------------------------------------

describe("the apply door", () => {
  it("a Yes holds the tag: the two sentences where the tag would be, no tag", () => {
    const html = renderToStaticMarkup(
      h(DoneScreen, {
        kicker: "Rawuser · pilot",
        done: { customer_id: "novbe", tag: buildSnippet("novbe"), withheld: true },
      }),
    );
    expect(text(html)).toContain(YES_HELD_LINE);
    expect(text(html)).toContain(TAG_WITH_NOTE);
    expect(html).not.toContain(buildSnippet("novbe"));
    expect(html).toContain('data-block="tag-held"');
  });

  it("a No shows the tag as today", () => {
    const html = renderToStaticMarkup(
      h(DoneScreen, {
        kicker: "Rawuser · pilot",
        done: { customer_id: "brisk", tag: buildSnippet("brisk"), withheld: false },
      }),
    );
    expect(html).toContain("edge.example.com/s/brisk.js");
    expect(html).not.toContain("tag-held");
  });

  it("asks the question on the form before send, and sends the answer", () => {
    const src = readFileSync(
      new URL("../../src/components/apply/ApplyFlow.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("special_category: category");
    expect(src).toContain('data-block="special-category"');
    // Before the name and email, after the sources.
    expect(src.indexOf('data-block="special-category"')).toBeGreaterThan(
      src.indexOf("Where do your visitors come from?"),
    );
    expect(src.indexOf('data-block="special-category"')).toBeLessThan(
      src.indexOf("{/* 7. Name + email */}"),
    );
    // The form does not send without an answer.
    expect(src).toContain("if (category === null) {");
    expect(src).toContain("withheld: category === true || data.tag_withheld === true");
  });
});

// ---------------------------------------------------------------------------
// The screens' wiring (source), and the older worker
// ---------------------------------------------------------------------------

describe("the Connect and Look screens", () => {
  const src = readFileSync(
    new URL("../../src/components/start/FirstRun.tsx", import.meta.url),
    "utf8",
  );

  it("Connect: the question sits above the tag; step 2 waits while the tag is withheld", () => {
    const q = src.indexOf("<ConnectQuestion");
    const steps = src.indexOf("<PlatformSteps", q);
    const step2 = src.indexOf("2. Open your page once", steps);
    expect(q).toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(q);
    expect(step2).toBeGreaterThan(steps);
    expect(src).toContain('withheld && category && "held" in category');
    expect(src).toContain("disabled={opening || reading || withheld}");
  });

  it("Look: the list sits above Go live; a blocking line closes the button with the sentence under it", () => {
    const list = src.indexOf("<BeforeGoLive");
    const button = src.indexOf("disabled={busy || blocked}", list);
    const stop = src.indexOf('data-line="go-live-stop"', button);
    expect(list).toBeGreaterThan(0);
    expect(button).toBeGreaterThan(list);
    expect(stop).toBeGreaterThan(button);
    expect(src).toContain("blockingLine(checks)");
    expect(src).toContain("visibleChecks(readiness.answer.checks, false)");
  });

  it("the go-live 409 and the capture-link 409 show the API's error as written", () => {
    expect(src.match(/errorSentence\(e\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("an older worker: no answer, no question, the tag as today", () => {
    // The question renders only with an answer; the tag block is held only
    // while loading or withheld.
    expect(src).toContain("{category && (");
    expect(src).toContain(
      'readiness.state === "loading" || readiness.answer?.tag_withheld === true',
    );
    const tag = renderToStaticMarkup(h(PlatformSteps, { probe: null, tag: TAG }));
    expect(tag).toContain(TAG_SRC);
  });
});

describe("the /onboard door and the Pages card", () => {
  it("/onboard asks first and holds the tag and the capture link while withheld", () => {
    const src = readFileSync(
      new URL("../../src/components/onboard/OnboardFlow.tsx", import.meta.url),
      "utf8",
    );
    expect(src.indexOf("<ConnectQuestion")).toBeLessThan(src.indexOf("Guided setup"));
    expect(src).toContain("!held && (");
    expect(src).toContain("held={held}");
  });

  it("the Pages card keeps the tag out of its lines while withheld", () => {
    const src = readFileSync(
      new URL("../../src/components/start/PagesCard.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("tagWithheld ? null : siteLine(health?.site)");
    expect(src).toContain("tagWithheld ? null : lateTagLine(health)");
    expect(src).toContain("errorSentence(e)");
  });
});
