import "../identity/example";
import { describe, expect, it } from "vitest";
import {
  afterLine,
  armRows,
  asTreatedLine,
  axisDomain,
  axisPos,
  axisTicks,
  bySourceOpen,
  cardSub,
  changeDialog,
  checksItems,
  closedDaysLine,
  controlStatus,
  dialogKind,
  endDialog,
  figureFor,
  heldBackBox,
  howItWorks,
  pillFor,
  signed,
  startDialog,
  startLedger,
  timelineFor,
  verdictFor,
} from "../../src/lib/proof";
import { CONTROL_OFF, CONTROL_RUNNING, REPORTS } from "./proof-fixtures";

const R = REPORTS;
const CHECKS_NONE = {
  split_set: 0,
  split_seen: null,
  split_p: null,
  split_ok: true,
  uncounted_share: null,
  uncounted_ok: true,
  mixed_visits: 0,
};

describe("the card's title and subline", () => {
  it("one title in every state, the negative one included", () => {
    for (const r of Object.values(REPORTS)) expect(r.title).toBe("What the versions did");
  });
  it("names the one confirmed button, else the buttons", () => {
    expect(cardSub(R.interim)).toBe(
      "Clicks on Start free, visits with a signal that were put in the test",
    );
    expect(cardSub({ metric: { kind: "cta_clicks", labels: ["A", "B"] } })).toBe(
      "Clicks on your confirmed buttons, visits with a signal that were put in the test",
    );
  });
});

describe("pillFor", () => {
  it("one pill per state, green and red only on a result", () => {
    expect(pillFor(R.off)).toMatchObject({ tone: "muted", text: "No test" });
    expect(pillFor(R.not_enough)).toMatchObject({ text: "Test running · day 3", live: true });
    expect(pillFor(R.interim)).toMatchObject({ text: "Test running · week 4 of 10", live: true });
    expect(pillFor(R.held_back)).toMatchObject({ tone: "warn", text: "Checking the test" });
    expect(pillFor(R.positive)).toMatchObject({ tone: "ok", text: "Result · read 16 Nov" });
    expect(pillFor(R.no_difference)).toMatchObject({ tone: "muted" });
    expect(pillFor(R.negative)).toMatchObject({ tone: "err" });
    expect(pillFor(R.ended)).toMatchObject({ tone: "muted", text: "Test ended 16 Nov" });
    expect(pillFor(R.ended_early).text).toBe("Test ended 2 Nov · before its read date");
  });
});

describe("figureFor: grey before the read date, colour only when clear of zero", () => {
  it("interim is grey, hatched, with no estimate of extra clicks", () => {
    const f = figureFor(R.interim);
    expect(f).toMatchObject({ key: "Lift so far", big: "+19%", ink: "muted", small: "interim" });
    expect(f?.range).toBe("range -5% to +50%");
    expect(f?.strip?.band).toBe("moving");
    expect(f?.earn?.rest).toBe("No estimate of extra clicks before the read date.");
  });

  it("not enough data shows no number and no range", () => {
    expect(figureFor(R.not_enough)).toMatchObject({
      big: null,
      range: "needs 10 clicks in each group",
      strip: null,
    });
  });

  it("positive: green, with the estimate of extra clicks for the first time", () => {
    const f = figureFor(R.positive);
    expect(f).toMatchObject({ key: "Lift on Start free", big: "+25%", ink: "ok", small: null });
    expect(f?.range).toBe("likely +8% to +44%");
    expect(f?.earn).toEqual({
      strong: "About 210 extra clicks",
      rest: " on Start free, between 80 and 340.",
      em: null,
    });
    // The method moved into How this works (Results page, 2026-10-04).
    expect(howItWorks(R.positive).map((h) => h.k)).toContain("Extra clicks");
  });

  it("no difference: neutral ink, not clear of zero, no estimate", () => {
    const f = figureFor(R.no_difference);
    expect(f).toMatchObject({ big: "+5%", ink: "fg", small: "not clear of zero" });
    expect(f?.strip?.band).toBe("solid");
    expect(f?.earn?.rest).toBe("No estimate of extra clicks.");
  });

  it("negative: red, fewer clicks counted the same way", () => {
    const f = figureFor(R.negative);
    expect(f).toMatchObject({ big: "-15%", ink: "err" });
    expect(f?.earn?.strong).toBe("About 140 fewer clicks");
    expect(f?.earn?.rest).toBe(" on Start free, between 20 and 270.");
  });

  it("ended early is never coloured", () => {
    expect(figureFor(R.ended_early)).toMatchObject({
      key: "Lift on Start free, final",
      ink: "fg",
      small: "not clear of zero",
      earn: null,
    });
  });

  it("held back and off show no figure", () => {
    expect(figureFor(R.held_back)).toBeNull();
    expect(figureFor(R.off)).toBeNull();
  });
});

