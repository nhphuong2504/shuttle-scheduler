/**
 * Pool standings with tie-break order:
 * 1. wins
 * 2. head-to-head for a two-team tie
 * 3. mini-table wins / differential for multi-team ties
 * 4. overall point differential
 * 5. validated manual override
 */

export interface StandingMatch {
  team_a_id: string | null;
  team_b_id: string | null;
  score_a: number | null;
  score_b: number | null;
  winner_id: string | null;
  status: string;
}

export interface Standing {
  teamId: string;
  played: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  diff: number;
  rank: number;
  manualOverride: number | null;
}

const isReported = (m: StandingMatch) => m.status === "reported" || m.status === "walkover";

export function expectedPoolMatchCount(teamCount: number): number {
  return (teamCount * (teamCount - 1)) / 2;
}

export function poolPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function poolIsComplete(teamIds: string[], matches: StandingMatch[]): boolean {
  if (teamIds.length < 4) return false;
  const expected = expectedPoolMatchCount(teamIds.length);
  const seen = new Set<string>();
  let valid = 0;
  for (const m of matches) {
    if (!isReported(m) || !m.winner_id || !m.team_a_id || !m.team_b_id) continue;
    if (!teamIds.includes(m.team_a_id) || !teamIds.includes(m.team_b_id)) continue;
    if (m.team_a_id === m.team_b_id) continue;
    if (m.winner_id !== m.team_a_id && m.winner_id !== m.team_b_id) continue;
    const key = poolPairKey(m.team_a_id, m.team_b_id);
    if (seen.has(key)) continue;
    seen.add(key);
    valid++;
  }
  return valid === expected;
}

function between(matches: StandingMatch[], x: string, y: string): StandingMatch | undefined {
  return matches.find(
    (match) =>
      isReported(match) &&
      ((match.team_a_id === x && match.team_b_id === y) || (match.team_a_id === y && match.team_b_id === x)),
  );
}

function compareOverrideThenId(a: Standing, b: Standing): number {
  if (a.manualOverride != null && b.manualOverride != null && a.manualOverride !== b.manualOverride) {
    return a.manualOverride - b.manualOverride;
  }
  return a.teamId.localeCompare(b.teamId);
}

function sortCluster(matches: StandingMatch[], group: Standing[]): Standing[] {
  if (group.length <= 1) return group;

  if (group.length === 2) {
    const [x, y] = group as [Standing, Standing];
    const h2h = between(matches, x.teamId, y.teamId);
    if (h2h?.winner_id === x.teamId) return [x, y];
    if (h2h?.winner_id === y.teamId) return [y, x];
    if (y.diff !== x.diff) return y.diff > x.diff ? [y, x] : [x, y];
    return [x, y].sort(compareOverrideThenId);
  }

  const ids = new Set(group.map((s) => s.teamId));
  const mini = new Map(group.map((s) => [s.teamId, { wins: 0, diff: 0 }]));
  for (const m of matches) {
    if (!isReported(m) || !m.team_a_id || !m.team_b_id || !m.winner_id) continue;
    if (!ids.has(m.team_a_id) || !ids.has(m.team_b_id)) continue;
    const winner = mini.get(m.winner_id);
    if (winner) winner.wins++;
    const a = mini.get(m.team_a_id);
    const b = mini.get(m.team_b_id);
    if (a) a.diff += (m.score_a ?? 0) - (m.score_b ?? 0);
    if (b) b.diff += (m.score_b ?? 0) - (m.score_a ?? 0);
  }

  return [...group].sort((p, q) => {
    const pm = mini.get(p.teamId)!;
    const qm = mini.get(q.teamId)!;
    if (qm.wins !== pm.wins) return qm.wins - pm.wins;
    if (qm.diff !== pm.diff) return qm.diff - pm.diff;
    if (q.diff !== p.diff) return q.diff - p.diff;
    return compareOverrideThenId(p, q);
  });
}

export function computeStandings(
  teamIds: string[],
  matches: StandingMatch[],
  manualOverrides: Record<string, number | null> = {},
): Standing[] {
  const base = new Map<string, Standing>();
  for (const id of teamIds) {
    base.set(id, {
      teamId: id,
      played: 0,
      wins: 0,
      losses: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      diff: 0,
      rank: 0,
      manualOverride: manualOverrides[id] ?? null,
    });
  }

  for (const m of matches) {
    if (!isReported(m) || !m.team_a_id || !m.team_b_id) continue;
    const a = base.get(m.team_a_id);
    const b = base.get(m.team_b_id);
    if (!a || !b) continue;
    const sa = m.score_a ?? 0;
    const sb = m.score_b ?? 0;
    a.played++;
    b.played++;
    a.pointsFor += sa;
    a.pointsAgainst += sb;
    b.pointsFor += sb;
    b.pointsAgainst += sa;
    if (m.winner_id === m.team_a_id) {
      a.wins++;
      b.losses++;
    } else if (m.winner_id === m.team_b_id) {
      b.wins++;
      a.losses++;
    }
  }

  for (const s of base.values()) s.diff = s.pointsFor - s.pointsAgainst;

  const byWins = new Map<number, Standing[]>();
  for (const s of base.values()) {
    const list = byWins.get(s.wins) ?? [];
    list.push(s);
    byWins.set(s.wins, list);
  }

  const sorted: Standing[] = [];
  for (const wins of [...byWins.keys()].sort((a, b) => b - a)) {
    sorted.push(...sortCluster(matches, byWins.get(wins) ?? []));
  }

  sorted.forEach((s, i) => {
    s.rank = i + 1;
  });
  return sorted;
}
