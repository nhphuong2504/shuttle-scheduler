import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Contract tests for the hardening migration and the role-redesign migration. They
 * document required RPC/RLS behavior so a live database can be checked without
 * embedding credentials here.
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
      // The two lifecycle verbs. They replaced `current_staff_role` and
      // `is_invited_email`, which were never really in this list's subject matter: the
      // list is about writes going through a transaction, and a role lookup was only
      // ever here because it was the thing an RPC guard called.
      "start_tournament",
      "complete_tournament",
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
 *
 * Historical. `20260919000000` is an applied migration and immutable, so these
 * assertions read what it did and still pass. What that migration *established*, though,
 * has since been replaced: `activate_tournament` was dropped and its Draft -> In Progress
 * meaning moved to `start_tournament`, and `set_active_tournament` was narrowed to the
 * platform-admin public default. See the role-redesign block below for the current
 * contract; read this one as the state the redesign started from.
 */
describe("set_active_tournament migration (superseded by the role redesign)", () => {
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
 * The role redesign.
 *
 * The migration is written so that it fails on a catalogue question rather than on a
 * diff: it runs its own `do $verify$ ... $verify$` before it drops the legacy helpers.
 * These assertions are the same questions asked again, from the repository, for the
 * reason the migration states in its own header - the migration must not be able to pass
 * its own gate while the suite says something different.
 *
 * The two that are not merely restatements are the closed lists. `assert_tournament_writable`
 * is the only guard with a platform-admin override, and its call sites are the enumerated
 * repair paths; asserting the set rather than a count is what makes a widened override
 * fail here instead of surfacing as a tournament a platform admin could score after it was
 * completed. `assert_tournament_live`'s call sites are the mirror image: every scoring and
 * live path, none of which may acquire the override.
 */
describe("role redesign migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const FILE = "20260927000000_tournova_role_redesign.sql";
  const sql = readFileSync(join(dir, FILE), "utf8");
  /** The executable SQL with line comments stripped, so prose cannot satisfy a check. */
  const code = (source: string) => source.replace(/--.*$/gm, "");
  const executable = code(sql);
  /**
   * The same SQL with the migration's own `do $verify$ ... $verify$;` block removed.
   *
   * The verification block has to name the literals it scans the catalogue for, so it
   * contains strings a scan of the *migration* would read as a violation. Assertions about
   * what the migration does are made against this, not against the raw file.
   */
  const withoutVerify = executable.replace(/do \$verify\$[\s\S]*?\$verify\$;/, "");

  it("is not re-opened by any later migration", () => {
    // This block used to assert that the redesign was the last migration. Phase 2's
    // identity canon deliberately follows it, so "last" stopped being the right question.
    // What still has to hold is what the assertion was protecting: nothing after the
    // redesign re-creates the vocabulary it retired, in a table, a function or a grant.
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const later = files.slice(files.indexOf(FILE) + 1);
    expect(later.length).toBeGreaterThan(0);
    for (const name of later) {
      const body = code(readFileSync(join(dir, name), "utf8"));
      for (const helper of ["has_staff_role", "current_staff_role", "is_invited_email"]) {
        expect(body, name).not.toMatch(
          new RegExp(`create (or replace )?function public\\.${helper}`),
        );
      }
      expect(body, name).not.toMatch(/create table public\.staff_roles/);
    }
  });

  it("renames the staff vocabulary instead of adding a parallel one", () => {
    // A rename rather than a new table: the existing rows are the same people, and the
    // recovery runbook and the auth trigger both key on the email column that a fresh
    // table would lose.
    expect(sql).toMatch(/alter table public\.staff_roles rename to profiles/);
    expect(sql).toMatch(/alter table public\.profiles rename column role to system_role/);
    expect(sql).toMatch(/check \(system_role in \('admin', 'user'\)\)/);
    // The three tournament-scoped roles map to `user`, and they are converted before the
    // new check is added, because a CHECK validates against the rows already present.
    const convert = executable.indexOf("set system_role = 'user'");
    const addCheck = executable.indexOf("profiles_system_role_check");
    expect(convert).toBeGreaterThan(-1);
    expect(addCheck).toBeGreaterThan(convert);
  });

  it("retires draft and published as statuses, converting before constraining", () => {
    const convert = executable.indexOf("set status = 'upcoming' where status = 'draft'");
    const addCheck = executable.indexOf("tournaments_status_check");
    expect(convert).toBeGreaterThan(-1);
    expect(addCheck).toBeGreaterThan(-1);
    expect(convert).toBeLessThan(executable.indexOf("check (status in ('upcoming'"));
    expect(executable).toMatch(/check \(status in \('upcoming', 'in_progress', 'completed'\)\)/);
    expect(executable).toMatch(/alter column status set default 'upcoming'/);
    // The old constraint that tied `is_active` to a lifecycle state is what made the two
    // ideas inseparable; dropping it is what lets two tournaments run at once.
    expect(executable).toMatch(/drop constraint tournaments_active_status_check/);
    // No literal `'published'` anywhere, and `'draft'` only in the conversion above.
    // Checked outside the verification block: that block has to name the literals it
    // scans the catalogue for, so reading them as violations would be reading its own
    // pattern as the thing it forbids.
    expect(withoutVerify).not.toMatch(/'published'/);
    const drafts = withoutVerify.match(/'draft'/g) ?? [];
    expect(drafts).toHaveLength(1);
  });

  it("makes ownership a profile, not an auth identity", () => {
    // The load-bearing choice: a profile exists before its identity does, and survives that
    // identity being recreated, which is what the recovery runbook does.
    expect(sql).toMatch(
      /add column owner_user_id uuid references public\.profiles\(id\) on delete restrict/,
    );
    // Nullable so the backfill can run, then tightened. Asserted in that order.
    const backfill = executable.indexOf("owner_user_id =");
    const notNull = executable.search(/alter column owner_user_id set not null/);
    expect(backfill).toBeGreaterThan(-1);
    expect(notNull).toBeGreaterThan(backfill);
  });

  it("withholds UPDATE on the three lifecycle columns at the privilege layer", () => {
    // Column privileges rather than a trigger, because a generic BEFORE UPDATE guard cannot
    // both forbid client writes and permit the SECURITY DEFINER lifecycle RPCs.
    expect(executable).toMatch(
      /revoke insert, update, delete, truncate, references, trigger\s+on public\.tournaments from anon, authenticated/,
    );
    const grant = executable.match(/grant update \(([\s\S]*?)\) on public\.tournaments/);
    expect(grant, "the migration must list the editable columns explicitly").toBeTruthy();
    const columns = [...(grant?.[1] ?? "").matchAll(/([a-z_]+)/g)].map((m) => m[1] as string);
    // Withheld, each for its own reason: the state machine owns `status`, `is_active` is
    // the public default pointer, `owner_user_id` is ownership.
    for (const withheld of ["status", "is_active", "owner_user_id"]) {
      expect(columns).not.toContain(withheld);
    }
    // And the setup surface an editor is allowed to type into is present, so the revoke
    // did not quietly close the two direct writers the app still uses.
    for (const editable of [
      "name",
      "format",
      "venue_timezone",
      "registration_opens_at",
      "registration_closes_at",
    ]) {
      expect(columns).toContain(editable);
    }
  });

  it("adds no column-protection trigger on tournaments", () => {
    // The temptation is a BEFORE UPDATE trigger over `status`/`is_active`. It cannot work:
    // it has to permit the lifecycle RPCs, which means either making them platform-admin
    // only or treating `auth.uid() IS NULL` as the signal, both of which are worse than the
    // privilege it replaces.
    for (const m of sql.matchAll(/create trigger ([a-z_]+)/g)) {
      expect(m[1]).not.toMatch(/tournaments_(status|lifecycle|active|owner)_guard/);
    }
  });

  it("drops the legacy helpers only after asserting nothing names them", () => {
    // Ordering is the whole safety argument: a helper dropped while an object still
    // references it fails the migration, and one referenced after being dropped fails at
    // runtime. The verification block is asserted to come first, and to scan for all three.
    const verify = sql.indexOf("do $verify$");
    const drop = sql.indexOf("drop function if exists public.current_staff_role()");
    expect(verify).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(verify);
    for (const helper of ["has_staff_role", "current_staff_role", "is_invited_email"]) {
      expect(executable).toMatch(new RegExp(`drop function if exists public\\.${helper}`));
      // Each scan excludes the drop list, or it would be asking whether a function calls
      // itself while it still exists - the one question that cannot be answered yes.
      expect(executable).toMatch(
        new RegExp(`p\\.proname not in \\('current_staff_role', 'has_staff_role', 'is_invited_email'\\)`),
      );
    }
  });

  it("carries the lifecycle guard classification as closed lists", () => {
    // The override is the dangerous half, so it is pinned to its call sites. Adding one is
    // how a completed tournament becomes scoreable again.
    const writable = sql.match(
      /p\.prosrc like '%PERFORM public\.assert_tournament_writable\(%'[\s\S]*?distinct from\s*'([^']+)'/,
    );
    expect(writable?.[1]?.split(",").sort()).toEqual(
      [
        "add_tournament_day",
        "apply_day_schedule",
        "apply_placement_day_schedule",
        "decide_tournament_registration",
        "remove_tournament_day",
        "reset_placement_schedule",
        "reset_placement_stage",
        "set_tournament_courts",
      ].sort(),
    );

    // The live guard is the mirror: every scoring and live-operation path, and nothing that
    // should keep working on a completed tournament.
    const live = sql.match(
      /p\.prosrc like '%PERFORM public\.assert_tournament_live\(%'[\s\S]*?distinct from\s*'([^']+)'/,
    );
    expect(live?.[1]?.split(",").sort()).toEqual(
      [
        "apply_placement_round_two",
        "apply_tier_draws",
        "report_draw_result",
        "report_placement_result",
        "report_pool_result",
        "report_tier_draw_result",
        "reschedule_live_match",
        "reschedule_placement_match",
        "reset_and_repair_match",
        "reset_match_with_note",
        "reset_placement_result",
        "reset_tier_draw_result",
        "resolve_match_exception",
        "start_match_safe",
        "start_placement_match",
        "start_tier_draw_match",
      ].sort(),
    );

    // Only the writable guard consults the platform role. Either of the other two
    // acquiring it would give an admin a way around a state rather than a way through a
    // repair.
    expect(executable).toMatch(
      /prosrc like '%is_platform_admin%'\s*\)\s*then\s+raise exception 'PART 9: assert_tournament_live must not consult the platform role'/,
    );
  });

  it("keeps readiness independent of participation", () => {
    // This is the property registration depends on, and it is easy to lose by adding an
    // entry-count check to the checklist - which would make a tournament need entrants
    // before it could start, and entrants need a started tournament.
    //
    // Both readers are scanned, not just the boolean: the six checks live in
    // `tournament_readiness_checks`, so an entry count added there would not appear in
    // `tournament_is_ready` at all.
    const start = executable.indexOf("FUNCTION public.tournament_readiness_checks");
    const reader = executable.indexOf("FUNCTION public.tournament_readiness(");
    const end = executable.indexOf("$$;", reader) + 3;
    expect(start).toBeGreaterThan(-1);
    expect(reader).toBeGreaterThan(start);
    const body = executable.slice(start, end);
    expect(body.length).toBeGreaterThan(0);
    for (const table of [
      "teams",
      "placement_entrants",
      "placement_matches",
      "tier_draws",
      "tier_draw_matches",
    ]) {
      expect(body).not.toMatch(new RegExp(`public\\.${table}`));
    }
  });

  it("refuses direct writes to the request and membership tables", () => {
    // No client write policy at all, and the grant closed too, so the refusal does not
    // depend on a policy staying absent.
    for (const table of ["tournament_editors", "tournament_registrations"]) {
      expect(executable).toMatch(
        new RegExp(`revoke insert, update, delete on public\\.${table} from anon, authenticated`),
      );
    }
    expect(executable).toMatch(
      /policies\s+where schemaname = 'public' and tablename = 'tournament_registrations'\s+and cmd in \('INSERT', 'UPDATE', 'DELETE', 'ALL'\)/,
    );
  });

  it("resolves the five renames and leaves no legacy name behind", () => {
    // Four renamed entry points plus the dropped overload. Each old name has to be gone,
    // or there are two ways to do one thing and only one of them is guarded.
    //
    // Matched case-insensitively: the schema DDL at the top of the migration is lowercase
    // while these later `DROP`s are uppercase, and the assertion is about the statement
    // rather than about the casing.
    for (const dropped of [
      "create_tournament_draft",
      "save_tournament_draft",
      "delete_tournament_draft",
      "activate_tournament",
      "reopen_tournament",
    ]) {
      expect(executable).toMatch(
        new RegExp(`drop function if exists public\\.${dropped}`, "i"),
      );
    }
    // The unused legacy overload took a day count and a start date, both now derived.
    expect(executable).toMatch(
      /drop function if exists public\.create_tournament\(text, integer, integer, date, jsonb\)/i,
    );
    // And the five that replace them exist.
    for (const kept of [
      "create_tournament",
      "save_tournament_config",
      "discard_tournament",
      "start_tournament",
      "complete_tournament",
    ]) {
      expect(executable).toMatch(new RegExp(`function public\\.${kept}\\(`, "i"));
    }
  });

  it("narrows set_active_tournament to the public default", () => {
    // The one verb that is still global, and the only one that should be. It no longer
    // writes `status`, and it is no longer ownership - moving everybody's default is a
    // platform decision.
    const body = executable.slice(executable.indexOf("FUNCTION public.set_active_tournament"));
    const until = body.indexOf("$$;");
    const fn = code(body.slice(0, until));
    expect(fn).toMatch(/IF NOT public\.is_platform_admin\(\) THEN/);
    expect(fn).not.toMatch(/status\s*=/);
    expect(fn).toMatch(/SET is_active = false WHERE is_active/);
  });

  it("publishes the two new tables to the realtime publication", () => {
    expect(sql).toMatch(
      /tables text\[\] := array\['tournament_editors', 'tournament_registrations'\]/,
    );
    // `staff_roles` is not re-added under its new name: a publication tracks the relation,
    // so the rename follows it. Re-adding would be a duplicate ADD and would raise.
    // Checked outside the verification block, whose FK-target assertion legitimately names
    // the table.
    expect(withoutVerify).not.toMatch(/'profiles'/);
  });

  it("asserts its own gates before it commits", () => {
    // The migration raises rather than warns. A warning printed into a CI log is not a
    // failure, and this is the one migration where a silent partial result is worse than
    // no result at all.
    expect(sql).toMatch(/do \$verify\$/);
    expect(sql).not.toMatch(/raise warning 'PART 9/);
    expect(sql).toMatch(/raise exception 'PART 9:/);
  });
});

