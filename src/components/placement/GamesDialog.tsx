import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { gamesWinnerFor, type GameScore } from "@/lib/tournament/format";
import { gamesNeededToWin, scoringRuleLabel, type ScoringRule } from "@/lib/tournament/scoring";

/**
 * Game-by-game score entry for one match.
 *
 * Existing on the placement surface rather than reusing the desk's match dialog
 * because that one is wired to `pool_matches` / `draw_matches`. This one takes a
 * rule and returns games, so the same component serves the placement stage
 * (usually a single game) and the tier knockouts (usually best of three) without
 * either stage's rule leaking into the other.
 *
 * Both stages share one scoring rule config per tournament, read by the database
 * when the result is reported. The client validates against the same rule only to
 * give immediate feedback; the database is still the authority.
 */
export function GamesDialog({
  open,
  onOpenChange,
  title,
  sideLabels,
  rule,
  initialGames,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** [left, right] labels, so the inputs read as the actual entrants. */
  sideLabels: [string, string];
  rule: ScoringRule;
  initialGames?: GameScore[] | undefined;
  onSubmit: (games: GameScore[]) => Promise<void>;
}) {
  const needed = gamesNeededToWin(rule);
  const [games, setGames] = useState<GameScore[]>(() => startingGames(initialGames));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog is opened for a different match, so a stale score
  // from the previous match cannot be submitted by muscle memory.
  useEffect(() => {
    if (!open) return;
    setGames(startingGames(initialGames));
    setError(null);
    setSaving(false);
    // `initialGames` is rebuilt on each render by the caller, so depending on it
    // would reset the inputs mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const winner = gamesWinnerFor(games, rule);

  function update(index: number, side: "a" | "b", raw: string) {
    const value = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value)) return;
    setGames((current) =>
      current.map((game, i) => (i === index ? { ...game, [side]: Math.max(0, value) } : game)),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {scoringRuleLabel(rule)} — a side needs {needed} game{needed === 1 ? "" : "s"}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="grid grid-cols-[1.5rem_1fr_4rem_4rem] items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span />
            <span />
            <span className="text-center">{sideLabels[0]}</span>
            <span className="text-center">{sideLabels[1]}</span>
          </div>
          {games.map((game, index) => (
            <div key={index} className="grid grid-cols-[1.5rem_1fr_4rem_4rem] items-center gap-2">
              <span className="font-score text-xs text-muted-foreground">{index + 1}</span>
              <span className="truncate text-xs">Game {index + 1}</span>
              <Input
                className="h-8 text-center font-score"
                inputMode="numeric"
                type="number"
                min={0}
                value={game.a}
                onChange={(event) => update(index, "a", event.target.value)}
              />
              <Input
                className="h-8 text-center font-score"
                inputMode="numeric"
                type="number"
                min={0}
                value={game.b}
                onChange={(event) => update(index, "b", event.target.value)}
              />
            </div>
          ))}

          <div className="flex items-center gap-2">
            {games.length < rule.bestOf ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setGames((current) => [...current, { a: 0, b: 0 }])}
              >
                Add game
              </Button>
            ) : null}
            {games.length > 1 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setGames((current) => current.slice(0, -1))}
              >
                Remove game
              </Button>
            ) : null}
          </div>
        </div>

        {error ? (
          <p className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-xs font-medium text-danger-foreground">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            disabled={saving || !winner}
            onClick={async () => {
              if (!winner) return;
              setSaving(true);
              setError(null);
              try {
                await onSubmit(games);
                onOpenChange(false);
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : "Could not save the result.");
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving
              ? "Saving…"
              : winner
                ? `Save — ${sideLabels[winner === "a" ? 0 : 1]} wins`
                : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A single empty game, or the existing score when there is one.
 *
 * A best-of-three match starts with one row rather than three: the desk enters a
 * second game only when there is one, which mirrors how a match actually runs.
 */
function startingGames(initial?: GameScore[] | undefined): GameScore[] {
  if (initial && initial.length > 0) return initial.map((game) => ({ ...game }));
  return [{ a: 0, b: 0 }];
}
