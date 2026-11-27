// The Daily's hamburger menu: four Menu 1 rows (ui/menuRow.ts) and a billing line. Digest time and Write automatically are changed here; Show what the digest sent and Settings open
// something; "Digest billing this month" only tells. Drawing only; what each row does is handed in. Text only.
import { drawMenuRow, fillMenuRow } from "./menuRow";

export interface DigestMenu {
  /** The edition start time, "HH:MM". */
  time(): string;
  /** Ask for a new time (a small window); `done` is called after one was saved. */
  pickTime(done: () => void): void;
  /** Write automatically: null when the setting is not offered (no AI layer). */
  autoWrite(): boolean | null;
  setAutoWrite(on: boolean): void;
  /** Absent: no "Show what the digest sent" row. */
  showSent?: () => void;
  /** Absent: no Settings row. */
  settings?: () => void;
  /** The estimated cost of the AI writes this month, all devices (dollars); null: unreadable. Absent: no billing row. */
  monthCost?: () => Promise<number | null>;
}

/** "$0.31": dollars, two decimals. */
export const money = (n: number): string => `$${n.toFixed(2)}`;

const AUTO = "Write automatically";
const BILLING = "Digest billing this month";

/** The rows, in `panel`. `fold`: close the menu (a row that opens something); `repaint`: draw the rows again. */
export function drawDigestMenu(panel: HTMLElement, m: DigestMenu, o: { fold: () => void; repaint: () => void }): void {
  drawMenuRow(panel, { label: "Digest time", value: m.time(), opens: true, cls: "blyg-menu-time", title: "When a new edition of the Daily starts", run: () => m.pickTime(o.repaint) });
  const auto = m.autoWrite();
  if (auto !== null) {
    const row = drawMenuRow(panel, { label: AUTO, value: auto ? "On" : "Off", cls: "blyg-menu-auto", title: "Write the digest with your AI model once for each new edition, in the background (uses tokens)", run: () => undefined });
    row.setAttr("role", "switch");
    row.setAttr("aria-checked", String(auto));
    let on = auto;
    row.addEventListener("click", () => {
      on = !on;
      m.setAutoWrite(on);
      fillMenuRow(row, { label: AUTO, value: on ? "On" : "Off" });
      row.setAttr("aria-checked", String(on));
    });
  }
  if (m.showSent) {
    const show = m.showSent;
    drawMenuRow(panel, { label: "Show what the digest sent", opens: true, cls: "blyg-menu-sent", title: "The requests the digest made to your AI model", run: () => (o.fold(), show()) });
  }
  if (m.settings) {
    const open = m.settings;
    drawMenuRow(panel, { label: "Settings", opens: true, cls: "blyg-menu-settings", title: "Open this plugin's settings", run: () => (o.fold(), open()) });
  }
  if (m.monthCost) {
    // A line that only tells. The figure is read when the menu is drawn; unreadable or not yet known: no value (never a wrong one).
    const row = drawMenuRow(panel, { label: BILLING, cls: "blyg-menu-billing", title: "The estimated cost of the digest's AI writes this month, all your devices" });
    void m.monthCost().then(
      (n) => {
        if (n !== null && row.isConnected !== false) fillMenuRow(row, { label: BILLING, value: money(n) });
      },
      () => undefined,
    );
  }
}
