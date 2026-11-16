/**
 * Pilot requests live 12 months after their last status change
 * (privacy review, 2026-10-25, ruling 3 on docs/sales/site-privacy.md).
 * Real SQL over every migration, 0046 included.
 */

import { describe, expect, it } from "vitest";
import type { AdminEnv } from "../../src/admin/handlers.ts";
import {
  PILOT_REQUEST_DELETE_SQL,
  PILOT_REQUEST_KEEP_MS,
  deleteOldPilotRequests,
  handlePilotRequestUpdateStatus,
} from "../../src/admin/pilot-requests.ts";
import { makeSqliteD1 } from "./sqlite-d1.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-25T12:00:00Z");

function seed(
  db: ReturnType<typeof makeSqliteD1>["db"],
  id: string,
  created_at: number,
  status_at: number | null,
  status = "new",
) {
  db.prepare(
    "INSERT INTO pilot_requests (id, email, site_url, note, created_at, status, status_at) VALUES (?, 'a@b.example', NULL, NULL, ?, ?, ?)",
  ).run(id, created_at, status, status_at);
}

function ids(db: ReturnType<typeof makeSqliteD1>["db"]): string[] {
  return (db.prepare("SELECT id FROM pilot_requests ORDER BY id").all() as { id: string }[]).map(
    (r) => r.id,
  );
}

describe("deleteOldPilotRequests", () => {
  it("keeps 365 days and reads status_at before created_at", () => {
    expect(PILOT_REQUEST_KEEP_MS).toBe(365 * DAY);
    expect(PILOT_REQUEST_DELETE_SQL).toBe(
      "DELETE FROM pilot_requests WHERE COALESCE(status_at, created_at) < ?",
    );
  });

  it("deletes by the last status change, else by arrival", async () => {
    const { d1, db } = makeSqliteD1();
    const cutoff = NOW - 365 * DAY;
    seed(db, "plt_a_old", cutoff - 400 * DAY, cutoff - 1); // changed 365 days and 1 ms ago
    seed(db, "plt_b_recent_change", cutoff - 400 * DAY, cutoff + 1, "contacted"); // old, changed lately
    seed(db, "plt_c_on_the_line", cutoff, cutoff); // exactly 365 days: kept
    seed(db, "plt_d_null_old", cutoff - 1, null); // no status_at, old arrival
    seed(db, "plt_e_null_new", NOW - DAY, null); // no status_at, new
    seed(db, "plt_f_new", NOW, NOW);

    const deleted = await deleteOldPilotRequests(d1, NOW);
    expect(deleted).toBe(2);
    expect(ids(db)).toEqual([
      "plt_b_recent_change",
      "plt_c_on_the_line",
      "plt_e_null_new",
      "plt_f_new",
    ]);
  });

  it("migration 0046 backfills status_at from created_at", () => {
    const { db } = makeSqliteD1();
    // The backfill statement as the migration runs it, on a row from before.
    db.prepare(
      "INSERT INTO pilot_requests (id, email, created_at, status) VALUES ('plt_x', 'a@b.example', 1000, 'new')",
    ).run();
    db.exec("UPDATE pilot_requests SET status_at = created_at WHERE status_at IS NULL;");
    expect(db.prepare("SELECT status_at FROM pilot_requests").get()).toEqual({ status_at: 1000 });
  });
});

describe("update-status stamps status_at", () => {
  function env(d1: D1Database): AdminEnv {
    return { DB: d1, DASHBOARD_ORIGIN: "https://app.example.com" } as unknown as AdminEnv;
  }
  function post(body: unknown): Request {
    return new Request("https://api.example.com/admin/pilot-requests/update-status", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("moves status_at on a change and leaves it on the same status", async () => {
    const { d1, db } = makeSqliteD1();
    seed(db, "plt_1", 1000, 1000);
    const at = () =>
      db.prepare("SELECT status, status_at FROM pilot_requests").get() as {
        status: string;
        status_at: number;
      };

    const before = Date.now();
    const r1 = await handlePilotRequestUpdateStatus(
      post({ id: "plt_1", status: "contacted" }),
      env(d1),
    );
    expect(r1.status).toBe(200);
    const first = at();
    expect(first.status).toBe("contacted");
    expect(first.status_at).toBeGreaterThanOrEqual(before);

    seed(db, "plt_2", 2000, null);
    await handlePilotRequestUpdateStatus(post({ id: "plt_2", status: "new" }), env(d1));
    expect(
      (
        db.prepare("SELECT status_at FROM pilot_requests WHERE id = 'plt_2'").get() as {
          status_at: number;
        }
      ).status_at,
    ).toBe(2000);

    db.prepare("UPDATE pilot_requests SET status_at = 5 WHERE id = 'plt_1'").run();
    await handlePilotRequestUpdateStatus(post({ id: "plt_1", status: "contacted" }), env(d1));
    expect(at().status_at).toBe(5);
  });
});
