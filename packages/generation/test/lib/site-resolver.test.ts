/**
 * The public-address check with an install's own resolver
 * (docs/specs/run-anywhere.md): on a plain server the machine's resolver
 * answers, and nothing is asked of a resolver outside.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotPublicUrlError,
  assertPublicUrl,
  fetchOnHost,
  resolveHost,
} from "../../src/lib/public-url.ts";

afterEach(() => vi.unstubAllGlobals());

/** Any request made while this runs, by host. */
function watchFetch(answer: () => Response = () => new Response("ok")): string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    asked.push(new URL(typeof input === "string" || input instanceof URL ? input : input.url).host);
    return answer();
  });
  return asked;
}

describe("the public-address check with the install's own resolver", () => {
  it("classifies what the resolver gives: public, private, a name that does not exist, no answer", async () => {
    const asked = watchFetch();
    expect(await resolveHost("site.example", async () => ["93.184.216.34"])).toBe("public");
    expect(await resolveHost("site.example", async () => ["93.184.216.34", "10.0.0.5"])).toBe(
      "private",
    );
    expect(await resolveHost("site.example", async () => ["127.0.0.1"])).toBe("private");
    expect(await resolveHost("site.example", async () => ["::1"])).toBe("private");
    expect(await resolveHost("site.example", async () => [])).toBe("unresolved");
    expect(await resolveHost("site.example", async () => null)).toBe("unknown");
    expect(
      await resolveHost("site.example", async () => {
        throw new Error("resolver down");
      }),
    ).toBe("unknown");
    // The resolver outside was not asked once.
    expect(asked).toEqual([]);
  });

  it("refuses a name that resolves to this machine or its network, and one it cannot resolve", async () => {
    watchFetch();
    const url = new URL("https://site.example/");
    await expect(assertPublicUrl(url, async () => ["192.168.1.20"])).rejects.toBeInstanceOf(
      NotPublicUrlError,
    );
    await expect(assertPublicUrl(url, async () => [])).rejects.toBeInstanceOf(NotPublicUrlError);
    await expect(assertPublicUrl(url, async () => null)).rejects.toBeInstanceOf(NotPublicUrlError);
    await expect(assertPublicUrl(url, async () => ["93.184.216.34"])).resolves.toBeUndefined();
  });

  it("a guarded read asks the install's resolver, then only the site itself", async () => {
    const asked = watchFetch();
    const resolved: string[] = [];
    const { resp } = await fetchOnHost(
      new URL("https://site.example/pricing"),
      {},
      "site.example",
      true,
      async (host) => {
        resolved.push(host);
        return ["93.184.216.34"];
      },
    );
    expect(resp.status).toBe(200);
    expect(resolved).toEqual(["site.example"]);
    expect(asked).toEqual(["site.example"]);
  });

  it("with no resolver handed in, a Worker asks one over HTTPS, as before", async () => {
    const asked = watchFetch(() =>
      Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }),
    );
    expect(await resolveHost("site.example")).toBe("public");
    expect([...new Set(asked)]).toEqual(["cloudflare-dns.com"]);
  });
});
