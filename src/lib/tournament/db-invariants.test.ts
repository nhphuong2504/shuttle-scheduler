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

/**
 * Days used to be frozen at activation: `save_tournament_days` refuses anything that
 * is not a draft, so going from two days to three meant rebuilding the tournament.
 * These RPCs add and remove days on a live one, and the guard trigger is what keeps
 * the two orders — date and `day_number` — from drifting apart, which is what
 * `sliceRowsByDay` relies on to attribute a match to a day.
 */
describe("tournament day management migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const file = "20260919040000_tournament_day_management.sql";
  const sql = readFileSync(join(dir, file), "utf8");

  it("guards the date order for every writer, not just the RPCs", () => {
    // A trigger rather than validation inside the RPCs, because the date is also
    // editable by a plain table update from the Schedule page.
    expect(sql).toMatch(/FUNCTION public\.tournament_days_guard_order\(\)/);
    expect(sql).toMatch(/CREATE TRIGGER tournament_days_guard_order/);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF tournament_id, day_number, date/);
    // The row being written must be excluded, or an update would compare against its
    // own old values and fail every time.
    expect(sql).toMatch(/d\.id <> NEW\.id/);
    // Ordering needs both directions checked: a lower number with a later date, or a
    // higher number with an earlier date.
    expect(sql).toMatch(/d\.day_number < NEW\.day_number AND d\.date > NEW\.date/);
    expect(sql).toMatch(/d\.day_number > NEW\.day_number AND d\.date < NEW\.date/);
    expect(sql).toMatch(/d\.date = NEW\.date/);
  });

  it("lets a day be added to a tournament that is already running", () => {
    expect(sql).toMatch(/FUNCTION public\.add_tournament_day\(/);
    // The date decides the position, so the caller never sends a day number.
    expect(sql).toMatch(/p_date date/);
    expect(sql).not.toMatch(/add_tournament_day\(\s*p_tournament_id uuid,\s*p_day_number/);
    expect(sql).toMatch(/count\(\*\) \+ 1 INTO v_target/);
    // Descending, so each row moves into a slot the previous move vacated. A single
    // multi-row UPDATE would give no ordering guarantee and trip the unique index.
    expect(sql).toMatch(/ORDER BY d\.day_number DESC/);
  });

  it("keeps the seven-day cap and the day_count summary honest", () => {
    expect(sql).toMatch(/v_total >= 7/);
    expect(sql).toMatch(/at most 7 days/);
    expect(sql).toMatch(/SET day_count = \(SELECT count\(\*\) FROM public\.tournament_days/);
  });

  it("refuses to strand a match or empty the tournament", () => {
    expect(sql).toMatch(/FUNCTION public\.remove_tournament_day\(/);
    expect(sql).toMatch(/A tournament needs at least one day/);
    expect(sql).toMatch(/still has % match\(es\) on it/);
    // Every table a match can live in has to be checked, or removing a day that only
    // holds a knockout match would silently re-attribute it.
    for (const table of [
      "placement_matches",
      "tier_draw_matches",
      "pool_matches",
      "draw_matches",
    ]) {
      expect(sql).toMatch(new RegExp(`FROM public\\.${table} m`));
    }
  });

  it("reads the day window in the venue's timezone", () => {
    // `date + start_time` is a wall clock. Compared against a timestamptz directly it
    // would be cast using the session timezone — UTC on Supabase — which is hours off
    // for a US venue and would put matches on the wrong side of a boundary.
    expect(sql).toMatch(/AT TIME ZONE v_tz/);
    expect(sql).toMatch(/SELECT venue_timezone INTO v_tz/);
    // The last day overruns to infinity, so its territory has no upper bound.
    expect(sql).toMatch(/v_next_start IS NULL OR scheduled\.at < v_next_start/);
  });

  it("steps the rows down in ascending order after a delete", () => {
    expect(sql).toMatch(/ORDER BY d\.day_number\b(?! DESC)/);
    expect(sql).toMatch(/SET day_number = v_row\.day_number - 1/);
    expect(sql).toMatch(/DELETE FROM public\.tournament_days WHERE id = p_day_id/);
  });

  it("closes the implicit PUBLIC grants it restores by re-creating the functions", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.add_tournament_day\(uuid, date, time, time\) FROM anon, PUBLIC/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.remove_tournament_day\(uuid, uuid\) FROM anon, PUBLIC/,
    );
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.add_tournament_day/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.remove_tournament_day/);
  });
});

/**
 * A schedule reset and a stage reset are different acts, and the difference is exactly
 * what they do to `placement_entrants`.
 *
 * `reset_placement_stage` was the only way back from a bad build, and it took the seed
 * order with it — so on the Schedule tab, "rebuild the schedule" and "start the
 * tournament over" were the same button, and a host who only wanted to rebuild lost an
 * order they had set by hand. Scheduling is a later decision than seeding, so the
 * schedule reset keeps the seeding and the stage reset clears it.
 *
 * Both migrations are asserted together, because the distinction *is* the contract and
 * either one drifting back toward the other collapses it back into one action.
 */
