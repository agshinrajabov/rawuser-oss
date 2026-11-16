import { describe, expect, it } from "vitest";
import {
  applicationStage,
  isEmailShape,
  normalizeSiteUrl,
  siteHost,
  sourceLabel,
  stageIndex,
  toMs,
} from "../src/lib/apply";

const base = { status: "invited" as const, submitted_at: null, tag_seen_at: null, live_at: null };

describe("normalizeSiteUrl", () => {
  it("adds https to a bare host and keeps a full URL", () => {
    expect(normalizeSiteUrl("acme.com")).toBe("https://acme.com/");
    expect(normalizeSiteUrl("  http://acme.com/pricing ")).toBe("http://acme.com/pricing");
  });
  it("refuses what cannot be a site", () => {
    expect(normalizeSiteUrl("")).toBeNull();
    expect(normalizeSiteUrl("acme")).toBeNull();
    expect(normalizeSiteUrl("ftp://acme.com")).toBeNull();
    expect(normalizeSiteUrl("javascript:alert(1)")).toBeNull();
  });
  it("shows a host without www", () => {
    expect(siteHost("https://www.acme.com/x")).toBe("acme.com");
  });
});

describe("isEmailShape", () => {
  it("accepts a plain address and refuses a broken one", () => {
    expect(isEmailShape("a@b.test")).toBe(true);
    expect(isEmailShape("a@b")).toBe(false);
    expect(isEmailShape("a b@c.test")).toBe(false);
  });
});

describe("application status", () => {
  it("takes the furthest stage reached", () => {
    expect(applicationStage(base)).toBe("invited");
    expect(applicationStage({ ...base, status: "applied" })).toBe("applied");
    expect(applicationStage({ ...base, status: "applied", tag_seen_at: 1 })).toBe("tag_seen");
    expect(applicationStage({ ...base, status: "applied", tag_seen_at: 1, live_at: 2 })).toBe(
      "live",
    );
    expect(applicationStage({ ...base, status: "archived", live_at: 2 })).toBe("archived");
  });
  it("an archived row keeps the steps it reached on the status line", () => {
    expect(stageIndex({ ...base, status: "archived", submitted_at: 5 })).toBe(1);
    expect(stageIndex({ ...base, live_at: 9 })).toBe(3);
  });
  it("labels sources and tolerates seconds", () => {
    expect(sourceLabel("ai")).toBe("ChatGPT and AI tools");
    expect(sourceLabel("mastodon")).toBe("mastodon");
    expect(toMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});
