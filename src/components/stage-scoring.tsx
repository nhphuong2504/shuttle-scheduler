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
 * One stage's scoring rule: how a match is won, which is what a reported score is
 * validated against.
 *
 * This used to live in the setup wizard, which is the only reason it was captured
 * before the tournament existed. It sits beside the durations on the Schedule page
 * because the two describe the same match, and because the desk is the place that
 * finds out a rule needs adjusting.
 *
 * Numbers are held as text while they are being typed, so a half-entered value is
 * never parsed into the rule; the prop is authoritative once the field is left.
 */
export function StageScoring({
  title,
  detail,
  rule,
  disabled,
  onRule,
  onPreset,
}: {
  title: string;
  detail: string;
  rule: ScoringRule;
  disabled: boolean;
  /** A hand-edited rule. */
  onRule: (rule: ScoringRule) => void;
  /** A preset, with the slot duration it suggests so both can be saved together. */
  onPreset: (rule: ScoringRule, slotMinutes: number) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const activePreset = presetForRule(rule);
  const needed = gamesNeededToWin(rule);
  const suggested = suggestedSlotMinutes(rule);

  /**
   * Drops the in-progress text whenever the rule itself changes.
   *
   * A committed edit is left in the box until the saved rule catches up, so the
   * value the host typed is never replaced by the old one for the moment the update
   * is in flight. Clearing on the rule's own change is what stops that from
   * masking a preset: picking "Single game to 15" must move the box to 15 even if
   * a stale 21 is still sitting in it.
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </p>
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
      </div>

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

      <p className="text-[11px] text-muted-foreground">
        {scoringRuleLabel(rule)}. {needed} game{needed === 1 ? "" : "s"} wins the match. This
        scoring choice suggests {suggested} minutes a match.
      </p>
    </div>
  );
}
