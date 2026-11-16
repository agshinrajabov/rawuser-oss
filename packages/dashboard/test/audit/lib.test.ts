/**
 * The audit's words and numbers (lib/audit.ts): counts with their floors,
 * the answers, the groups, the sample title, every test line, the last line,
 * the disclosures, every Audit page stage, the Applications rows, the
 * first-run lines, refusals and the fragment token.
 */
import "../identity/example";
import { describe, expect, it } from "vitest";
import {
  BANNER_LINE,
  aiAnswer,
  auditPageView,
  auditRefusal,
  auditRowView,
  cannotSee,
  countCell,
  countInline,
  expectedEnd,
  groupSub,
  hashToken,
  howSure,
  howWeCount,
  inAppAnswer,
  lastLine,
  liveNextLine,
  noReferrerAnswer,
  rangeLabel,
  resultRange,
  reviewTestLine,
  sampleTitle,
  spendText,
  stripText,
  testLineView,
  versionsAtStartLine,
} from "../../src/lib/audit";
import {
  COUNTS,
  EXTENDED,
  FULL,
  NOW,
  RESULT_LINE,
  SPEND_CAP,
  START,
  STATUS,
  TEMPLATE_SAMPLE,
  TOO_FEW,
} from "./audit-fixtures";

const DAY = 864e5;

describe("counts", () => {
  it('reads "<5" as fewer than 5 and 0 as None seen', () => {
    expect(countCell("<5")).toBe("fewer than 5");
    expect(countCell(0)).toBe("None seen");
    expect(countCell(1240)).toBe("1,240");
    expect(countInline(0)).toBe("none");
    expect(countInline("<5")).toBe("fewer than 5");
  });
});

describe("the three answers", () => {
  const a = FULL.answers;
  if (!a) throw new Error("fixture");
  it("full: the API's share, the names and the other", () => {
    expect(aiAnswer(a.ai)).toMatchObject({
      title: "AI assistants sent about 4% of your visits.",
      sub: "52 visits. ChatGPT 31, Perplexity 9, other 12.",
      bar: [{ width: 4 }],
    });
    const app = inAppAnswer(a.in_app);
    expect(app.title).toBe("Links opened inside apps: about 9%.");
    expect(app.sub).toBe("61 we could name, 51 probably.");
    expect(app.key).toBe(true);
    expect(app.bar?.[1]?.hatched).toBe(true);
    expect(noReferrerAnswer(a.no_referrer)).toMatchObject({
      title: "71 visits came from inside an app with no referrer and no tags.",
      sub: "Most analytics tools count these as Direct.",
    });
  });
  it("counts only: no percent, no bar, the floors in words", () => {
    const c = COUNTS.answers;
    if (!c) throw new Error("fixture");
    expect(aiAnswer(c.ai)).toEqual({
      title: "AI assistants sent 9 visits.",
      sub: "ChatGPT 6, other fewer than 5.",
      bar: null,
    });
    expect(inAppAnswer(c.in_app).title).toBe("Links opened inside apps: 14.");
    expect(inAppAnswer(c.in_app).bar).toBeNull();
  });
  it("a zero reads none seen, never no AI traffic", () => {
    expect(aiAnswer({ visits: 0, share: null, names: [], other: null }).title).toBe(
      "AI assistants: none seen.",
    );
    expect(noReferrerAnswer({ visits: 0, share: null }).title).toMatch(/none seen/);
    expect(noReferrerAnswer({ visits: "<5", share: null }).title).toMatch(/^Fewer than 5 visits/);
    expect(inAppAnswer({ visits: "<5", share: null, named: "<5", probably: 0 }).sub).toBe(
      "Fewer than 5 we could name, none probably.",
    );
  });
  it("under 1% says so", () => {
    expect(
      aiAnswer({
        visits: 6,
        share: { pct: 0, under_one: true, low: 0, high: 1 },
        names: [],
        other: null,
      }).title,
    ).toBe("AI assistants sent under 1% of your visits.");
  });
});

describe("groups", () => {
  it("names, the other line, and the probably count", () => {
    const [ai, , , , , other, none] = FULL.groups;
    expect(ai && groupSub(ai)).toBe("ChatGPT 31, Perplexity 9, other 12");
    expect(other && groupSub(other)).toBe("Email apps and your own tagged links");
    expect(none && groupSub(none)).toBe(
      "No referrer, no tags. 51 probably a link from a phone app.",
    );
    const cnone = COUNTS.groups.find((g) => g.key === "none");
    expect(cnone && groupSub(cnone)).toBe(
      "No referrer, no tags. 6 probably a link from a phone app.",
    );
  });
});

describe("the sample's title", () => {
  it("saw, would see, and a group", () => {
    expect(sampleTitle(FULL.sample as never)).toBe("What your visitors from ChatGPT saw");
    expect(sampleTitle(TOO_FEW.sample as never)).toBe("What a visitor from ChatGPT would see");
    expect(sampleTitle(TEMPLATE_SAMPLE)).toBe("What your visitors from search saw");
  });
});

