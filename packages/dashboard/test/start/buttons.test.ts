/**
 * Buttons stay as built until the operator turns one on (mock
 * design/mock/sales-readiness/pilot-gaps.html, screen 04, states A14 to
 * A19, approved 2026-10-12; contract docs/specs/button-rewrite.md): the
 * switch off by default, the caution when on, the form's button, the
 * counted pill, the API's 409 sentence as written, the same list under a
 * page after go live, and a worker that lists no buttons.
 */
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import {
  ButtonPartRow,
  ButtonRefusal,
  PageButtons,
  PartRow,
} from "../../src/components/start/Buttons";
import { PagesCard } from "../../src/components/start/PagesCard";
import { ApiError } from "../../src/lib/api";
import {
  BUTTONS_OFF_LINE,
  BUTTON_FAILED_LINE,
  BUTTON_OFF_NOTE,
  BUTTON_ON_NOTE,
  type ButtonFetcher,
  FORM_BUTTON_ON_NOTE,
  buttonNote,
  buttonRefusal,
  buttonsLine,
  isCountedButton,
  readButtons,
  setButton,
  withSwitch,
  withSwitches,
} from "../../src/lib/buttons";
import type {
  ButtonRow,
  ButtonSetAnswer,
  CustomerListItem,
  Manifest,
  ManifestResponse,
} from "../../src/types/api";

const HERO: ButtonRow = {
  path: "hero.cta.label",
  label: "Hero button",
  text: "Məhsullarımızla tanış olun!",
  rewrite: false,
  counted: true,
  form: false,
};
const SUBMIT: ButtonRow = {
  path: "forms.submit_label",
  label: "Form submit button",
  text: "Göndər",
  rewrite: false,
  counted: false,
  form: true,
};

/** The sentence the API gives for a counted button during a test (conversions.ts). */
const TEST_LOCK =
  "A test is running, so the buttons it counts cannot change. Stop the test first to change them.";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function rowHtml(button: ButtonRow, chosen: { section_path: string; label: string } | null = null) {
  return renderToStaticMarkup(
    h("ul", null, h(ButtonPartRow, { button, chosen, onToggle: () => undefined })),
  );
}

const CUSTOMER = {
  id: "medora",
  slug: "medora",
  domain: "www.medora.test",
  plan: "pilot",
  status: "active",
} as CustomerListItem;

function manifestRow(over: Partial<ManifestResponse> = {}): ManifestResponse {
  return {
    customer_id: "medora",
    page_path: "/",
    manifest: {},
    source_url: "https://www.medora.test/",
    generated_at: 1,
    confirmed_at: 2,
    cost_usd: 0,
    status: "confirmed",
    ...over,
  };
}

describe("the words", () => {
  it("off is the default, and says the button stays", () => {
    expect(buttonNote(HERO)).toEqual({ text: BUTTON_OFF_NOTE, caution: false });
    expect(BUTTON_OFF_NOTE).toBe("Stays as on your page.");
  });

  it("on gives one line of caution; a form's button sends the same form", () => {
    expect(buttonNote({ ...HERO, rewrite: true })).toEqual({
      text: "Its words will change. It will still open the same page.",
      caution: true,
    });
    expect(buttonNote({ ...SUBMIT, rewrite: true })).toEqual({
      text: "Its words will change. It will still send the same form.",
      caution: true,
    });
    expect(BUTTON_ON_NOTE).not.toBe(FORM_BUTTON_ON_NOTE);
  });

  it("the parts line: buttons stay, or how many are rewritten", () => {
    expect(buttonsLine([HERO, SUBMIT])).toBe("Buttons stay as on your page.");
    expect(buttonsLine([{ ...HERO, rewrite: true }, SUBMIT])).toBe("1 button rewritten.");
    expect(
      buttonsLine([
        { ...HERO, rewrite: true },
        { ...SUBMIT, rewrite: true },
      ]),
    ).toBe("2 buttons rewritten.");
    expect(BUTTONS_OFF_LINE).toBe("Buttons stay as on your page.");
  });

  it("a page without buttons, or a worker that lists none, adds nothing to the line", () => {
    expect(buttonsLine([])).toBeNull();
    expect(buttonsLine(null)).toBeNull();
    expect(buttonsLine(undefined)).toBeNull();
  });

  it("counted: the API's word, or the button chosen to count on the same screen", () => {
    expect(isCountedButton(HERO)).toBe(true);
    expect(isCountedButton(SUBMIT)).toBe(false);
    expect(isCountedButton(SUBMIT, { section_path: "forms.submit_label", label: "Göndər" })).toBe(
      true,
    );
    expect(isCountedButton(SUBMIT, { section_path: "hero.cta.label", label: "x" })).toBe(false);
    expect(isCountedButton(SUBMIT, null)).toBe(false);
  });
});

