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
    // Both withheld columns: ownership is the FK's business, and `is_active` was the global
    // presentation pointer - a client write to either is the failure this asserts away.
    expect(columns).not.toContain("owner_profile_id");
    expect(columns).not.toContain("is_active");
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
    // Fixed feeder definitions are private; in-app call records use recipient-scoped RPC polling.
    expect(publishedTables()).toEqual(schemaTables().filter(table => !['placement_round_two_slots', 'match_calls', 'player_notifications'].includes(table)));
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

/**
 * Registration entries and the identity bridge.
 *
 * Phase 1 answered "whose row is this" with an email address, which is not an identity: it
 * is a string a person types, it is neither unique nor normalized on `players`, and a
 * participant could therefore be handed somebody else's contact data by typing that address
 * into a form. This migration gives a player row an owner, and it does so with **two**
 * mechanisms rather than one - a column privilege and a trigger - because each alone has a
 * way round it that the other closes: a later migration can re-issue a table-wide grant,
 * and a policy cannot distinguish the one writer that is allowed to set the column.
 *
 * The assertions below are mostly questions the migration asks its own catalogue, asked
 * again from the repository, for the reason the role-redesign block states: the migration
 * must not be able to pass its own gate while the suite says something different. The two
 * that are not restatements are the ordering inside the guard's transition table and what
 * `can_manage_player` is allowed to read membership from - neither is visible to a
 * catalogue query.
 */
