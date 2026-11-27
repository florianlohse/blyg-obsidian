// The masthead's date. The Daily's window is an edition (src/digest/edition.ts), no longer the calendar day.

/** English ordinal of a day of the month: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd, 23rd, 31st. */
export function ordinal(day: number): string {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const last = day % 10;
  return `${day}${teen ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

const EN = "en-US";
const parts = (t: number): Record<string, string> => Object.fromEntries(new Intl.DateTimeFormat(EN, { weekday: "long", year: "numeric", month: "long", day: "numeric" }).formatToParts(t).map((p) => [p.type, p.value]));

/** The masthead's date, always English whatever the device's language: "Friday, November 27th, 2026". The time zone is the device's (the edition cutoff logic is elsewhere and unchanged). */
export function mastheadDate(t: number): string {
  const p = parts(t);
  return `${p.weekday}, ${p.month} ${ordinal(Number(p.day))}, ${p.year}`;
}

/** The same without the year, for the list of editions: "Thursday, November 26th". */
export function editionLabel(t: number): string {
  const p = parts(t);
  return `${p.weekday}, ${p.month} ${ordinal(Number(p.day))}`;
}
