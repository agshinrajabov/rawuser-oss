import "./identity/example";
import { describe, expect, it } from "vitest";
import {
  connectSteps,
  defaultWebflowPlan,
  doneLede,
  donePolicyStep,
  doneTagStep,
  keepsChecking,
  lateCause,
  linesLabel,
  lovableMessage,
  pickerOrder,
  seenLine,
  tagCondition,
  tagIsOn,
  waitLine,
  whereText,
} from "../src/lib/install";
import { buildSnippet } from "../src/lib/snippet-tag";
import type { InstallCsp, InstallFacts, ProbeResponse } from "../src/types/api";

const CLEAN: InstallCsp = {
  verdict: { source: "none", enforced: null, report_only: null, trusted_types: false },
  blocks: false,
  degrades: false,
  report_only_blocks: false,
  lines: [],
  report_only_lines: [],
  notes: [],
  where: null,
};

function install(over: Partial<InstallFacts> = {}, csp: Partial<InstallCsp> = {}): InstallFacts {
  return {
    platform: "other",
    hosting: null,
    tag_position: "head_first",
    tag_flags: [],
    csp: { ...CLEAN, ...csp },
    ...over,
  };
}

function probe(over: Partial<ProbeResponse> = {}): ProbeResponse {
  return {
    customer_id: "brisk",
    status: "active",
    reason: "Last event 3m ago",
    tag_form: "script",
    probed_at: 0,
    page_path: "/",
    read: "ok",
    tag_runs: true,
    install: install(),
    ...over,
  };
}

/** A prospect's site as read live on 3 Oct (spec B). */
const BRISK_CSP: Partial<InstallCsp> = {
  verdict: {
    source: "header",
    enforced: { script: "missing_host", connect: "missing_host", style: "ok", frames: "blocked" },
    report_only: null,
    trusted_types: false,
  },
  blocks: true,
  lines: [
    "script-src 'self' 'unsafe-inline' https://edge.example.com",
    "connect-src 'self' https://*.posthog.com https://vitals.vercel-insights.com https://edge.example.com",
  ],
  notes: ["frames_blocked"],
  where: "next_config",
};

describe("the tag we hand out", () => {
  it("carries data-cfasync=false, the same string as the generation worker", () => {
    expect(buildSnippet("brisk")).toBe(
      '<script data-cfasync="false" src="https://edge.example.com/s/brisk.js"></script>',
    );
  });
});

