/**
 * Pool standings with tie-break order:
 * 1. head-to-head result
 * 2. point differential across pool matches
 * 3. manual override flag for the desk (coin toss)
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

export function poolIsComplete(matches: StandingMatch[]): boolean {
  return matches.length > 0 && matches.every((m) => isReported(m) && m.winner_id);
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

  const headToHead = (x: string, y: string): number => {
    const m = matches.find(
      (match) =>
        isReported(match) &&
        ((match.team_a_id === x && match.team_b_id === y) || (match.team_a_id === y && match.team_b_id === x)),
    );
    if (!m || !m.winner_id) return 0;
    return m.winner_id === x ? -1 : 1;
  };

  const sorted = [...base.values()].sort((a, b) => {
    if (a.manualOverride != null && b.manualOverride != null && a.manualOverride !== b.manualOverride) {
      return a.manualOverride - b.manualOverride;
    }
    if (b.wins !== a.wins) return b.wins - a.wins;
    const h2h = headToHead(a.teamId, b.teamId);
    if (h2h !== 0) return h2h;
    if (b.diff !== a.diff) return b.diff - a.diff;
    return 0;
  });

  sorted.forEach((s, i) => {
    s.rank = i + 1;
  });
  return sorted;
}
