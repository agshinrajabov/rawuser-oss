/**
 * A customer created on an install that set nothing keeps no code in a
 * visitor's browser (docs/specs/open-source-release.md 6.3): its
 * `remember_off` is 1, neither bundle writer gives `rm`, and the customer's
 * script carries no memory statement. With REMEMBER_DEFAULT "on" it does,
 * once the special-category question is answered "no"; on a site marked
 * sensitive only when REMEMBER_ON_SENSITIVE is "on" too. The edge's writer
 * reads the same var the same way as generation's.
 */

import { describe, expect, it } from "vitest";
import { insertCustomer } from "../../generation/src/admin/handlers.ts";
import { writeVisitorBundle } from "../../generation/src/admin/onboard.ts";
import { makeKv, makeSqliteD1 } from "../../generation/test/admin/sqlite-d1.ts";
import { bundleFromD1 } from "../src/bundle-writeback.ts";
import { choiceRecallFor } from "../src/direct.ts";

type Vars = { REMEMBER_DEFAULT?: string; REMEMBER_ON_SENSITIVE?: string };

/** Creates the customer as the worker does, then both writers' bundles under `vars`. */
async function created(vars: Vars, sensitive: boolean, answer: 0 | null = null) {
  const { d1, db } = makeSqliteD1();
  const kv = makeKv();
  await insertCustomer(
    { DB: d1, ...vars },
    {
      slug: "acme",
      domain: "acme.test",
      plan: "pilot",
      contactEmail: null,
      contactName: null,
      createdAt: 1,
      sensitive: sensitive ? { sensitive: true, kept: ["/about"] } : null,
    },
  );
  if (answer !== null) {
    db.prepare("UPDATE customers SET special_category = ? WHERE id = 'acme'").run(answer);
  }
  await writeVisitorBundle({ DB: d1, VARIANTS: kv, ...vars }, "acme");
  const fromGeneration = kv.store.get("v1:vm:acme") ?? "";
  const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv, ...vars }, "acme");
  // Both writers, the same bytes, whatever the vars say.
  expect(JSON.stringify(fromEdge)).toBe(fromGeneration);
  return { bundle: fromEdge as { rm?: 1 }, script: choiceRecallFor(fromEdge) };
}

describe("an install that set nothing", () => {
  it.each([
    ["a new customer, the question not answered", false, null],
    ["a new customer that answered no", false, 0],
    ["a customer marked sensitive at creation", true, null],
  ] as const)("%s: no rm, no memory statement in its script", async (_name, sensitive, answer) => {
    const { bundle, script } = await created({}, sensitive, answer);
    expect(bundle).not.toHaveProperty("rm");
    expect(script).toBe("");
  });
});

describe("an install that turned the memory on for new customers", () => {
  const ON = { REMEMBER_DEFAULT: "on" };

  it("a customer that answered no gets rm and the statement", async () => {
    const { bundle, script } = await created(ON, false, 0);
    expect(bundle.rm).toBe(1);
    expect(script).not.toBe("");
  });

  it("not before the question is answered", async () => {
    const { bundle, script } = await created(ON, false, null);
    expect(bundle).not.toHaveProperty("rm");
    expect(script).toBe("");
  });

  it("not on a site marked sensitive, unless the install allows it there too", async () => {
    const without = await created(ON, true);
    expect(without.bundle).not.toHaveProperty("rm");
    expect(without.script).toBe("");
    const off = await created({ ...ON, REMEMBER_ON_SENSITIVE: "off" }, true);
    expect(off.bundle).not.toHaveProperty("rm");
    expect(off.script).toBe("");
    const allowed = await created({ ...ON, REMEMBER_ON_SENSITIVE: "on" }, true);
    expect(allowed.bundle.rm).toBe(1);
    expect(allowed.script).not.toBe("");
  });

  it("allowing it on marked sites turns nothing on by itself", async () => {
    const { bundle, script } = await created({ REMEMBER_ON_SENSITIVE: "on" }, true);
    expect(bundle).not.toHaveProperty("rm");
    expect(script).toBe("");
  });
});
