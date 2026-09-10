import type { ScheduledUndoStatus } from '../types/db';

/**
 * A message is scheduled exactly while its held submission is pending
 * (SL-4.5). Settled rows and anything else parked in the Scheduled
 * folder are ordinary mail: deletable, movable, and replyable.
 */
export function isScheduledMessage(
  message: { scheduled_undo_status?: ScheduledUndoStatus | string | null } | null | undefined,
): boolean {
  return message?.scheduled_undo_status === 'pending';
}
