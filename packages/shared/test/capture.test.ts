/**
 * receiveCapture: the shared token-gated DOM receive used by both workers.
 */

import { describe, expect, it } from "vitest";
import {
  CAPTURE_MAX_RAW_BYTES,
  CAPTURE_MAX_STORED_BYTES,
  CAPTURE_TTL_S,
  type CaptureStore,
  captureKey,
  captureTokenKey,
  receiveCapture,
  stripFieldValues,
  stripNonContent,
} from "../src/capture.ts";

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const puts: { key: string; ttl?: number }[] = [];
  const store: CaptureStore = {
    get: async (k) => data.get(k) ?? null,
    put: async (k, v, o) => {
      data.set(k, v);
      puts.push({ key: k, ttl: o?.expirationTtl });
    },
    delete: async (k) => {
      data.delete(k);
    },
  };
  return { store, data, puts };
}

const TOKEN = "abcdef1234567890abcdef1234567890";
const META = JSON.stringify({ customer_id: "lumera", page_path: "/" });

describe("receiveCapture", () => {
  it("stores the cleaned HTML under the customer/path key, fifteen minutes, and burns the token", async () => {
    const { store, data, puts } = memoryStore({ [captureTokenKey(TOKEN)]: META });
    const out = await receiveCapture(
      { token: TOKEN, html: "<html><script>x()</script><body><h1>Salam</h1></body></html>" },
      store,
    );
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.customer_id).toBe("lumera");
    expect(out.body.page_path).toBe("/");
    const stored = data.get(captureKey("lumera", "/"));
    expect(stored).toContain("<h1>Salam</h1>");
    expect(stored).not.toContain("<script");
    expect(puts.find((p) => p.key === captureKey("lumera", "/"))?.ttl).toBe(CAPTURE_TTL_S);
    expect(data.has(captureTokenKey(TOKEN))).toBe(false);
  });

  it("rejects a missing or unknown token without writing anything", async () => {
    const { store, data } = memoryStore();
    expect((await receiveCapture({ token: TOKEN, html: "<p>x</p>" }, store)).status).toBe(403);
    expect((await receiveCapture({ html: "<p>x</p>" }, store)).status).toBe(400);
    expect((await receiveCapture({ token: TOKEN }, store)).status).toBe(400);
    expect((await receiveCapture(null, store)).status).toBe(400);
    expect(data.size).toBe(0);
  });

  it("caps raw and stored sizes", async () => {
    const { store, data } = memoryStore({ [captureTokenKey(TOKEN)]: META });
    const tooBig = "a".repeat(CAPTURE_MAX_RAW_BYTES + 1);
    expect((await receiveCapture({ token: TOKEN, html: tooBig }, store)).status).toBe(413);
    const big = `<p>${"b".repeat(CAPTURE_MAX_STORED_BYTES + 100)}</p>`;
    expect((await receiveCapture({ token: TOKEN, html: big }, store)).status).toBe(200);
    expect(data.get(captureKey("lumera", "/"))?.length).toBe(CAPTURE_MAX_STORED_BYTES);
  });

  it("is single use", async () => {
    const { store } = memoryStore({ [captureTokenKey(TOKEN)]: META });
    expect((await receiveCapture({ token: TOKEN, html: "<p>1</p>" }, store)).status).toBe(200);
    expect((await receiveCapture({ token: TOKEN, html: "<p>2</p>" }, store)).status).toBe(403);
  });
});

describe("stripNonContent", () => {
  it("removes comments, script, style, noscript, svg, iframe and link", () => {
    const out = stripNonContent(
      "<!-- c --><link rel=x><script>a</script><style>b</style><noscript>c</noscript><svg>d</svg><iframe>e</iframe><p>keep</p>",
    );
    expect(out).toBe("<p>keep</p>");
    // hreflang alternates survive: they say which languages the site has.
    expect(
      stripNonContent(
        '<link rel="stylesheet" href="a.css"><link rel="alternate" hreflang="az" href="/az"><p>k</p>',
      ),
    ).toBe('<link rel="alternate" hreflang="az" href="/az"><p>k</p>');
  });
});

describe("key prefixes", () => {
  it("capture keys never share the variant prefix the visitor path reads", () => {
    expect(captureKey("c", "/").startsWith("v1:variant:")).toBe(false);
    expect(captureTokenKey("t").startsWith("v1:")).toBe(false);
  });
});

describe("stripFieldValues: what a form field holds is not page copy", () => {
  it("takes the value out of text, email, hidden and untyped inputs, in any quoting", () => {
    const out = stripFieldValues(
      `<input type="email" value="dana@site.example" placeholder="Your email">` +
        `<input type='hidden' name='csrf' value='9f2c1e77aa'>` +
        "<input name=first value=Dana>" +
        `<INPUT TYPE="text" VALUE="Dana Smith">`,
    );
    expect(out).not.toMatch(/dana|Dana|9f2c1e77aa/);
    expect(out).toContain('placeholder="Your email"');
    expect(out).toContain("name='csrf'");
  });

  it("keeps a button's value: it is the words on the button", () => {
    const html = `<input type="submit" value="Start free trial"><input type=button value="Compare"><input type="reset" value="Clear">`;
    expect(stripFieldValues(html)).toBe(html);
  });

  it("empties a textarea and keeps the tag", () => {
    expect(
      stripFieldValues(`<textarea name="bio" rows="3">I live at 5 Hill Road</textarea><p>Copy</p>`),
    ).toBe(`<textarea name="bio" rows="3"></textarea><p>Copy</p>`);
  });

  it("a value that holds a closing bracket does not end the tag early", () => {
    const out = stripFieldValues(
      `<input type="text" value="a>b secret" class="field"><h1>Title</h1>`,
    );
    expect(out).toBe(`<input type="text" class="field"><h1>Title</h1>`);
  });

  it("leaves everything that is not a field alone", () => {
    const html = `<h1 data-value="x">Title</h1><option value="pro">Pro</option><a href="/p?value=1">Plans</a>`;
    expect(stripFieldValues(html)).toBe(html);
  });

  it("is part of the cleaning every captured or fetched page goes through", () => {
    const out = stripNonContent(
      `<form><input type="email" value="dana@site.example"><button>Send</button></form>`,
    );
    expect(out).not.toContain("dana@site.example");
    expect(out).toContain("<button>Send</button>");
  });
});