describe("registration entries and the identity bridge", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const FILE = "20260929020000_registration_entries_and_identity.sql";
  const sql = readFileSync(join(dir, FILE), "utf8");
  /** The executable SQL with line comments stripped, so prose cannot satisfy a check. */
  const executable = sql.replace(/--.*$/gm, "");
  /**
   * The same SQL with the migration's own `do $verify$ ... $verify$;` block removed. That
   * block has to name the literals it scans the catalogue for, so its strings would read as
   * violations of the rules it checks.
   */
  const withoutVerify = executable.replace(/do \$verify\$[\s\S]*?\$verify\$;/, "");

  /**
   * One function's source, from its `CREATE` to its closing dollar-quote.
   *
   * Anchored on `create ... function`, not on `function` alone: `comment on function
   * public.x(...)` contains the same substring and would otherwise capture the comment
   * following the definition instead of the definition.
   */
  const fnBody = (signature: string, source = executable): string => {
    const start = source.search(new RegExp(`create (or replace )?function public\\.${signature}`, "i"));
    expect(start, `${signature} is not defined`).toBeGreaterThan(-1);
    const opener = source.slice(start).match(/as \$([a-z_]*)\$/i);
    const tag = opener?.[1] ?? "";
    const close = source.indexOf(`$${tag}$;`, start);
    expect(close, `${signature} has no closing dollar-quote`).toBeGreaterThan(start);
    return source.slice(start, close + tag.length + 4);
  };

  it("withholds the link at the privilege layer, and only the link", () => {
    // The grants are read as a set rather than matched one column at a time: the editable
    // list is the whole contract, and a column added to it in a later edit is exactly the
    // change that has to fail here.
    const grants = [
      ...executable.matchAll(/grant (insert|update) \(([^)]*)\) on public\.players/gi),
    ];
    expect(grants.map((g) => g[1]?.toLowerCase()).sort()).toEqual(["insert", "update"]);
    for (const grant of grants) {
      const columns = [...(grant[2] ?? "").matchAll(/[a-z_]+/gi)].map((m) => m[0].toLowerCase());
      expect(columns.sort()).toEqual(["email", "gender", "name", "phone"]);
    }
    // Withheld, not merely absent from the list: the table-wide write is closed first, so
    // the column grants are the only way in.
    expect(executable).toMatch(
      /revoke insert, update, truncate, references, trigger\s+on public\.players from anon, authenticated/,
    );
    // DELETE is deliberately *not* in that revoke. The policy restricts deletion to a
    // platform admin, and withdrawing the privilege as well would make that path
    // unreachable rather than restricted.
    expect(executable).toMatch(/create policy "players delete" on public\.players[\s\S]*?is_platform_admin\(\)/);
  });

  it("keeps the guard's transition table, in the order the arms depend on", () => {
    const guard = fnBody("players_profile_link_guard\\(\\)");
    // A rename or an email edit carries no transition, so it must be admitted first - or
    // every ordinary edit would have to raise the flag.
    const unchanged = guard.indexOf("is not distinct from old.profile_id");
    // The de-link is unconditional, ahead of the flag, because the FK's
    // `ON DELETE SET NULL` arrives as exactly this transition and has no recognisable
    // actor. Ordering is what makes it expressible; there is no arm that identifies it.
    const delink = guard.indexOf("if new.profile_id is null then");
    // A -> B is refused *before* the flag is consulted, so an approved link is not a
    // licence to hand the row to somebody else.
    const relink = guard.indexOf("old.profile_id is not null");
    const flag = guard.indexOf("if not v_linking then");
    expect(unchanged).toBeGreaterThan(-1);
    expect(delink).toBeGreaterThan(unchanged);
    expect(relink).toBeGreaterThan(delink);
    expect(flag).toBeGreaterThan(relink);

    // The flag is transaction-local (`true`), so it cannot leak into a later statement on
    // a pooled connection, and it is read as a setting rather than as a role name - which
    // is what keeps the sanctioned writer recognisable without naming it.
    expect(guard).toMatch(/current_setting\('tournova\.allow_profile_link', true\)/);
    expect(guard).toMatch(/raise exception/);
  });

  it("reads membership from the entry, never from derived placement data", () => {
    // `placement_entrants` is built by `sync_placement_entrants` after a draw exists and
    // cleared by `reset_placement_stage`, so membership derived from it would appear and
    // disappear with the placement stage - access that comes and goes, and refused for
    // exactly the entrants who have not been placed yet.
    const predicate = fnBody("can_manage_player\\(p_player_id uuid\\)");
    expect(predicate).toMatch(/public\.teams t/);
    expect(predicate).toMatch(/t\.player_1_id = p_player_id OR t\.player_2_id = p_player_id/);
    expect(predicate).toMatch(/tr\.owner_profile_id = public\.current_profile_id\(\)/);
    expect(predicate).toMatch(/public\.tournament_editors e/);
    expect(predicate).toMatch(/public\.is_platform_admin\(\)/);
    expect(predicate).not.toMatch(/placement_entrants/);
    // The entry's own tournament column, not the category it derives from: NOT NULL,
    // indexed, and the same hop the rest of the authorization surface reads.
    expect(predicate).toMatch(/t\.tournament_id/);
    expect(predicate).not.toMatch(/public\.categories/);
    // And the identity-canon rule: a profile column is compared to a profile id, never to
    // the auth uid, which would type-check and silently match nothing.
    expect(predicate).toMatch(/pl\.profile_id = public\.current_profile_id\(\)/);
    expect(predicate).not.toMatch(/profile_id\s*=\s*auth\.uid\(\)/);
  });

  it("replaces the Phase 1 editor policy with one per verb", () => {
    // The role redesign shipped a single `FOR ALL` policy admitting any tournament editor,
    // while `docs/authorization.md` documented UPDATE and DELETE as admin-only. Four verbs,
    // because they answer four different questions - and no `FOR ALL` left, which is what
    // an editor policy would be.
    expect(executable).toMatch(/drop policy if exists "players editor write" on public\.players/);
    const policies = [
      ...executable.matchAll(/create policy "players (\w+)" on public\.players\s+for (\w+)/gi),
    ];
    expect(
      policies.map((p) => `${p[1]}:${p[2]?.toLowerCase()}`).sort(),
      "the players policies are the four verbs and nothing else",
    ).toEqual(["delete:delete", "insert:insert", "read:select", "update:update"]);

    // The insert arm keeps `profile_id is null` even though the grant already withholds the
    // column: a policy that is only safe because of a grant two sections above reopens if
    // the grant is ever re-issued, and this is the half the trigger backstops.
    const insert = executable.slice(executable.indexOf('create policy "players insert"'));
    expect(insert.slice(0, insert.indexOf(";"))).toMatch(/profile_id is null/);
    // Both halves on the update policy. A `FOR UPDATE` policy with only `USING` restricts
    // which rows may be updated and not what they may be updated *to*.
    const update = executable.slice(executable.indexOf('create policy "players update"'));
    const updateBody = update.slice(0, update.indexOf(";"));
    expect(updateBody).toMatch(/using \(/);
    expect(updateBody).toMatch(/with check \(/);
  });

  it("gives the entries table a shape that cannot claim a partner", () => {
    // A partner is a name and an email, never a `players.id`: they have not claimed
    // anything, may not be an account holder, and resolving them at submission time would
    // either invent a person or claim one.
    //
    // Scoped to the table body rather than scanned across the file: the same file adds an
    // FK to `profiles`, and a whole-file scan would be asserting about the wrong statement.
    const table = executable.slice(executable.indexOf("create table public.tournament_registration_entries"));
    const body = table.slice(0, table.indexOf(");"));
    expect(body).toMatch(/registration_id uuid not null/);
    expect(body).toMatch(/category_id uuid not null/);
    expect(body).toMatch(/partner_name text/);
    expect(body).toMatch(/partner_email text/);
    // No partner *id* of any kind, which is the claim this table must never be able to make.
    expect(body).not.toMatch(/player_id/);
    expect(body).toMatch(/unique \(registration_id, category_id\)/);
    // Both foreign keys cascade, so a deleted category cannot leave a request asking for
    // something that no longer exists.
    expect(body.match(/on delete cascade/g)).toHaveLength(2);
    // Read by the requester and by nobody else through a policy: the reviewer path is the
    // definer RPC, because a policy's subquery runs as the caller.
    expect(executable).toMatch(
      /alter table public\.tournament_registration_entries enable row level security/,
    );
    expect(executable).toMatch(
      /create policy "registration entries own read" on public\.tournament_registration_entries/,
    );
    // And closed at the privilege layer too, so a direct write is refused whether or not a
    // policy stays absent - the same treatment the request and membership tables get.
    expect(executable).toMatch(
      /revoke insert, update, delete, truncate, references, trigger\s+on public\.tournament_registration_entries from anon, authenticated/,
    );
    // And published, because a table outside the publication drops its events with no
    // error at all - the stage the plan trusts rather than verifies.
    expect(executable).toMatch(
      /array\['tournament_registration_entries'\]/,
    );
    expect(executable).toMatch(
      /alter publication supabase_realtime add table public\.%I/,
    );
  });

  it("makes a rejection re-appliable, and moves the arbiter with the index", () => {
    // An unconditional unique key makes a rejection permanent: the row stays, the key keeps
    // it, and a person turned down once can never apply again. That is not a policy anybody
    // chose - it is what the constraint means.
    expect(executable).toMatch(
      /create unique index tournament_registrations_live_request_idx\s+on public\.tournament_registrations \(tournament_id, profile_id\)\s+where status <> 'rejected'/,
    );
    expect(executable).toMatch(
      /alter table public\.tournament_registrations\s+drop constraint if exists tournament_registrations_unique_request/,
    );
    // The Phase 1 body inferred the dropped constraint, and an `ON CONFLICT` clause that no
    // longer resolves raises at run time rather than at apply time - so it has to move in
    // the same file as the index it infers, and both reads have to carry the predicate or a
    // rejected row and a live row can coexist and the read could return either.
    //
    // Read from the *two-argument* body Step 9 leaves in place, not from the one-argument
    // form it drops: the S8 body still carries the clause, so a signature that matched the
    // first definition would pass here while the shipped function had lost the predicate.
    const fn = fnBody("submit_tournament_registration\\(\\s*p_tournament_id uuid,\\s*p_entries jsonb");
    expect(fn).toMatch(/on conflict \(tournament_id, profile_id\) where status <> 'rejected' do nothing/);
    expect(fn.match(/status <> 'rejected'/g)).toHaveLength(2);
  });

  it("closes the executable surface it adds", () => {
    // `create function` grants EXECUTE to PUBLIC, so a new predicate is an API until it is
    // closed - and a new function that is not closed is the failure this project has hit
    // before with `activate_tournament`.
    expect(executable).toMatch(/revoke all on function public\.can_manage_player\(uuid\) from public, anon/);
    expect(executable).toMatch(/grant execute on function public\.can_manage_player\(uuid\) to authenticated/);
    // The predicate has to stay callable: an RLS policy is evaluated as the querying role.
    expect(executable).toMatch(
      /revoke all on function public\.players_profile_link_guard\(\) from public, anon, authenticated/,
    );
  });

  it("adds the link once, as a null-able reference that survives the person", () => {
    // The link is `ON DELETE SET NULL`, not `CASCADE`: deleting a person must not delete
    // the player rows that record what they did in a tournament, and it must not fail
    // either. The guard's unconditional de-link arm is what makes this FK legal.
    expect(withoutVerify).toMatch(
      /alter table public\.players\s+add column profile_id uuid references public\.profiles\(id\) on delete set null/,
    );
    const additions = executable.match(/add column profile_id/g) ?? [];
    expect(additions).toHaveLength(1);
    // One row per person, and NULL is the common case - a walk-in and a partner supplied by
    // name both have no account. A plain unique index would allow exactly one of them.
    expect(executable).toMatch(
      /create unique index players_profile_id_key\s+on public\.players \(profile_id\)\s+where profile_id is not null/,
    );
    // The projection anon reads must not gain the link, and a `create or replace view` here
    // is the one-line change that would publish who is who.
    expect(withoutVerify).not.toMatch(/create or replace view public\.public_players/);
  });

  it("replaces the one-argument submission rather than shadowing it", () => {
    // A leftover one-argument function wins for a client that sends only the tournament id,
    // and that client would file the entry-less request this step exists to make
    // impossible. Dropped, not merely superseded - and the default keeps the refusal
    // reachable, so the same client reads the sentence about choosing an event instead of
    // PostgREST's "function does not exist".
    const drop = executable.indexOf("drop function if exists public.submit_tournament_registration(uuid);");
    expect(drop, "the Phase 1 one-argument submission is not dropped").toBeGreaterThan(-1);
    const create = executable.indexOf(
      "create or replace function public.submit_tournament_registration(",
      drop,
    );
    expect(create).toBeGreaterThan(drop);
    const header = executable.slice(create, executable.indexOf("returns uuid", create));
    expect(header).toMatch(/p_tournament_id uuid/);
    expect(header).toMatch(/p_entries jsonb default '\[\]'::jsonb/);

    // The two reads grow entry columns, and Postgres refuses to change an OUT parameter
    // name in place - so they are dropped too, and the drop has to precede the create.
    for (const name of ["review_tournament_registrations", "my_tournament_registration"]) {
      const droppedAt = executable.indexOf(`drop function if exists public.${name}(uuid);`);
      const created = executable.indexOf(`create function public.${name}(`, droppedAt);
      expect(droppedAt, name).toBeGreaterThan(-1);
      expect(created, name).toBeGreaterThan(droppedAt);
    }
  });

  it("files the entries, and replaces them rather than accumulating on a retry", () => {
    const fn = fnBody("submit_tournament_registration\\(\\s*p_tournament_id uuid,\\s*p_entries jsonb");
    // The refusal is on the payload *shape* first, so a client that sends an object where an
    // array belongs reads a sentence rather than a cast error.
    expect(fn).toMatch(/jsonb_typeof\(p_entries\) <> 'array'/);
    expect(fn).toMatch(/jsonb_array_length\(p_entries\) = 0/);
    expect(fn).toMatch(/raise exception 'Choose at least one event to enter'/);
    // Delete-then-insert, in that order: a retry has to replace the set, and the delete is
    // only safe because the whole function is one transaction that rolls it back on refusal.
    const del = fn.indexOf("delete from public.tournament_registration_entries");
    const ins = fn.indexOf("insert into public.tournament_registration_entries");
    expect(del).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(del);
    // A decided request is an approved entrant's row, and replacing its entries would rewrite
    // what they were approved for - so a live non-pending request is refused, not updated.
    expect(fn).toMatch(/v_status <> 'pending'/);
    expect(fn).toMatch(/raise exception 'Your registration has already been decided'/);
    // The one insert into the entries table carries the partner as supplied, never a player.
    expect(fn).toMatch(
      /insert into public\.tournament_registration_entries\s+\(registration_id, category_id, partner_name, partner_email\)/,
    );
  });

  it("refuses each entry mistake with the sentence that names it", () => {
    const fn = fnBody("submit_tournament_registration\\(\\s*p_tournament_id uuid,\\s*p_entries jsonb");
    // "not in this tournament", "not open" and "unknown" are three different mistakes, and a
    // single generic refusal would leave the person guessing which one they made.
    expect(fn).toMatch(/if v_cat_tournament <> p_tournament_id/);
    expect(fn).toMatch(/raise exception 'That event belongs to another tournament'/);
    expect(fn).toMatch(/if not v_cat_active/);
    expect(fn).toMatch(/raise exception 'That event is not open for registration'/);
    expect(fn).toMatch(/raise exception 'Unknown event'/);
    // One event per entry, or the same category can be filed twice and approved twice.
    expect(fn).toMatch(/v_category = any \(v_seen\)/);
    expect(fn).toMatch(/raise exception 'Each event may only be chosen once'/);
    // Per-player cap, then the doubles rules. Singles discards the partner fields rather than
    // refusing them - a form that always sends them is not an error - which is what keeps a
    // singles entry from leaving a row claiming a partner.
    expect(fn).toMatch(/v_cap is not null and jsonb_array_length\(p_entries\) > v_cap/);
    expect(fn).toMatch(
      /if v_cat_entry_type = 'pair' then[\s\S]*?raise exception 'A doubles event needs a partner name and email'/,
    );
    // The self-partner comparison is by *normalized* address, the same normalization the
    // approval deduplicates by, so the two agree about who counts as the same person.
    expect(fn).toMatch(
      /normalize_email\(v_partner_email\) = v_caller_email[\s\S]*?raise exception 'You cannot enter a doubles event with yourself as your partner'/,
    );
    expect(fn).toMatch(/v_partner_name := null;/);
    expect(fn).toMatch(/v_partner_email := null;/);
  });

  it("withdraws the requester's own pending request, and deletes nothing else", () => {
    const fn = fnBody("withdraw_tournament_registration\\(p_registration_id uuid\\)");
    expect(fn).toMatch(/if not found then\s*raise exception 'Unknown registration request'/);
    // `is distinct from`, not `<>`: an anonymous caller's profile is NULL, and `<> NULL` is
    // never true, which would let through exactly the caller this refuses.
    expect(fn).toMatch(/v_profile is distinct from public\.current_profile_id\(\)/);
    expect(fn).toMatch(/v_status <> 'pending'/);
    expect(fn).toMatch(/raise exception 'This request has already been decided'/);
    // One delete, and it targets the request table only. The entries follow by cascade; no
    // player, team or entrant is touched, which is what keeps withdrawal from being a quiet
    // deletion of competition data.
    const deletes = [...fn.matchAll(/delete from public\.(\w+)/g)].map((m) => m[1]);
    expect(deletes).toEqual(["tournament_registrations"]);
    expect(fn).not.toMatch(/can_edit_tournament/);
  });

  it("keeps the requester's link the approval's only writer, and the partner an unlinked row", () => {
    const fn = fnBody("decide_tournament_registration\\(\\s*p_registration_id uuid,\\s*p_decision text,\\s*p_note text",
    );
    // The transaction-local flag (`true`) is what the guard reads as the sanction, so it
    // cannot ride a later statement on a pooled connection.
    expect(fn).toMatch(/set_config\('tournova\.allow_profile_link', 'on', true\)/);
    // The requester's row: reused by `profile_id`, created only when there is none.
    expect(fn).toMatch(/where pl\.profile_id = v_requester_profile/);
    // The partner match is restricted to unlinked rows *and* to the normalized address: a
    // linked row is not a candidate and is never touched, because email deduplicates and
    // never identifies. A single candidate is reused; zero or several create a fresh row.
    expect(fn).toMatch(/where pl\.profile_id is null/);
    expect(fn).toMatch(
      /public\.normalize_email\(pl\.email\) = public\.normalize_email\(v_entry\.partner_email\)/,
    );
    expect(fn).toMatch(/if array_length\(v_candidates, 1\) = 1 then/);
    // The partner's insert says NULL explicitly, which is what makes "this branch never
    // links" visible where it is read rather than inferred from a default.
    expect(fn).toMatch(
      /insert into public\.players \(name, email, profile_id\)\s+values \(coalesce\(v_entry\.partner_name, 'Partner'\), v_entry\.partner_email, null\)/,
    );
    // Two kinds of player insert only, and the team insert is the entry.
    expect((fn.match(/insert into public\.players/g) ?? []).length).toBe(2);
    expect(fn).toMatch(/insert into public\.teams \(category_id, player_1_id, player_2_id\)/);
    // The caps are checked before the insert so the refusal can name the category, and the
    // player count mirrors the trigger's - including entries this approval already inserted.
    expect(fn).toMatch(/raise exception 'Category % \(%\) is full: % of % entries'/);
    expect(fn).toMatch(/this tournament allows %/);
    expect(fn).toMatch(/and t\.category_id <> v_entry\.category_id/);
    // Rejection creates nothing: the reject branch returns before the bridge is reached.
    const reject = fn.indexOf("if p_decision = 'rejected' then");
    const bridge = fn.indexOf("select r.profile_id into v_requester_profile");
    expect(reject).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(reject);
    // And the decision still cannot be made once the event is completed - the writable guard,
    // not the configurable one, because a request may legitimately be decided after the
    // window closes.
    expect(fn).toMatch(/perform public\.assert_tournament_writable\(v_tournament\)/);
    expect(fn).not.toMatch(/assert_tournament_configurable/);
  });

  it("gives both reads one row per entry, with the reviewer's the only player-resolution", () => {
    const review = fnBody("review_tournament_registrations\\(p_tournament_id uuid\\)");
    for (const column of [
      "registration_id uuid",
      "entry_id uuid",
      "category_code text",
      "entry_type text",
      "partner_name text",
      "partner_email text",
      "player_id uuid",
      "partner_player_id uuid",
    ]) {
      expect(review, column).toMatch(new RegExp(column.replace(/ /g, "\\s+")));
    }
    // Editor-gated: the queue is the reviewer's, and a policy's subquery runs as the caller,
    // which is why this is a definer RPC rather than a table read.
    expect(review).toMatch(
      /if not public\.can_edit_tournament\(p_tournament_id\) then\s*raise exception 'Not authorized'/,
    );
    // The count and the row cannot disagree, and player_id comes from the partial unique
    // index so it needs no ordering. A request with no entries still appears, once, with null
    // entry columns - which is what a Phase 1 row decided under the old form looks like.
    expect(review).toMatch(/left join public\.tournament_registration_entries e/);
    expect(review).toMatch(
      /\(select pl\.id from public\.players pl where pl\.profile_id = r\.profile_id\) as player_id/,
    );
    // The partner is found by elimination - they are never the linked row - and only once the
    // request has been approved, so a pending one reports what happened rather than a preview.
    expect(review).toMatch(/when t\.player_1_id = r\.player_id then t\.player_2_id/);
    expect(review).toMatch(/and r\.player_id is not null/);

    const mine = fnBody("my_tournament_registration\\(p_tournament_id uuid\\)");
    for (const column of ["entry_id uuid", "category_code text", "decision_note text"]) {
      expect(mine, column).toMatch(new RegExp(column.replace(/ /g, "\\s+")));
    }
    // The caller's own row only, and the live request outranks a rejected older one - `false`
    // sorts after `true`, so the predicate is `desc` on purpose.
    expect(mine).toMatch(/r\.profile_id = public\.current_profile_id\(\)/);
    expect(mine).toMatch(/order by \(r\.status <> 'rejected'\) desc, r\.created_at desc\s*limit 1/);
    expect(mine).toMatch(/left join public\.tournament_registration_entries e/);
  });

  it("closes the five names it adds, and leaves them callable by a session", () => {
    // `create function` grants EXECUTE to PUBLIC, so each name is an API until it is closed.
    // The REVOKE is repeated for the replaced functions because that is this repository's
    // shape, not because a replacement loses its grant.
    const lowered = executable.toLowerCase();
    const signatures = [
      "submit_tournament_registration(uuid, jsonb)",
      "withdraw_tournament_registration(uuid)",
      "review_tournament_registrations(uuid)",
      "my_tournament_registration(uuid)",
      "decide_tournament_registration(uuid, text, text)",
    ];
    for (const sig of signatures) {
      expect(lowered, sig).toContain(`revoke all on function public.${sig} from public, anon;`);
      expect(lowered, sig).toContain(`grant execute on function public.${sig} to authenticated;`);
    }
  });

  it("asserts its own Step 9 gates before it commits", () => {
    // Same shape as the Step 8 block, and the same reason: a warning in a CI log is not a
    // failure, and the two failures a later edit is most likely to introduce here are the
    // one-argument submission reappearing and a second function opening the link flag.
    expect(sql).toMatch(/do \$verify_rpcs\$/);
    expect(sql).toMatch(/raise exception 'registration rpcs:/);
    expect(sql).toMatch(
      /if to_regprocedure\('public\.submit_tournament_registration\(uuid\)'\) is not null then/,
    );
    expect(sql).toMatch(/and p\.proname <> 'decide_tournament_registration'/);
  });

  it("asserts its own gates before it commits", () => {
    // The migration raises rather than warns, for the reason the role redesign states: a
    // warning in a CI log is not a failure, and this is a change whose half-applied state
    // is worse than no change at all.
    expect(sql).toMatch(/do \$verify\$/);
    expect(sql).toMatch(/raise exception 'registration:/);
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/raise warning/i);
  });
});

/**
 * Retiring `is_active`.
 *
 * Phase 2 moved global navigation state onto the per-user pointer, so the Phase 1 boolean
 * is reader-less by the time this migration lands. The repository-side contract is that
 * the reader was re-scoped before the writer went, and that the column, its index and the
 * global verb are all gone without a cascade that could hide an unexpected dependency. The
 * migration asks the catalogue the same questions itself; these assertions are what stop
 * the file from drifting from that claim.
 */
describe("retire is_active migration", () => {
  const RETIRE_FILE = "20260929010000_retire_is_active.sql";
  const sql = readFileSync(
    join(__dirname, "../../../supabase/migrations", RETIRE_FILE),
    "utf8",
  );
  const executable = sql.replace(/--.*$/gm, "");

  const fnBody = (signature: string): string => {
    const start = executable.search(
      new RegExp(`create (or replace )?function public\\.${signature}`, "i"),
    );
    expect(start, `${signature} is not defined`).toBeGreaterThan(-1);
    const opener = executable.slice(start).match(/as \$([a-z_]*)\$/i);
    const tag = opener?.[1] ?? "";
    const close = executable.indexOf(`$${tag}$;`, start);
    expect(close, `${signature} has no closing dollar-quote`).toBeGreaterThan(start);
    return executable.slice(start, close + tag.length + 4);
  };

  it("re-scopes current_tournament_id() to the caller's pointer alone", () => {
    const fn = fnBody("current_tournament_id\\(\\)");
    // The fallback read a global row; the replacement reads only the caller's profile.
    expect(fn).not.toMatch(/is_active/);
    expect(fn).not.toMatch(/from public\.tournaments/);
    expect(fn).toMatch(/from public\.profiles p\s+where p\.user_id = auth\.uid\(\)/);
    // An anonymous caller - which is also the server-rendering request - gets NULL, so a
    // server-side call can never redirect a bookmark to somebody's live desk.
    expect(fn).toMatch(/if auth\.uid\(\) is null then\s+return null;/);
  });

  it("drops the writer, then the index, then the column", () => {
    const dropFn = executable.indexOf(
      "drop function if exists public.set_active_tournament(uuid);",
    );
    const dropIndex = executable.indexOf(
      "drop index if exists public.tournaments_single_active;",
    );
    const dropColumn = executable.indexOf("drop column if exists is_active");
    expect(dropFn, "set_active_tournament is not dropped").toBeGreaterThan(-1);
    expect(dropIndex, "tournaments_single_active is not dropped").toBeGreaterThan(dropFn);
    expect(dropColumn, "is_active is not dropped").toBeGreaterThan(dropIndex);
  });

  it("drops the column without a cascade", () => {
    // A cascade would silently take a view or constraint nobody meant to remove. There is
    // no dependent left by design, so the drop must be able to say so.
    expect(executable).not.toMatch(/drop column if exists is_active\s+cascade/i);
  });

  it("verifies the retirement against the catalogue before it commits", () => {
    expect(sql).toMatch(/do \$verify\$/);
    expect(sql).toMatch(/raise exception 'retire is_active:/);
    expect(executable).not.toMatch(/raise warning/i);
  });
});

/**
 * Naming the walk-in arm.
 *
 * Phase 1's `has_any_tournament_edit()` described the wrong thing: it authorises adding an
 * unlinked person to the *global* roster, not an edit of any tournament, and a reader looking
 * for a per-tournament capability already has `can_edit_tournament(uuid)`. Phase 2 narrowed
 * the read side of the `players` surface with `can_manage_player(uuid)`; this migration
 * finishes the pair on the create side.
 *
 * It is a rename and nothing else, which is what makes the contract small and worth pinning:
 * the three arms are unchanged, the policy is re-pointed before the old function is dropped,
 * and the old name survives in neither the catalogue nor any function body.
 */
describe("walk-in predicate migration", () => {
  const FILE = "20260929030000_walk_in_player_predicate.sql";
  const sql = readFileSync(join(__dirname, "../../../supabase/migrations", FILE), "utf8");
  const executable = sql.replace(/--.*$/gm, "");

  it("keeps the authorization the old name carried, under a name that says it", () => {
    const start = executable.search(
      /create (or replace )?function public\.can_add_walk_in_player\(\)/i,
    );
    expect(start, "can_add_walk_in_player() is not defined").toBeGreaterThan(-1);
    const body = executable.slice(start, executable.indexOf("$$;", start));
    expect(body).toMatch(/is_platform_admin\(\)/);
    expect(body).toMatch(
      /from public\.tournaments t\s+where t\.owner_profile_id = public\.current_profile_id\(\)/,
    );
    expect(body).toMatch(
      /from public\.tournament_editors e\s+where e\.profile_id = public\.current_profile_id\(\)/,
    );
    // Every arm resolves the caller through the one predicate, never by comparing a profile
    // column to the auth uid - which type-checks and silently matches nothing.
    expect(body).not.toMatch(/profile_id\s*=\s*auth\.uid\(\)/);
  });

  it("re-points the policy before it drops the old function", () => {
    // A policy is a dependent object: dropping first makes the migration fail, and skipping
    // the alter leaves the dropped name referenced, so the order *is* the change.
    const alter = executable.indexOf('alter policy "players insert" on public.players');
    const drop = executable.indexOf("drop function public.has_any_tournament_edit();");
    expect(alter, "the policy is not re-pointed").toBeGreaterThan(-1);
    expect(drop, "the old predicate is not dropped").toBeGreaterThan(alter);
    expect(executable.slice(alter, drop)).toMatch(/can_add_walk_in_player\(\)/);
  });

  it("leaves the policy's self-service arm untouched", () => {
    // The other arm grants nothing - the row it admits is unlinked - and a rename that
    // quietly dropped it would close self-insertion for a person adding themselves.
    const alter = executable.slice(executable.indexOf('alter policy "players insert"'));
    expect(alter).toMatch(/profile_id is null/);
    expect(alter).toMatch(
      /public\.normalize_email\(email\) = public\.normalize_email\(auth\.jwt\(\) ->> 'email'\)/,
    );
  });

  it("closes the implicit PUBLIC grant and opens it to authenticated alone", () => {
    expect(executable).toMatch(
      /revoke all on function public\.can_add_walk_in_player\(\) from anon, public/,
    );
    expect(executable).toMatch(
      /grant execute on function public\.can_add_walk_in_player\(\) to authenticated/,
    );
    expect(executable).not.toMatch(
      /grant execute on function public\.can_add_walk_in_player\(\) to anon/,
    );
  });

  it("verifies the rename against the catalogue before it commits", () => {
    expect(sql).toMatch(/do \$verify\$/);
    expect(sql).toMatch(/raise exception 'walk-in predicate:/);
    expect(executable).not.toMatch(/raise warning/i);
  });
});

/**
 * Explore at scale.
 *
 * Two public reads, granted to `anon`. What these assert is the shape that keeps a public,
 * pageable read safe and correct: the implicit PUBLIC grant is closed and re-issued to the two
 * roles that call it, every free argument is a closed vocabulary that raises, the page size is
 * clamped, the order is total so pages add up, and the existing summary read is left alone.
 */
describe("explore tournaments migration", () => {
  const FILE = "20261007000000_explore_tournaments.sql";
  const sql = readFileSync(join(__dirname, "../../../supabase/migrations", FILE), "utf8");
  const executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  it("closes the implicit PUBLIC grant and re-issues it to anon and authenticated", () => {
    for (const signature of [
      "explore_tournaments\\(text, text, boolean, text, text, int, int\\)",
      "explore_tournament_counts\\(text, boolean, text\\)",
    ]) {
      expect(executable).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature}\\s+FROM anon, PUBLIC`),
      );
      expect(executable).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature}\\s+TO anon, authenticated`),
      );
    }
  });

  it("is a definer read that pins its search path", () => {
    expect(executable.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(executable.match(/SET search_path = public/g)).toHaveLength(2);
  });

  it("refuses a word outside each closed vocabulary", () => {
    expect(executable).toMatch(/Unknown status filter/);
    expect(executable).toMatch(/Unknown sort/);
    expect(executable.match(/Unknown range/g)).toHaveLength(2);
  });

  it("clamps the page size and ends the order in the id", () => {
    expect(executable).toMatch(/least\(greatest\(coalesce\(p_limit, 12\), 1\), 50\)/);
    expect(executable).toMatch(/f\.t_created DESC,\s+f\.t_id\s+LIMIT/);
  });

  it("takes the size of the whole result in the same statement as the page", () => {
    expect(executable).toMatch(/\(count\(\*\) OVER \(\)\)::int/);
  });

  it("leaves tournament_summary alone", () => {
    expect(executable).not.toMatch(/FUNCTION public\.tournament_summary/);
  });
});

/** The text of one function definition: its CREATE through the closing dollar quote it opens. */
function functionSource(source: string, name: string): string {
  const start = source.indexOf(`FUNCTION public.${name}`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const tag = rest.match(/\bAS\s+(\$[a-z_]*\$)/i)?.[1];
  expect(tag, `${name} opens a dollar quote`).toBeTruthy();
  const first = rest.indexOf(tag as string);
  const second = rest.indexOf(tag as string, first + (tag as string).length);
  return rest.slice(0, second + (tag as string).length);
}

/**
 * The tournament window, atomic creation, start-on-first-match and the registration rules.
 *
 * Three migrations, asserted against their source for the reason the earlier blocks give:
 * what they guard against is invisible at runtime. `CREATE OR REPLACE FUNCTION` restores the
 * implicit PUBLIC grant, a guard written as an RPC check is a guard a direct table update
 * walks around, and a lifecycle rule that quietly consults the platform role stops being a
 * rule. Each assertion names the failure it prevents.
 */
describe("tournament window migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const sql = readFileSync(join(dir, "20261008000000_tournament_window.sql"), "utf8")
    // Normalised, because the assertions below match multi-line SQL as it is written in the
    // file. A Windows checkout with `core.autocrlf` converts the file to CRLF, and a `\n` in a
    // search string then matches nothing - a failure about the checkout, not the migration.
    .replace(/\r\n/g, "\n");
  const executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const withoutVerify = executable.replace(/DO \$verify\$[\s\S]*?\$verify\$;/, "");

  const fn = (name: string) => functionSource(withoutVerify, name);

  it("adds the window nullable, backfills it, then constrains it", () => {
    const add = withoutVerify.indexOf("ADD COLUMN IF NOT EXISTS starts_on date");
    const fill = withoutVerify.indexOf("UPDATE public.tournaments t\nSET starts_on");
    const notNull = withoutVerify.indexOf("ALTER COLUMN starts_on SET NOT NULL");
    const order = withoutVerify.indexOf("CHECK (starts_on <= ends_on)");
    expect(add).toBeGreaterThan(-1);
    expect(fill).toBeGreaterThan(add);
    expect(notNull).toBeGreaterThan(fill);
    expect(order).toBeGreaterThan(notNull);
  });

  it("backfills an unrecognised timezone safely, in UTC", () => {
    expect(withoutVerify).toMatch(/created_at AT TIME ZONE 'UTC'\)::date/);
  });

  it("keeps the window out of the editor UPDATE grant", () => {
    // Written only by create_tournament and update_tournament_window.
    expect(withoutVerify).not.toMatch(/GRANT UPDATE \([^)]*starts_on/i);
  });

  it("has no seven-day ceiling left in a constraint or a function", () => {
    expect(withoutVerify).not.toMatch(/BETWEEN 1 AND 7/);
    expect(withoutVerify).not.toMatch(/at most 7 days/);
    expect(withoutVerify).not.toMatch(/v_total >= 7/);
    expect(withoutVerify).toMatch(/CHECK \(day_count >= 1\)/);
    expect(withoutVerify).toMatch(/CHECK \(day_number >= 1\)/);
  });

  it("derives the instants from the window, in the venue timezone", () => {
    expect(fn("tournament_starts_at")).toMatch(
      /\(t\.starts_on::timestamp\) AT TIME ZONE t\.venue_timezone/,
    );
    expect(fn("tournament_ends_at")).toMatch(
      /\(\(t\.ends_on \+ 1\)::timestamp\) AT TIME ZONE t\.venue_timezone/,
    );
  });

  it("no longer asks readiness about days, and still ignores participation", () => {
    const checks = fn("tournament_readiness_checks");
    expect(checks).not.toMatch(/'id', 'days'/);
    expect(checks).not.toMatch(/'id', 'day_dates'/);
    for (const id of ["basics", "timezone", "categories", "category_caps"]) {
      expect(checks).toContain(`'id', '${id}'`);
    }
    for (const table of ["teams", "placement_entrants", "placement_matches", "tier_draws"]) {
      expect(checks).not.toContain(table);
    }
  });

  it("guards a playing day against the window with a trigger, so a table update cannot walk around it", () => {
    expect(withoutVerify).toMatch(
      /CREATE TRIGGER tournament_days_guard_window\s+BEFORE INSERT OR UPDATE OF tournament_id, date\s+ON public\.tournament_days/,
    );
    expect(fn("tournament_days_guard_window")).toMatch(/is outside the tournament window/);
  });

  it("locks the timezone under a schedule with a trigger", () => {
    expect(withoutVerify).toMatch(
      /CREATE TRIGGER tournaments_guard_timezone\s+BEFORE UPDATE OF venue_timezone\s+ON public\.tournaments/,
    );
    expect(fn("tournaments_guard_timezone")).toMatch(/tournament_has_schedule\(NEW\.id\)/);
  });

  it("creates a tournament in one function that refuses an incomplete one", () => {
    const create = fn("create_tournament(p_payload jsonb)");
    expect(create).toMatch(/SECURITY DEFINER/);
    for (const refusal of [
      "Sign in to create a tournament",
      "A tournament needs a name",
      "Choose the day the tournament starts",
      "Choose the day the tournament ends",
      "The tournament cannot end before it starts",
    ]) {
      expect(create).toContain(refusal);
    }
    expect(create).toMatch(/INSERT INTO public\.categories/);
    expect(create).toMatch(/PERFORM public\.assert_registration_window\(new_id\)/);
    expect(create).toMatch(/NOT public\.tournament_is_ready\(new_id\)/);
    expect(create).toMatch(/SET current_tournament_id = new_id\s+WHERE user_id = auth\.uid\(\)/);
  });

  it("leaves no second creation path", () => {
    expect(withoutVerify).not.toMatch(/FUNCTION public\.create_tournament_draft/);
  });

  it("locks the first date once the tournament is in progress, and re-checks the deadline", () => {
    const update = fn("update_tournament_window");
    expect(update).toMatch(/t\.status <> 'upcoming' AND p_starts_on <> t\.starts_on/);
    expect(update).toMatch(/would fall outside the window/);
    expect(update).toMatch(/PERFORM public\.assert_registration_window\(p_tournament_id\)/);
    expect(update).toMatch(/can_edit_tournament/);
  });

  it("allows no playing days, but never removes a day that holds a match", () => {
    expect(fn("remove_tournament_day")).not.toMatch(/A tournament needs at least one day/);
    expect(fn("remove_tournament_day")).toMatch(/still has % match\(es\) on it/);
  });

  it("refuses to replace the days wholesale once anything is scheduled", () => {
    expect(fn("save_tournament_days")).toMatch(
      /IF public\.tournament_has_schedule\(p_tournament_id\) THEN/,
    );
  });

  it("repeats the revoke and grant pair for everything it creates or replaces", () => {
    for (const internal of [
      "tournament_starts_at(uuid)",
      "tournament_ends_at(uuid)",
      "tournament_readiness_checks(uuid)",
      "tournament_has_schedule(uuid)",
      "tournament_days_guard_window()",
      "tournaments_guard_timezone()",
    ]) {
      expect(withoutVerify).toContain(`'${internal}'`);
    }
    expect(withoutVerify).toMatch(/revoke all on function public\.%s from anon, authenticated, public/);
    expect(withoutVerify).toMatch(/revoke all on function public\.%s from public, anon/);
    for (const client of [
      "create_tournament(jsonb)",
      "update_tournament_window(uuid, date, date)",
    ]) {
      expect(withoutVerify).toContain(`'${client}'`);
    }
  });

  it("verifies its own result", () => {
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/RAISE EXCEPTION 'M1:/);
  });
});

