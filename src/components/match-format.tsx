import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SCORING_PRESETS,
  gamesNeededToWin,
  isOddBestOf,
  presetForRule,
  scoringRuleLabel,
  suggestedSlotMinutes,
  type ScoringRule,
} from "@/lib/tournament/scoring";

/**
 * One stage's whole match format: how a match is won, how long it holds a court, and
 * how much rest a player gets before the next one.
 *
 * These three describe a single match, but they used to be split across a "Match
 * timings" grid and a separate "Scoring" block. That let the two contradict each
 * other without saying so: the rule on screen would suggest 45 minutes while the
 * duration box a section above held 25. A host had no way to see the disagreement,
 * and nothing on either side was wrong on its own.
 *
 * Edit them together and the card can reconcile the suggestion against the duration
 * it finds, which turns a silent inconsistency into a one-click fix. Presets still
 * set both at once, and now that lands in one card instead of two.
 *
 * Scoring numbers are held as text while they are typed, so a half-entered value is
 * never parsed into the rule; the prop is authoritative once a field is left.
 */
export function MatchFormatCard({
  title,
  detail,
  rule,
  slotMinutes,
  restMinutes,
  slotMin,
  restMin,
  slotText,
  restText,
  disabled,
  onRule,
  onPreset,
  onSlotChange,
  onRestChange,
  onSlotCommit,
  onRestCommit,
}: {
  title: string;
  detail: string;
  rule: ScoringRule;
  /** The saved duration, used for the suggestion comparison. */
  slotMinutes: number;
  restMinutes: number;
  slotMin: number;
  restMin: number;
  /** In-progress text for the duration and rest boxes. */
  slotText: string;
  restText: string;
  disabled: boolean;
  /** A hand-edited rule. */
  onRule: (rule: ScoringRule) => void;
  /** A preset, with the slot duration it suggests so both can be saved together. */
  onPreset: (rule: ScoringRule, slotMinutes: number) => void;
  onSlotChange: (raw: string) => void;
  onRestChange: (raw: string) => void;
  onSlotCommit: (raw: string) => void;
  onRestCommit: (raw: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState(false);
  const activePreset = presetForRule(rule);
  const needed = gamesNeededToWin(rule);
  const suggested = suggestedSlotMinutes(rule);
  const mismatch = suggested !== slotMinutes;

  /**
   * Drops the in-progress text whenever the rule itself changes.
   *
   * A committed edit is left in the box until the saved rule catches up, so the
   * value the host typed is never replaced by the old one for the moment the update
   * is in flight. Clearing on the rule's own change is what stops that from masking a
   * preset: picking "Single game to 15" must move the box to 15 even if a stale 21 is
   * still sitting in it.
   */
  const signature = `${rule.gamesTo}:${rule.winBy}:${rule.bestOf}`;
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    setDrafts({});
  }, [signature]);

  const fieldText = (key: string, value: number) => drafts[key] ?? String(value);

  const commitField = (key: "gamesTo" | "winBy" | "bestOf", raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    const valid =
      Number.isFinite(parsed) &&
      (key === "bestOf"
        ? isOddBestOf(parsed)
        : key === "gamesTo"
          ? parsed >= 1 && parsed <= 99
          : parsed >= 1 && parsed <= 20);
    if (!valid) {
      // Revert to what is actually stored rather than leaving a rejected edit on screen.
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    if (parsed === rule[key]) {
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    onRule({ ...rule, [key]: parsed });
  };

  /**
   * Presets answer the common case, so the three raw numbers stay behind a toggle
   * rather than greeting every host with a scoring table. An edited rule opens the
   * toggle by itself, or the mismatch it created would be invisible.
   */
  useEffect(() => {
    if (activePreset.custom) setShowCustom(true);
  }, [activePreset.custom]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-display text-sm font-semibold">{title}</p>
        <Badge variant={activePreset.custom ? "secondary" : "outline"}>
          {activePreset.custom ? "Custom" : activePreset.label}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{detail}</p>

      <div className="flex flex-wrap gap-2">
        {SCORING_PRESETS.filter((preset) => !preset.custom).map((preset) => (
          <Button
            key={preset.id}
            size="sm"
            variant={activePreset.id === preset.id ? "secondary" : "outline"}
            disabled={disabled}
            onClick={() =>
              onPreset(
                { gamesTo: preset.gamesTo, winBy: preset.winBy, bestOf: preset.bestOf },
                preset.suggestedMinutes,
              )
            }
          >
            {preset.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          aria-expanded={showCustom}
          onClick={() => setShowCustom((value) => !value)}
        >
          {showCustom ? "Hide custom" : "Custom"}
        </Button>
      </div>

      {showCustom ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${title}-games-to`} className="text-xs text-muted-foreground">
              Game to
            </Label>
            <Input
              id={`${title}-games-to`}
              type="number"
              min={1}
              max={99}
              className="h-9"
              disabled={disabled}
              value={fieldText("gamesTo", rule.gamesTo)}
              onChange={(event) => setDrafts((prev) => ({ ...prev, gamesTo: event.target.value }))}
              onBlur={(event) => commitField("gamesTo", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${title}-win-by`} className="text-xs text-muted-foreground">
              Win by
            </Label>
            <Input
              id={`${title}-win-by`}
              type="number"
              min={1}
              max={20}
              className="h-9"
              disabled={disabled}
              value={fieldText("winBy", rule.winBy)}
              onChange={(event) => setDrafts((prev) => ({ ...prev, winBy: event.target.value }))}
              onBlur={(event) => commitField("winBy", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${title}-best-of`} className="text-xs text-muted-foreground">
              Best of
            </Label>
            <Input
              id={`${title}-best-of`}
              type="number"
              min={1}
              max={9}
              step={2}
              className="h-9"
              disabled={disabled}
              value={fieldText("bestOf", rule.bestOf)}
              onChange={(event) => setDrafts((prev) => ({ ...prev, bestOf: event.target.value }))}
              onBlur={(event) => commitField("bestOf", event.target.value)}
            />
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${title}-slot`} className="text-xs text-muted-foreground">
            Match length
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={`${title}-slot`}
              type="number"
              min={slotMin}
              className="h-9 w-20"
              disabled={disabled}
              value={slotText}
              onChange={(event) => onSlotChange(event.target.value)}
              onBlur={(event) => onSlotCommit(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">min</span>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${title}-rest`} className="text-xs text-muted-foreground">
            Rest before the next match
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={`${title}-rest`}
              type="number"
              min={restMin}
              className="h-9 w-20"
              disabled={disabled}
              value={restText}
              onChange={(event) => onRestChange(event.target.value)}
              onBlur={(event) => onRestCommit(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">min</span>
          </div>
        </div>
      </div>

      {mismatch ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-warn-surface px-2.5 py-2 text-t4 text-warn-foreground">
          <span>
            {scoringRuleLabel(rule)} usually needs about {suggested} min, but this stage is set to{" "}
            {slotMinutes}.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-t4"
            disabled={disabled}
            onClick={() => onSlotCommit(String(suggested))}
          >
            Use {suggested} min
          </Button>
        </div>
      ) : (
        <p className="text-t4 text-muted-foreground">
          {scoringRuleLabel(rule)}. {needed} game{needed === 1 ? "" : "s"} wins the match, about{" "}
          {suggested} minutes each. Rest gap {restMinutes} min.
        </p>
      )}
    </div>
  );
}