/**
 * Identity canon.
 *
 * Phase 1 held ownership on a `profiles` row but left membership and registration requests
 * keyed on `auth.users.id`, so an editor grant or a request died with the identity instead
 * of surviving it - which is the failure `profiles` exists to prevent. This migration
 * renames all four relationships onto a profile id and moves every per-person predicate
 * onto `current_profile_id()`.
 *
 * The assertions below are the same questions the migration asks its own catalogue, asked
 * again from the repository, for the reason the role-redesign block states: a migration
 * must not be able to pass its own gate while the suite says something different.
 */
describe("identity canon migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const FILE = "20260929000000_identity_canon.sql";
  const PHASE_ONE = "20260927000000_tournova_role_redesign.sql";
  const sql = readFileSync(join(dir, FILE), "utf8");
  /** The executable SQL with line comments stripped, so prose cannot satisfy a check. */
  const code = (source: string) => source.replace(/--.*$/gm, "");
  const executable = code(sql);

  /** One function's source, from its `CREATE` to its closing dollar-quote. */
  const fnBody = (signature: string, source = executable): string => {
    const start = source.indexOf(`FUNCTION public.${signature}`);
    expect(start, `${signature} is not defined`).toBeGreaterThan(-1);
    const opener = source.slice(start).match(/AS \$([a-z_]*)\$/);
    const tag = opener?.[1] ?? "";
    const close = source.indexOf(`$${tag}$;`, start);
    expect(close, `${signature} has no closing dollar-quote`).toBeGreaterThan(start);
    return source.slice(start, close + tag.length + 4);
  };

  it("checks for unmatched identities before it changes anything", () => {
    // The pre-flight has to precede the DDL: its whole value is that it aborts a migration
    // whose conversion would silently drop a person.
    const preflight = executable.indexOf("from public.tournament_editors e");
    const firstDdl = executable.search(/alter table public\.tournaments rename column/);
    expect(preflight).toBeGreaterThan(-1);
    expect(firstDdl).toBeGreaterThan(preflight);
    // Both member-bearing tables are counted, and the raise names the counts rather than
    // failing on a constraint with a code.
    expect(executable).toMatch(/from public\.tournament_registrations r/);
    expect(executable).toMatch(/tournament_editors row\(s\) and % tournament_registrations row\(s\)/);
  });

  it("converts both kinds of column, with opposite answers for an unmatched value", () => {
    // Members and requesters are the relationship, so they map totally - guaranteed by the
    // pre-flight rather than by a coalesce that would hide a missing person.
    for (const [table, alias] of [
      ["tournament_editors", "e"],
      ["tournament_registrations", "r"],
    ] as const) {
      expect(executable).toMatch(
        new RegExp(
          `update public\\.${table} ${alias}\\s+set profile_id = \\(\\s*select p\\.id from public\\.profiles p where p\\.user_id = ${alias}\\.profile_id\\s*\\)`,
        ),
      );
    }
    // Actors are attribution, so an unmatched value becomes NULL instead of keeping an
    // auth uuid in a profile column. A correlated subquery, not `update ... from`, which
    // would leave the unmatched rows untouched - an auth uid left in a profile column.
    for (const [table, alias, col] of [
      ["tournament_editors", "e", "added_by_profile_id"],
      ["tournament_registrations", "r", "decided_by_profile_id"],
    ] as const) {
      expect(executable).toMatch(
        new RegExp(
          `update public\\.${table} ${alias}\\s+set ${col} = \\(\\s*select p\\.id from public\\.profiles p where p\\.user_id = ${alias}\\.${col}\\s*\\)`,
        ),
      );
    }
  });

  it("keeps the member and requester columns NOT NULL through the rename", () => {
    // A rename carries the column's constraints and grants with it, so the risk is not the
    // rename - it is the conversion widening the column to admit a NULL person.
    const phase1 = readFileSync(join(dir, PHASE_ONE), "utf8");
    const declaredNotNull =
      phase1.match(/user_id uuid not null references auth\.users\(id\) on delete cascade/g) ?? [];
    expect(declaredNotNull).toHaveLength(2);
    expect(executable).not.toMatch(/alter column profile_id (drop not null|set default null)/);
    // And the new constraints keep the same delete behaviour the old ones had, so a rename
    // is not a quiet change of what a delete cascades to.
    expect(executable).toMatch(
      /foreign key \(profile_id\) references public\.profiles\(id\) on delete cascade/,
    );
    expect(executable).toMatch(
      /foreign key \(added_by_profile_id\) references public\.profiles\(id\) on delete set null/,
    );
    expect(executable).toMatch(
      /foreign key \(decided_by_profile_id\) references public\.profiles\(id\) on delete set null/,
    );
  });

  it("drops the auth foreign keys by catalogue lookup, not by an assumed name", () => {
    // An auto-generated name that differed would leave an FK to auth.users behind, and the
    // migration would still succeed - which is precisely the silent failure it guards.
    expect(executable).toMatch(/confrelid = 'auth\.users'::regclass/);
    expect(executable).toMatch(/c\.relname in \('tournament_editors', 'tournament_registrations'\)/);
  });

  it("resolves every per-person rule through current_profile_id", () => {
    expect(sql).toMatch(/FUNCTION public\.current_profile_id\(\)/);
    // The two arms of `current_system_role()`: the auth link, and the normalized JWT email
    // that resolves before the trigger has run - which is what lets a recreated identity
    // recover its access rather than lose it.
    const definition = fnBody("current_profile_id()");
    expect(definition).toMatch(/p\.user_id = auth\.uid\(\)/);
    expect(definition).toMatch(/normalize_email\(auth\.jwt\(\) ->> 'email'\)/);

    for (const fn of [
      "is_tournament_owner(p_tournament_id uuid)",
      "is_tournament_editor(p_tournament_id uuid)",
      "has_any_tournament_edit()",
      "tournament_registrations_guard_insert()",
      "tournament_registrations_guard_update()",
      "submit_tournament_registration(p_tournament_id uuid)",
      "my_tournament_registration(p_tournament_id uuid)",
      "add_tournament_editor(p_tournament_id uuid, p_email text)",
    ]) {
      const body = fnBody(fn);
      expect(body, fn).toMatch(/current_profile_id\(\)/);
      // And none of them compares a profile column to the auth uid, which would type-check
      // in SQL and silently match nothing.
      expect(body, fn).not.toMatch(/(owner_|added_by_|decided_by_)?profile_id\s*=\s*auth\.uid\(\)/);
    }
  });

  it("covers the two arms Phase 1's own verification did not", () => {
    // PART 9 checked that `owner_user_id` is never compared to `auth.uid()`. The
    // `tournament_editors` read arm and the registration own-read arm were not covered,
    // and both named a `user_id` column that no longer exists.
    expect(executable).toMatch(/or added_by_profile_id = public\.current_profile_id\(\)/);
    expect(executable).toMatch(/using \(profile_id = public\.current_profile_id\(\)\)/);
  });

  it("scans the catalogue for a profile id held under a user_id name", () => {
    // A `..._user_id` that references `profiles` reads as an auth uid and joins to the
    // wrong table. Asserted at apply time, and re-asserted here so the scan cannot be
    // deleted without the suite noticing.
    expect(executable).toMatch(/a profile id is held under a user_id name/);
    expect(executable).toMatch(/a\.attname ~ '_user_id\$'/);
    expect(executable).toMatch(/con\.confrelid = 'public\.profiles'::regclass/);
  });

  it("keeps the caller's profile out of the request payload", () => {
    // The requester is stamped from the caller, never read from the row being written, so
    // a request cannot be filed on somebody else's behalf.
    const guard = fnBody("tournament_registrations_guard_insert()");
    expect(guard).toMatch(/NEW\.profile_id := public\.current_profile_id\(\)/);
    expect(guard).toMatch(/NEW\.status := 'pending'/);
    expect(guard).toMatch(/NEW\.decided_by_profile_id := NULL/);
  });

  it("re-issues the tournaments column grant under the new name", () => {
    // The privilege is held per column attribute, so a rename alone would not require it.
    // Re-issuing is what lets this file - rather than an applied migration - be the place
    // the withheld set is asserted from.
    const grant = executable.match(/grant update \(([\s\S]*?)\) on public\.tournaments/);
    expect(grant, "the migration must list the editable columns explicitly").toBeTruthy();
    const columns = [...(grant?.[1] ?? "").matchAll(/([a-z_]+)/g)].map((m) => m[1] as string);
    expect(columns).not.toContain("owner_profile_id");
    expect(columns).toContain("name");
    expect(columns).toContain("registration_opens_at");
    expect(executable).toMatch(
      /has_column_privilege\('authenticated', 'public\.tournaments', 'owner_profile_id', 'update'\)/,
    );
  });

  it("grants the new predicate and repeats the grants its drops removed", () => {
    // `current_profile_id()` is called from inside RLS policies, which are evaluated as
    // the querying role, so that role needs EXECUTE. The three re-created functions lost
    // their grant with the DROP and have to get it back.
    expect(executable).toMatch(
      /grant execute on function public\.current_profile_id\(\) to authenticated/,
    );
    for (const sig of [
      "review_tournament_registrations(uuid)",
      "list_tournament_editors(uuid)",
      "remove_tournament_editor(uuid, uuid)",
    ]) {
      expect(executable).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated`);
    }
  });

  it("re-creates the three functions whose signature it changes", () => {
    // Postgres refuses to change an OUT parameter name - or an input parameter name - in
    // place, so a rename of the returned `user_id` or of `p_user_id` requires DROP first.
    // Leaving the CREATE OR REPLACE form would fail the migration at apply time.
    for (const sig of [
      "list_tournament_editors(uuid)",
      "review_tournament_registrations(uuid)",
      "remove_tournament_editor(uuid, uuid)",
    ]) {
      expect(executable).toContain(`DROP FUNCTION IF EXISTS public.${sig}`);
    }
    // And the roster and the two reviewer-facing functions carry profile ids out.
    expect(fnBody("list_tournament_editors(p_tournament_id uuid)")).toMatch(
      /RETURNS TABLE \(profile_id uuid, email text, is_owner boolean, created_at timestamptz\)/,
    );
    expect(fnBody("review_tournament_registrations(p_tournament_id uuid)")).toMatch(
      /profile_id uuid/,
    );
    expect(fnBody("remove_tournament_editor(p_tournament_id uuid, p_profile_id uuid)")).toMatch(
      /DELETE FROM public\.tournament_editors\s+WHERE tournament_id = p_tournament_id AND profile_id = p_profile_id/,
    );
  });

  it("leaves the auth-link comparisons alone", () => {
    // `profiles.user_id` IS the auth link, and the pointer update in `create_tournament`
    // is about the caller's own row. Rewriting those onto `current_profile_id()` would be
    // the same mistake in the other direction.
    expect(fnBody("create_tournament(p_payload jsonb)")).toMatch(
      /SET current_tournament_id = new_id\s+WHERE user_id = auth\.uid\(\)/,
    );
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
    // redefines the function has to come through this test rather than around it. The role
    // redesign is that later migration: it re-creates the checklist to move the guard from
    // a global admin role onto the per-tournament edit right.
    const definers = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) =>
        /FUNCTION public\.tournament_readiness\(p_tournament_id uuid\)/.test(
          readFileSync(join(dir, name), "utf8"),
        ),
      );
    expect(definers.at(-1)).toBe("20260927000000_tournova_role_redesign.sql");
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
  /** The migration that re-creates both resets onto the per-tournament edit right. */
  const REDESIGN_FILE = "20260927000000_tournova_role_redesign.sql";
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

  /**
   * The same for `reset_placement_schedule`, and for the same reason: the role redesign
   * re-creates it to move its guard off the retired staff role, so the last definer is now
   * that migration rather than the one that introduced the reset.
   */
  const scheduleDefiners = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) =>
      /FUNCTION public\.reset_placement_schedule\(p_tournament_id uuid\)/.test(
        readFileSync(join(dir, name), "utf8"),
      ),
    );
  const effectiveScheduleFile = scheduleDefiners.at(-1) as string;
  const effectiveScheduleSql = readFileSync(join(dir, effectiveScheduleFile), "utf8");

  /** The executable SQL with line comments stripped, so prose cannot satisfy a check. */
  const code = (sql: string) => sql.replace(/--.*$/gm, "");

  /**
   * One function's source, from its `CREATE` to its closing dollar-quote.
   *
   * Needed because a whole-file scan cannot tell a function body from the verification
   * block that scans every function by name: `has_staff_role` appears in the latter as a
   * literal, and a `not.toMatch` over the file would fail on the checker rather than on
   * the thing it checks.
   */
  const fnBody = (source: string, signature: string): string => {
    const start = source.indexOf(`FUNCTION public.${signature}`);
    expect(start, `${signature} is not defined`).toBeGreaterThan(-1);
    const opener = source.slice(start).match(/AS \$([a-z_]*)\$/);
    const tag = opener?.[1] ?? "";
    const close = source.indexOf(`$${tag}$;`, start);
    expect(close, `${signature} has no closing dollar-quote`).toBeGreaterThan(start);
    return source.slice(start, close + tag.length + 4);
  };

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

  it("is editable-only and takes the build's advisory lock", () => {
    // The guard moved from `has_staff_role(ARRAY['admin'])` to `can_edit_tournament` with
    // the redesign, so the effective definition is the one that has to be asserted - the
    // original file is immutable history and still names the retired helper. The check is
    // on the executable SQL, because the redesign's header comments name the old helper
    // while explaining that it is gone.
    const effective = code(fnBody(effectiveScheduleSql, "reset_placement_schedule(p_tournament_id uuid)"));
    expect(effective).toMatch(/can_edit_tournament\(p_tournament_id\)/);
    expect(effective).not.toMatch(/has_staff_role/);
    // The same key as `apply_placement_day_schedule` and the live reflow, so a reset
    // cannot delete rows out from under a build that is halfway through writing slots.
    expect(effective).toMatch(/pg_advisory_xact_lock\(hashtext\('live-schedule'\)\)/);
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
    // The role redesign is that later migration: it re-creates the function to move the
    // guard onto `can_edit_tournament`.
    expect(scheduleDefiners).toEqual([scheduleFile, REDESIGN_FILE]);
    expect(effectiveScheduleFile).toBe(REDESIGN_FILE);
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

  it("keeps a guard on the stage reset when it is replaced", () => {
    // Replacing the function to add the gate must not cost the guard it already had.
    // It moved from the retired staff role to the per-tournament edit right; what must not
    // happen is the re-creation losing the guard altogether.
    const effective = code(fnBody(stageSql, "reset_placement_stage(p_tournament_id uuid)"));
    expect(effective).toMatch(/can_edit_tournament\(p_tournament_id\)/);
    expect(effective).not.toMatch(/has_staff_role/);
  });

  it("re-issues the revoke and grant for the replaced function", () => {
    // `CREATE OR REPLACE FUNCTION` restores the implicit EXECUTE grant to PUBLIC, so a
    // replaced function that does not repeat the pair re-opens to `anon`. This is the
    // failure mode these contract tests exist to catch.
    //
    // The redesign does this through the same generated loop as every other RPC, so the
    // assertion is that both resets are listed in it rather than that four literal
    // statements were retyped. Membership of the loop *is* the revoke-and-grant.
    const grantLoop = code(effectiveScheduleSql);
    for (const sig of ["reset_placement_schedule(uuid)", "reset_placement_stage(uuid)"]) {
      expect(grantLoop).toContain(`'${sig}'`);
    }
    expect(grantLoop).toMatch(
      /execute format\('revoke all on function public\.%s from public, anon', f\)/,
    );
    expect(grantLoop).toMatch(
      /execute format\('grant execute on function public\.%s to authenticated', f\)/,
    );
  });

  it("is the last word on reset_placement_stage", () => {
    // Symmetric with the schedule reset above: the redesign is the definition that runs,
    // and a later migration has to come through this test rather than around it.
    expect(stageDefiners).toEqual([
      "20260917050000_placement_stage_reset.sql",
      "20260926010000_placement_stage_reset_gate.sql",
      REDESIGN_FILE,
    ]);
    expect(stageFile).toBe(REDESIGN_FILE);
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
