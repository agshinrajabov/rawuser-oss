/**
 * The words of a button that is off are in no answer (pilot-gaps.md,
 * the lab recheck of 2026-10-12, task H9).
 *
 * An off button is not a target since the switch, but a version written
 * before it still carries the label in `sections`, and the snippet writes a
 * part the page tags itself (`data-rawuser="hero.cta.label"`) whatever the
 * targets say: on the lab the button changed on 9 of 9 loads with the
 * switch off. /select and /carry now leave the label, its other lengths and
 * its link out of what they send, from the manifest the answer already
 * holds. The stored body, its `body_id` and its `prompt_hash` are not
 * changed.
 *
 * The database is a real SQLite with every migration; the KV parses JSON
 * reads the way Workers KV does and counts what is read.
 */
import { visitorBundleKey } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { writeVisitorBundle } from "../../generation/src/admin/onboard.ts";
import { makeKv, makeSqliteD1 } from "../../generation/test/admin/sqlite-d1.ts";
import worker from "../src/index.ts";

const part = (css: string, extra: Record<string, unknown> = {}) => ({
  css: [css],
  text: [],
  structural: css,
  ...extra,
});

/** The stored manifest of `/`: the hero button off, the closing button on, the form's off. */
const STORED = {
  "hero.headline": part("h1"),
  "hero.body": part("h1 + p"),
  "hero.cta.label": part('[data-rawuser="hero.cta.label"]'),
  "hero.cta.href": part('[data-rawuser="hero.cta.label"]'),
  "cta.cta.label": part("a.closing", { rewrite: true }),
  "forms.submit_label": part("form button", { rewrite: false }),
};

/** A version written while every button was rewritten, with every length. */
const version = (customer = "acme") => ({
  customer_id: customer,
  profile_key: "intent:problem",
  generated_at: 1,
  prompt_hash: "prompt-hash-of-the-stored-body",
  body_id: "0123456789abcdef",
  sections: {
    hero: {
      kind: "hero",
      headline: "A headline for this visit",
      headline_alt: "A longer headline for this visit",
      body: "A paragraph that says why.",
      cta: {
        label: "Tell us your problem",
        label_alt: "Tell us about your problem",
        label_alt2: "Tell us",
        href: "/contact",
      },
    },
    cta: { kind: "cta", cta: { label: "See how it works", label_alt: "See it work" } },
    forms: { kind: "forms", submit_label: "Send it" },
  },
});

/** What goes out for STORED: every word but the two off buttons'. */
const SENT = {
  hero: {
    kind: "hero",
    headline: "A headline for this visit",
    headline_alt: "A longer headline for this visit",
    body: "A paragraph that says why.",
  },
  cta: { kind: "cta", cta: { label: "See how it works", label_alt: "See it work" } },
};

/** No word, length or link of an off button, anywhere in the text of an answer. */
const OFF_WORDS = [
  "Tell us your problem",
  "Tell us about your problem",
  '"Tell us"',
  "/contact",
  "Send it",
];

interface Sent {
  sections: unknown;
  prompt_hash?: string;
  body_id?: string;
}

