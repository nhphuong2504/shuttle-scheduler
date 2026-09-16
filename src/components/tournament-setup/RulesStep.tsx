import { Panel } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BEST_OF_OPTIONS,
  SCORING_PRESETS,
  gamesNeededToWin,
  presetForRule,
  scoringRuleLabel,
  suggestedSlotMinutes,
  type ScoringRule,
} from "@/lib/tournament/scoring";
import type { DraftForm, RulesForm } from "./types";

interface StageConfig {
  key: "placement" | "knockout";
  title: string;
  detail: string;
  rule: ScoringRule;
  slotMinutes: number;
  restGapMinutes: number;
  onRule: (rule: ScoringRule) => void;
  onSlotMinutes: (minutes: number) => void;
  onRestGapMinutes: (minutes: number) => void;
  /** What the duration means, so the label is not just "duration". */
  slotLabel: string;
  restLabel: string;
}

export function RulesStep({
  form,
  onChange,
}: {
  form: DraftForm;
  onChange: (patch: Partial<DraftForm>) => void;
}) {
  const setRules = (patch: Partial<RulesForm>) => onChange({ rules: { ...form.rules, ...patch } });

  return (
    <div className="space-y-4">
      <Panel title="Scoring and scheduling are separate">
        <p className="text-xs text-muted-foreground">
          Scoring decides how a match is won. Duration decides how much court time it is given in
          the schedule. The system suggests a duration from the scoring choice, and the host can
          always override it.
        </p>
      </Panel>

      <StageRules
        key="placement"
        title="Placement stage"
        detail="The two rounds that sort entrants into draws. These matches are usually shorter."
        rule={form.rules.placementRule}
        slotMinutes={form.rules.placementSlotMinutes}
        restGapMinutes={form.rules.placementRestGapMinutes}
        onRule={(rule) => setRules({ placementRule: rule })}
        onSlotMinutes={(minutes) => setRules({ placementSlotMinutes: minutes })}
        onRestGapMinutes={(minutes) => setRules({ placementRestGapMinutes: minutes })}
        slotLabel="Minutes per placement match"
        restLabel="Minutes of rest between placement matches"
      />

      <StageRules
        key="knockout"
        title="Knockout draws"
        detail="A/B/C/D single elimination. These decide the medals, so they are usually longer."
        rule={form.rules.knockoutRule}
        slotMinutes={form.rules.knockoutSlotMinutes}
        restGapMinutes={form.rules.knockoutRestGapMinutes}
        onRule={(rule) => setRules({ knockoutRule: rule })}
        onSlotMinutes={(minutes) => setRules({ knockoutSlotMinutes: minutes })}
        onRestGapMinutes={(minutes) => setRules({ knockoutRestGapMinutes: minutes })}
        slotLabel="Minutes per knockout match"
        restLabel="Minutes of rest between a player's knockout matches"
      />
    </div>
  );
}

function StageRules({
  title,
  detail,
  rule,
  slotMinutes,
  restGapMinutes,
  onRule,
  onSlotMinutes,
  onRestGapMinutes,
  slotLabel,
  restLabel,
}: Omit<StageConfig, "key">) {
  const suggested = suggestedSlotMinutes(rule);
  const usingSuggestion = slotMinutes === suggested;
  const activePreset = presetForRule(rule);
  const needed = gamesNeededToWin(rule);

  const setRule = (patch: Partial<ScoringRule>) => onRule({ ...rule, ...patch });

  const choosePreset = (id: string) => {
    const preset = SCORING_PRESETS.find((entry) => entry.id === id);
    if (!preset) return;
    if (preset.custom) {
      // Keeping the current values reveals the editors without changing the rule.
      return;
    }
    onRule({ gamesTo: preset.gamesTo, winBy: preset.winBy, bestOf: preset.bestOf });
    // Following the preset also adopts its suggested duration.
    onSlotMinutes(preset.suggestedMinutes);
  };

  return (
    <Panel
      title={title}
      right={
        <Badge variant={activePreset.custom ? "secondary" : "outline"}>
          {activePreset.custom ? "Custom" : activePreset.label}
        </Badge>
      }
    >
      <p className="mb-3 text-xs text-muted-foreground">{detail}</p>

      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Preset
          </p>
          <div className="flex flex-wrap gap-2">
            {SCORING_PRESETS.filter((preset) => !preset.custom).map((preset) => {
              const active = presetForRule(rule).id === preset.id;
              return (
                <Button
                  key={preset.id}
                  size="sm"
                  variant={active ? "secondary" : "outline"}
                  onClick={() => choosePreset(preset.id)}
                >
                  {preset.label}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${title}-games-to`}>Game to</Label>
            <Input
              id={`${title}-games-to`}
              type="number"
              min={1}
              max={99}
              value={rule.gamesTo}
              onChange={(e) => setRule({ gamesTo: Number.parseInt(e.target.value, 10) || 0 })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${title}-win-by`}>Win by</Label>
            <Input
              id={`${title}-win-by`}
              type="number"
              min={1}
              max={20}
              value={rule.winBy}
              onChange={(e) => setRule({ winBy: Number.parseInt(e.target.value, 10) || 0 })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${title}-best-of`}>Best of</Label>
            <Select
              value={String(rule.bestOf)}
              onValueChange={(next) => setRule({ bestOf: Number.parseInt(next, 10) })}
            >
              <SelectTrigger id={`${title}-best-of`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BEST_OF_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option === 1 ? "Single game" : `Best of ${option}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {scoringRuleLabel(rule)}. {needed} game{needed === 1 ? "" : "s"} wins the match.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${title}-slot`}>{slotLabel}</Label>
            <div className="flex gap-2">
              <Input
                id={`${title}-slot`}
                type="number"
                min={5}
                max={240}
                value={slotMinutes}
                onChange={(e) => onSlotMinutes(Number.parseInt(e.target.value, 10) || 0)}
              />
              <Button
                variant="outline"
                disabled={usingSuggestion}
                onClick={() => onSlotMinutes(suggested)}
              >
                {usingSuggestion ? "Suggested" : `Use ${suggested}m`}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {usingSuggestion
                ? `Using the ${suggested} minutes suggested by this scoring choice.`
                : `Overridden. This scoring choice suggests ${suggested} minutes.`}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${title}-rest`}>{restLabel}</Label>
            <Input
              id={`${title}-rest`}
              type="number"
              min={0}
              max={120}
              value={restGapMinutes}
              onChange={(e) => onRestGapMinutes(Number.parseInt(e.target.value, 10) || 0)}
            />
            <p className="text-[11px] text-muted-foreground">
              A player may not be placed again until this gap has passed.
            </p>
          </div>
        </div>
      </div>
    </Panel>
  );
}
