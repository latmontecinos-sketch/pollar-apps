/**
 * The attendee counter shown on an event. Only a number, and only once it is
 * big enough to say something: "1 person is going" reads as an empty room.
 */

/** From this many tickets issued the count is shown. */
export const ATTENDEE_THRESHOLD = 5;

export function shouldShowAttendees(count: number, threshold = ATTENDEE_THRESHOLD): boolean {
  return Number.isInteger(count) && count >= threshold;
}

/** The number to put on screen, or null when it should stay hidden. */
export function attendeesToShow(count: number): number | null {
  return shouldShowAttendees(count) ? count : null;
}
