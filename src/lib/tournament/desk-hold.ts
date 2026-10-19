import type { DeskAction } from "./desk-actions";
import type { DeskMatchModel } from "./desk";

/**
 * Lists that move: holding a ranked list still under the pointer, and saying what is new.
 *
 * `deskActions` and `upNext` re-rank on every thirty-second tick and on every live update,
 * which is right for the order and wrong for the pointer: a re-sort mid-click turns a click
 * aimed at Court 4's Start into a click on another court's. This module is the rule that
 * keeps that from happening, kept pure so it can be tested without a browser.
 *
 * ## The hold
 *
 * While the pointer is over a list, or focus is inside it, the rows keep the order they had
 * when the hold began. Their wording still comes from the current ranking, so a row that
 * gets later says so in place. Two things are allowed to happen to the held order itself:
 *
 *   - a row that should leave stays, and is reported in `leaving` so the list can dim it;
 *   - a row that was not there is appended at the end, and is reported in `added`.
 *
 * When the hold ends the list is the ranking again, so the move the moderator was protected
 * from happens once, after they have finished pointing.
 *
 * ## New
 *
 * `added` is the set of keys the list did not draw last time. The caller stamps those with
 * `NEW_ROW_MS` - the "New" tag is a bounded cue, not a state that has to be cleared by hand.
 * `seen` is `null` before the list has drawn once: a list's opening state is not a change,
 * so the first pass marks nothing new.
 */

/** How long a row that has just appeared keeps its "New" tag. */
export const NEW_ROW_MS = 10_000;

export interface DeskListOrder<T> {
  /** The rows to draw, in the order to draw them. */
  rows: readonly T[];
  /** Keys drawn but no longer in the ranking: dimmed until the hold ends. */
  leaving: ReadonlySet<string>;
  /** Keys the list did not draw last time: tagged "New" for `NEW_ROW_MS`. */
  added: ReadonlySet<string>;
  /** The keys drawn, in order, for the next pass's `seen`. */
  keys: readonly string[];
}

export interface DeskListHoldInput<T> {
  /** The list as `deskActions` or `upNext` ranked it now. */
  ranked: readonly T[];
  key: (row: T) => string;
  /**
   * The rows and order to keep while held, or null when the list is not held. Rows that
   * have left `ranked` are kept here, which is what lets them be drawn dimmed.
   */
  held: readonly T[] | null;
  /** The keys drawn last time, or null before the list has drawn once. */
  seen: ReadonlySet<string> | null;
}

export function holdDeskList<T>({
  ranked,
  key,
  held,
  seen,
}: DeskListHoldInput<T>): DeskListOrder<T> {
  let rows: T[];
  const leaving = new Set<string>();

  if (held) {
    const current = new Map(ranked.map((row) => [key(row), row]));
    const heldKeys = new Set<string>();
    rows = [];
    for (const row of held) {
      const rowKey = key(row);
      heldKeys.add(rowKey);
      const rankedRow = current.get(rowKey);
      if (rankedRow) {
        // The place is held; the wording is the ranking's, not the snapshot's.
        rows.push(rankedRow);
      } else {
        rows.push(row);
        leaving.add(rowKey);
      }
    }
    // New rows go to the end of the held list, in the order the ranking puts them in.
    for (const row of ranked) {
      if (!heldKeys.has(key(row))) rows.push(row);
    }
  } else {
    rows = [...ranked];
  }

  const keys = rows.map(key);
  const added = new Set<string>();
  if (seen) {
    for (const rowKey of keys) {
      if (!seen.has(rowKey)) added.add(rowKey);
    }
  }

  return { rows, leaving, added, keys };
}

/**
 * The identity of a "Needs action" row across renders.
 *
 * A match keeps one key whatever kind it is: a `blocked-late` match becomes `start-late`
 * when the player it was waiting for finishes, and that is the same row changing its words,
 * not one row leaving and another arriving. The pool row is its own thing and is keyed by
 * the pool.
 */
export function deskActionKey<TMatch extends DeskMatchModel, TPool extends { id: string }>(
  action: DeskAction<TMatch, TPool>,
): string {
  return action.kind === "results-late" ? `pool-${action.pool.id}` : `match-${action.match.id}`;
}