describe("the sentence", () => {
  it("an ended test splits into the end line and the frozen result", () => {
    const v = verdictFor(R.ended);
    expect(v.text).toBe("Test ended on 16 Nov. Every visit with a signal gets a version again.");
    expect(v.next?.startsWith("The result as read on 16 Nov:")).toBe(true);
  });
  it("a broken split holds the rates back and says why in its own box", () => {
    expect(verdictFor(R.held_back).text).toBe(
      "The split looks off. We are checking it before showing a result.",
    );
    const box = heldBackBox(R.held_back);
    expect(box?.text).toContain("So far 1,239 of 5,200 did (23.8%).");
    expect(armRows(R.held_back)).toBeNull();
  });
  it("interim is quiet; a result is not", () => {
    expect(verdictFor(R.interim).quiet).toBe(true);
    expect(verdictFor(R.positive).quiet).toBe(false);
  });
  it("the after lines", () => {
    // One short line each (Results page, 2026-10-04); Natural lift left the customer's view.
    // No test: the three steps above start one; nobody is asked (measure-setup mock).
    expect(afterLine(R.off, false)).toBeNull();
    expect(afterLine(R.off, true)).toBeNull();
    expect(afterLine(R.interim, false)).toBe("Can tell a lift of 20% or more from none by 16 Nov.");
    expect(afterLine(R.negative, false)).toBe("Sam will write to you today.");
    expect(afterLine(R.ended_early, false)).toBe("11,200 visits, 7 Sep to 1 Nov.");
    expect(asTreatedLine(R.positive)).toContain("counting only the 10,758 visits");
    expect(asTreatedLine(R.no_difference)).toBeNull();
    // The caveats the card no longer shows are under How this works.
    const how = (r: (typeof R)[keyof typeof R]) => howItWorks(r).map((h) => h.k);
    expect(how(R.positive)).toContain("As treated");
    expect(how(R.interim)).toContain("Smaller effects");
    expect(how(R.interim)).toContain("What it does not say");
  });
});

describe("arms, timeline, checks", () => {
  it("counts always shown; bars scale to the higher rate", () => {
    const rows = armRows(R.interim);
    expect(rows?.map((r) => [r.value, r.counts])).toEqual([
      ["9.4%", "389 of 4,154"],
      ["7.8%", "82 of 1,046"],
    ]);
    expect(Math.round(rows?.[0]?.width ?? 0)).toBe(80);
  });
  it("not enough data counts clicks toward 10", () => {
    expect(armRows(R.not_enough)?.map((r) => r.counts)).toEqual([
      "clicks, enough",
      "clicks, 3 to go",
    ]);
  });
  it("the timeline runs from the start to the read date", () => {
    const t = timelineFor(R.interim);
    expect(t?.start).toBe("Mon 7 Sep · start");
    expect(t?.mid).toBe("today, day 27 of 70");
    expect(t?.end).toBe("Mon 16 Nov · read date");
    expect(timelineFor(R.not_enough)?.start).toBe("Wed 30 Sep · start · today is day 3");
    expect(timelineFor(R.positive)).toBeNull();
  });
  it("the checks row", () => {
    expect(checksItems(R.interim.checks ?? CHECKS_NONE)).toEqual([
      { text: "Split 20.1% for a set 20%", tone: "ok" },
      { text: "0.9% of visits could not be counted", tone: "muted" },
      { text: "4 visits saw both", tone: "muted" },
    ]);
    expect(checksItems(R.held_back.checks ?? CHECKS_NONE)[0]?.tone).toBe("warn");
    expect(closedDaysLine(R.ended)).toBe("Read from closed days, 7 Sep to 15 Nov");
  });
  it("by source opens by itself on the read date", () => {
    expect(bySourceOpen(R.interim)).toBe(false);
    expect(bySourceOpen(R.positive)).toBe(true);
  });
});