describe("tagCondition", () => {
  it("brisk.test: found but blocked by the policy, red, two lines", () => {
    const c = tagCondition(
      probe({ install: install({ platform: "nextjs", hosting: "vercel" }, BRISK_CSP) }),
      "brisk.test",
    );
    expect(c.kind).toBe("blocked");
    expect(c.tone).toBe("err");
    expect(c.line).toBe("Tag found on brisk.test, but your site's security policy blocks it.");
    if (c.kind === "blocked") expect(c.body).toContain("two lines of the policy");
    expect(tagIsOn(c)).toBe(false);
    expect(keepsChecking(c)).toBe(true);
  });

  it("a clean head install is found, and the body top says where", () => {
    expect(tagCondition(probe(), "x.com")).toMatchObject({
      kind: "found",
      line: "Tag found on x.com.",
    });
    const top = tagCondition(
      probe({ install: install({ platform: "webflow", tag_position: "body_top" }) }),
      "first-site.webflow.io",
    );
    expect(top.line).toBe("Tag found on first-site.webflow.io, at the top of the body.");
    expect(keepsChecking(top)).toBe(false);
  });

  it("report-only is amber and keeps the tag on", () => {
    const c = tagCondition(
      probe({
        install: install(
          { hosting: "netlify" },
          {
            report_only_blocks: true,
            report_only_lines: ["script-src 'self' https://edge.example.com"],
          },
        ),
      }),
      "yourproduct.com",
    );
    expect(c.kind).toBe("report_only");
    expect(c.tone).toBe("warn");
    expect(tagIsOn(c)).toBe(true);
  });

  it("bot protection: amber until the tag has run, then green", () => {
    const turnedAway = probe({
      status: "unknown",
      read: "bot_protection",
      tag_runs: false,
      install: null,
    });
    expect(tagCondition(turnedAway, "x.com").kind).toBe("bot_protection");
    const ran = { ...turnedAway, tag_runs: true };
    expect(tagCondition(ran, "x.com")).toMatchObject({
      kind: "runs",
      line: "Tag runs on x.com. Your page reached Rawuser.",
    });
  });

  it("names the late causes", () => {
    const gtm = tagCondition(
      probe({
        status: "removed",
        reason: "Snippet tag not found in page HTML",
        install: install({ tag_position: "not_found", tag_flags: ["gtm"] }),
      }),
      "x.com",
    );
    expect(gtm).toMatchObject({
      kind: "late",
      cause: "gtm",
      line: "Tag runs through Google Tag Manager.",
    });

    const rocket = tagCondition(
      probe({ install: install({ tag_flags: ["rocket_loader"] }) }),
      "x.com",
    );
    expect(rocket).toMatchObject({ kind: "late", cause: "rocket_loader" });

    const footer = tagCondition(
      probe({ install: install({ tag_position: "body_late" }) }),
      "x.com",
    );
    expect(footer.line).toBe("Tag found on x.com, but it sits at the end of your page.");

    const older = tagCondition(
      probe({
        tag_form: "generic",
        install: install({ platform: "lovable", tag_flags: ["async"] }),
      }),
      "taskboard-landing-page.lovable.app",
    );
    expect(older.kind).toBe("late");
    if (older.kind === "late") {
      expect(older.body).toContain("older tag with `async`");
      expect(older.body).toContain("Ask Lovable");
    }
  });

  it("a late tag never promises a swap: the page stays as built (late-tag.md)", () => {
    for (const cause of ["async", "gtm", "rocket_loader", "body_late"] as const) {
      const flags = cause === "body_late" ? [] : [cause];
      const c = tagCondition(
        probe({
          install: install({
            tag_position: cause === "body_late" ? "body_late" : "head_first",
            tag_flags: flags,
          }),
        }),
        "x.com",
      );
      if (c.kind !== "late") throw new Error(cause);
      expect(c.body).toMatch(/as you built it/);
      expect(c.body).not.toMatch(/then the version|before the version/);
    }
  });

  it("a hash-only policy says write to us, not a wrong line", () => {
    const c = tagCondition(
      probe({
        install: install(
          {},
          {
            blocks: true,
            verdict: {
              source: "header",
              enforced: { script: "hash_only", connect: "ok", style: "ok", frames: "ok" },
              report_only: null,
              trusted_types: false,
            },
            notes: ["hash_only"],
          },
        ),
      }),
      "x.com",
    );
    expect(c.kind).toBe("hash_only");
  });

  it("another customer's tag is red", () => {
    const c = tagCondition(
      probe({ status: "removed", reason: "Snippet tag found, but with another customer id" }),
      "x.com",
    );
    expect(c).toMatchObject({ kind: "other_customer", tone: "err" });
  });
});

describe("lateCause", () => {
  it("is null for a clean head install and for a tag that is not there", () => {
    expect(lateCause("head_first", [], "script")).toBeNull();
    expect(lateCause("not_found", [], null)).toBeNull();
    expect(lateCause("head_late", ["blocking_script_before"], "script")).toBe(
      "blocking_script_before",
    );
  });
});