describe("what the versions did", () => {
  it("every state, never an interim lift", () => {
    expect(testLineView({ state: "no_button" }).lead).toBe(
      "No button was counted, so there is no test yet.",
    );
    expect(testLineView({ state: "off" }).lead).toBe("No test was running.");
    expect(testLineView({ state: "low_traffic" }).lead).toBe(
      "Too little traffic to measure the versions within a year.",
    );
    expect(testLineView({ state: "checking" }).lead).toBe("We are checking the test.");
    const early = testLineView({ state: "too_early", visits_needed: 14400, weeks: 20 });
    expect(`${early.lead} ${early.rest}`).toBe(
      "Too early. The test needs about 14,400 visits with a version, about 20 weeks at this week's traffic. It keeps running in a pilot.",
    );
    expect(early.weeks).toBe(20);
    expect(testLineView({ state: "too_early", visits_needed: null, weeks: null }).rest).toBe(
      "It keeps running in a pilot.",
    );
    expect(testLineView(RESULT_LINE).lead).toBe(
      "Visits that saw the versions clicked Start free 25% more often.",
    );
    expect(resultRange({ value: 0.25, low: 0.1, high: 0.4 })).toEqual({
      range: "likely +10% to +40%",
      note: "Likely between 10% and 40% more than your original page.",
    });
  });
});

describe("the last line", () => {
  it("running test, no test, and nothing seen", () => {
    expect(lastLine(FULL)).toEqual({
      lead: "589 visits saw a version made for why they came.",
      rest: "The test keeps running in a pilot.",
    });
    expect(lastLine(COUNTS).rest).toBe("A pilot keeps it going and measures what it earns.");
    expect(lastLine(TOO_FEW).lead).toBe("Your versions are written and ready.");
    expect(lastLine({ saw_version: "<5", test_running: false }).lead).toBe(
      "Fewer than 5 visits saw a version made for why they came.",
    );
  });
});

describe("disclosures", () => {
  it("the banner line only when the prospect ticked the box, in the privacy review's words", () => {
    expect(cannotSee(FULL).some((l) => l.text === BANNER_LINE && l.banner)).toBe(true);
    expect(cannotSee(COUNTS).some((l) => l.text === BANNER_LINE)).toBe(false);
    expect(BANNER_LINE).toBe(
      "If your banner holds our tag back, only visits that accepted it are counted.",
    );
  });
  it("one week or two", () => {
    expect(cannotSee(FULL)[3]?.text).toMatch(/^This is one week\./);
    expect(cannotSee(COUNTS)[3]?.text).toMatch(/^This is two weeks\./);
  });
  it("How sure lists the API's ranges, full state only", () => {
    const sure = howSure(FULL);
    expect(sure[0]).toEqual({ label: "AI assistants", low: 3, high: 6 });
    expect(sure.map((s) => s.label)).toContain("No source to read");
    expect(sure.filter((s) => s.label === "AI assistants")).toHaveLength(1);
    expect(howSure(COUNTS)).toEqual([]);
  });
  it("the sample line in How we count only with a sample", () => {
    expect(howWeCount(FULL)).toHaveLength(4);
    expect(howWeCount({ sample: null })).toHaveLength(3);
  });
  it("versions at the start: a line only when some were missing", () => {
    expect(versionsAtStartLine(FULL)).toBeNull();
    expect(versionsAtStartLine(TOO_FEW)).toBe(
      "64 of 90 versions were written when counting began.",
    );
    expect(versionsAtStartLine({ versions_at_start: null })).toBeNull();
  });
});

describe("dates", () => {
  it("a whole-day window reads its seven days", () => {
    expect(rangeLabel(START, START + 7 * DAY)).toBe("7 to 13 October");
    expect(rangeLabel(START, START + 14 * DAY)).toBe("7 to 20 October");
    expect(rangeLabel(Date.UTC(2026, 8, 28, 15), Date.UTC(2026, 9, 5, 15))).toBe(
      "28 September to 4 October",
    );
  });
});