describe("the range strip", () => {
  it("keeps the mock's -40% to +60% unless the range is wider", () => {
    expect(axisDomain(-0.05, 0.5)).toEqual({ min: -40, max: 60 });
    expect(axisDomain(-0.04, 0.94)).toEqual({ min: -40, max: 100 });
    expect(axisPos(0, { min: -40, max: 60 })).toBe(40);
    expect(axisTicks({ min: -40, max: 60 })).toEqual([-40, 0, 20, 60]);
    expect(signed(0)).toBe("0%");
  });
});

describe("the holdout control", () => {
  it("the status line", () => {
    expect(controlStatus(CONTROL_OFF)).toBe("No test has run");
    expect(controlStatus(CONTROL_RUNNING)).toMatch(
      /^20% since \w{3} 7 Sep, \d\d:\d\d · read date Mon 16 Nov, fixed on day 14$/,
    );
  });

  it("which dialog", () => {
    expect(dialogKind(0, 20)).toBe("start");
    expect(dialogKind(20, 0)).toBe("end");
    expect(dialogKind(20, 10)).toBe("change");
  });

  it("start: cost and read time at this customer's traffic", () => {
    const now = Date.parse("2026-10-05T10:00:00Z");
    expect(startDialog("brisk.test", 20)).toMatchObject({
      title: "Start a 20% holdout on brisk.test?",
      lead: "1 in 5 visits that would get a version sees the original page instead, picked at random per visit.",
      confirm: "Start the test",
    });
    const l = startLedger(CONTROL_OFF, 20, "Start free", now);
    expect(l.rows[0]).toEqual({
      dt: "Costs",
      dd: "About 1,200 visits a month see the original instead of a version.",
      m: "If the versions lift clicks by 20%, that is about 19 Start free clicks a month given up.",
    });
    expect(l.rows[1]?.dd).toBe("About 10 weeks, around Mon 14 Dec.");
    expect(l.compare.map((c) => c.percent)).toEqual([10, 20, 50]);
    expect(l.basis).toBe(
      "Based on the last 30 days: about 6,000 visits with a signal and a version, 8.0% clicked Start free.",
    );
  });

  it("end mid-test: says what ending early costs", () => {
    const d = endDialog("brisk.test", R.interim);
    expect(d.title).toBe("End the test on brisk.test?");
    expect(d.lead).toBe(
      "It is day 27 of 70. Ending now leaves the result inconclusive, with today's range at -5% to +50%.",
    );
    expect(d.rows.map((r) => r.dt)).toEqual(["Visitors", "The card", "Restarting"]);
    expect(d.danger).toBe(true);
  });

  it("change mid-test: a new test, the read date moves", () => {
    const now = Date.parse("2026-10-05T10:00:00Z");
    const d = changeDialog("brisk.test", CONTROL_RUNNING, R.interim, 20, 10, now);
    expect(d.title).toBe("Change the holdout on brisk.test to 10%?");
    expect(d.lead).toBe(
      "This starts a new test. The 27 days so far do not count toward it, and the read date moves from 16 Nov to about Mon 8 Feb (about 18 weeks).",
    );
    expect(d.cancel).toBe("Keep 20%");
    expect(d.confirm).toBe("Start a new test at 10%");
  });
});

describe("no dashes", () => {
  it("no em or en dash in any line the card or the dialogs write", () => {
    const now = Date.parse("2026-10-05T10:00:00Z");
    const texts: string[] = [];
    for (const r of Object.values(REPORTS)) {
      const v = verdictFor(r);
      texts.push(v.text, v.next ?? "", afterLine(r, true) ?? "", afterLine(r, false) ?? "");
      texts.push(pillFor(r).text, asTreatedLine(r) ?? "", heldBackBox(r)?.text ?? "");
      const f = figureFor(r);
      texts.push(f?.key ?? "", f?.range ?? "", f?.earn?.rest ?? "", f?.earn?.em ?? "");
      for (const h of howItWorks(r)) texts.push(h.text);
      texts.push(endDialog("brisk.test", r).lead);
    }
    texts.push(startDialog("brisk.test", 50).lead);
    for (const row of startLedger(CONTROL_OFF, 10, "Start free", now).rows)
      texts.push(row.dd, row.m ?? "");
    for (const t of texts) expect(t).not.toMatch(/[\u2013\u2014]/);
  });
});
