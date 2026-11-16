import { describe, expect, it } from "vitest";
import {
  type HealthIssue,
  type HealthIssuesResponse,
  type HealthPage,
  type IssueCode,
  healthByPath,
  healthFor,
  healthLines,
  issueTone,
  loadHealth,
  siteLine,
} from "../../src/components/start/health";
import { ApiError } from "../../src/lib/api";

const H = "24 h";

function issue(
  code: IssueCode,
  count: number,
  share: number,
  slot: string | null = null,
): HealthIssue {
  return { code, count, share, slot };
}

function page(loads: number, issues: HealthIssue[], page_path = "/"): HealthPage {
  return { page_path, loads, issues };
}

describe("healthLines: share or counts", () => {
  it("writes a percentage from 100 loads on, in full on the first line", () => {
    const lines = healthLines(page(510, [issue("lines_changed", 36, 0.0706, "hero.headline")]));
    expect(lines).toEqual([
      {
        tone: "warn",
        text: `On 7% of visits in the last ${H}, the headline took more lines than yours.`,
        link: "part",
      },
    ]);
  });

  it("writes counts below 100 loads, and the short form on the second line", () => {
    const lines = healthLines(
      page(40, [issue("reverted", 5, 0.125, "hero.headline"), issue("reveal_cap", 3, 0.075)]),
    );
    expect(lines.map((l) => l.text)).toEqual([
      `On 5 of 40 visits in the last ${H}, your page put its own words back in the headline, so those visitors saw yours.`,
      "On 3 of 40, the version came too late and visitors saw your original page.",
    ]);
  });

  it("switches to a percentage exactly at 100 loads", () => {
    expect(healthLines(page(99, [issue("swap_shift", 5, 0.0505)]))[0]?.text).toBe(
      `On 5 of 99 visits in the last ${H}, your page moved when the words changed.`,
    );
    expect(healthLines(page(100, [issue("swap_shift", 5, 0.05)]))[0]?.text).toBe(
      `On 5% of visits in the last ${H}, your page moved when the words changed.`,
    );
  });

  it("says fewer than 1% rather than 0%", () => {
    expect(healthLines(page(1000, [issue("select_failed", 4, 0.004)]))[0]?.text).toBe(
      `On fewer than 1% of visits in the last ${H}, Rawuser did not answer in time, so visitors saw your original page. Nothing to change on your side.`,
    );
  });

  it("uses the hours the endpoint answered with", () => {
    expect(healthLines(page(200, [issue("swap_shift", 10, 0.05)]), 48)[0]?.text).toBe(
      "On 5% of visits in the last 48 h, your page moved when the words changed.",
    );
  });
});

describe("healthLines: the 3-load floor", () => {
  it("hides a problem seen on fewer than 3 loads", () => {
    expect(healthLines(page(20, [issue("lines_changed", 2, 0.1, "hero.headline")]))).toEqual([]);
  });

  it("shows it from 3 loads on", () => {
    expect(healthLines(page(20, [issue("lines_changed", 3, 0.15, "hero.headline")]))).toHaveLength(
      1,
    );
  });

  it("drops the low one and keeps the next problem that qualifies", () => {
    const lines = healthLines(
      page(30, [issue("reverted", 2, 0.07, "hero.headline"), issue("swap_shift", 4, 0.13)]),
    );
    expect(lines.map((l) => l.text)).toEqual([
      `On 4 of 30 visits in the last ${H}, your page moved when the words changed.`,
    ]);
  });

  it("gives a clean page, or no data, no line at all", () => {
    expect(healthLines(page(500, []))).toEqual([]);
    expect(healthLines(undefined)).toEqual([]);
    expect(healthLines(page(0, [issue("select_failed", 3, 1)]))).toEqual([]);
  });
});

describe("healthLines: order and the two-line cap", () => {
  const issues = [
    issue("swap_shift", 6, 0.03),
    issue("reverted", 24, 0.12, "hero.headline"),
    issue("reveal_cap", 8, 0.04),
    issue("apply_error", 4, 0.02, "hero.body"),
  ];

  it("puts the most frequent first, in full, then the second short, and stops at two", () => {
    const lines = healthLines(page(200, issues));
    expect(lines).toEqual([
      {
        tone: "warn",
        text: `On 12% of visits in the last ${H}, your page put its own words back in the headline, so those visitors saw yours.`,
        link: "part",
      },
      {
        tone: "err",
        text: "On 4%, the version came too late and visitors saw your original page.",
        link: null,
      },
    ]);
  });

  it("does not depend on the order the endpoint sent", () => {
    expect(healthLines(page(200, [...issues].reverse()))).toEqual(healthLines(page(200, issues)));
  });

  it("links only the first line", () => {
    const lines = healthLines(
      page(200, [issue("lines_changed", 20, 0.1, "hero.headline"), issue("swap_shift", 10, 0.05)]),
    );
    expect(lines[0]?.link).toBe("part");
    expect(lines[1]).toEqual({
      tone: "warn",
      text: "On 5%, your page moved when the words changed.",
      link: null,
    });
  });
});

