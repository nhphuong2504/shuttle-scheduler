import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSession } from "@/hooks/useSession";
import { createPlayer, createTeam, deleteTeam, setTeamWithdrawn } from "@/lib/tournament/actions";
import { indexBy, teamLabel, useCategories, usePlayers, useTeams } from "@/lib/tournament/data";

export const Route = createFileRoute("/registration")({
  head: () => ({
    meta: [
      { title: "Registration | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content: "Register players and doubles pairs across the four badminton categories, capped at two per player.",
      },
      { property: "og:title", content: "Registration | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content: "Register players and doubles pairs across the four badminton categories, capped at two per player.",
      },
    ],
  }),
  component: RegistrationPage,
});

function RegistrationPage() {
  const qc = useQueryClient();
  const { canRegister } = useSession();
  const { data: categories } = useCategories();
  const { data: players } = usePlayers();
  const { data: teams } = useTeams();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<string>("");

  const [categoryId, setCategoryId] = useState<string>("");
  const [p1, setP1] = useState<string>("");
  const [p2, setP2] = useState<string>("");

  const playerMap = useMemo(() => indexBy(players), [players]);
  const category = (categories ?? []).find((c) => c.id === categoryId);
  const isPair = category?.entry_type === "pair";

  const categoryCount = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const t of teams ?? []) {
      for (const pid of [t.player_1_id, t.player_2_id]) {
        if (!pid) continue;
        const set = map.get(pid) ?? new Set<string>();
        set.add(t.category_id);
        map.set(pid, set);
      }
    }
    return map;
  }, [teams]);

  const atCap = (playerId: string) => {
    const set = categoryCount.get(playerId);
    if (!set) return false;
    return set.size >= 2 && !set.has(categoryId);
  };

  const refresh = () => {
    qc.invalidateQueries();
  };

  const addPlayer = async () => {
    try {
      await createPlayer({ name, email, phone, gender });
      setName("");
      setEmail("");
      setPhone("");
      setGender("");
      toast.success("Player added");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add player");
    }
  };

  const addEntry = async () => {
    try {
      if (!categoryId || !p1) return;
      if (isPair && !p2) throw new Error("This category needs a pair — pick both players.");
      if (isPair && p1 === p2) throw new Error("A pair needs two different players.");
      await createTeam({ categoryId, player1: p1, player2: isPair ? p2 : null });
      setP1("");
      setP2("");
      toast.success("Entry added");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add entry");
    }
  };

  const eligible = (players ?? []).filter((p) => !atCap(p.id));

  return (
    <AppShell
      title="Registration"
      subtitle="Each player may enter a maximum of two categories. A third entry is rejected outright."
    >
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <div className="space-y-4">
          <Panel title="Add player">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="pname">Name</Label>
                <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pemail">Email</Label>
                <Input id="pemail" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pphone">Phone</Label>
                <Input id="pphone" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Gender</Label>
                <Select value={gender} onValueChange={setGender}>
                  <SelectTrigger>
                    <SelectValue placeholder="Required for category checks" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="M">Male</SelectItem>
                    <SelectItem value="F">Female</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button className="w-full" disabled={!canRegister || !name.trim()} onClick={addPlayer}>
                Add player
              </Button>
            </div>
          </Panel>

          <Panel title="Add entry">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={categoryId} onValueChange={setCategoryId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose category" />
                  </SelectTrigger>
                  <SelectContent>
                    {(categories ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.code} — {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{isPair ? "Player 1" : "Player"}</Label>
                <PlayerSelect value={p1} onChange={setP1} options={eligible} />
              </div>
              {isPair ? (
                <div className="space-y-1.5">
                  <Label>Player 2</Label>
                  <PlayerSelect value={p2} onChange={setP2} options={eligible.filter((p) => p.id !== p1)} />
                </div>
              ) : null}
              <Button className="w-full" disabled={!canRegister || !categoryId || !p1} onClick={addEntry}>
                Add entry
              </Button>
              <p className="text-xs text-muted-foreground">
                Players already in two other categories are hidden from these lists.
              </p>
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          {(categories ?? []).map((c) => {
            const list = (teams ?? []).filter((t) => t.category_id === c.id);
            return (
              <Panel
                key={c.id}
                title={`${c.code} — ${c.name}`}
                right={<span className="font-score text-xs text-muted-foreground">{list.length} entries</span>}
              >
                {list.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No entries yet.</p>
                ) : (
                  <ul className="divide-y divide-hairline">
                    {list.map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span className={t.withdrawn ? "text-muted-foreground line-through" : ""}>
                          {teamLabel(t, playerMap)}
                        </span>
                        <span className="flex gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!canRegister}
                            onClick={async () => {
                              await setTeamWithdrawn(t.id, !t.withdrawn);
                              refresh();
                            }}
                          >
                            {t.withdrawn ? "Reinstate" : "Withdraw"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!canRegister}
                            onClick={async () => {
                              try {
                                await deleteTeam(t.id);
                                refresh();
                              } catch (error) {
                                toast.error(error instanceof Error ? error.message : "Could not remove entry");
                              }
                            }}
                          >
                            Remove
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}

function PlayerSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; name: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Choose player" />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {options.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