describe("readButtons: the list on any answer", () => {
  it("reads the rows as the API gives them", () => {
    expect(readButtons([HERO, { ...SUBMIT, proposed: true }])).toEqual([
      HERO,
      { ...SUBMIT, proposed: true },
    ]);
  });

  it("an answer without the field (a quickstart or a manifest from an older worker) is null", () => {
    expect(readButtons(undefined)).toBeNull();
    expect(readButtons(null)).toBeNull();
    expect(readButtons("buttons")).toBeNull();
  });

  it("anything but true is off, and a row without a path is dropped", () => {
    expect(
      readButtons([
        { path: "hero.cta.label", label: "Hero button", text: "Start", rewrite: "yes" },
        { label: "No path" },
        null,
      ]),
    ).toEqual([
      {
        path: "hero.cta.label",
        label: "Hero button",
        text: "Start",
        rewrite: false,
        counted: false,
        form: false,
      },
    ]);
  });
});

describe("go live sends each switch as the screen shows it", () => {
  const manifest: Manifest = {
    "hero.headline": { css: ["h1"], text: ["Sağlam həyat"], structural: "" },
    "hero.cta.label": { css: [".btn"], text: ["Məhsullarımızla tanış olun!"], structural: "" },
    // A snapshot from before the operator turned it off again.
    "forms.submit_label": { css: ["form button"], text: ["Göndər"], structural: "", rewrite: true },
  };

  it("on is true, off is false, and a part that is no button is untouched", () => {
    const sent = withSwitches(manifest, [{ ...HERO, rewrite: true }, SUBMIT]);
    expect(sent["hero.cta.label"]?.rewrite).toBe(true);
    expect(sent["forms.submit_label"]?.rewrite).toBe(false);
    expect(sent["hero.headline"]).toBe(manifest["hero.headline"]);
    // The screen's own copy is not changed.
    expect(manifest["hero.cta.label"]?.rewrite).toBeUndefined();
  });

  it("without a list (an older worker) the manifest goes as it is", () => {
    expect(withSwitches(manifest, null)).toBe(manifest);
    expect(withSwitches(manifest, [])).toBe(manifest);
  });

  it("a button the manifest does not have adds no entry", () => {
    const sent = withSwitches(manifest, [{ ...HERO, path: "pricing.cta.label", rewrite: true }]);
    expect(Object.keys(sent)).toEqual(Object.keys(manifest));
  });

  it("the Look screen sends it at go live", () => {
    const src = readFileSync(
      new URL("../../src/components/start/FirstRun.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("manifest: withSwitches(manifest, buttons)");
  });
});

describe("setButton: one switch, one request", () => {
  const input = { customerId: "medora", pagePath: "/", path: "hero.cta.label", on: true };

  it("posts the switch and takes the answer's list", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const answer: ButtonSetAnswer = {
      page_path: "/",
      confirmed: true,
      test_running: false,
      buttons: [{ ...HERO, rewrite: true, counted: false }, SUBMIT],
      changed: true,
      stale: 20,
    };
    const fetcher = (async (path: string, init?: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init?.body)) });
      return answer;
    }) as ButtonFetcher;
    const r = await setButton(fetcher, input, [{ ...HERO, counted: false }, SUBMIT]);
    expect(calls).toEqual([
      {
        path: "/admin/onboard/button",
        body: { customer_id: "medora", page_path: "/", path: "hero.cta.label", rewrite: true },
      },
    ]);
    expect(r).toEqual({ ok: true, buttons: answer.buttons, stale: 20 });
  });

  it("the 409 during a test: the switch goes back and the API's sentence is shown as written", async () => {
    const fetcher = (async () => {
      throw new ApiError(409, `API error 409: ${JSON.stringify({ error: TEST_LOCK })}`);
    }) as ButtonFetcher;
    const before = [HERO, SUBMIT];
    const r = await setButton(fetcher, input, before);
    expect(r).toEqual({ ok: false, buttons: before, refusal: TEST_LOCK });
    expect(r.buttons[0]?.rewrite).toBe(false);
  });

  it("any other failure gets a plain line, never the API's inner words", async () => {
    const notFound = (async () => {
      throw new ApiError(404, 'API error 404: {"error":"No manifest found for this path"}');
    }) as ButtonFetcher;
    const r = await setButton(notFound, input, [HERO]);
    expect(r).toEqual({ ok: false, buttons: [HERO], refusal: BUTTON_FAILED_LINE });
    expect(buttonRefusal(new TypeError("fetch failed"))).toBe(BUTTON_FAILED_LINE);
    expect(BUTTON_FAILED_LINE).not.toMatch(/manifest/i);
  });

  it("an answer without a list keeps the switch as it was set", async () => {
    const fetcher = (async () => ({ changed: true })) as unknown as ButtonFetcher;
    const r = await setButton(fetcher, input, [HERO, SUBMIT]);
    expect(r).toEqual({
      ok: true,
      buttons: withSwitch([HERO, SUBMIT], "hero.cta.label", true),
      stale: 0,
    });
  });
});

