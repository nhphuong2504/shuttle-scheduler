/**
 * Tournament-side types relocated out of the legacy scheduler: a scheduled slot is the shape the
 * UI, the diff and the planner all speak.
 */

export interface ScheduledSlot {
  matchId: string;
  courtId: string;
  courtNumber: number;
  start: Date;
  end: Date;
  categoryId: string;
  overrun: boolean;
}
