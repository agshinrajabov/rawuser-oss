/**
 * The two-part tag on the Pages card (docs/specs/faster-tag.md step 6,
 * "API contract (generation)"; mock design/mock/sales-readiness/two-part-tag.html,
 * approved 2026-10-26 with the founder's four decisions; the privacy review's
 * build ruling: the consent line above every style offered, the 1.5 s line
 * under "Before you choose", both in the offer and in the stale state).
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

import { PagesCard } from "../../src/components/start/PagesCard";
import { PreStaleNote, TwoPartTag } from "../../src/components/start/TwoPartTag";
import { tagCondition } from "../../src/lib/install";
import {
  PRE_BACKSTOP_LINE,
  PRE_CONSENT_LINE,
  PRE_CURRENT_LINE,
  PRE_LEAD,
  PRE_REFUSED_LINE,
  PRE_STALE_LINE,
  WHERE_STEPS,
  checkPre,
  preCspLines,
  preNeedsCheck,
  preStatus,
  preView,
  readPre,
} from "../../src/lib/pre-paste";
import type { CustomerListItem, ManifestResponse, PrePasteResponse } from "../../src/types/api";
import { install, probe } from "../install-fixtures";

type CspAnswer = NonNullable<PrePasteResponse["csp"]>;

const HASH = "'sha256-IOyuj+jb8S10OZYiHeLA7kLVjjEAds2/42n0U2jsUlY='";
const CSS =
  "@keyframes __rwp{from{visibility:hidden}to{visibility:visible}}[data-rawuser]{visibility:hidden;animation:__rwp 0s 1500ms both!important}section.hero h1{visibility:hidden;animation:__rwp 0s 1500ms both!important}";
const STYLE = `<style data-rawuser-pre>${CSS}</style>`;
const SCRIPT =
  '<script async data-cfasync="false" src="https://edge.example.com/s/measure-lab.js"></script>';
const LINE = `style-src 'self' https://fonts.example ${HASH}`;

function answer(over: Partial<PrePasteResponse> = {}): PrePasteResponse {
  return {
    customer_id: "measure-lab",
    available: true,
    blocked: null,
    paste: { css: CSS, style: STYLE, script: SCRIPT, html: `${STYLE}\n${SCRIPT}` },
    csp: {
      hash: HASH,
      needed: false,
      policy: "none",
      refused: false,
      lines: [],
      lines_read: false,
    },
    state: "none",
    stale: false,
    probed_at: 1793000000000,
    platform: { detected: "other", form: "html", ready: true },
    platforms: [
      { id: "html", status: "ready", where: ["head_first"] },
      { id: "webflow", status: "ready", where: ["head_code", "body_embed_top"] },
      { id: "framer", status: "ready", where: ["start_of_head"] },
      { id: "lovable", status: "not_yet", where: [] },
      { id: "nextjs", status: "not_yet", where: [] },
    ],
    ...over,
  };
}

const NEEDS_LINE: Partial<PrePasteResponse> = {
  csp: {
    hash: HASH,
    needed: true,
    policy: "needs_hash",
    refused: false,
    lines: [LINE],
    lines_read: true,
  },
};

const STALE: Partial<PrePasteResponse> = { state: "stale", stale: true };

const BLOCKED = (blocked: PrePasteResponse["blocked"]): PrePasteResponse =>
  answer({ available: false, blocked, paste: null, csp: null, state: null, stale: false });

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

function offer(a: PrePasteResponse, open = true): string {
  return text(
    renderToStaticMarkup(
      h(TwoPartTag, { customerId: a.customer_id, answer: a, onAnswer: noop, defaultOpen: open }),
    ),
  );
}

function stale(a: PrePasteResponse, open = true): string {
  return text(
    renderToStaticMarkup(
      h(PreStaleNote, { customerId: a.customer_id, answer: a, onAnswer: noop, defaultOpen: open }),
    ),
  );
}

describe("preView: which state the card shows", () => {
  it("shows nothing before go live, for an audit, an ended customer, or no parts", () => {
    for (const b of ["not_live", "audit", "inactive", "no_parts"] as const) {
      expect(preView(BLOCKED(b))).toEqual({ kind: "hidden" });
    }
    expect(preView(null)).toEqual({ kind: "hidden" });
  });

  it("offer with no paste or no read yet; current; stale wins", () => {
    expect(preView(answer())).toEqual({ kind: "offer" });
    expect(preView(answer({ state: null }))).toEqual({ kind: "offer" });
    expect(preView(answer({ state: "current" }))).toEqual({ kind: "current" });
    expect(preView(answer(STALE))).toEqual({ kind: "stale" });
  });

  it("Lovable and Next.js read 'not yet' (decision 3)", () => {
    const lov = answer({ platform: { detected: "lovable", form: null, ready: false } });
    expect(preView(lov)).toEqual({ kind: "not_yet", platform: "Lovable" });
    const next = answer({ platform: { detected: "nextjs", form: null, ready: false } });
    expect(preView(next)).toEqual({ kind: "not_yet", platform: "Next.js" });
    expect(offer(lov)).toBe("Two-part tag. Not yet for Lovable.");
  });

  it("an unknown platform gets the offer with plain HTML chosen", () => {
    const a = answer({ platform: { detected: null, form: null, ready: null } });
    expect(preView(a)).toEqual({ kind: "offer" });
    expect(offer(a)).toContain("Paste both parts first inside <head>");
    expect(WHERE_STEPS.head_first).toContain("after `<meta charset>`");
  });
});

describe("the policy line: only when the API says it is needed", () => {
  it("not needed: no line", () => {
    expect(preCspLines(answer())).toEqual([]);
    expect(offer(answer())).not.toContain("Your security policy blocks the style");
  });

  it("needed and read: the exact line, the hash marked", () => {
    expect(preCspLines(answer(NEEDS_LINE))).toEqual([LINE]);
    const html = renderToStaticMarkup(
      h(TwoPartTag, {
        customerId: "measure-lab",
        answer: answer(NEEDS_LINE),
        onAnswer: noop,
        defaultOpen: true,
      }),
    );
    expect(text(html)).toContain("Your security policy blocks the style. Add this line.");
    expect(text(html)).toContain(LINE);
    expect(html).toContain("var(--state-success)_10%");
  });

  it("needed but not read (GET): no line until the check, and a check is due", () => {
    const a = answer({
      csp: {
        ...(NEEDS_LINE.csp as NonNullable<PrePasteResponse["csp"]>),
        lines: [],
        lines_read: false,
      },
    });
    expect(preCspLines(a)).toEqual([]);
    expect(preNeedsCheck(a)).toBe(true);
    const unknown = answer({
      csp: { hash: HASH, needed: null, policy: null, refused: false, lines: [], lines_read: false },
    });
    expect(preNeedsCheck(unknown)).toBe(true);
    expect(preNeedsCheck(answer())).toBe(false);
  });

  it("never builds a bare style-src of its own", () => {
    const html = offer(
      answer({
        csp: { ...(answer().csp as CspAnswer), needed: true, lines: [], lines_read: true },
      }),
    );
    expect(html).not.toContain("style-src");
  });
});

describe("the offer at the card's foot", () => {
  it("closed: the founder's line and one link, no style", () => {
    const t = offer(answer(), false);
    expect(t).toBe(`Two-part tag. ${PRE_LEAD} Show the two-part tag`);
    expect(t).not.toContain("faster");
  });

  it("open: steps, consent above the style, both parts byte for byte, async marked", () => {
    const t = offer(answer());
    expect(t).toContain(PRE_CONSENT_LINE);
    expect(t.indexOf(PRE_CONSENT_LINE)).toBeLessThan(t.indexOf(STYLE));
    expect(t).toContain(STYLE);
    expect(t).toContain(SCRIPT);
    expect(t).toContain(`${STYLE.length} characters`);
    // Only the attribute is marked, never the word inside data-cfasync.
    const html = renderToStaticMarkup(
      h(TwoPartTag, {
        customerId: "measure-lab",
        answer: answer(),
        onAnswer: noop,
        defaultOpen: true,
      }),
    );
    expect(html.match(/var\(--state-success\)_10%[^>]*>async /g)?.length).toBe(1);
    expect(t).toContain("Lovable, Next.js: not yet");
    expect(t).toContain("Check again");
  });

  it("Webflow gets its two places, Framer its one", () => {
    const wf = offer(answer({ platform: { detected: "webflow", form: "webflow", ready: true } }));
    expect(wf).toContain("Paid plan: Site settings, Custom code, Head code.");
    expect(wf).toContain("Free plan: a Code Embed at the very top of the body");
    const fr = offer(answer({ platform: { detected: "framer", form: "framer", ready: true } }));
    expect(fr).toContain("Site settings, General, Custom code, Start of <head>");
  });

  it("a paste the policy refuses opens with its line", () => {
    const a = answer({
      state: "current",
      csp: { ...(NEEDS_LINE.csp as NonNullable<PrePasteResponse["csp"]>), refused: true },
    });
    const t = offer(a, false);
    expect(t).toContain(PRE_REFUSED_LINE);
    expect(t).toContain(LINE);
  });

  it("current: one ok line and Check again, no paste", () => {
    const t = offer(answer({ state: "current" }));
    expect(t).toContain(PRE_CURRENT_LINE);
    expect(t).toContain("Check again");
    expect(t).not.toContain(STYLE);
  });

  it("stale is not at the foot (it sits under the intro)", () => {
    expect(offer(answer(STALE))).toBe("");
  });
});

describe("the stale paste under the intro", () => {
  it("closed: the amber line and Show the new paste", () => {
    expect(stale(answer(STALE), false)).toBe(`${PRE_STALE_LINE} Show the new paste`);
  });

  it("open: the new style, its new hash line, Check again", () => {
    const t = stale(answer({ ...STALE, ...NEEDS_LINE }));
    expect(t).toContain("New style, replaces the old");
    expect(t).toContain(STYLE);
    expect(t).toContain("New line for your policy");
    expect(t).toContain(LINE);
    expect(t).toContain("The script line stays as it is.");
    expect(t).toContain("Check again");
  });

  it("without a policy that needs it, no policy line", () => {
    expect(stale(answer(STALE))).not.toContain("New line for your policy");
  });

  it("shows nothing when the paste is not stale", () => {
    expect(stale(answer())).toBe("");
    expect(stale(answer({ state: "current" }))).toBe("");
  });
});

describe("the privacy review's build ruling: both strings in both states", () => {
  for (const [name, render] of [
    ["offer", () => offer(answer())],
    ["stale", () => stale(answer(STALE))],
  ] as const) {
    it(`${name}: the consent line above the style, the 1.5 s line under Before you choose`, () => {
      const t = render();
      expect(t).toContain("If your Rawuser tag loads only after consent, do not paste the style.");
      expect(t.indexOf(PRE_CONSENT_LINE)).toBeLessThan(t.indexOf(STYLE));
      expect(t).toContain("Before you choose");
      expect(t).toContain(
        "If our script does not load, those parts show as built after 1.5 seconds.",
      );
      expect(t.indexOf("Before you choose")).toBeLessThan(t.indexOf(PRE_BACKSTOP_LINE));
    });
  }
});

describe("the status line from the state word", () => {
  it("says each state once", () => {
    expect(preStatus(answer({ state: "current" }))?.text).toBe(PRE_CURRENT_LINE);
    expect(preStatus(answer(STALE))).toEqual({ tone: "warn", text: PRE_STALE_LINE });
    expect(preStatus(answer({ state: null }))).toBeNull();
    expect(preStatus(BLOCKED("not_live"))).toBeNull();
  });
});

describe("the calls: the customer's own id", () => {
  it("GET /admin/install/pre with the id encoded", async () => {
    const seen: { path: string; init?: RequestInit }[] = [];
    const fetcher = async <T>(path: string, init?: RequestInit) => {
      seen.push({ path, init });
      return answer({ customer_id: "a b" }) as T;
    };
    const r = await readPre("a b", fetcher);
    expect(r?.customer_id).toBe("a b");
    expect(seen).toEqual([{ path: "/admin/install/pre?customer_id=a%20b", init: undefined }]);
  });

  it("Check again posts the id to /admin/install/pre/check", async () => {
    const seen: { path: string; init?: RequestInit }[] = [];
    const fetcher = async <T>(path: string, init?: RequestInit) => {
      seen.push({ path, init });
      return answer(NEEDS_LINE) as T;
    };
    const r = await checkPre("measure-lab", fetcher);
    expect(r?.csp?.lines).toEqual([LINE]);
    expect(seen[0]?.path).toBe("/admin/install/pre/check");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ customer_id: "measure-lab" });
  });

  it("a 403 or any failure leaves the card as it was", async () => {
    const fail = async <T>(): Promise<T> => {
      throw new Error("API error 403");
    };
    expect(await readPre("x", fail)).toBeNull();
    expect(await checkPre("x", fail)).toBeNull();
  });

  it("the Live screen asks for the signed-in customer's own id", () => {
    const src = readFileSync(
      new URL("../../src/components/start/FirstRun.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("usePrePaste(customer.id)");
    expect(src).toMatch(/user\?\.role === "customer" \? \(user\.customer_id/);
  });
});

describe("a current paste is not the late-tag warning", () => {
  it("async with a current paste reads as found, not late", () => {
    const flags = install({ tag_flags: ["async"] });
    const late = tagCondition(probe({ install: flags }), "lab.example");
    expect(late.kind).toBe("late");
    const two = tagCondition(
      probe({ install: flags, pre: { state: "current", policy: "none", lines: [] } }),
      "lab.example",
    );
    expect(two.kind).not.toBe("late");
    const old = tagCondition(
      probe({ install: flags, pre: { state: "stale", policy: "none", lines: [] } }),
      "lab.example",
    );
    expect(old.kind).toBe("late");
  });
});

const CUSTOMER = {
  id: "measure-lab",
  slug: "measure-lab",
  domain: "measure-lab.example",
  plan: "lab",
  status: "active",
} as CustomerListItem;

function manifestRow(): ManifestResponse {
  return {
    customer_id: "measure-lab",
    page_path: "/",
    manifest: {},
    source_url: "https://measure-lab.example/",
    generated_at: 1,
    confirmed_at: 2,
    cost_usd: 0,
    status: "confirmed",
  };
}

function card(a: PrePasteResponse | null, tagWithheld = false): string {
  return text(
    renderToStaticMarkup(
      h(PagesCard, {
        customer: CUSTOMER,
        pages: [manifestRow()],
        readyByPath: { "/": 36 },
        perPage: 36,
        writing: false,
        onPageAdded: noop,
        tagWithheld,
        pre: { answer: a, onAnswer: noop },
      }),
    ),
  );
}

describe("on the Pages card", () => {
  it("stale: the line under the intro, before the page rows", () => {
    const t = card(answer(STALE));
    expect(t).toContain(PRE_STALE_LINE);
    expect(t.indexOf(PRE_STALE_LINE)).toBeLessThan(t.indexOf("/ homepage"));
  });

  it("offer: after the rows", () => {
    const t = card(answer());
    expect(t.indexOf(PRE_LEAD)).toBeGreaterThan(t.indexOf("/ homepage"));
  });

  it("nothing before go live, before the answer, or with the tag withheld", () => {
    expect(card(BLOCKED("not_live"))).not.toContain("Two-part tag");
    expect(card(null)).not.toContain("Two-part tag");
    expect(card(answer(STALE), true)).not.toContain(PRE_STALE_LINE);
  });
});

describe("copy", () => {
  it("no em or en dash anywhere it renders", () => {
    const all = [
      offer(answer()),
      offer(answer(NEEDS_LINE)),
      offer(answer({ state: "current" })),
      stale(answer({ ...STALE, ...NEEDS_LINE })),
      card(answer(STALE)),
    ].join(" ");
    expect(all).not.toMatch(/[–—]/);
    const lib = readFileSync(new URL("../../src/lib/pre-paste.ts", import.meta.url), "utf8");
    const comp = readFileSync(
      new URL("../../src/components/start/TwoPartTag.tsx", import.meta.url),
      "utf8",
    );
    expect(lib + comp).not.toMatch(/[–—]/);
  });
});
