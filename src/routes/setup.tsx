import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, EmptyState, Panel, StatTile } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/hooks/useSession";
import { createTournament, type TournamentCategoryInput } from "@/lib/tournament/actions";
import { useActiveTournament, useCourts, useTournamentDays } from "@/lib/tournament/data";

export const Route = createFileRoute("/setup")({
  head: () => ({
    meta: [
      { title: "New tournament | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content:
          "Create a tournament: name, day count, court count, start date and the active categories.",
      },
      { property: "og:title", content: "New tournament | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content:
          "Create a tournament: name, day count, court count, start date and the active categories.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SetupPage,
});

/** The four categories the desk has always run, offered as the starting point. */
const CATEGORY_TEMPLATES = [
  { code: "MS", name: "Men's Singles", entryType: "individual", sortOrder: 1 },
  { code: "MD", name: "Men's Doubles", entryType: "pair", sortOrder: 2 },
  { code: "WD", name: "Women's Doubles", entryType: "pair", sortOrder: 3 },
  { code: "XD", name: "Mixed Doubles", entryType: "pair", sortOrder: 4 },
] as const;

interface CategoryDraft {
  code: string;
  name: string;
  entryType: string;
  sortOrder: number;
  active: boolean;
  cap: string;
}

function defaultDrafts(): CategoryDraft[] {
  return CATEGORY_TEMPLATES.map((c) => ({ ...c, active: true, cap: "" }));
}

function todayIso() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function parseIntStrict(raw: string): number | null {
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || Number.isNaN(value)) return null;
  return value;
}

function SetupPage() {
  const qc = useQueryClient();
  const { isAdmin, canSchedule, signedIn } = useSession();
  const canCreate = isAdmin || canSchedule;

  const { data: activeTournament } = useActiveTournament();
  const { data: activeCourts } = useCourts();
  const { data: activeDays } = useTournamentDays();

  const [name, setName] = useState("");
  const [dayCount, setDayCount] = useState("2");
  const [courtCount, setCourtCount] = useState("8");
  const [startDate, setStartDate] = useState(todayIso);
  const [drafts, setDrafts] = useState<CategoryDraft[]>(defaultDrafts);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const setDraft = (code: string, patch: Partial<CategoryDraft>) =>
    setDrafts((rows) => rows.map((row) => (row.code === code ? { ...row, ...patch } : row)));

  const selected = drafts.filter((d) => d.active);

  const problems = useMemo(() => {
    const issues: string[] = [];
    const days = parseIntStrict(dayCount);
    const courts = parseIntStrict(courtCount);
    if (!name.trim()) issues.push("Give the tournament a name.");
    if (days == null || days < 1 || days > 7)
      issues.push("Day count must be a whole number from 1 to 7.");
    if (courts == null || courts < 1 || courts > 64)
      issues.push("Court count must be a whole number from 1 to 64.");
    if (!startDate) issues.push("Pick a start date.");
    if (selected.length === 0) issues.push("Switch on at least one category.");
    for (const draft of selected) {
      if (draft.cap.trim() === "") continue;
      const cap = parseIntStrict(draft.cap);
      if (cap == null || cap < 2)
        issues.push(`${draft.code} cap must be a whole number of 2 or more, or blank for no cap.`);
    }
    return issues;
  }, [name, dayCount, courtCount, startDate, selected]);

  const submit = async () => {
    if (problems.length) {
      toast.error(problems[0] ?? "Check the form.");
      return;
    }
    const categories: TournamentCategoryInput[] = selected.map((draft) => ({
      code: draft.code,
      name: draft.name,
      entryType: draft.entryType,
      sortOrder: draft.sortOrder,
      active: true,
      maxEntries: draft.cap.trim() === "" ? null : parseIntStrict(draft.cap),
    }));

    setBusy(true);
    try {
      const id = await createTournament({
        name,
        dayCount: parseIntStrict(dayCount) as number,
        courtCount: parseIntStrict(courtCount) as number,
        startDate,
        categories,
      });
      setCreatedId(id);
      await qc.invalidateQueries();
      toast.success("Tournament created and set active");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the tournament");
    } finally {
      setBusy(false);
    }
  };

  if (signedIn && !canCreate) {
    return (
      <AppShell
        title="New tournament"
        subtitle="Only admins and schedulers can create a tournament."
      >
        <Panel title="Not permitted">
          <p className="text-sm text-muted-foreground">
            Your account does not hold the admin or scheduler role. Ask an admin to grant it on the{" "}
            <Link
              to="/staff"
              className="font-semibold text-primary underline-offset-4 hover:underline"
            >
              staff
            </Link>{" "}
            page.
          </p>
        </Panel>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="New tournament"
      subtitle="A tournament owns its days, courts and categories. Everything else in the desk is scoped to it."
      actions={
        createdId ? (
          <>
            <Button size="sm" variant="outline" asChild>
              <Link to="/registration">Registration</Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/schedule">Build schedule</Link>
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Panel title="Basics">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tname">Tournament name</Label>
                <Input
                  id="tname"
                  value={name}
                  placeholder="City Open 2026"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="days">Days</Label>
                <Input
                  id="days"
                  type="number"
                  min={1}
                  max={7}
                  value={dayCount}
                  onChange={(e) => setDayCount(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="courts">Courts</Label>
                <Input
                  id="courts"
                  type="number"
                  min={1}
                  max={64}
                  value={courtCount}
                  onChange={(e) => setCourtCount(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="start">First day</Label>
                <Input
                  id="start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Courts are created as rows numbered 1..{parseIntStrict(courtCount) ?? "n"}. Days run
              on consecutive dates from the first day.
            </p>
          </Panel>

          <Panel title="Categories">
            <ul className="divide-y divide-hairline">
              {drafts.map((draft) => (
                <li key={draft.code} className="flex flex-wrap items-center gap-3 py-2.5">
                  <label className="flex min-w-[220px] items-center gap-2.5">
                    <Checkbox
                      checked={draft.active}
                      onCheckedChange={(checked) =>
                        setDraft(draft.code, { active: checked === true })
                      }
                    />
                    <span className="text-sm">
                      <span className="font-score font-semibold">{draft.code}</span>{" "}
                      <span className="text-muted-foreground">{draft.name}</span>
                    </span>
                  </label>
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`cap-${draft.code}`} className="text-xs text-muted-foreground">
                      Cap
                    </Label>
                    <Input
                      id={`cap-${draft.code}`}
                      className="w-24"
                      inputMode="numeric"
                      placeholder="none"
                      disabled={!draft.active}
                      value={draft.cap}
                      onChange={(e) => setDraft(draft.code, { cap: e.target.value })}
                    />
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              A cap is enforced when entries are added. Leave blank for uncapped.
            </p>
          </Panel>

          <Panel title="Create">
            {!canCreate ? (
              <p className="mb-3 text-xs text-warn-foreground">
                {signedIn
                  ? "Your account needs the admin or scheduler role to create a tournament."
                  : "Sign in at the desk before creating a tournament."}
              </p>
            ) : null}
            {problems.length ? (
              <ul className="mb-3 space-y-1 text-xs text-danger-foreground">
                {problems.map((issue) => (
                  <li key={issue}>• {issue}</li>
                ))}
              </ul>
            ) : (
              <p className="mb-3 text-xs text-muted-foreground">
                Ready: {selected.length} categor{selected.length === 1 ? "y" : "ies"},{" "}
                {parseIntStrict(courtCount) ?? 0} courts, {parseIntStrict(dayCount) ?? 0} days.
              </p>
            )}
            <Button
              className="w-full sm:w-auto"
              disabled={busy || problems.length > 0 || !canCreate}
              onClick={submit}
            >
              {busy ? "Creating…" : "Create tournament"}
            </Button>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Currently active">
            {activeTournament ? (
              <div className="space-y-1 text-sm">
                <p className="font-display font-semibold">{activeTournament.name}</p>
                <p className="text-muted-foreground">
                  {activeDays?.length ?? activeTournament.day_count} day(s) ·{" "}
                  {activeCourts?.length ?? 0} court(s)
                </p>
                {(activeDays ?? []).map((day) => (
                  <p key={day.id} className="font-score text-xs text-muted-foreground">
                    Day {day.day_number}: {day.date} · {day.start_time.slice(0, 5)}–
                    {day.end_time.slice(0, 5)}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No active tournament. The desk will stay empty until one is created.
              </p>
            )}
          </Panel>

          {createdId ? (
            <Panel title="Created">
              <p className="text-sm text-muted-foreground">
                The new tournament is now active. Register entries next, then build the group
                schedule on day 1.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" asChild>
                  <Link to="/registration">Open registration</Link>
                </Button>
                <Button size="sm" asChild>
                  <Link to="/schedule">Open schedule</Link>
                </Button>
              </div>
            </Panel>
          ) : (
            <Panel title="What this does">
              <ul className="space-y-2 text-xs text-muted-foreground">
                <li>Creates the tournament and switches it on as the active scope.</li>
                <li>Materialises one court row per court, numbered from 1.</li>
                <li>Creates one day row per day on consecutive dates, 09:00–18:30 by default.</li>
                <li>Creates only the categories you leave switched on.</li>
              </ul>
            </Panel>
          )}
        </div>
      </div>
    </AppShell>
  );
}