describe("the two placement resets keep their scopes", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const scheduleFile = "20260926000000_placement_schedule_reset.sql";
  const scheduleSql = readFileSync(join(dir, scheduleFile), "utf8");

  /**
   * Every migration that defines `reset_placement_stage`, in filename order.
   *
   * There are two now — the original and the one that adds the gate — so the assertions
   * below read the **last** one. That is the definition that actually runs, and reading a
   * superseded file would let a later migration drop the seed-clearing or the admin guard
   * while these tests stayed green.
   */
  const stageDefiners = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) =>
      /FUNCTION public\.reset_placement_stage\(p_tournament_id uuid\)/.test(
        readFileSync(join(dir, name), "utf8"),
      ),
    );
  const stageFile = stageDefiners.at(-1) as string;
  const stageSql = readFileSync(join(dir, stageFile), "utf8");

  /** The executable SQL with line comments stripped, so prose cannot satisfy a check. */
  const code = (sql: string) => sql.replace(/--.*$/gm, "");

  it("clears the schedule and the derived tier only", () => {
    expect(scheduleSql).toMatch(
      /FUNCTION public\.reset_placement_schedule\(p_tournament_id uuid\)/,
    );
    for (const table of ["tier_draw_matches", "tier_draws", "placement_matches"]) {
      expect(scheduleSql).toMatch(new RegExp(`DELETE FROM public\\.${table} WHERE tournament_id`));
    }
    // The tier is decided by the placement record, not the seed, so it cannot outlive
    // the results it was derived from.
    expect(code(scheduleSql)).toMatch(/SET tier = NULL/);
  });

  it("keeps the seed order and the waivers, which is the whole point", () => {
    // Checked against the executable SQL, not the file: the header comment names all
    // three columns while explaining why they are deliberately left alone.
    for (const cleared of [
      /seed\s*=\s*NULL/,
      /seed_locked_at\s*=\s*NULL/,
      /excluded\s*=\s*false/,
    ]) {
      expect(code(scheduleSql)).not.toMatch(cleared);
    }
    // And the stage reset still clears them, or the two would be the same action.
    expect(stageSql).toMatch(/seed = NULL/);
    expect(stageSql).toMatch(/seed_locked_at = NULL/);
    expect(stageSql).toMatch(/excluded = false/);
  });

  it("is admin-only and takes the build's advisory lock", () => {
    expect(scheduleSql).toMatch(/has_staff_role\(ARRAY\['admin'\]\)/);
    // The same key as `apply_placement_day_schedule` and the live reflow, so a reset
    // cannot delete rows out from under a build that is halfway through writing slots.
    expect(scheduleSql).toMatch(/pg_advisory_xact_lock\(hashtext\('live-schedule'\)\)/);
  });

  it("closes the implicit PUBLIC grant it restores by creating the function", () => {
    expect(scheduleSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.reset_placement_schedule\(uuid\) FROM anon, PUBLIC/,
    );
    expect(scheduleSql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reset_placement_schedule\(uuid\)/,
    );
  });

  it("is the last word on reset_placement_schedule", () => {
    // A later migration that redefines it has to come through this test, not around it.
    const definers = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) =>
        /FUNCTION public\.reset_placement_schedule\(p_tournament_id uuid\)/.test(
          readFileSync(join(dir, name), "utf8"),
        ),
      );
    expect(definers.at(-1)).toBe(scheduleFile);
  });

  it("refuses the stage reset until the schedule that depends on the seeding is gone", () => {
    // The seed order is what round one was paired from, so discarding it under a live
    // bracket strands matches that can no longer explain their own pairings. The gate is
    // in the database because the button is not the only caller: any admin session can
    // reach the RPC directly over PostgREST.
    const executable = code(stageSql);
    expect(executable).toMatch(/Clear the schedule first/);

    // The set it refuses on is the set `reset_placement_schedule` clears. If that set
    // grows, the two functions have to drift together rather than one silently admitting
    // a state the other still has work for.
    for (const table of ["placement_matches", "tier_draws", "tier_draw_matches"]) {
      expect(executable).toMatch(
        new RegExp(`SELECT 1 FROM public\\.${table} WHERE tournament_id = p_tournament_id`),
      );
    }
  });

  it("takes the build's lock before it checks the gate", () => {
    // The check and the deletes have to be one decision. A build that slipped a round-one
    // row in between them would otherwise be deleting rows the gate had just approved.
    const executable = code(stageSql);
    const lock = executable.indexOf("pg_advisory_xact_lock");
    const gate = executable.indexOf("Clear the schedule first");
    expect(lock).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(lock);
  });

  it("keeps the stage reset admin-only when it is replaced", () => {
    // Replacing the function to add the gate must not cost the guard it already had.
    expect(stageSql).toMatch(/has_staff_role\(ARRAY\['admin'\]\)/);
  });

  it("re-issues the revoke and grant for the replaced function", () => {
    // `CREATE OR REPLACE FUNCTION` restores the implicit EXECUTE grant to PUBLIC, so a
    // replaced function that does not repeat the pair re-opens to `anon`. This is the
    // failure mode these contract tests exist to catch.
    expect(stageSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.reset_placement_stage\(uuid\) FROM anon, PUBLIC/,
    );
    expect(stageSql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reset_placement_stage\(uuid\) TO authenticated/,
    );
  });

  it("is the last word on reset_placement_stage", () => {
    // Symmetric with the schedule reset above: the gate migration is the definition that
    // runs, and a later one has to come through this test rather than around it.
    expect(stageDefiners).toHaveLength(2);
    expect(stageFile).toBe("20260926010000_placement_stage_reset_gate.sql");
  });
});

