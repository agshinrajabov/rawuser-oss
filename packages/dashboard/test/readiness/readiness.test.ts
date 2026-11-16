/**
 * The readiness check before go live, the library (mock
 * design/mock/sales-readiness/readiness-check.html, approved as drawn
 * 2026-10-14; contract docs/specs/readiness-check.md, "The API" and "As
 * approved"): the answer read as the API writes it, the order of the list,
 * what a customer session may see, when the list folds, which line blocks,
 * the day-3 traffic line, the customers column, the question's states on
 * Connect, the 409 sentence, and an older worker (404) read as "as today".
 */
import "../identity/example";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/lib/api";
import {
  ANSWER_FIRST,
  AS_CUSTOMER_SEES,
  type Api,
  BEFORE_HEADING,
  GENERIC_ASK,
  NO_TAG_UNTIL_MARKED,
  QUESTION,
  READINESS_PATH,
  READY_LINE,
  READY_WORD,
  SHOW_CHECKS,
  SPECIAL_CATEGORY_PATH,
  SUPERADMIN_ONLY,
  TAG_LABEL,
  TAG_WITH_NOTE,
  TRAFFIC_WHY_DIRECTION,
  TRAFFIC_WHY_OK,
  WHAT_MEAN,
  WHY_LINES,
  WHY_WE_ASK,
  YES_HELD_LINE,
  answerSpecialCategory,
  blockingLine,
  checkById,
  connectCategory,
  countWords,
  errorSentence,
  listFolded,
  promptLine,
  readAnswer,
  readReadiness,
  readinessCount,
  sortChecks,
  trafficLine,
  trafficWhy,
  visibleChecks,
} from "../../src/lib/readiness";
import { ANSWER, MEDORA, READY, check } from "./fixtures";

const NO_DASH = /[–—]/;

describe("readAnswer: the answer as the API writes it", () => {
  it("reads every field and keeps the sentences and labels as written", () => {
    const a = readAnswer({
      ok: true,
      customer_id: "medora",
      blocks_go_live: false,
      special_category: true,
      tag_withheld: false,
      checks: [
        {
          id: "tag",
          state: "red",
          line: "The tag is in the body. About one load in four paints before it and stays as built.",
          action: { label: "Move it first in the head", href: "/start" },
          known: "now",
          blocks: false,
          superadmin_only: false,
        },
      ],
    });
    expect(a).not.toBeNull();
    expect(a?.special_category).toBe(true);
    expect(a?.tag_withheld).toBe(false);
    expect(a?.checks[0]).toEqual({
      id: "tag",
      state: "red",
      line: "The tag is in the body. About one load in four paints before it and stays as built.",
      action: { label: "Move it first in the head", href: "/start" },
      known: "now",
      blocks: false,
      superadmin_only: false,
    });
  });

  it("an unanswered question is null, a withheld tag true, a missing field its default", () => {
    const a = readAnswer({ ok: true, checks: [], special_category: null, tag_withheld: true });
    expect(a?.special_category).toBeNull();
    expect(a?.tag_withheld).toBe(true);
    expect(a?.blocks_go_live).toBe(false);
    const b = readAnswer({ checks: [{ id: "category", state: "red", line: "x", blocks: true }] });
    expect(b?.blocks_go_live).toBe(true);
    expect(b?.checks[0]?.action).toBeNull();
    expect(b?.checks[0]?.known).toBe("now");
    expect(b?.checks[0]?.superadmin_only).toBe(false);
  });

  it("an answer without a list, or a row that is not a check, is not the readiness answer", () => {
    expect(readAnswer({ ok: true })).toBeNull();
    expect(readAnswer(null)).toBeNull();
    expect(readAnswer("x")).toBeNull();
    const a = readAnswer({ checks: [{ id: "tag", state: "blue", line: "x" }, 7, null] });
    expect(a?.checks).toEqual([]);
  });

  it("an action without a label is none; an empty href is null", () => {
    const a = readAnswer({
      checks: [
        { id: "tag", state: "red", line: "x", action: { href: "/start" } },
        { id: "counted", state: "red", line: "y", action: { label: "Pick it", href: "" } },
      ],
    });
    expect(a?.checks[0]?.action).toBeNull();
    expect(a?.checks[1]?.action).toEqual({ label: "Pick it", href: null });
  });
});