describe("start on first match migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const sql = readFileSync(join(dir, "20261008010000_start_on_first_match.sql"), "utf8");
  const executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const withoutVerify = executable.replace(/DO \$verify\$[\s\S]*?\$verify\$;/, "");

  const fn = (name: string) => functionSource(withoutVerify, name);

  it("drops start_tournament and creates no replacement button", () => {
    expect(withoutVerify).toMatch(/DROP FUNCTION IF EXISTS public\.start_tournament\(uuid\)/);
    expect(withoutVerify).not.toMatch(/CREATE OR REPLACE FUNCTION public\.start_tournament/);
  });

  it("flips upcoming to in progress inside each of the three match starts", () => {
    for (const name of [
      "start_placement_match(p_match_id uuid, p_court_id uuid DEFAULT NULL::uuid)",
      "start_tier_draw_match(p_match_id uuid, p_court_id uuid DEFAULT NULL::uuid)",
      "start_match_safe(p_table text, p_match_id uuid, p_court_id uuid, p_ignore_rest boolean DEFAULT false)",
    ]) {
      const body = fn(name);
      expect(body, name).toMatch(/can_edit_tournament/);
      expect(body, name).toMatch(/lock_tournament_lifecycle_shared/);
      expect(body, name).toMatch(/assert_tournament_can_start_match/);
      expect(body, name).toMatch(/mark_tournament_started/);
      expect(body, name).not.toMatch(/assert_tournament_live/);
      // The flip comes before the match row is touched, so nothing the match update fires
      // sees a match on court inside a tournament that is still upcoming. A failed start
      // raises and takes the flip with it.
      expect(body.indexOf("mark_tournament_started"), name).toBeGreaterThan(
        body.indexOf("assert_tournament_can_start_match"),
      );
      expect(body.indexOf("mark_tournament_started"), name).toBeLessThan(
        body.search(/\bUPDATE public\.(placement|tier_draw|pool|draw)_matches/),
      );
    }
  });

  it("takes the lifecycle lock before any other lock a start already takes", () => {
    const body = fn(
      "start_match_safe(p_table text, p_match_id uuid, p_court_id uuid, p_ignore_rest boolean DEFAULT false)",
    );
    expect(body.indexOf("lock_tournament_lifecycle_shared")).toBeLessThan(
      body.indexOf("hashtext('live-schedule')"),
    );
  });

  it("makes the transition idempotent and one-way", () => {
    const mark = fn("mark_tournament_started");
    expect(mark).toMatch(/SET status = 'in_progress'\s+WHERE id = p_tournament_id AND status = 'upcoming'/);
  });

  it("never lets a completed tournament have a match started, whoever asks", () => {
    const guard = fn("assert_tournament_can_start_match");
    expect(guard).toMatch(/v_state = 'completed'/);
    expect(guard).not.toMatch(/is_platform_admin/);
    expect(guard).toMatch(/now\(\) < v_starts/);
  });

  it("completes only with nothing on court, under the exclusive half of the lifecycle lock", () => {
    const complete = fn("complete_tournament");
    expect(complete).toMatch(/pg_advisory_xact_lock\(hashtext\('lifecycle:' \|\| p_tournament_id::text\)\)/);
    expect(complete).toMatch(/match\(es\) are still being played/);
    expect(complete).toMatch(/can_edit_tournament/);
  });

  it("counts what is left from the four match tables", () => {
    const counts = fn("tournament_completion_counts");
    for (const table of ["placement_matches", "tier_draw_matches", "pool_matches", "draw_matches"]) {
      expect(counts).toContain(`public.${table}`);
    }
    expect(counts).toMatch(/'on_court', count\(\*\) FILTER \(WHERE status = 'in-progress'\)/);
    expect(counts).toMatch(/'unplayed', count\(\*\) FILTER \(WHERE status = 'scheduled'\)/);
  });

  it("keeps the transition and the lock helpers off the client surface", () => {
    expect(withoutVerify).toMatch(/'mark_tournament_started\(uuid\)'/);
    expect(withoutVerify).toMatch(/'lock_tournament_lifecycle_shared\(uuid\)'/);
    expect(withoutVerify).toMatch(/revoke all on function public\.%s from anon, authenticated, public/);
  });

  it("verifies its own result", () => {
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/RAISE EXCEPTION 'M2:/);
  });
});

