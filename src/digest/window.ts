// The masthead's date. The Daily's window is an edition (src/digest/edition.ts), no longer the calendar day.

/** English ordinal of a day of the month: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd, 23rd, 31st. */
export function ordinal(day: number): string {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const last = day % 10;
  return `${day}${teen ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

/** The masthead's date: the weekday and the full date in the person's own locale (`locale` undefined: the device's); in English the day is an ordinal ("November 23rd"). */
export function mastheadDate(t: number, locale?: string): string {
  const f = new Intl.DateTimeFormat(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  if (!f.resolvedOptions().locale.toLowerCase().startsWith("en")) return f.format(t);
  return f.formatToParts(t).map((p) => (p.type === "day" ? ordinal(Number(p.value)) : p.value)).join("");
}