function setup(
  opts: {
    customer?: string;
    /** The install's own site (OWN_SITE_CUSTOMER); unset, the install names none. */
    ownSite?: string;
    manifests?: Record<string, Record<string, unknown>>;
    body?: ReturnType<typeof version>;
  } = {},
) {
  const customer = opts.customer ?? "acme";
  const manifests = opts.manifests ?? { "/": STORED };
  const body = opts.body ?? version(customer);
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, status, created_at) VALUES (?, ?, 'acme.test', 'active', 1)",
  ).run(customer, customer);
  const insert = db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES (?, ?, ?, 1, 'https://acme.test/', 1)",
  );
  for (const [path, manifest] of Object.entries(manifests)) {
    insert.run(customer, path, JSON.stringify(manifest));
  }

  const sqls: string[] = [];
  const DB = {
    prepare(sql: string) {
      sqls.push(sql);
      return d1.prepare(sql);
    },
  } as unknown as D1Database;

  const store = new Map<string, string>();
  const gets: string[] = [];
  /** The version as KV holds it, one text for every key of the customer. */
  const storedBody = JSON.stringify(body);
  const VARIANTS = {
    async get(key: string, o?: string | { type?: string }) {
      gets.push(key);
      const raw = key.startsWith(`v1:variant:${customer}`) ? storedBody : (store.get(key) ?? null);
      if (raw === null) return null;
      const type = typeof o === "string" ? o : o?.type;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete() {},
  } as unknown as KVNamespace;

  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => waits.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const env = {
    VARIANTS,
    DB,
    ENVIRONMENT: "test",
    PREVIEW_TOKEN: "",
    HOLDOUT_PERCENT: "0",
    ...(opts.ownSite ? { OWN_SITE_CUSTOMER: opts.ownSite } : {}),
  };
  const fetch = async (url: string) => {
    const res = await worker.fetch(
      new Request(url, {
        headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140" },
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);
    return res;
  };

  async function select(path = "/") {
    const res = await fetch(
      `https://edge.test/select?customer_id=${customer}&path=${encodeURIComponent(path)}&utm_source=chatgpt.com`,
    );
    const text = await res.text();
    const answer = JSON.parse(text) as {
      source: string;
      variant: Sent | null;
      body_id?: string;
      targets?: Record<string, unknown>;
      carryable?: boolean;
    };
    return { text, answer };
  }

  async function carry() {
    const res = await fetch(`https://edge.test/carry?customer_id=${customer}&carry=problem:ai`);
    const text = await res.text();
    return { text, bodies: (JSON.parse(text) as { bodies: Record<string, Sent> }).bodies };
  }

  /** The bundle as generation's writeVisitorBundle writes it, into this KV. */
  async function generationWrites() {
    const kv = makeKv();
    await writeVisitorBundle({ DB: d1, VARIANTS: kv }, customer);
    store.set(visitorBundleKey(customer), kv.store.get(visitorBundleKey(customer)) ?? "");
  }

  return { select, carry, fetch, generationWrites, store, gets, sqls, db, body, storedBody };
}

describe("the words of a button that is off: /select and /carry", () => {
  it("the off button's label, its other lengths and its link are in neither answer", async () => {
    const t = setup();
    await t.generationWrites();
    const selected = await t.select();
    const carried = await t.carry();

    expect(selected.answer.source).toBe("kv");
    expect(selected.answer.variant?.sections).toEqual(SENT);
    expect(carried.bodies["/"]?.sections).toEqual(SENT);
    for (const word of OFF_WORDS) {
      expect(selected.text, word).not.toContain(word);
      expect(carried.text, word).not.toContain(word);
    }
    // Not a target either, as before.
    expect(Object.keys(selected.answer.targets ?? {})).toEqual([
      "hero.headline",
      "hero.body",
      "cta.cta.label",
    ]);
  });

  it("the on button's words are in both answers, and the other parts are untouched", async () => {
    const t = setup();
    await t.generationWrites();
    const selected = await t.select();
    const carried = await t.carry();
    const stored = t.body.sections;
    for (const sections of [selected.answer.variant?.sections, carried.bodies["/"]?.sections]) {
      const s = sections as typeof stored;
      expect(s.cta).toEqual(stored.cta);
      expect(s.hero.headline).toBe(stored.hero.headline);
      expect(s.hero.headline_alt).toBe(stored.hero.headline_alt);
      expect(s.hero.body).toBe(stored.hero.body);
      expect(s.hero.kind).toBe("hero");
    }
  });

  it("the tab's copy and the edge's answer are the same text for the page, words and parts", async () => {
    // The snippet tells the two apart by JSON.stringify([sections, targets]).
    const t = setup();
    await t.generationWrites();
    const selected = await t.select();
    const carried = (await t.carry()).bodies["/"] as Sent & { targets: unknown };
    expect(JSON.stringify([carried.sections, carried.targets])).toBe(
      JSON.stringify([selected.answer.variant?.sections, selected.answer.targets]),
    );
    expect(selected.answer.carryable).toBe(true);
  });

  it("body_id and prompt_hash stay the stored body's, and the stored body is not changed", async () => {
    const t = setup();
    await t.generationWrites();
    const selected = await t.select();
    const carried = await t.carry();
    expect(selected.answer.body_id).toBe(t.body.body_id);
    expect(selected.answer.variant?.body_id).toBe(t.body.body_id);
    expect(selected.answer.variant?.prompt_hash).toBe(t.body.prompt_hash);
    expect(carried.bodies["/"]?.body_id).toBe(t.body.body_id);
    expect(carried.bodies["/"]?.prompt_hash).toBe(t.body.prompt_hash);
    // Everything but the sections goes out as stored.
    const { sections: _sent, ...restSent } = selected.answer.variant as Sent;
    const { sections: _stored, ...restStored } = t.body;
    expect(restSent).toEqual(restStored);
    // Nothing was written: no version key, and the body in hand still has the label.
    expect([...t.store.keys()]).toEqual([visitorBundleKey("acme")]);
    expect(JSON.parse(t.storedBody)).toEqual(version());
  });

  it("no read is added: the bundle once, no database", async () => {
    const t = setup();
    await t.generationWrites();
    t.gets.length = 0;
    await t.select();
    expect(t.gets.filter((k) => k === visitorBundleKey("acme"))).toHaveLength(1);
    // The carry switch, the tombstone, the bundle and the cascade's two keys.
    expect(t.gets).toHaveLength(5);
    t.gets.length = 0;
    await t.carry();
    expect(t.gets.filter((k) => k === visitorBundleKey("acme"))).toHaveLength(1);
    expect(t.sqls).toEqual([]);
  });

  it("with no bundle in KV the database's manifest says the same", async () => {
    const t = setup();
    const selected = await t.select();
    expect(selected.answer.variant?.sections).toEqual(SENT);
    for (const word of OFF_WORDS) expect(selected.text, word).not.toContain(word);
    const fresh = setup();
    const carried = await fresh.carry();
    expect(carried.bodies["/"]?.sections).toEqual(SENT);
    for (const word of OFF_WORDS) expect(carried.text, word).not.toContain(word);
  });

  it("a button turned on has its words in both answers: the body goes out whole", async () => {
    const on = {
      ...STORED,
      "hero.cta.label": { ...STORED["hero.cta.label"], rewrite: true },
      "forms.submit_label": { ...STORED["forms.submit_label"], rewrite: true },
    };
    const t = setup({ manifests: { "/": on } });
    await t.generationWrites();
    const selected = await t.select();
    const carried = await t.carry();
    expect(selected.answer.variant?.sections).toEqual(t.body.sections);
    expect(carried.bodies["/"]?.sections).toEqual(t.body.sections);
    expect(selected.text).toContain("Tell us your problem");
    expect(selected.text).toContain("/contact");
  });

  it("a body without the label is unchanged", async () => {
    const body = { ...version(), sections: SENT as never };
    const t = setup({ body });
    await t.generationWrites();
    const selected = await t.select();
    const carried = await t.carry();
    expect(selected.answer.variant).toEqual(body);
    expect(carried.bodies["/"]?.sections).toEqual(SENT);
  });

  it("a page that borrows the root's manifest borrows its switches", async () => {
    const t = setup();
    await t.generationWrites();
    const selected = await t.select("/about");
    expect(selected.answer.variant?.sections).toEqual(SENT);
    expect(selected.answer.carryable).toBeUndefined();
  });

  it("each page by its own manifest: on one page, off on another", async () => {
    const t = setup({
      manifests: {
        "/": STORED,
        "/pricing": {
          "hero.headline": part("h1"),
          "hero.cta.label": part("a.buy", { rewrite: true }),
        },
      },
    });
    await t.generationWrites();
    const home = await t.select();
    const pricing = await t.select("/pricing");
    const carried = await t.carry();
    expect(home.answer.variant?.sections).toEqual(SENT);
    // On /pricing the hero button is on, the closing and the form's are not parts.
    const priced = {
      hero: { ...version().sections.hero, cta: { ...version().sections.hero.cta } },
    };
    // Its link rides with the label that is written.
    expect(pricing.answer.variant?.sections).toEqual(priced);
    expect(carried.bodies["/pricing"]?.sections).toEqual(priced);
    expect(carried.bodies["/"]?.sections).toEqual(SENT);
  });

  it("a page whose every part is a button that is off: no button's words go out", async () => {
    const t = setup({ manifests: { "/": { "forms.submit_label": part("form button") } } });
    await t.generationWrites();
    const selected = await t.select();
    expect(selected.answer.targets).toEqual({});
    expect(selected.answer.variant?.sections).toEqual({
      hero: SENT.hero,
    });
    expect(selected.text).not.toContain("See how it works");
  });
});

describe("a page with no manifest has no switch: its body goes out as stored", () => {
  // button-rewrite.md, "Not built, and why": a customer whose page tags its
  // own elements and never confirmed a page has no entry to hold a switch.
  // The tag on a button is the page author's own yes.
  it("with an empty bundle, and with no bundle and no row in the database", async () => {
    for (const bundle of [{ v: 1, pages: {}, conv: [] }, null]) {
      const t = setup({ manifests: {} });
      if (bundle) t.store.set(visitorBundleKey("acme"), JSON.stringify(bundle));
      const selected = await t.select();
      expect(selected.answer.source).toBe("kv");
      expect(selected.answer.targets).toBeUndefined();
      expect(selected.answer.variant).toEqual(t.body);
      // And nothing to keep for a later page: /carry hands out confirmed pages only.
      expect((await t.carry()).bodies).toEqual({});
    }
  });

  it("a page the bundle does not list, on a site whose root is not confirmed either", async () => {
    const t = setup({ manifests: { "/pricing": { "hero.headline": part("h1") } } });
    await t.generationWrites();
    const selected = await t.select("/lab/tagged");
    expect(selected.answer.targets).toBeUndefined();
    expect(selected.answer.variant).toEqual(t.body);
    // The confirmed page next to it follows its own manifest.
    const pricing = await t.select("/pricing");
    expect(pricing.answer.variant?.sections).toEqual({ hero: SENT.hero });
  });
});

describe("the operator's own site reads the label from the body by design", () => {
  // Its hero is a component that asks /select and /select-bulk and renders
  // hero.cta.label; the snippet does not run there. The install names the
  // site in OWN_SITE_CUSTOMER.
  const OWN = { customer: "own-site", ownSite: "own-site" };

  it("/select sends its body as stored, also with the button off in its manifest", async () => {
    const t = setup(OWN);
    await t.generationWrites();
    const selected = await t.select();
    expect(selected.answer.variant).toEqual(t.body);
    expect(selected.text).toContain("Tell us your problem");
    // The parts are the manifest's all the same: the button is not a target.
    expect(Object.keys(selected.answer.targets ?? {})).not.toContain("hero.cta.label");
  });

  it("/select-bulk sends the same bodies as stored, and reads no bundle", async () => {
    const t = setup(OWN);
    await t.generationWrites();
    t.gets.length = 0;
    const res = await t.fetch("https://edge.test/select-bulk?customer_id=own-site");
    const { variants } = (await res.json()) as { variants: Array<{ variant: unknown }> };
    expect(variants).toHaveLength(36);
    for (const v of variants) expect(v.variant).toEqual(t.body);
    expect(t.gets).toHaveLength(36);
    expect(t.gets).not.toContain(visitorBundleKey("own-site"));
    expect(t.sqls).toEqual([]);
  });

  it("no other customer's bodies are read through /select-bulk", async () => {
    const t = setup({ ownSite: "own-site" });
    const res = await t.fetch("https://edge.test/select-bulk?customer_id=acme");
    expect(res.status).toBe(403);
    expect(t.gets).toEqual([]);
  });

  it("an install that names no site of its own has no such route and no such exception", async () => {
    const t = setup({ customer: "own-site" });
    await t.generationWrites();
    t.gets.length = 0;
    const res = await t.fetch("https://edge.test/select-bulk?customer_id=own-site");
    expect(res.status).toBe(404);
    expect(t.gets).toEqual([]);
    // And its body follows the page's manifest like any customer's.
    const selected = await t.select();
    expect(selected.text).not.toContain("Tell us your problem");
  });
});