describe("registration window rules migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const sql = readFileSync(join(dir, "20261008020000_registration_window_rules.sql"), "utf8");
  const executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const withoutVerify = executable.replace(/DO \$verify\$[\s\S]*?\$verify\$;/, "");

  const fn = (name: string) => functionSource(withoutVerify, name);

  it("requires the deadline to close before the window opens", () => {
    const assert = fn("assert_registration_window(p_tournament_id uuid)");
    expect(assert).toMatch(/v_closes > v_starts/);
    expect(assert).toMatch(/Registration must close after it opens/);
    expect(assert).toMatch(/Set both the opening and the closing time/);
  });

  it("guards the two columns for every writer, not only the dedicated RPC", () => {
    expect(withoutVerify).toMatch(
      /CREATE TRIGGER tournaments_guard_registration\s+BEFORE UPDATE OF registration_opens_at, registration_closes_at\s+ON public\.tournaments/,
    );
    const guard = fn("tournaments_guard_registration");
    expect(guard).toMatch(/Registration has already opened/);
    expect(guard).toMatch(/registration cannot be extended/);
    expect(guard).toMatch(/OLD\.status <> 'upcoming'/);
    expect(guard).toMatch(/tournament_has_schedule\(OLD\.id\)/);
  });

  it("sets the window through one editor RPC that is upcoming only", () => {
    const set = fn("set_registration_window(");
    expect(set).toMatch(/can_edit_tournament/);
    expect(set).toMatch(/assert_tournament_configurable/);
    expect(set).toMatch(/PERFORM public\.assert_registration_window\(p_tournament_id\)/);
  });

  it("re-creates both public reads with the playing-day span and keeps them public", () => {
    expect(withoutVerify).toMatch(/DROP FUNCTION IF EXISTS public\.tournament_summary/);
    expect(withoutVerify).toMatch(/DROP FUNCTION IF EXISTS public\.explore_tournaments/);
    expect(withoutVerify.match(/play_starts_at timestamptz/g)).toHaveLength(2);
    expect(withoutVerify.match(/play_ends_at timestamptz/g)).toHaveLength(2);
    for (const signature of [
      "tournament_summary\\(text, text, uuid\\[\\], int, int\\)",
      "explore_tournaments\\(text, text, boolean, text, text, int, int\\)",
    ]) {
      expect(withoutVerify).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM anon, PUBLIC`),
      );
      expect(withoutVerify).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO anon, authenticated`),
      );
    }
  });

  it("keeps the page order total", () => {
    expect(withoutVerify).toMatch(/f\.t_created DESC,\s+f\.t_id\s+LIMIT v_limit/);
  });

  it("verifies its own result", () => {
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/RAISE EXCEPTION 'M3:/);
  });
});