describe("the Audit page, every stage", () => {
  it("before go live, writing, counting, extended, checking, ready, lapsed, ended", () => {
    expect(auditPageView(STATUS.before_go_live)).toMatchObject({
      pill: "Before go live",
      s1: "Your report counts the 7 days after you go live.",
    });
    expect(auditPageView(STATUS.writing)).toMatchObject({
      s1: "Counting starts when your versions are written.",
      s2: "64 of 90 so far.",
    });
    const c = auditPageView(STATUS.counting);
    expect(c).toMatchObject({
      pill: "Counting",
      live: true,
      s1: "Day 3 of 7.",
      s2: "Your report: about 14 October.",
      period: "Live since 7 October · 412 visits counted",
      after: "Where they came from comes with the report.",
      foot: "The audit ends 21 October unless you start a pilot.",
    });
    expect(c.days).toEqual({
      cells: 7,
      today: 2,
      first: "Wed 7 Oct",
      mid: "day 3",
      last: "Tue 13 Oct",
    });
    expect(auditPageView(EXTENDED)).toMatchObject({
      s1: "Day 9 of 14.",
      s2: "Your report: about 21 October.",
      after: "Under 300 visits in the first week, so we count one more.",
    });
    expect(auditPageView(STATUS.checking)).toMatchObject({
      pill: "Being checked",
      s1: "Counted 7 to 13 October.",
      s2: "Sam reads every report before it goes out.",
      after: "You get it in the thread your invite came in.",
    });
    expect(auditPageView(STATUS.ready)).toMatchObject({
      pill: "Ready",
      tone: "ok",
      s1: "Your report is ready.",
      s2: "7 to 13 October, 1,240 visits.",
      foot: "The audit ends 21 October unless you start a pilot.",
    });
    expect(auditPageView(STATUS.lapsed)).toMatchObject({
      s1: "No go live within 14 days, so the audit closed.",
      after: "Nothing was shown to visitors. Your account is deleted on 5 December.",
    });
    expect(auditPageView(STATUS.ended)).toMatchObject({
      pill: "Audit ended Wed 21 Oct",
      s1: "The audit ended.",
      s2: "Your page shows as you built it. You can remove the tag.",
    });
  });
  it("the end date: seven days after the report until released, then the API's", () => {
    expect(expectedEnd(STATUS.counting)).toBe(START + 14 * DAY);
    expect(expectedEnd(STATUS.ready)).toBe(STATUS.ready.ends_at);
    expect(expectedEnd(STATUS.before_go_live)).toBeNull();
  });
});

describe("the first-run lines", () => {
  it("the strip before and after go live", () => {
    expect(stripText(null)).toBe("report a week after you go live");
    expect(stripText(STATUS.before_go_live)).toBe("report a week after you go live");
    expect(stripText(STATUS.counting)).toBe("report about 14 October");
    expect(stripText(STATUS.ready)).toBe("report ready");
  });
  it("Live: the report and the end", () => {
    expect(liveNextLine(STATUS.counting)).toBe(
      "Your report: 14 October. The audit ends 21 October unless you start a pilot.",
    );
  });
});

describe("Applications rows", () => {
  it("every audit stage", () => {
    expect(auditRowView(STATUS.before_go_live, SIGNED_UP_PLUS(3))).toMatchObject({
      label: "Waiting for go live",
      detail: "day 4 of 14",
    });
    expect(auditRowView(STATUS.writing, NOW)).toMatchObject({
      label: "Writing",
      detail: "64 of 90",
    });
    expect(auditRowView(STATUS.counting, NOW)).toMatchObject({
      label: "Counting",
      live: true,
      detail: "day 3 of 7 · 412 visits",
    });
    expect(auditRowView(STATUS.checking, NOW)).toMatchObject({
      label: "Ready to review",
      tone: "ink",
      detail: "1,240 visits",
    });
    expect(auditRowView({ ...STATUS.checking, report_built_at: null }, NOW).label).toBe(
      "Building the report",
    );
    expect(auditRowView(STATUS.ready, NOW)).toMatchObject({
      label: "Released",
      detail: "ends 21 Oct",
    });
    expect(auditRowView(STATUS.ended, NOW)).toMatchObject({
      label: "Ended",
      detail: "deleted on 13 Dec",
      faint: true,
    });
    expect(auditRowView(SPEND_CAP, NOW)).toMatchObject({
      label: "Spend cap",
      tone: "warn",
      detail: "71 of 90 written",
    });
    expect(spendText(0.18)).toBe("$0.18");
  });
  it("the review's test line", () => {
    expect(reviewTestLine(FULL)).toBe("Running · too early");
  });
});

function SIGNED_UP_PLUS(days: number): number {
  return STATUS.before_go_live.signed_up_at + days * DAY;
}

describe("tokens and refusals", () => {
  it("reads t from a fragment only", () => {
    expect(hashToken("#t=abc123")).toBe("abc123");
    expect(hashToken("")).toBe("");
    expect(hashToken("#x=1")).toBe("");
  });
  it("an audit cap refusal carries the API's sentence", () => {
    const e = new Error(
      'API error 409: {"error":"audit_pages_full","message":"Three pages in the audit. A pilot has more."}',
    );
    expect(auditRefusal(e)).toEqual({
      code: "audit_pages_full",
      message: "Three pages in the audit. A pilot has more.",
    });
    expect(auditRefusal(new Error('API error 409: {"error":"used"}'))).toBeNull();
    expect(auditRefusal(new Error("network"))).toBeNull();
  });
});