describe("healthLines: every kind in full and short", () => {
  it("writes the approved copy for each code", () => {
    const full = (i: HealthIssue) => healthLines(page(200, [i]))[0];
    const short = (i: HealthIssue) =>
      healthLines(page(200, [issue("reverted", 199, 0.995, "hero.headline"), i]))[1]?.text;

    expect(full(issue("select_failed", 6, 0.03))).toEqual({
      tone: "err",
      text: `On 3% of visits in the last ${H}, Rawuser did not answer in time, so visitors saw your original page. Nothing to change on your side.`,
      link: null,
    });
    expect(short(issue("select_failed", 6, 0.03))).toBe(
      "On 3%, Rawuser did not answer and visitors saw your original page.",
    );

    expect(full(issue("reveal_cap", 8, 0.04))?.text).toBe(
      `On 4% of visits in the last ${H}, the version came too late, so visitors saw your original page. Nothing to change on your side.`,
    );

    expect(full(issue("apply_error", 4, 0.02, "hero.headline"))?.text).toBe(
      `On 2% of visits in the last ${H}, Rawuser hit an error while writing the headline. Nothing to change on your side.`,
    );
    expect(short(issue("apply_error", 4, 0.02, "hero.headline"))).toBe(
      "On 2%, Rawuser hit an error while writing the headline.",
    );

    expect(full(issue("rich_failed", 6, 0.03))?.text).toBe(
      `On 3% of visits in the last ${H}, a file Rawuser needs for this page did not load, so the headline stayed as you built it. Nothing to change on your side.`,
    );
    expect(short(issue("rich_failed", 6, 0.03))).toBe(
      "On 3%, a file Rawuser needs did not load and the headline stayed as you built it.",
    );

    expect(short(issue("lines_changed", 14, 0.07, "hero.headline"))).toBe(
      "On 7%, the headline took more lines than yours.",
    );

    expect(full(issue("swap_shift", 10, 0.05))).toEqual({
      tone: "warn",
      text: `On 5% of visits in the last ${H}, your page moved when the words changed.`,
      link: "page",
    });

    expect(short(issue("reverted", 24, 0.12, "hero.headline"))).toBe(
      "On 12%, your page put its own words back in the headline.",
    );
  });

  it("never shows a code or a slot path, even for a slot it cannot name", () => {
    const lines = healthLines(
      page(200, [
        issue("lines_changed", 20, 0.1, "pricing.tier.name"),
        issue("apply_error", 6, 0.03, null),
      ]),
    );
    expect(lines.map((l) => l.text)).toEqual([
      `On 10% of visits in the last ${H}, a part of the page took more lines than yours.`,
      "On 3%, Rawuser hit an error while writing this page.",
    ]);
    for (const l of lines) {
      expect(l.text).not.toMatch(/_|\.[a-z]/);
      expect(l.text).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("issueTone: warn for the customer's problems, err for Rawuser's", () => {
  it("maps each code", () => {
    for (const c of ["lines_changed", "swap_shift", "reverted"] as const)
      expect(issueTone(c)).toBe("warn");
    for (const c of ["select_failed", "reveal_cap", "apply_error", "rich_failed"] as const)
      expect(issueTone(c)).toBe("err");
  });

  it("asks nothing of the customer on Rawuser's own faults", () => {
    for (const c of ["select_failed", "reveal_cap", "apply_error", "rich_failed"] as const) {
      const line = healthLines(page(200, [issue(c, 10, 0.05, "hero.headline")]))[0];
      expect(line?.tone).toBe("err");
      expect(line?.link).toBeNull();
      expect(line?.text.endsWith("Nothing to change on your side.")).toBe(true);
    }
  });
});

describe("paths", () => {
  it("matches /az and /az/ as one page", () => {
    const resp: HealthIssuesResponse = {
      customer_id: "lumera",
      hours: 24,
      since: 0,
      loads: 60,
      pages: [page(60, [issue("swap_shift", 4, 0.07)], "/az/")],
    };
    const byPath = healthByPath(resp);
    expect(healthFor(byPath, "/az")?.loads).toBe(60);
    expect(healthFor(byPath, "/AZ/")?.loads).toBe(60);
    expect(healthFor(byPath, "/")).toBeUndefined();
  });
});

describe("loadHealth: silent", () => {
  it("gives nothing on a 403, so the card shows nothing extra", async () => {
    const forbidden = async <T>(_: string): Promise<T> => {
      throw new ApiError(403, "API error 403: Forbidden: superadmin role required");
    };
    const h = await loadHealth("lumera", forbidden);
    expect(h).toBeNull();
    expect(healthLines(healthFor(healthByPath(h), "/"))).toEqual([]);
  });

  it("gives nothing on any other failure or a malformed answer", async () => {
    expect(await loadHealth("lumera", async () => Promise.reject(new Error("offline")))).toBeNull();
    expect(await loadHealth("lumera", async <T>() => ({}) as T)).toBeNull();
  });

  it("asks for the last 24 h of the customer", async () => {
    let asked = "";
    const resp: HealthIssuesResponse = {
      customer_id: "a b",
      hours: 24,
      since: 0,
      loads: 0,
      pages: [],
    };
    await loadHealth("a b", async <T>(path: string) => {
      asked = path;
      return resp as T;
    });
    expect(asked).toBe("/admin/health/issues?customer_id=a%20b&hours=24");
  });
});

describe("install-friction lines on the Pages card", () => {
  it("late_tag is amber and links to the tag's fix", () => {
    const lines = healthLines(page(212, [issue("late_tag", 31, 0.146)]));
    expect(lines).toEqual([
      {
        tone: "warn",
        text: `On 15% of visits in the last ${H}, your tag ran after the page appeared, so those visitors saw your page as you built it.`,
        link: "tag",
      },
    ]);
    expect(issueTone("late_tag")).toBe("warn");
  });

  it("the site-wide policy line, only when the policy blocks", () => {
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
    expect(siteLine(site)).toBe(
      "Your site's security policy now blocks Rawuser, so visitors see your pages as built.",
    );
    expect(siteLine({ ...site, csp_blocks_since: Date.UTC(2026, 9, 2, 14, 0) })).toMatch(
      /^Since Fri 2 Oct, \d\d:00, your site's security policy blocks Rawuser, so visitors see your pages as built\.$/,
    );
    expect(siteLine({ ...site, csp_blocks: false })).toBeNull();
    expect(siteLine(null)).toBeNull();
  });
});