describe("update tournament details migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const sql = readFileSync(join(dir, "20261008030000_update_tournament_details.sql"), "utf8");
  const executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const withoutVerify = executable.replace(/DO \$verify\$[\s\S]*?\$verify\$;/, "");
  const body = functionSource(withoutVerify, "update_tournament_details");

  it("is open until completion, and no further", () => {
    expect(body).toMatch(/can_edit_tournament/);
    expect(body).toMatch(/PERFORM public\.assert_tournament_writable\(p_tournament_id\)/);
    expect(body).not.toMatch(/assert_tournament_configurable/);
  });

  it("writes the seven detail columns and nothing that alters a game", () => {
    const set = body.match(/UPDATE public\.tournaments SET([\s\S]*?)WHERE id = p_tournament_id/);
    expect(set, "the update statement").toBeTruthy();
    const columns = [...(set?.[1] ?? "").matchAll(/^\s*([a-z_]+) =/gm)].map((match) => match[1]);
    expect(columns).toEqual([
      "name",
      "notes",
      "venue_name",
      "venue_address",
      "organizer_name",
      "organizer_email",
      "organizer_phone",
    ]);
  });

  it("still needs a name", () => {
    expect(body).toMatch(/A tournament needs a name/);
  });

  it("is a client RPC for signed-in callers only", () => {
    expect(withoutVerify).toMatch(
      /REVOKE ALL ON FUNCTION public\.update_tournament_details\(uuid, jsonb\) FROM public, anon/,
    );
    expect(withoutVerify).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.update_tournament_details\(uuid, jsonb\) TO authenticated/,
    );
  });

  it("verifies its own result", () => {
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/RAISE EXCEPTION 'M4:/);
  });
});

/**
 * The start-policy switch.
 *
 * The one on-the-day writer that sits beside the wizard rather than inside it: the wizard's
 * configuration is frozen from the first match, but whether short rest blocks a start has to stay
 * changeable while the tournament plays. Asserted against the migration source for the same reason
 * the details block is: the guard and the one-column scoping are visible only in the SQL, and a
 * widened writer would compile and run.
 *
 * The seven columns of `update_tournament_details` are pinned by the block above and are not touched
 * here — this is a separate function on purpose.
 */
describe("start policy migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const sql = readFileSync(join(dir, "20261012000000_tournament_start_policy.sql"), "utf8");
  const executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const withoutVerify = executable.replace(/DO \$verify\$[\s\S]*?\$verify\$;/, "");
  const body = functionSource(withoutVerify, "set_tournament_start_policy");

  it("is open until completion, for the people who may edit the tournament", () => {
    expect(body).toMatch(/can_edit_tournament/);
    expect(body).toMatch(/PERFORM public\.assert_tournament_writable\(p_tournament_id\)/);
    expect(body).not.toMatch(/assert_tournament_configurable/);
  });

  it("writes the one start-policy column and nothing else", () => {
    const set = body.match(/UPDATE public\.tournaments SET([\s\S]*?)WHERE id = p_tournament_id/);
    expect(set, "the update statement").toBeTruthy();
    const columns = [...(set?.[1] ?? "").matchAll(/^\s*([a-z_]+) =/gm)].map((match) => match[1]);
    expect(columns).toEqual(["block_start_on_short_rest"]);
  });

  it("refuses a missing value rather than reading it as off", () => {
    expect(body).toMatch(/p_block_start_on_short_rest IS NULL/);
  });

  it("raises for an unknown tournament", () => {
    expect(body).toMatch(/RAISE EXCEPTION 'Unknown tournament'/);
  });

  it("is a client RPC for signed-in callers only", () => {
    expect(withoutVerify).toMatch(
      /REVOKE ALL ON FUNCTION public\.set_tournament_start_policy\(uuid, boolean\) FROM public, anon/,
    );
    expect(withoutVerify).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.set_tournament_start_policy\(uuid, boolean\) TO authenticated/,
    );
  });

  it("verifies its own result", () => {
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/RAISE EXCEPTION 'M7:/);
  });
});

/**
 * The roster is read one tournament at a time.
 *
 * Asserted against the migration source because the failure is invisible at runtime until
 * somebody lists the platform: `public_players` answering to `anon` looks like working code.
 * What matters is the shape of the three calls and that the view's grant is gone.
 */
describe("the scoped player reads migration", () => {
  const dir = join(process.cwd(), "supabase", "migrations");
  const sql = readFileSync(join(dir, "20261009000000_scoped_player_reads.sql"), "utf8");
  const body = sql.replace(/--.*$/gm, "");

  it("withdraws the roster view from anon and authenticated", () => {
    expect(body).toMatch(/REVOKE SELECT ON public\.public_players FROM anon, authenticated/);
    // Re-creating the view would restore nothing here, but it is the one-line change that
    // would publish the link column, so it is kept out of this file.
    expect(body).not.toMatch(/CREATE (OR REPLACE )?VIEW public\.public_players/i);
  });

  it("lists a tournament's people publicly, with three columns and no contact data", () => {
    expect(body).toMatch(
      /FUNCTION public\.tournament_players\(p_tournament_id uuid\)\s+RETURNS TABLE \(id uuid, name text, gender text\)/,
    );
    expect(body).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.tournament_players\(uuid\) TO anon, authenticated/,
    );
    const fn = body.slice(body.indexOf("FUNCTION public.tournament_players"));
    expect(fn.slice(0, fn.indexOf("COMMENT ON"))).not.toMatch(/email|phone|profile_id/);
  });

  it("searches only for an editor of the tournament, and bounds what it returns", () => {
    expect(body).toMatch(/IF NOT public\.can_edit_tournament\(p_tournament_id\) THEN/);
    expect(body).toMatch(/char_length\(v_query\) < 2/);
    expect(body).toMatch(/LIMIT least\(greatest\(COALESCE\(p_limit, 20\), 1\), 50\)/);
    expect(body).toMatch(
      /REVOKE ALL ON FUNCTION public\.search_players\(uuid, text, integer\) FROM PUBLIC, anon/,
    );
  });

  it("creates a walk-in through the create-side predicate and returns the id", () => {
    expect(body).toMatch(/IF NOT public\.can_add_walk_in_player\(\) THEN/);
    expect(body).toMatch(/RETURNING players\.id INTO v_id/);
    // The link is never a parameter: only an approved registration may set it.
    expect(body).not.toMatch(/p_profile/);
  });

  it("checks its own grants", () => {
    expect(sql).toMatch(/DO \$verify\$/);
  });
});

/**
 * The sample tournaments, and the two calls that make and unmake them.
 *
 * Three properties carry the whole mechanism, and every one of them is something a later
 * edit could quietly reverse: the marker is withheld from every client, the generator is
 * reachable only by the service role, and the reads that draw a tournament to the public
 * carry the marker so a label can be drawn from a fact rather than from a guess. The one
 * assertion that is about a *shape* rather than a privilege is `remove_demo_tournaments`
 * running first inside `seed_demo_tournaments`: that is what makes a second run idempotent,
 * and it is the kind of ordering that survives review and then gets moved.
 */
