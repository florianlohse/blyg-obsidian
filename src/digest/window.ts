// The masthead's date. The Daily's window is an edition (src/digest/edition.ts), no longer the calendar day.

/** The masthead's date: the weekday and the full date in the person's own locale (`locale` undefined: the device's). */
export function mastheadDate(t: number, locale?: string): string {
  return new Date(t).toLocaleDateString(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
