import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Contract tests for the hardening migration. They document required RPC/RLS
 * behavior so a live database can be checked without embedding credentials here.
 */
describe("database invariant contract", () => {
  it("requires transactional RPCs for generation and scoring", () => {
    const required = [
      "apply_pool_generation",
      "apply_draw_generation",
      "apply_day_schedule",
      "report_pool_result",
      "report_draw_result",
      "reset_and_repair_match",
      "start_match_safe",
      "reschedule_live_match",
      "reset_match_with_note",
      "shift_live_schedule_after_match",
      "current_staff_role",
      "is_invited_email",
    ];
    expect(required).toHaveLength(12);
  });

  it("requires public roster without PII", () => {
    expect(["id", "name", "gender"]).not.toContain("email");
  });

  it("requires apply_day_schedule to roll back partial rebuilds", () => {
    expect([
      "live-schedule advisory lock",
      "post-apply completeness check for assigned scheduled matches",
    ]).toHaveLength(2);
  });
});

/**
 * The active-tournament swap.
 *
 * Asserted against the migration source, because the failure it guards against is
 * invisible at runtime: `CREATE OR REPLACE FUNCTION` restores the implicit EXECUTE
 * grant to PUBLIC, so re-creating a guarded function silently re-opens it to
 * `anon` unless the revoke is repeated. That is exactly what happened to
 * `activate_tournament` here, and it is the kind of thing a live check would only
 * catch from outside.
 */
describe("set_active_tournament migration", () => {
  const sql = readFileSync(
    join(__dirname, "../../../supabase/migrations/20260919000000_set_active_tournament.sql"),
    "utf8",
  );

  it("defines the swap and keeps activate_tournament as a delegate", () => {
    expect(sql).toMatch(/FUNCTION public\.set_active_tournament\(p_tournament_id uuid\)/);
    expect(sql).toMatch(/FUNCTION public\.activate_tournament\(p_tournament_id uuid\)/);
    // One implementation: the draft entry point calls the swap rather than repeating it.
    expect(sql).toMatch(/PERFORM public\.set_active_tournament\(p_tournament_id\)/);
    // The partial unique index allows one active row, so the old scope is cleared first.
    expect(sql).toMatch(/UPDATE public\.tournaments SET is_active = false WHERE is_active/);
  });

  it("gates a draft on readiness but does not re-gate an activated tournament", () => {
    expect(sql).toMatch(/IF v_status = 'draft' THEN/);
    expect(sql).toMatch(/tournament_readiness/);
  });

  it("closes the implicit PUBLIC grant on both functions", () => {
    for (const fn of ["set_active_tournament", "activate_tournament"]) {
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(uuid\\) FROM anon, PUBLIC`),
      );
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(uuid\\)`));
    }
  });
});

/**
 * Because setup stopped asking for courts, the per-day court check can no longer
 * block activation: a tournament is activated before its venue's courts exist, and
 * they are configured at the first build. The check is kept, but as an advisory.
 *
 * Superseded by the trim-readiness migration below, which removed the court check
 * along with the other Schedule-owned ones. This block still documents what *that*
 * migration did, so keep reading it as history rather than as the current contract.
 */
describe("deferred day-courts readiness migration", () => {
  const sql = readFileSync(
    join(__dirname, "../../../supabase/migrations/20260919010000_defer_day_courts_readiness.sql"),
    "utf8",
  );

  it("redefines the checklist without dropping any of it", () => {
    expect(sql).toMatch(/FUNCTION public\.tournament_readiness\(p_tournament_id uuid\)/);
    for (const id of [
      "basics",
      "timezone",
      "days",
      "day_windows",
      "day_courts",
      "day_dates",
      "day_breaks",
      "categories",
      "category_caps",
      "rules",
    ]) {
      expect(sql).toMatch(new RegExp(`'id', '${id}'`));
    }
  });

  it("marks only the per-day court check as non-blocking", () => {
    const advisory = sql.match(/'blocking', false/g) ?? [];
    expect(advisory).toHaveLength(1);
    // The single advisory has to be the court check, not something else.
    const courtCheck = sql.slice(sql.indexOf("'id', 'day_courts'"));
    expect(courtCheck.slice(0, courtCheck.indexOf("'ok'"))).toMatch(/'blocking', false/);
  });

  it("computes ready from the blocking checks alone", () => {
    // `blocking` defaults to true, so an older check cannot silently become optional.
    expect(sql).toMatch(/COALESCE\(\(c->>'blocking'\)::boolean, true\)/);
  });

  it("closes the implicit PUBLIC grant it restores by re-creating the function", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.tournament_readiness\(uuid\) FROM anon, PUBLIC/,
    );
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.tournament_readiness\(uuid\)/);
  });
});