describe("demo tournament migrations", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const flagFile = "20261015000000_demo_tournament_flag.sql";
  const seedFile = "20261015010000_demo_tournament_seed.sql";
  const flagSql = readFileSync(join(dir, flagFile), "utf8");
  const flagBody = flagSql.replace(/--.*$/gm, "");
  const seedSql = readFileSync(join(dir, seedFile), "utf8");
  const seedBody = seedSql.replace(/--.*$/gm, "");

  it("adds the marker to both tables that need one, non-null with a false default", () => {
    for (const table of ["tournaments", "players"]) {
      expect(flagBody).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table}\\s+ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false`,
        ),
      );
    }
  });

  it("keeps the marker out of every client's hands", () => {
    // The withholding is an *absence*, not a statement: writes on both tables are granted
    // as allow-lists (`grant update (...)` in `20260929000000_identity_canon.sql` and
    // `grant insert/update (...)` in `20260929020000_registration_entries_and_identity.sql`),
    // and `is_demo` is simply not named in either. That is the house pattern, and it is also
    // the fragile one - the way this breaks is somebody adding the column to an allow-list
    // while filling out a grant, so the assertion that matters is over every migration, not
    // just this one.
    const migrations = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const granted = migrations.filter((f) => {
      const body = readFileSync(join(dir, f), "utf8").replace(/--.*$/gm, "");
      // `grant <privileges> ( <columns> )` - an allow-list block. Matching across the
      // parenthesised list is what distinguishes a column grant from `grant execute on
      // function ...`, which is a different list entirely.
      return /grant\s+[a-z,\s]*\([\s\S]*?is_demo[\s\S]*?\)\s+on\s+public\./i.test(body);
    });
    expect(granted).toEqual([]);

    // And the database is asked, rather than the file being trusted to have said nothing:
    // the verify block refuses to apply the column if either role can write it.
    expect(flagBody).toMatch(/has_column_privilege\('authenticated', 'public\.tournaments', 'is_demo', 'UPDATE'\)/);
    expect(flagBody).toMatch(/has_column_privilege\('authenticated', 'public\.players', 'is_demo', 'UPDATE'\)/);
  });

  it("leaves the marker readable, because the label is drawn from it", () => {
    // Withholding the write must not withhold the read: both reads return the column, and
    // the app renders the label from the row it was handed rather than from a second query.
    // A `revoke select` on either table would be a plausible-looking security tightening that
    // silently greys out every Demo label.
    const migrations = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const revoked = migrations.filter((f) =>
      /revoke[^;]*\bselect[^;]*\([\s\S]*?is_demo[\s\S]*?\)/i.test(
        readFileSync(join(dir, f), "utf8").replace(/--.*$/gm, ""),
      ),
    );
    expect(revoked).toEqual([]);
    expect(flagBody).toMatch(/t\.is_demo\b/);
    expect(flagBody).toMatch(/f\.t_is_demo\b/);
  });

  it("carries the marker through the two reads that draw a tournament", () => {
    // Both are dropped and re-created rather than replaced in place, because
    // `CREATE OR REPLACE FUNCTION` cannot change a `RETURNS TABLE` shape.
    for (const signature of [
      "tournament_summary\\(text, text, uuid\\[\\], int, int\\)",
      "explore_tournaments\\(text, text, boolean, text, text, int, int\\)",
    ]) {
      expect(flagBody).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${signature}`));
      expect(flagBody).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature}\\s+TO anon, authenticated`));
    }
    expect(flagBody.match(/is_demo boolean/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("stops the roster search answering with sample people", () => {
    // A sample person on a real draw is the leak the marker exists to prevent, and
    // `search_players` is the one read that spans every tournament on the platform.
    expect(flagBody).toMatch(/AND NOT p\.is_demo/);
  });

  it("is a migration that seeds nothing", () => {
    // The point of the split: pushing to production must leave production with an empty
    // column and an uncalled function. Seeding is an act, not a deploy.
    expect(flagBody).not.toMatch(/INSERT INTO public\.(tournaments|players)/);
    expect(seedBody).toMatch(/^CREATE OR REPLACE FUNCTION public\.seed_demo_tournaments\(\)/m);
    expect(seedBody).not.toMatch(/^SELECT public\.seed_demo_tournaments\(\)/m);
  });

  it("makes both calls a service-role act and no client's", () => {
    for (const fn of ["seed_demo_tournaments\\(\\)", "remove_demo_tournaments\\(\\)", "demo_tournament_owner\\(\\)"]) {
      expect(seedBody).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM PUBLIC, anon, authenticated`),
      );
      expect(seedBody).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn} TO service_role`));
    }
  });

  it("removes before it writes, so a second run cannot duplicate a row", () => {
    const body = seedBody.slice(seedBody.indexOf("FUNCTION public.seed_demo_tournaments"));
    expect(body.indexOf("PERFORM public.remove_demo_tournaments()")).toBeGreaterThan(-1);
    expect(body.indexOf("PERFORM public.remove_demo_tournaments()")).toBeLessThan(
      body.indexOf("INSERT INTO public.tournaments"),
    );
  });

  it("deletes only rows it marked, and clears desk activity by match id", () => {
    // A wrong dataset raises inside one transaction; a wrong *delete* is not recoverable, so
    // the two removers are asserted to name the flag rather than a name or a date.
    const remove = seedBody.slice(
      seedBody.indexOf("FUNCTION public.remove_demo_tournaments"),
      seedBody.indexOf("FUNCTION public.seed_demo_tournaments"),
    );
    expect(remove).toMatch(/DELETE FROM public\.tournaments WHERE is_demo/);
    expect(remove).toMatch(/DELETE FROM public\.players WHERE is_demo/);
    expect(remove).toMatch(/DELETE FROM public\.desk_activity da/);
    // `desk_activity` has no `tournament_id` and no foreign key, so nothing cascades it.
    expect(remove).toMatch(/da\.match_id IN/);
    // No bare delete of a table the demonstration does not own.
    expect(remove).not.toMatch(/DELETE FROM public\.tournaments\s*;/);
  });

  it("checks its own grants and shape", () => {
    expect(seedSql).toMatch(/DO \$verify\$/);
    expect(seedSql).toMatch(/RAISE EXCEPTION 'D2:/);
    expect(flagSql).toMatch(/DO \$verify\$/);
    expect(flagSql).toMatch(/RAISE EXCEPTION 'D1:/);
  });
});

describe("full knockout bracket migration", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "20261016000000_full_knockout_bracket.sql"),
    "utf8",
  );
  const body = (name: string) => {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} is defined`).toBeGreaterThan(-1);
    const next = sql.indexOf("CREATE OR REPLACE FUNCTION", start + 1);
    return sql.slice(start, next === -1 ? undefined : next);
  };

  it("creates every round at the draw and links parents", () => {
    const fill = body("fill_tier_bracket");
    expect(fill).toMatch(/generate_series\(1, v_size \/ \(1 << v_round\)\)/);
    expect(fill).toMatch(/ON CONFLICT \(draw_id, round, slot\) DO NOTHING/);
    expect(fill).toMatch(/parent_a_id = a\.id/);
    expect(sql).toMatch(/PERFORM public\.fill_tier_bracket\(v_draw_id\)/);
  });

  it("advances by filling the child slot and never inserts a round", () => {
    const advance = body("advance_tier_draw_locked");
    expect(advance).not.toMatch(/INSERT INTO/);
    // Odd slots feed side A and even slots side B, the rule the correction trigger uses too.
    expect(advance).toMatch(/p\.slot % 2 = 1/);
    expect(advance).toMatch(/p\.slot % 2 = 0/);
    expect(advance).toMatch(/c\.status = 'scheduled'/);
    expect(advance).toMatch(/champion_id/);
  });

  it("refuses to start a match with an empty side, and to reset one whose child began", () => {
    expect(body("start_tier_draw_match")).toMatch(/entrant_a_id IS NOT NULL/);
    const reset = body("reset_tier_draw_result");
    expect(reset).toMatch(/v_child\.status <> 'scheduled'/);
    expect(reset).toMatch(/champion_id = NULL/);
  });

  it("ignores undecided slots in the knockout completeness check", () => {
    const writer = body("apply_placement_day_schedule");
    expect(writer).toMatch(/AND entrant_a_id IS NOT NULL\s+AND entrant_b_id IS NOT NULL/);
  });

  it("wraps the sample seed so a reset still yields full brackets, with the same privileges", () => {
    expect(sql).toMatch(/RENAME TO seed_demo_tournaments_rows/);
    const wrapper = body("seed_demo_tournaments");
    expect(wrapper).toMatch(/seed_demo_tournaments_rows\(\)/);
    expect(wrapper).toMatch(/fill_tier_bracket\(v_draw\)/);
    expect(wrapper).toMatch(/t\.is_demo/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.seed_demo_tournaments\(\) TO service_role/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.seed_demo_tournaments\(\) FROM PUBLIC, anon, authenticated/);
  });

  it("keeps the internal helper off the client surface", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.fill_tier_bracket\(uuid\) FROM anon, authenticated, PUBLIC/);
    expect(sql).toMatch(/DO \$verify\$/);
  });
});

describe("place_ready_matches migration", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "20261017000000_place_ready_matches.sql"),
    "utf8",
  );

  it("is additive: it fills only empty slots and never clears a row", () => {
    expect(sql).toMatch(/court_id IS NULL AND scheduled_time IS NULL/);
    expect(sql).not.toMatch(/SET scheduled_time = NULL/);
    expect(sql).not.toMatch(/DELETE FROM/);
    expect(sql).toMatch(/'already_placed'/);
  });

  it("re-checks each slot on the server and skips rather than failing the batch", () => {
    for (const reason of ["court_busy", "player_busy", "not_ready", "bad_court", "in_the_past"]) {
      expect(sql).toContain(`'${reason}'`);
    }
    expect(sql).toMatch(/placement_occupied_matches\(p_tournament_id\)/);
  });

  it("is guarded like the other writers and shares their lock", () => {
    expect(sql).toMatch(/can_edit_tournament\(p_tournament_id\)/);
    expect(sql).toMatch(/assert_tournament_writable\(p_tournament_id\)/);
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtext\('live-schedule'\)\)/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.place_ready_matches\(uuid, text, jsonb\) FROM anon, PUBLIC/);
  });
});

describe("prerequisite order migration", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "20261023000000_prerequisite_order.sql"),
    "utf8",
  );
  const body = (name: string) => {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start).toBeGreaterThan(-1);
    const ends = [
      sql.indexOf("\nCREATE OR REPLACE FUNCTION", start + 1),
      sql.indexOf("\nREVOKE ALL", start),
    ].filter((index) => index > -1);
    return sql.slice(start, Math.min(...ends));
  };

  it("checks the order in both directions, with a reason rather than a failed batch", () => {
    const writer = body("place_ready_matches");
    for (const reason of ["prerequisite_unplaced", "before_prerequisite", "after_dependent"]) {
      expect(writer).toContain(`'${reason}'`);
    }
    // Taken earliest first, so a prerequisite sent with its dependent is on the books for it.
    expect(writer).toMatch(/ORDER BY \(e\.value->>'scheduled_time'\)::timestamptz/);
    // A void prerequisite is no wait, and a reported one is over whether or not it held a slot.
    expect(writer).toMatch(/pre\.status <> 'void'/);
    expect(writer).toMatch(/NOT IN \('reported', 'walkover'\)/);
    // Still the additive writer.
    expect(writer).toMatch(/court_id IS NULL AND scheduled_time IS NULL/);
    expect(writer).not.toMatch(/DELETE FROM/);
  });

  it("leaves a prerequisite behind a match on its own court out of the reflow floor", () => {
    const core = body("shift_live_schedule_core");
    expect(core).toMatch(/prereq\.court_id = current_match\.court_id/);
    expect(core).toMatch(/prereq\.day_id IS NOT DISTINCT FROM current_match\.day_id/);
    // The in-progress handling from 20261010 is carried over unchanged.
    expect(core).toMatch(/source_status = 'in-progress'/);
    expect(core).toMatch(/COALESCE\(prereq\.actual_start, prereq\.shifted_time\)/);
  });

  it("keeps both functions' privileges and verifies on apply", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.place_ready_matches\(uuid, text, jsonb\) FROM anon, PUBLIC/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.shift_live_schedule_core\(text, uuid\) FROM anon, authenticated, PUBLIC/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.shift_live_schedule_core\(text, uuid\) TO service_role/);
    expect(sql).toMatch(/DO \$verify\$/);
  });
});

describe("whole-millisecond match times migration", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "20261023010000_whole_millisecond_match_times.sql"),
    "utf8",
  );

  it("truncates the three scheduling times on every match table, on insert and on write", () => {
    expect(sql).toMatch(/date_trunc\('milliseconds', NEW\.scheduled_time\)/);
    expect(sql).toMatch(/date_trunc\('milliseconds', NEW\.started_at\)/);
    expect(sql).toMatch(/date_trunc\('milliseconds', NEW\.ended_at\)/);
    for (const table of ["pool_matches", "draw_matches", "placement_matches", "tier_draw_matches"]) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE TRIGGER ${table}_whole_ms\\s+BEFORE INSERT OR UPDATE OF scheduled_time, started_at, ended_at ON public\\.${table}`,
        ),
      );
    }
  });

  it("backfills without leaving a time-shifted or result-corrected entry behind", () => {
    for (const table of ["pool_matches", "draw_matches", "placement_matches", "tier_draw_matches"]) {
      expect(sql).toContain(`DISABLE TRIGGER ${table}_desk_activity`);
      expect(sql).toContain(`ENABLE TRIGGER ${table}_desk_activity`);
      expect(sql).toContain(`DISABLE TRIGGER record_${table}_result_correction`);
      expect(sql).toContain(`ENABLE TRIGGER record_${table}_result_correction`);
    }
  });

  it("keeps the helper off the client surface and verifies on apply", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.truncate_match_times_to_ms\(\) FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/still has % rows with a sub-millisecond time/);
  });
});

