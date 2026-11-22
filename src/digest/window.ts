// The Daily's day: one digest per local calendar day, from midnight to now. Pure; nothing is remembered between openings, so a new day is a new digest.

/** Midnight at the start of the local calendar day that contains `now`. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Today's window: local midnight to now. */
export function dayWindow(now: number): { since: number; until: number } {
  return { since: startOfLocalDay(now), until: now };
}

/** The masthead's date: the weekday and the full date in the person's own locale (`locale` undefined: the device's). */
export function mastheadDate(t: number, locale?: string): string {
  return new Date(t).toLocaleDateString(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
