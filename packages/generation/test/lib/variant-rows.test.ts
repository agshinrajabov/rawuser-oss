import { describe, expect, it } from "vitest";
import { writeErrorRow } from "../../src/lib/variant-rows.ts";
import { makeSqliteD1 } from "../admin/sqlite-d1.ts";

// 2026-10-05, on a lab site: five rows the lint refused named the models of
// a static per-intent split, not the model that wrote them, so an error
// looked like a fall through to another provider. The row names the id of
// the model the call was routed to.
describe("writeErrorRow", () => {
  it("records the model the call was routed to, on insert and on a repeat failure", async () => {
    const { d1, db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at) VALUES ('acme', 'acme', 'acme.test', 'active', 1)",
    ).run();
    const tuple = { intent_dim: "competitor", source_dim: "social" } as const;
    await writeErrorRow(
      "acme",
      tuple,
      "v1:variant:acme:competitor:social",
      "lint: x",
      d1,
      "/",
      "model-a",
    );
    const first = db.prepare("SELECT model, status FROM variants").get() as {
      model: string;
      status: string;
    };
    expect(first).toEqual({ model: "model-a", status: "error" });
    await writeErrorRow(
      "acme",
      tuple,
      "v1:variant:acme:competitor:social",
      "timeout",
      d1,
      "/",
      "model-b",
    );
    const again = db.prepare("SELECT model FROM variants").get() as { model: string };
    expect(again.model).toBe("model-b");
  });

  it("takes any model id as it is configured, a binding's too", async () => {
    const { d1, db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at) VALUES ('acme', 'acme', 'acme.test', 'active', 1)",
    ).run();
    await writeErrorRow(
      "acme",
      { intent_dim: "problem", source_dim: "ai" },
      "k",
      "x",
      d1,
      "/",
      "@spare/model-c",
    );
    const row = db.prepare("SELECT model FROM variants").get() as { model: string };
    expect(row.model).toBe("@spare/model-c");
  });
});