describe("readReadiness: the read, and an older worker", () => {
  const ok: Api = async <T>(path: string) => {
    expect(path).toBe(`${READINESS_PATH}?customer_id=medora`);
    return ANSWER(MEDORA) as T;
  };

  it("answers the list", async () => {
    const out = await readReadiness("medora", ok);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.answer.checks).toHaveLength(MEDORA.length);
  });

  it("a 404 (an older worker) is missing: the screens behave as today", async () => {
    const api: Api = async () => {
      throw new ApiError(404, "API error 404: Not found");
    };
    expect(await readReadiness("medora", api)).toEqual({ kind: "missing" });
  });

  it("an answer without the list is missing too", async () => {
    const api: Api = async <T>() => ({ ok: true }) as T;
    expect(await readReadiness("medora", api)).toEqual({ kind: "missing" });
  });

  it("any other failure is failed, never thrown", async () => {
    const api: Api = async () => {
      throw new ApiError(500, "API error 500: boom");
    };
    expect(await readReadiness("medora", api)).toEqual({ kind: "failed" });
    const net: Api = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await readReadiness("medora", net)).toEqual({ kind: "failed" });
  });

  it("the customer id is encoded", async () => {
    let seen = "";
    const api: Api = async <T>(path: string) => {
      seen = path;
      return ANSWER([]) as T;
    };
    await readReadiness("a b", api);
    expect(seen).toBe(`${READINESS_PATH}?customer_id=a%20b`);
  });
});

describe("answerSpecialCategory: the operator's answer", () => {
  it("posts customer_id and a boolean answer", async () => {
    let body = "";
    const api: Api = async <T>(path: string, init?: RequestInit) => {
      expect(path).toBe(SPECIAL_CATEGORY_PATH);
      expect(init?.method).toBe("POST");
      body = String(init?.body);
      return { ok: true } as T;
    };
    expect(await answerSpecialCategory("medora", true, api)).toEqual({ kind: "ok" });
    expect(JSON.parse(body)).toEqual({ customer_id: "medora", answer: true });
    await answerSpecialCategory("medora", false, api);
    expect(JSON.parse(body)).toEqual({ customer_id: "medora", answer: false });
  });

  it("a 409 comes back as its sentence, as written", async () => {
    const api: Api = async () => {
      throw new ApiError(
        409,
        `API error 409: ${JSON.stringify({ error: "The site is being marked. Ask again in a minute", code: "x" })}`,
      );
    };
    expect(await answerSpecialCategory("medora", true, api)).toEqual({
      kind: "refused",
      sentence: "The site is being marked. Ask again in a minute",
    });
  });

  it("any other failure is one plain line", async () => {
    const api: Api = async () => {
      throw new ApiError(500, "API error 500: boom");
    };
    const out = await answerSpecialCategory("medora", true, api);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.message).not.toMatch(NO_DASH);
  });
});

describe("errorSentence: a 409's error as written", () => {
  it("reads the error of a 409 and nothing else", () => {
    const line = "Your site is in a special category. We finish its setup by hand before go live.";
    expect(
      errorSentence(new ApiError(409, `API error 409: ${JSON.stringify({ error: line })}`)),
    ).toBe(line);
    expect(errorSentence(new ApiError(409, "API error 409: not json"))).toBeNull();
    expect(
      errorSentence(new ApiError(409, `API error 409: ${JSON.stringify({ error: "" })}`)),
    ).toBeNull();
    expect(
      errorSentence(new ApiError(400, `API error 400: ${JSON.stringify({ error: line })}`)),
    ).toBeNull();
    expect(errorSentence(new Error(line))).toBeNull();
    expect(errorSentence("x")).toBeNull();
  });
});