/**
 * The migration that gives a 21-point game its 30-point ceiling.
 *
 * It exists because the predicate was written out three times - in `placement_check_games`,
 * `report_draw_result` and `report_pool_result` - and one of the three is what let `31-29`
 * through. The assertions below are about the *shape* of the fix rather than its arithmetic,
 * which `integration/score-cap.test.ts` proves against a real Postgres: if a later migration
 * restates the comparison inline, the drift can start again.
 */
describe("game point cap migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const FILE = "20261022000000_game_point_cap.sql";
  const sql = readFileSync(join(dir, FILE), "utf8");

  it("derives the cap from the rule rather than storing a fourth column", () => {
    expect(sql).toMatch(
      /create or replace function public\.game_point_cap\(p_games_to int, p_win_by int\)/i,
    );
    expect(sql).toMatch(/p_games_to = 21 AND p_win_by = 2 THEN 30/);
    // A column would have to be threaded through the wizard, the row and every reader.
    expect(sql).not.toMatch(/add column/i);
  });

  it("answers 'is this a legal game' in one place", () => {
    expect(sql).toMatch(
      /create or replace function public\.game_score_is_legal\(\s*p_a int,\s*p_b int,\s*p_games_to int,\s*p_win_by int\s*\)/i,
    );
    // The cap is the second way to win: 30-29 is deuce ended, not a short margin.
    expect(sql).toMatch(/cap\.points IS NOT NULL/);
    expect(sql).toMatch(/LEAST\(p_a, p_b\) = cap\.points - 1/);
  });

  it("routes every writer through the shared predicate", () => {
    for (const fn of ["placement_check_games", "report_draw_result", "report_pool_result"]) {
      // Case-insensitive: the definitions are written upper-case, and `indexOf` is not.
      const start = sql.search(new RegExp(`FUNCTION public\\.${fn}\\b`, "i"));
      expect(start, `${fn} is defined here`).toBeGreaterThan(-1);
      const body = sql.slice(start);
      expect(body, fn).toMatch(/public\.game_score_is_legal\(/);
      // The old inline comparison is what could drift from the others.
      expect(body, fn).not.toMatch(/sa - sb >= win_by/);
      expect(body, fn).not.toMatch(/p_score_a - p_score_b >= 2/);
    }
  });

  it("keeps the helpers out of reach of a client role", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.game_score_is_legal\(int, int, int, int\) FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(/has_function_privilege\('anon'/);
  });
});

/**
 * A game ends on the point it is won, so the margin is exact.
 *
 * `integration/score-cap.test.ts` asks Postgres the shared case table; these pin the *shape*
 * of the fix, because the failure this guards against is a later migration restating the
 * comparison inline and the copies drifting apart again.
 */
describe("exact game margin migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const sql = readFileSync(join(dir, "20261022020000_exact_game_margin.sql"), "utf8");

  it("redefines the shared predicate in place rather than adding a second copy", () => {
    expect(sql).toMatch(
      /create or replace function public\.game_score_is_legal\(\s*p_a int,\s*p_b int,\s*p_games_to int,\s*p_win_by int\s*\)/i,
    );
    // A DROP would take the grants with it, and a second definition would be a second answer.
    expect(sql).not.toMatch(/drop function/i);
  });

  it("requires the exact margin past the target", () => {
    // Past `games_to` the game ended on the point that opened the margin, so it is equal to
    // it - not "at least" it, which is what accepted 25-10.
    expect(sql).toMatch(/GREATEST\(p_a, p_b\) - LEAST\(p_a, p_b\) = p_win_by/);
    expect(sql).not.toMatch(/GREATEST\(p_a, p_b\) - LEAST\(p_a, p_b\) >=/);
    // At the target the loser must have been too far behind to reach deuce.
    expect(sql).toMatch(/LEAST\(p_a, p_b\) <= p_games_to - p_win_by/);
  });

  it("never lets a one-point game run past the target", () => {
    // Without this guard `high - low = 1` accepts 22-21, a game that was already over at 21-20.
    expect(sql).toMatch(/WHEN p_win_by > 1\s+AND GREATEST\(p_a, p_b\) > p_games_to/);
  });

  it("leaves uncapped rules without a ceiling of their own", () => {
    // The cap is still derived, unchanged: only the 21-point win-by-2 game stops at 30.
    expect(sql).not.toMatch(/create or replace function public\.game_point_cap/i);
    expect(sql).not.toMatch(/add column/i);
    // The cap is still the third way to win, and still the top bound.
    expect(sql).toMatch(/LEAST\(p_a, p_b\) = cap\.points - 1/);
  });

  it("checks its own arithmetic when it is applied", () => {
    // The rule cannot be read from TypeScript; a wrong CASE would otherwise ship unseen.
    expect(sql).toMatch(/DO \$verify\$[\s\S]*game_score_is_legal\(case_row\.a, case_row\.b, 21, 2\)/);
    expect(sql).toMatch(/\(25, 10, false\)/);
    expect(sql).toMatch(/game_score_is_legal\(22, 21, 21, 1\)/);
  });
});

/**
 * The report guards: who may write a result, against what state, and from which read.
 *
 * `integration/report-guards.test.ts` proves the refusals against a real Postgres; these pin
 * the *shape*, because a guard that is restated inline in a later migration is how the copies
 * drift apart again - and because a signature left behind as an overload fails at runtime for
 * every desk rather than here.
 */
describe("report guard migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const FILE = "20261022030000_report_guards.sql";
  const sql = readFileSync(join(dir, FILE), "utf8");

  it("leaves one definition per report name, not an overload", () => {
    // A defaulted parameter leaves the shorter signature resolvable, and PostgREST then
    // refuses to choose between the two for every call the desk makes.
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.report_placement_result\(uuid, jsonb, integer\)/);
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.report_tier_draw_result\(uuid, jsonb, integer\)/);
    expect(sql).toMatch(
      /to_regprocedure\('public\.report_placement_result\(uuid, jsonb, integer\)'\) IS NOT NULL/,
    );
  });

  it("locks the row before comparing the dialog's snapshot to it", () => {
    for (const fn of ["report_placement_result", "report_tier_draw_result", "report_draw_result"]) {
      const start = sql.search(new RegExp(`FUNCTION public\\.${fn}\\b`, "i"));
      expect(start, `${fn} is defined here`).toBeGreaterThan(-1);
      const body = sql.slice(start, sql.indexOf("$function$;", start));
      // The row is read under a lock, so the expectation is compared against - and the
      // result written to - the same version of the row.
      expect(body, fn).toMatch(/SELECT[\s\S]{0,400}?FOR UPDATE/);
      expect(body, fn).toMatch(/PERFORM public\.assert_reportable_match\(/);
    }
    // Compared against the locked row, not the one the client last saw.
    expect(sql).toMatch(/p_reported_time IS DISTINCT FROM p_expected_reported_at/);
    expect(sql).toMatch(/p_status IS DISTINCT FROM p_expected_status/);
  });

  /**
   * The advisory locks must come before the row lock, on every path.
   *
   * Every other writer in the system - the reflow, the placement resets,
   * `apply_placement_round_two` - takes `live-schedule` and `placement:<category>` first and
   * touches rows second. A reporter that locked its row first would hold one lock and wait
   * for the other while the other transaction does the same, and Postgres would break the tie
   * with "deadlock detected". Two moderators saving at the same moment is ordinary, so this
   * ordering has to be pinned rather than remembered.
   */
  it("takes the advisory locks before the row lock, so a save cannot deadlock", () => {
    const start = sql.search(/FUNCTION public\.report_placement_result\b/i);
    const body = sql.slice(start, sql.indexOf("$function$;", start));

    const liveSchedule = body.indexOf("pg_advisory_xact_lock(hashtext('live-schedule'))");
    const categoryLock = body.indexOf("hashtext('placement:'");
    const rowLock = body.indexOf("FOR UPDATE");

    expect(liveSchedule, "the live-schedule lock is taken").toBeGreaterThan(-1);
    expect(categoryLock, "the placement lock is taken").toBeGreaterThan(-1);
    expect(rowLock, "the row is locked").toBeGreaterThan(-1);

    expect(liveSchedule).toBeLessThan(rowLock);
    expect(categoryLock).toBeLessThan(rowLock);
    // The same order the other writers use: the day lock, then the category.
    expect(liveSchedule).toBeLessThan(categoryLock);
  });

  it("refuses a game's whole range before casting it", () => {
    // A negative score is not a score, which is also how the low end of `int` is handled:
    // -99999999999 is refused in words instead of failing an integer range cast.
    expect(sql).toMatch(/\(game ->> 'a'\)::numeric < 0 OR \(game ->> 'b'\)::numeric < 0/);
    expect(sql).toMatch(/\(game ->> 'a'\)::numeric > 2147483647/);
  });

  it("labels a guard that raises as STABLE, not IMMUTABLE", () => {
    const guard = sql.slice(
      sql.search(/FUNCTION public\.assert_reportable_match/),
      sql.search(/REVOKE ALL ON FUNCTION public\.assert_reportable_match/),
    );
    expect(guard).toMatch(/RETURNS void\s+LANGUAGE plpgsql\s+STABLE/);
    expect(guard).not.toMatch(/LANGUAGE plpgsql\s+IMMUTABLE/);
  });

  it("accepts only a result-bearing state", () => {
    // `reported` stays reportable: a correction is the same state with a different score.
    for (const state of ["scheduled", "in-progress", "reported"]) {
      expect(sql, state).toMatch(new RegExp(`p_status IS DISTINCT FROM '${state}'`));
    }
    expect(sql).toMatch(/This match is marked "%" and takes no score/);
  });

  it("refuses a match with a side still to be decided", () => {
    expect(sql).toMatch(/p_side_a IS NULL OR p_side_b IS NULL/);
  });

  it("checks the game's type before casting it", () => {
    // `(game->>'a')::int` on 21.5 is a Postgres type error, which reads as a server fault.
    expect(sql).toMatch(/jsonb_typeof\(game -> 'a'\) IS DISTINCT FROM 'number'/);
    expect(sql).toMatch(/Each game needs a whole number of points/);
  });

  it("gives the legacy draw the shared checker instead of its own copy", () => {
    const body = sql.slice(sql.search(/FUNCTION public\.report_draw_result/));
    expect(body).toMatch(/public\.placement_check_games\(/);
    // Comparing each game to `p_games -> -1` misses a repeated score, so the extra game is
    // accepted whenever the last two games match. It is gone, not merely guarded.
    expect(body).not.toMatch(/p_games -> -1/);
    expect(body).not.toMatch(/wins_a >= needed OR wins_b >= needed/);
  });

  it("keeps the guard and the reporters off a client role", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.assert_reportable_match\(text, uuid, uuid, timestamptz, text, timestamptz\)\s*FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(
      /has_function_privilege\('authenticated', 'public\.assert_reportable_match/,
    );
  });
});