describe("a button's row: what renders", () => {
  it("A15, a button off: the switch reads Off and the note says it stays", () => {
    const html = rowHtml(SUBMIT);
    expect(text(html)).toBe("Form submit button Göndər Rewrite: Off Stays as on your page.");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain("state-warn");
  });

  it("A16, a form's button on: the caution, in amber text", () => {
    const html = rowHtml({ ...SUBMIT, rewrite: true });
    expect(text(html)).toBe(
      "Form submit button Göndər Rewrite: On Its words will change. It will still send the same form.",
    );
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("state-warn");
  });

  it("A17, the counted button off: the pill stays", () => {
    expect(text(rowHtml(HERO))).toBe(
      "Hero button counted Məhsullarımızla tanış olun! Rewrite: Off Stays as on your page.",
    );
  });

  it("A18, the counted button on: it will still open the same page", () => {
    expect(text(rowHtml({ ...HERO, rewrite: true }))).toBe(
      "Hero button counted Məhsullarımızla tanış olun! Rewrite: On Its words will change. It will still open the same page.",
    );
  });

  it("before go live the pill follows the button chosen to count", () => {
    const notYet = { ...HERO, counted: false };
    expect(text(rowHtml(notYet))).not.toContain("counted");
    expect(text(rowHtml(notYet, { section_path: "hero.cta.label", label: "x" }))).toContain(
      "Hero button counted",
    );
  });

  it("the switch says what it does to a screen reader, and keeps a 44 px row to tap", () => {
    const html = rowHtml(HERO);
    expect(html).toContain('aria-label="Rewrite the hero button"');
    expect(html).toContain("min-h-[44px]");
  });

  it("a part that is no button has no switch", () => {
    const html = renderToStaticMarkup(
      h(
        "ul",
        null,
        h(PartRow, {
          name: "Features headline",
          words: "Sağlamlığınız üçün əlavələr",
          note: "Plain text.",
        }),
      ),
    );
    expect(text(html)).toBe("Features headline Sağlamlığınız üçün əlavələr Plain text.");
    expect(html).not.toContain('role="switch"');
  });

  it("the 409 sentence renders as the API wrote it", () => {
    const html = renderToStaticMarkup(h(ButtonRefusal, { line: TEST_LOCK }));
    expect(text(html)).toBe(TEST_LOCK);
    expect(html).toContain('role="alert"');
    expect(renderToStaticMarkup(h(ButtonRefusal, { line: null }))).toBe("");
  });
});

describe("after go live: the same list under the page", () => {
  function pageButtons(buttons: ButtonRow[] | undefined, defaultOpen = false) {
    return renderToStaticMarkup(
      h(PageButtons, { customerId: "medora", pagePath: "/", buttons, defaultOpen }),
    );
  }

  it("closed: one quiet line and See", () => {
    const html = pageButtons([HERO, SUBMIT]);
    expect(text(html)).toBe("Buttons stay as on your page. See");
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("state-warn");
  });

  it("open: every button with its switch", () => {
    const html = pageButtons([{ ...HERO, rewrite: true }, SUBMIT], true);
    const t = text(html);
    expect(t).toContain("1 button rewritten. Hide");
    expect(t).toContain(
      "Hero button counted Məhsullarımızla tanış olun! Rewrite: On Its words will change. It will still open the same page.",
    );
    expect(t).toContain("Form submit button Göndər Rewrite: Off Stays as on your page.");
    expect(html.match(/role="switch"/g)).toHaveLength(2);
  });

  it("a manifest answer without buttons (an older worker), or a page with none: nothing", () => {
    expect(pageButtons(undefined)).toBe("");
    expect(pageButtons([])).toBe("");
  });

  function card(pages: ManifestResponse[]) {
    return renderToStaticMarkup(
      h(PagesCard, {
        customer: CUSTOMER,
        pages,
        readyByPath: { "/": 20 },
        perPage: 20,
        writing: false,
        onPageAdded: () => undefined,
      }),
    );
  }

  it("the Pages card reads `buttons` from the manifest read", () => {
    const html = card([manifestRow({ buttons: [HERO, SUBMIT] })]);
    expect(text(html)).toContain("20 of 20 live Buttons stay as on your page. See");
  });

  it("the Pages card is as it was against a worker that sends none", () => {
    const html = card([manifestRow()]);
    expect(text(html)).not.toMatch(/Buttons|button rewritten/);
    expect(html).not.toContain("data-buttons");
  });
});