describe("Connect step 1", () => {
  it("Webflow: free is preselected until the tag is found in the head", () => {
    expect(defaultWebflowPlan(null)).toBe("free");
    expect(defaultWebflowPlan("not_found")).toBe("free");
    expect(defaultWebflowPlan("body_top")).toBe("free");
    expect(defaultWebflowPlan("head_first")).toBe("paid");
  });

  it("the heading follows where the tag goes", () => {
    expect(connectSteps("webflow", "free").heading).toBe(
      "Put this line at the top of your page's body",
    );
    expect(connectSteps("webflow", "paid").heading).toBe(
      "Paste this line into your site's `<head>`",
    );
    expect(connectSteps("lovable").message).toBe(true);
    expect(connectSteps("nextjs").steps).toHaveLength(3);
  });

  it("the platform line and the list", () => {
    expect(seenLine("webflow", null)).toBe("We see a Webflow site.");
    expect(seenLine("nextjs", "vercel")).toBe("We see a Next.js site on Vercel.");
    expect(seenLine("other", null)).toBeNull();
    expect(pickerOrder("wordpress")[0]).toBe("wordpress");
    expect(pickerOrder(null)).toHaveLength(10);
  });

  it("Framer: Settings, Code, Add script, as the editor shows it (2026-10-25)", () => {
    const s = connectSteps("framer");
    expect(s.steps).toEqual([
      "Open Settings, then Code, then Add script.",
      "Set Placement to Start of `<head>` and Run to Once, paste the line, then Add.",
      "Publish.",
    ]);
    expect(s.cost).toBeNull();
    expect(doneTagStep(install({ platform: "framer" }))).toBe(
      "In Settings, Code, Add script: Placement Start of `<head>`, Run Once. Then publish.",
    );
  });

  it("Lovable's message carries the tag", () => {
    expect(lovableMessage(buildSnippet("t"))).toContain(buildSnippet("t"));
  });
});

describe("where the policy lives", () => {
  it("brisk: next.config.js on Vercel", () => {
    expect(whereText("next_config", 2)).toBe(
      "Most likely in `next.config.js`, inside `async headers()`. Change these lines, keep the rest.",
    );
    expect(whereText("next_config", 1)).toMatch(/Change this line, keep the rest\.$/);
    expect(linesLabel(2)).toBe("Two lines for your policy");
    expect(linesLabel(1, "")).toBe("One line");
  });
});

describe("the 45-second line", () => {
  it("names the cause from the last probe", () => {
    const blocked = probe({ install: install({ platform: "nextjs" }, BRISK_CSP) });
    expect(waitLine(blocked, "brisk.test").text).toBe(
      "Nothing came back in 45 seconds. Your security policy blocks the tag (step 1).",
    );
    const missing = probe({
      status: "removed",
      reason: "Snippet tag not found in page HTML",
      tag_runs: false,
      install: install({ tag_position: "not_found" }),
    });
    expect(waitLine(missing, "brisk.test").kind).toBe("missing");
    expect(waitLine(probe(), "brisk.test")).toMatchObject({ kind: "fine", showLink: true });
    expect(waitLine(null, "brisk.test").kind).toBe("fine");
  });
});

describe("the apply done screen", () => {
  it("names the platform and adds the policy as a second step when it blocks", () => {
    const i = install({ platform: "nextjs", hosting: "vercel" }, BRISK_CSP);
    expect(doneLede(i)).toBe(
      "Your site runs on Next.js. Two changes on your side, then Sam sets up your first versions with you.",
    );
    expect(donePolicyStep(i)).toContain("`next.config.js`");
    expect(doneLede(install({ platform: "webflow" }))).toBe(
      "Your site runs on Webflow. Put the tag on, and Sam sets up your first versions with you.",
    );
    expect(doneTagStep(null)).toContain("Code Embed");
  });
});

describe("no dashes", () => {
  it("no em or en dash in any line the module writes", () => {
    const texts: string[] = [];
    const platforms = [
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
    ] as const;
    for (const p of platforms) {
      const s = connectSteps(p, "free");
      texts.push(s.heading, ...s.steps, s.cost ?? "", s.more?.summary ?? "", s.more?.text ?? "");
      texts.push(doneTagStep(install({ platform: p })), doneLede(install({ platform: p })));
    }
    for (const w of [
      "next_config",
      "next_middleware",
      "next_layout",
      "vercel_json",
      "netlify_headers",
      "cloudflare_headers",
      "meta_tag",
      "header",
    ] as const) {
      texts.push(whereText(w, 2), whereText(w, 1));
      texts.push(donePolicyStep(install({ platform: "nextjs" }, { ...BRISK_CSP, where: w })));
    }
    for (const flags of [["async"], ["defer"], ["module"], ["gtm"], ["rocket_loader"]] as const) {
      const c = tagCondition(probe({ install: install({ tag_flags: [...flags] }) }), "x.com");
      texts.push(c.line, "body" in c ? c.body : "");
      texts.push(waitLine(probe({ install: install({ tag_flags: [...flags] }) }), "x.com").text);
    }
    for (const t of texts) expect(t).not.toMatch(/[–—]/);
  });
});