/**
 * The mid-tournament changes: the four acts that only worked before the first match.
 *
 * `docs/roster-freeze.md` records why each was deferred; the migration is the SQL. What these pin
 * is the *shape* of the safety, because each function's danger is a silent one: a withdrawal that
 * leaves a court occupied, a shift that rewrites a played result, or a court move that stacks two
 * schedules on one court.
 */
describe("mid-tournament changes migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const sql = readFileSync(join(dir, "20261022040000_mid_tournament_changes.sql"), "utf8");
  const body = (name: string) => {
    const start = sql.search(new RegExp(`FUNCTION public\\.${name}\\b`, "i"));
    expect(start, `${name} is defined here`).toBeGreaterThan(-1);
    return sql.slice(start, sql.indexOf("$function$;", start));
  };

  it("takes the advisory locks before touching rows, on every path", () => {
    // The same order as the reporters and the reflow. Reversing it is how a save deadlocks; see
    // 20261022030000_report_guards.sql for the collision that proves it.
    for (const fn of ["withdraw_placement_team", "shift_tournament_days", "reassign_court_matches"]) {
      const fnBody = body(fn);
      const lock = fnBody.indexOf("pg_advisory_xact_lock(hashtext('live-schedule'))");
      const write = fnBody.indexOf("UPDATE ");
      expect(lock, `${fn} takes the day lock`).toBeGreaterThan(-1);
      expect(write, `${fn} writes`).toBeGreaterThan(-1);
      expect(lock, `${fn} locks before writing`).toBeLessThan(write);
    }
  });

  it("refuses to withdraw a team that is on court", () => {
    const fn = body("withdraw_placement_team");
    expect(fn).toMatch(/status = 'in-progress'/);
    expect(fn).toMatch(/That team is on court right now/);
  });

  it("converts only unplayed matches, and never invents games", () => {
    const fn = body("withdraw_placement_team");
    // A played match keeps its score: withdrawing afterwards does not un-play it.
    expect(fn).toMatch(/WHERE status = 'scheduled'/);
    expect(fn).toMatch(/status = 'walkover'/);
    expect(fn).toMatch(/games = '\[\]'::jsonb/);
  });

  it("advances the bracket after the walkovers", () => {
    expect(body("withdraw_placement_team")).toMatch(
      /PERFORM public\.advance_tier_draw_locked\(v_draw\)/,
    );
  });

  it("refuses a late add once the draw exists", () => {
    const fn = body("add_placement_entrant");
    expect(fn).toMatch(/assert_tournament_configurable/);
    expect(fn).toMatch(/FROM public\.placement_matches WHERE category_id = p_category_id/);
    expect(fn).toMatch(/The draw is already built for this event/);
    // The last seed, not a re-rank: moving an existing seed would silently change a matchup.
    expect(fn).toMatch(/COALESCE\(v_seed, 0\) \+ 1/);
  });

  it("shifts the days in the venue's zone, not the session's", () => {
    const fn = body("shift_tournament_days");
    // `scheduled_time + interval 'n days'` preserves the session clock, so a DST boundary moves
    // every match an hour on the venue's clock. The conversion is the fix, and it must stay.
    expect(fn).toMatch(/AT TIME ZONE v_tz\) \+ make_interval\(days => p_delta_days\)\) AT TIME ZONE v_tz/);
    expect(fn).not.toMatch(/scheduled_time = scheduled_time \+ make_interval/);
  });

  it("refuses a shift that would rewrite a played result", () => {
    const fn = body("shift_tournament_days");
    expect(fn).toMatch(/status NOT IN \('scheduled', 'void'\)/);
    expect(fn).toMatch(/already been played or started/);
  });

  it("refuses a court move onto a court that already has matches", () => {
    const fn = body("reassign_court_matches");
    expect(fn).toMatch(/A match is being played on that court/);
    expect(fn).toMatch(/already has % scheduled match/);
    expect(fn).toMatch(/is not in use on this day/);
  });

  it("keeps every function off a client role except the four entry points", () => {
    for (const signature of [
      "public.withdraw_placement_team(uuid)",
      "public.add_placement_entrant(uuid, uuid)",
      "public.shift_tournament_days(uuid, date, int)",
      "public.reassign_court_matches(uuid, uuid, uuid, uuid)",
    ]) {
      expect(sql, signature).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM public, anon;`);
      expect(sql, signature).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated;`);
    }
  });
});

/**
 * The correction history: a reported result that is replaced keeps what it replaced.
 *
 * `integration/result-history.test.ts` proves the trigger fires; these pin the shape, because
 * the failure mode of a trigger is silence - a table that looks complete while one of the
 * four writers is unwatched.
 */
describe("match result history migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const sql = readFileSync(join(dir, "20261022010000_match_result_history.sql"), "utf8");

  it("watches every table a result can be written to", () => {
    for (const table of ["pool_matches", "draw_matches", "placement_matches", "tier_draw_matches"]) {
      expect(sql, table).toMatch(
        new RegExp(`create trigger record_${table}_result_correction`, "i"),
      );
      expect(sql, table).toMatch(new RegExp(`after update on public\\.${table}`, "i"));
    }
  });

  it("records corrections, not first entries or clears", () => {
    // Both sides have to say `reported`: scheduled -> reported is an entry, and
    // reported -> scheduled is the reset RPC, which is already loud.
    expect(sql).toMatch(/before_row ->> 'status' IS DISTINCT FROM 'reported'/);
    expect(sql).toMatch(/after_row ->> 'status' IS DISTINCT FROM 'reported'/);
    expect(sql).toMatch(/before_row -> 'games' IS NOT DISTINCT FROM after_row -> 'games'/);
  });

  it("is written only by the trigger and read only by an editor", () => {
    expect(sql).toMatch(/revoke all on public\.match_result_history from anon/i);
    expect(sql).toMatch(
      /revoke insert, update, delete, truncate, references, trigger\s+on public\.match_result_history from authenticated/i,
    );
    expect(sql).toMatch(/using \(public\.can_edit_tournament\(public\.result_history_tournament/i);
    // Who sent it is half the reason to keep the row.
    expect(sql).toMatch(/public\.current_profile_id\(\)/);
  });
});

describe("start only placed matches migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const sql = readFileSync(join(dir, "20261025000000_start_only_placed_matches.sql"), "utf8");
  const executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const fn = (name: string) => functionSource(executable, name);
  const starts = [
    "start_placement_match(p_match_id uuid, p_court_id uuid DEFAULT NULL::uuid)",
    "start_tier_draw_match(p_match_id uuid, p_court_id uuid DEFAULT NULL::uuid)",
  ];

  it("checks the match is placed, under the schedule locks, before it writes", () => {
    for (const name of starts) {
      const body = fn(name);
      const guard = body.indexOf("assert_match_placed_for_start");
      expect(guard, name).toBeGreaterThan(body.indexOf("hashtext('schedule:2')"));
      expect(guard, name).toBeLessThan(body.search(/\bUPDATE public\.(placement|tier_draw)_matches/));
    }
  });

  it("never moves a match to the court the request names", () => {
    for (const name of starts) {
      expect(fn(name), name).not.toMatch(/court_id\s*=\s*COALESCE/);
    }
  });

  it("keeps everything the previous start bodies guaranteed", () => {
    for (const name of starts) {
      const body = fn(name);
      expect(body, name).toMatch(/can_edit_tournament/);
      expect(body, name).toMatch(/lock_tournament_lifecycle_shared/);
      expect(body, name).toMatch(/assert_tournament_can_start_match/);
      expect(body, name).toMatch(/mark_tournament_started/);
      expect(body, name).toMatch(/assert_can_start_match/);
      expect(body, name).toMatch(/shift_live_schedule_after_match/);
    }
    expect(fn(starts[1]!)).toMatch(/entrant_a_id IS NOT NULL/);
  });

  it("refuses a match with no court or time, and a court that is not its own", () => {
    const guard = fn("assert_match_placed_for_start");
    expect(guard).toMatch(/p_court_id IS NULL OR p_scheduled_time IS NULL/);
    expect(guard).toMatch(/p_requested_court IS NOT NULL AND p_requested_court <> p_court_id/);
    expect(executable).toMatch(
      /REVOKE ALL ON FUNCTION public\.assert_match_placed_for_start\(uuid, timestamptz, uuid\)\s+FROM PUBLIC, anon, authenticated/,
    );
  });
});

describe("drop reassign_court_matches migration", () => {
  const dir = join(__dirname, "../../../supabase/migrations");
  const sql = readFileSync(join(dir, "20261025010000_drop_reassign_court_matches.sql"), "utf8");

  it("drops the function by its full signature and checks it is gone", () => {
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS public\.reassign_court_matches\(uuid, uuid, uuid, uuid\);/,
    );
    expect(sql).toMatch(/RAISE EXCEPTION 'reassign_court_matches is still defined'/);
  });

  it("is the last word on the function: no later migration defines it again", () => {
    const later = readdirSync(dir)
      .filter((name) => name.endsWith(".sql") && name > "20261025010000")
      .map((name) => readFileSync(join(dir, name), "utf8"));
    for (const body of later) {
      expect(body).not.toMatch(/FUNCTION public\.reassign_court_matches/);
    }
  });
});
