export function timeLabel(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function minutesSince(value: string | Date | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  return Math.floor((now - d.getTime()) / 60000);
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export interface GameScore {
  a: number;
  b: number;
}

export function parseGames(value: unknown): GameScore[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((g): g is { a: number; b: number } => !!g && typeof g === "object" && "a" in g && "b" in g)
    .map((g) => ({ a: Number(g.a), b: Number(g.b) }));
}

export function gamesWinner(games: GameScore[]): "a" | "b" | null {
  let a = 0;
  let b = 0;
  for (const g of games) {
    if (g.a > g.b) a++;
    else if (g.b > g.a) b++;
  }
  if (a >= 2) return "a";
  if (b >= 2) return "b";
  if (games.length === 1 && a === 1) return "a";
  if (games.length === 1 && b === 1) return "b";
  return null;
}

export function gamesLabel(games: GameScore[]): string {
  if (!games.length) return "—";
  return games.map((g) => `${g.a}-${g.b}`).join(", ");
}