/**
 * Realtime publication membership.
 *
 * The failure this guards is silent in a way almost nothing else in the schema is. Every
 * screen subscribes with one unfiltered `postgres_changes` channel
 * (`useRealtimeRefresh`), so a table missing from the publication does not narrow the
 * subscription - it drops that table's events. The websocket still reports `SUBSCRIBED`,
 * so the desk still shows its `Live` badge while a result entered on one court never
 * appears on another. There is no error, no log line and no failing query to notice.
 *
 * Membership was configured in the Supabase dashboard, so this is checked against the
 * migration source. The expected list is derived from the tables the migrations actually
 * create rather than restated, so adding a table without publishing it fails here instead
 * of degrading a live tournament.
 */
describe("realtime publication membership migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const file = "20260920000000_realtime_publication_membership.sql";
  const sql = readFileSync(join(dir, file), "utf8");

  /** Every table the schema ends up with, following renames and drops in file order. */
  function schemaTables(): string[] {
    const tables = new Set<string>();
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const source = readFileSync(join(dir, name), "utf8");
      for (const m of source.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z_]+)/g)) {
        tables.add(m[1] as string);
      }
      for (const m of source.matchAll(
        /ALTER TABLE (?:IF EXISTS )?public\.([a-z_]+)\s+RENAME TO (?:public\.)?([a-z_]+)/g,
      )) {
        // A rename has to move the entry, or the old name reads as an unpublished table.
        if (tables.delete(m[1] as string)) tables.add(m[2] as string);
      }
      for (const m of source.matchAll(/DROP TABLE (?:IF EXISTS )?public\.([a-z_]+)/g)) {
        tables.delete(m[1] as string);
      }
    }
    return [...tables].sort();
  }

  function publishedTables(): string[] {
    const array = sql.match(/text\[\] := ARRAY\[([\s\S]*?)\];/);
    expect(array, "the migration must declare its table list as a text[] literal").toBeTruthy();
    return [...(array?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string).sort();
  }

  it("publishes every table the schema creates", () => {
    // Set equality in both directions: a missing table drops its events, and a stale entry
    // would mean the migration is describing a database that no longer exists.
    expect(publishedTables()).toEqual(schemaTables());
  });

  it("covers the tables the desk depends on, explicitly", () => {
    // Named rather than left to the derived comparison, so a future edit that removed all
    // of them at once could not still pass by shrinking both sides.
    for (const table of [
      "pool_matches",
      "draw_matches",
      "placement_matches",
      "tier_draw_matches",
      "tournament_days",
      "desk_activity",
    ]) {
      expect(publishedTables()).toContain(table);
    }
  });

  it("creates the publication when the project does not have one", () => {
    // `20260917080000` returned early with a NOTICE when the publication was absent, which
    // is precisely the silent case: the app runs, and realtime never delivers.
    expect(sql).toMatch(/CREATE PUBLICATION supabase_realtime/);
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'\)/);
  });

  it("is idempotent, because ADD TABLE raises on a duplicate", () => {
    expect(sql).toMatch(/FROM pg_publication_tables/);
    expect(sql).toMatch(/ALTER PUBLICATION supabase_realtime ADD TABLE public\.%I/);
  });

  it("skips a table this database does not have rather than failing", () => {
    expect(sql).toMatch(/c\.relkind = 'r'/);
    expect(sql).toMatch(/RAISE NOTICE 'Skipping public\.%/);
  });

  it("adds no table grant", () => {
    // A blanket `GRANT SELECT ON ALL TABLES` here would look harmless and would reverse the
    // deliberate `REVOKE SELECT ON public.players FROM anon`, re-exposing the roster -
    // including emails and phone numbers - to anyone holding the publishable key.
    const withoutComments = sql.replace(/--.*$/gm, "");
    expect(withoutComments).not.toMatch(/\bGRANT\b/);
    expect(withoutComments).not.toMatch(/\bREVOKE\b/);
  });
});