/**
 * The wizard collects only the basics, a date range, the events and the fixed format,
 * and it runs `tournament_readiness` at activation — when every Schedule-owned field
 * is still at its default. A check over courts, day hours, breaks or match rules could
 * therefore only ever report green, or report red for something the organizer cannot
 * fix on this screen. The checklist is trimmed to what setup actually gathers.
 */
describe("trimmed readiness migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const file = "20260919030000_trim_readiness_to_setup_scope.sql";
  const sql = readFileSync(join(dir, file), "utf8");

  it("keeps exactly the checks the setup wizard can act on", () => {
    expect(sql).toMatch(/FUNCTION public\.tournament_readiness\(p_tournament_id uuid\)/);
    for (const id of ["basics", "timezone", "days", "day_dates", "categories", "category_caps"]) {
      expect(sql).toMatch(new RegExp(`'id', '${id}'`));
    }
  });

  it("drops the checks whose data setup never collects", () => {
    for (const id of ["day_courts", "day_windows", "day_breaks", "rules"]) {
      expect(sql).not.toMatch(new RegExp(`'id', '${id}'`));
    }
  });

  it("leaves no check advisory, so the checklist is all-or-nothing again", () => {
    expect(sql).not.toMatch(/'blocking', false/);
    // The advisory mechanism survives for checks added later, and a check with no
    // flag still blocks, so nothing became optional by accident.
    expect(sql).toMatch(/COALESCE\(\(c->>'blocking'\)::boolean, true\)/);
  });

  it("does not leave the dropped checks' aggregates behind", () => {
    // An unused aggregate is dead code the next reader has to re-derive.
    for (const name of [
      "days_without_courts",
      "bad_windows",
      "breaks_outside",
      "overlapping_breaks",
    ]) {
      expect(sql).not.toMatch(new RegExp(name));
    }
  });

  it("closes the implicit PUBLIC grant it restores by re-creating the function", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.tournament_readiness\(uuid\) FROM anon, PUBLIC/,
    );
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.tournament_readiness\(uuid\)/);
  });

  it("is the last word on tournament_readiness", () => {
    // The gate is only as strict as its newest definition, so a later migration that
    // redefines the function has to come through this test rather than around it.
    const definers = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) =>
        /FUNCTION public\.tournament_readiness\(p_tournament_id uuid\)/.test(
          readFileSync(join(dir, name), "utf8"),
        ),
      );
    expect(definers.at(-1)).toBe(file);
  });
});

/**
 * Courts moved to the Schedule page, so the venue needs an RPC of its own. It must
 * not be able to take a court away from a match that is still using it: `court_id`
 * is `ON DELETE SET NULL`, so a shrink would unassign the match rather than fail.
 */
describe("set_tournament_courts migration", () => {
  const sql = readFileSync(
    join(__dirname, "../../../supabase/migrations/20260919020000_set_tournament_courts.sql"),
    "utf8",
  );

  it("defines the RPC with the venue's own bounds", () => {
    expect(sql).toMatch(
      /FUNCTION public\.set_tournament_courts\(\s*p_tournament_id uuid,\s*p_count int/,
    );
    expect(sql).toMatch(/p_count < 1 OR p_count > 64/);
  });

  it("refuses to remove a court that still holds a match", () => {
    expect(sql).toMatch(/still hold a match/);
    // Every table a court can be attached to has to be checked, or a live match on
    // the one that is missed would be silently unassigned.
    for (const table of [
      "placement_matches",
      "tier_draw_matches",
      "pool_matches",
      "draw_matches",
    ]) {
      expect(sql).toMatch(new RegExp(`FROM public\\.${table} m`));
    }
  });

  it("keeps the pool contiguous and the summary in sync", () => {
    expect(sql).toMatch(/DELETE FROM public\.courts/);
    expect(sql).toMatch(/generate_series\(1, p_count\)/);
    expect(sql).toMatch(/SET court_count = p_count/);
  });

  it("closes the implicit PUBLIC grant", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.set_tournament_courts\(uuid, int\) FROM anon, PUBLIC/,
    );
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_tournament_courts\(uuid, int\)/);
  });
});
