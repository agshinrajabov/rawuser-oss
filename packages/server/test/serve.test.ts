import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeContext, staticAnswer, staticServer, workerServer } from "../src/serve.ts";

const listen = (s: Server): Promise<string> =>
  new Promise((done) =>
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      done(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
    }),
  );

/** A worker that says back what it was given. */
const echo = {
  async fetch(request: Request) {
    const body = request.method === "POST" ? await request.text() : "";
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    return new Response(
      JSON.stringify({
        url: request.url,
        method: request.method,
        ip: request.headers.get("cf-connecting-ip"),
        realIp: request.headers.get("x-real-ip"),
        ua: request.headers.get("user-agent"),
        country: (request as Request & { cf?: { country?: string } }).cf?.country ?? null,
        body,
      }),
      { status: 201, headers },
    );
  },
};

describe("a worker behind a plain listener", () => {
  const servers: Server[] = [];
  const serve = async (options = {}) => {
    const s = workerServer(echo, {}, makeContext().ctx, options);
    servers.push(s);
    return listen(s);
  };
  afterAll(() => {
    for (const s of servers) s.close();
  });

  it("hands the worker the request as it came: address, method, headers, body; and writes its answer back", async () => {
    const base = await serve({ origin: "https://edge.site.example" });
    const res = await fetch(`${base}/select?customer_id=demo&utm_source=x`, {
      method: "POST",
      headers: { "user-agent": "tester", "content-type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(201);
    const seen = await res.json();
    // The public address, not the listener's own.
    expect(seen.url).toBe("https://edge.site.example/select?customer_id=demo&utm_source=x");
    expect(seen.method).toBe("POST");
    expect(seen.ua).toBe("tester");
    expect(seen.body).toBe("hello");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("the connecting address is the socket's, whatever a client claims", async () => {
    const base = await serve();
    const seen = await (
      await fetch(`${base}/`, {
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          "x-real-ip": "203.0.113.9",
          "x-forwarded-for": "203.0.113.9",
        },
      })
    ).json();
    expect(seen.ip).toBe("127.0.0.1");
    expect(seen.realIp).toBeNull();
  });

  it("behind your own proxy, and only when told so, it is the proxy's word: the last entry, never the client's", async () => {
    const base = await serve({ trustProxy: true });
    // The client wrote the first entry itself; the proxy added the second.
    const seen = await (
      await fetch(`${base}/`, { headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" } })
    ).json();
    expect(seen.ip).toBe("198.51.100.7");
    // A client that rotates what it claims is still one address.
    const again = await (
      await fetch(`${base}/`, { headers: { "x-forwarded-for": "192.0.2.44, 198.51.100.7" } })
    ).json();
    expect(again.ip).toBe("198.51.100.7");
    // No forwarded header: the socket's again.
    expect((await (await fetch(`${base}/`)).json()).ip).toBe("127.0.0.1");
  });

  it("the country is known only from the header the operator named, and only as two letters", async () => {
    const none = await serve();
    expect(
      (await (await fetch(`${none}/`, { headers: { "cf-ipcountry": "DE" } })).json()).country,
    ).toBeNull();
    const named = await serve({ countryHeader: "X-Country" });
    expect(
      (await (await fetch(`${named}/`, { headers: { "x-country": "de" } })).json()).country,
    ).toBe("DE");
    expect(
      (await (await fetch(`${named}/`, { headers: { "x-country": "Germany" } })).json()).country,
    ).toBeNull();
    expect((await (await fetch(`${named}/`)).json()).country).toBeNull();
  });

  it("a body over the limit is refused before the worker sees it", async () => {
    const base = await serve({ maxBody: 10 });
    const res = await fetch(`${base}/`, { method: "POST", body: "x".repeat(11) });
    expect(res.status).toBe(413);
  });

  it("a worker that throws answers 500 and the listener lives on", async () => {
    const logged: string[] = [];
    const s = workerServer(
      {
        fetch: async (r: Request) => {
          if (new URL(r.url).pathname === "/boom") throw new Error("boom");
          return new Response("ok");
        },
      },
      {},
      makeContext().ctx,
      {},
      (l) => logged.push(l),
    );
    servers.push(s);
    const base = await listen(s);
    expect((await fetch(`${base}/boom`)).status).toBe(500);
    expect(await (await fetch(`${base}/fine`)).text()).toBe("ok");
    expect(logged.join("\n")).toContain("boom");
  });
});

describe("work handed to waitUntil", () => {
  it("is kept until it ends, and a failure is logged and does not escape", async () => {
    const logged: string[] = [];
    const { ctx, idle } = makeContext((l) => logged.push(l));
    let done = false;
    ctx.waitUntil(
      new Promise<void>((r) =>
        setTimeout(() => {
          done = true;
          r();
        }, 20),
      ),
    );
    ctx.waitUntil(Promise.reject(new Error("the write failed")));
    await idle();
    expect(done).toBe(true);
    expect(logged).toEqual(["[waitUntil] the write failed"]);
  });
});

describe("the dashboard's files", () => {
  let root = "";
  let base = "";
  let server: Server;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "rawuser-static-"));
    writeFileSync(join(root, "index.html"), "<h1>home</h1>");
    writeFileSync(join(root, "404.html"), "<h1>missing</h1>");
    mkdirSync(join(root, "visitors"));
    writeFileSync(join(root, "visitors/index.html"), "<h1>visitors</h1>");
    mkdirSync(join(root, "_next/static/chunks"), { recursive: true });
    writeFileSync(join(root, "_next/static/chunks/a-1f2e3d.js"), "console.log(1)");
    // A file beside the export that must never be served.
    writeFileSync(join(root, "..", "secret-of-the-test.txt"), "no");
    server = staticServer(root);
    base = await listen(server);
  });
  afterAll(() => {
    server.close();
    rmSync(join(root, "..", "secret-of-the-test.txt"), { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("serves the home page, a page by its folder, and sends a bare folder to its slash", async () => {
    expect(await (await fetch(`${base}/`)).text()).toBe("<h1>home</h1>");
    expect(await (await fetch(`${base}/visitors/`)).text()).toBe("<h1>visitors</h1>");
    const bare = await fetch(`${base}/visitors?x=1`, { redirect: "manual" });
    expect(bare.status).toBe(308);
    expect(bare.headers.get("location")).toBe("/visitors/?x=1");
  });

  it("answers 404 with the export's own page", async () => {
    const res = await fetch(`${base}/nothing-here`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>missing</h1>");
  });

  it("never serves a file outside the export, however the path is written", () => {
    for (const p of [
      "/../secret-of-the-test.txt",
      "/%2e%2e/secret-of-the-test.txt",
      "/visitors/../../secret-of-the-test.txt",
      "/..%2fsecret-of-the-test.txt",
      "/%E0%A4%A",
    ]) {
      const a = staticAnswer(root, p);
      expect("file" in a ? a.file.includes("secret") : false, p).toBe(false);
      expect(a.status, p).toBe(404);
    }
  });

  it("hashed files are kept by the browser, pages are not; every answer carries the safety headers", async () => {
    const chunk = await fetch(`${base}/_next/static/chunks/a-1f2e3d.js`);
    expect(chunk.headers.get("cache-control")).toContain("immutable");
    expect(chunk.headers.get("content-type")).toContain("javascript");
    const page = await fetch(`${base}/`);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    for (const r of [chunk, page]) {
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("x-frame-options")).toBe("DENY");
    }
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
  });
});