describe("the order and the view of the list", () => {
  it("red first, then amber, green, grey; the API's order inside a state (A4, A18)", () => {
    const sorted = sortChecks(MEDORA);
    expect(sorted.map((c) => c.state)).toEqual([
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
    // Inside red the API's order holds: the tag line before the terms line.
    expect(sorted.slice(0, 2).map((c) => c.id)).toEqual(["tag", "terms"]);
    expect(sorted.map((c) => c.id).indexOf("counted")).toBeLessThan(
      sorted.map((c) => c.id).indexOf("contact_hint"),
    );
  });

  it("a customer session never sees a superadmin line; a superadmin sees the full list", () => {
    const customer = visibleChecks(MEDORA, false);
    expect(customer.some((c) => c.superadmin_only)).toBe(false);
    expect(customer.some((c) => c.id === "terms")).toBe(false);
    expect(customer).toHaveLength(MEDORA.length - 1);
    const admin = visibleChecks(MEDORA, true);
    expect(admin).toHaveLength(MEDORA.length);
    expect(admin[1]?.id).toBe("terms");
  });

  it("checkById finds a line or gives null", () => {
    expect(checkById(MEDORA, "category")?.state).toBe("green");
    expect(checkById(READY, "traffic")).toBeNull();
    expect(checkById(null, "tag")).toBeNull();
  });
});

describe("when the list folds, and what blocks", () => {
  it("every line green: folded to Ready to go live (A1, A2)", () => {
    expect(listFolded(READY)).toBe(true);
    expect(READY_LINE).toBe("Ready to go live.");
    expect(SHOW_CHECKS).toBe("Show the checks");
    expect(BEFORE_HEADING).toBe("Before you go live");
  });

  it("a grey line keeps it folded (A3); an amber or red line opens it (A4)", () => {
    expect(listFolded([...READY, check("buttons", "grey", "Your buttons keep their words.")])).toBe(
      true,
    );
    expect(listFolded([...READY, check("language", "amber", "Your site also has English.")])).toBe(
      false,
    );
    expect(listFolded(MEDORA)).toBe(false);
    expect(listFolded([])).toBe(true);
  });

  it("only a blocking line closes Go live, and its sentence goes under the button (A13)", () => {
    expect(blockingLine(MEDORA)).toBeNull();
    const yes = check(
      "category",
      "red",
      "Your site is in a special category. We finish its setup by hand before go live.",
      null,
      { blocks: true },
    );
    expect(blockingLine([check("tag", "red", "The tag is in the body."), yes])).toBe(yes.line);
  });
});

describe("the day-3 traffic line on Results (A14, A15)", () => {
  it("green or amber shows; grey (not known yet) and a missing answer do not", () => {
    const green = check(
      "traffic",
      "green",
      "About 60 visits a day with a test. A result in about 5 weeks.",
      null,
      {
        known: "after_day_3",
      },
    );
    expect(trafficLine(ANSWER([green]))?.line).toBe(green.line);
    const amber = check(
      "traffic",
      "amber",
      "About 70 visits a day. At this traffic the test shows a direction, not a proof.",
      {
        label: "Ask us to start a direction test",
        href: "mailto:help@example.com",
      },
    );
    expect(trafficLine(ANSWER([amber]))?.action?.label).toBe("Ask us to start a direction test");
    expect(trafficLine(ANSWER([check("traffic", "grey", "Not known yet.")]))).toBeNull();
    expect(trafficLine(ANSWER([]))).toBeNull();
    expect(trafficLine(null)).toBeNull();
  });

  it("What does that mean? has two lines for each case (A14, A16)", () => {
    expect(WHAT_MEAN).toBe("What does that mean?");
    expect(trafficWhy("green")).toEqual(TRAFFIC_WHY_OK);
    expect(trafficWhy("amber")).toEqual(TRAFFIC_WHY_DIRECTION);
    expect(TRAFFIC_WHY_OK).toHaveLength(2);
    expect(TRAFFIC_WHY_DIRECTION).toHaveLength(2);
  });
});

describe("the customers list, one column (A19)", () => {
  it("counts red and amber, red first", () => {
    expect(readinessCount(MEDORA)).toEqual({ red: 2, amber: 4 });
    expect(countWords({ red: 2, amber: 4 })).toEqual([
      { tone: "red", text: "2 red" },
      { tone: "amber", text: "4 amber" },
    ]);
    expect(countWords({ red: 1, amber: 0 })).toEqual([{ tone: "red", text: "1 red" }]);
    expect(countWords({ red: 0, amber: 3 })).toEqual([{ tone: "amber", text: "3 amber" }]);
  });

  it("Ready when neither", () => {
    expect(readinessCount(READY)).toEqual({ red: 0, amber: 0 });
    expect(countWords({ red: 0, amber: 0 })).toEqual([{ tone: "green", text: READY_WORD }]);
    expect(READY_WORD).toBe("Ready");
  });
});

describe("the question on Connect (section 03)", () => {
  const unanswered = (line: string) =>
    ANSWER([check("category", "amber", line, { label: "Answer", href: "/start" })], {
      special_category: null,
      tag_withheld: true,
    });

  it("unanswered: the question, the tag held with Answer this first (A7)", () => {
    const c = connectCategory(unanswered(GENERIC_ASK));
    expect(c).toEqual({ kind: "ask", prompt: null, held: ANSWER_FIRST });
    expect(ANSWER_FIRST).toBe("Answer this first.");
  });

  it("unanswered and the page read says health: the API's line over the question (A10)", () => {
    const line = "Your page reads like a health site. Tell us if it is.";
    expect(promptLine(check("category", "amber", line))).toBe(line);
    expect(connectCategory(unanswered(line))).toEqual({
      kind: "ask",
      prompt: line,
      held: ANSWER_FIRST,
    });
  });

  it("the plain ask is never printed over the question itself", () => {
    expect(promptLine(check("category", "amber", GENERIC_ASK))).toBeNull();
    expect(promptLine(check("category", "green", "Not a special-category site."))).toBeNull();
    expect(promptLine(null)).toBeNull();
  });

  it("No: the API's green line, with Change; the tag as today (A8)", () => {
    const a = ANSWER(
      [
        check("category", "green", "Not a special-category site.", {
          label: "Change",
          href: "/start",
        }),
      ],
      {
        special_category: false,
        tag_withheld: false,
      },
    );
    expect(connectCategory(a)).toEqual({ kind: "no", line: "Not a special-category site." });
  });

  it("Yes, not yet marked: the mock's red sentence and the tag comes with our note (A9)", () => {
    const a = ANSWER(
      [
        check(
          "category",
          "red",
          "Your site is in a special category. We finish its setup by hand before go live.",
          null,
          { blocks: true },
        ),
      ],
      { special_category: true, tag_withheld: true },
    );
    expect(connectCategory(a)).toEqual({
      kind: "yes-held",
      line: YES_HELD_LINE,
      held: TAG_WITH_NOTE,
    });
    expect(YES_HELD_LINE).toBe(
      "We need to set this site up for a sensitive topic first. We have been told and will write to you.",
    );
    expect(TAG_WITH_NOTE).toBe("The tag comes with our note.");
  });

  it("Yes and marked: the API's green line, the tag as today", () => {
    const line =
      "Set up as a special-category site: product pages are counted as a group and versions make no claims.";
    const a = ANSWER([check("category", "green", line)], {
      special_category: true,
      tag_withheld: false,
    });
    expect(connectCategory(a)).toEqual({ kind: "yes-marked", line });
  });

  it("a customer already live with no answer: the question, nothing withheld", () => {
    const a = ANSWER(
      [check("category", "amber", GENERIC_ASK, { label: "Answer", href: "/start" })],
      {
        special_category: null,
        tag_withheld: false,
      },
    );
    expect(connectCategory(a).kind).toBe("ask");
    expect(a.tag_withheld).toBe(false);
  });

  it("the question and Why we ask are the mock's two lines, word for word", () => {
    expect(QUESTION).toBe(
      "Is your site about health, religion, sexuality, politics or union membership?",
    );
    expect(WHY_WE_ASK).toBe("Why we ask");
    expect(WHY_LINES).toEqual([
      "On such a site we count product pages as a group, never one by one, and versions make no claim.",
      "The law treats these subjects apart (GDPR Art. 9).",
    ]);
  });
});

describe("the strings of this build carry no dash", () => {
  it("every string outside the list", () => {
    for (const s of [
      ANSWER_FIRST,
      AS_CUSTOMER_SEES,
      BEFORE_HEADING,
      GENERIC_ASK,
      NO_TAG_UNTIL_MARKED,
      QUESTION,
      READY_LINE,
      READY_WORD,
      SHOW_CHECKS,
      SUPERADMIN_ONLY,
      TAG_LABEL,
      TAG_WITH_NOTE,
      WHAT_MEAN,
      WHY_WE_ASK,
      YES_HELD_LINE,
      ...WHY_LINES,
      ...TRAFFIC_WHY_OK,
      ...TRAFFIC_WHY_DIRECTION,
    ]) {
      expect(s).not.toMatch(NO_DASH);
    }
    expect(TAG_LABEL).toBe("Tag · first in the head");
    expect(SUPERADMIN_ONLY).toBe("superadmin only");
    expect(NO_TAG_UNTIL_MARKED).toBe("no tag until marked");
    expect(AS_CUSTOMER_SEES).toBe("As the customer sees it, plus the terms");
  });
});
