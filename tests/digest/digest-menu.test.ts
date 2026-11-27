// The Daily's hamburger menu (ui/digestMenu.ts): Digest time, Write automatically, Show what the digest sent, Settings, and the billing line; the right rows for each setup; the billing
// figure only when it could be read.
import { describe, expect, it } from "vitest";
import { drawDigestMenu, money, type DigestMenu } from "../../src/ui/digestMenu";

class El {
  cls = new Set<string>();
  text = "";
  attrs: Record<string, string> = {};
  children: El[] = [];
  handlers: Array<() => void> = [];
  isConnected = true;
  constructor(public tag = "div") {}
  private make(tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }): El {
    const e = new El(tag);
    o?.cls?.split(" ").forEach((c) => e.cls.add(c));
    if (o?.text) e.text = o.text;
    Object.assign(e.attrs, o?.attr ?? {});
    this.children.push(e);
    return e;
  }
  createDiv(o?: { cls?: string; text?: string; attr?: Record<string, string> }): El {
    return this.make("div", o);
  }
  createSpan(o?: { cls?: string; text?: string; attr?: Record<string, string> }): El {
    return this.make("span", o);
  }
  createEl(tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }): El {
    return this.make(tag, o);
  }
  setAttr(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(_t: string, fn: () => void): void {
    this.handlers.push(fn);
  }
  click(): void {
    this.handlers.forEach((h) => h());
  }
  empty(): void {
    this.children = [];
  }
  all(): El[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

const rowsOf = (panel: El): El[] => panel.children.filter((c) => c.cls.has("blyg-menurow"));
const labelOf = (r: El): string => r.children.find((c) => c.cls.has("blyg-menurow-label"))?.text ?? "";
const valueOf = (r: El): string => r.children.find((c) => c.cls.has("blyg-menurow-value"))?.text ?? "";
const goOf = (r: El): string => r.children.find((c) => c.cls.has("blyg-menurow-go"))?.text ?? "";
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const full = (over: Partial<DigestMenu> = {}): { menu: DigestMenu; log: string[] } => {
  const log: string[] = [];
  let auto = false;
  const menu: DigestMenu = {
    time: () => "07:00",
    pickTime: (done) => (log.push("pickTime"), done()),
    autoWrite: () => auto,
    setAutoWrite: (on) => ((auto = on), log.push(`auto:${on}`)),
    showSent: () => log.push("showSent"),
    settings: () => log.push("settings"),
    monthCost: () => Promise.resolve(0.31),
    ...over,
  };
  return { menu, log };
};

describe("the Daily menu", () => {
  it("has four rows and a billing line, in this order, as Menu 1 rows: label left, value right, a › only where a row opens something", async () => {
    const panel = new El();
    drawDigestMenu(panel as unknown as HTMLElement, full().menu, { fold: () => undefined, repaint: () => undefined });
    await settle();
    const rows = rowsOf(panel);
    expect(rows.map(labelOf)).toEqual(["Digest time", "Write automatically", "Show what the digest sent", "Settings", "Digest billing this month"]);
    expect(rows.map(goOf)).toEqual(["›", "", "›", "›", ""]);
    expect(valueOf(rows[0]!)).toBe("07:00");
    expect(valueOf(rows[1]!)).toBe("Off");
    expect(valueOf(rows[4]!)).toBe("$0.31");
    expect(rows[4]!.tag).toBe("div"); // the billing line only tells: no button
    for (const gone of ["Refresh", "Advanced", "Write the digest", "Re-sort sections", "Edition", "Editor"]) expect(rows.map(labelOf)).not.toContain(gone);
  });
  it("Write automatically is a switch: a tap toggles the setting, the value says On or Off, aria-checked follows", () => {
    const panel = new El();
    const { menu, log } = full();
    drawDigestMenu(panel as unknown as HTMLElement, menu, { fold: () => undefined, repaint: () => undefined });
    const row = rowsOf(panel)[1]!;
    expect(row.attrs.role).toBe("switch");
    expect(row.attrs["aria-checked"]).toBe("false");
    row.click();
    expect(log).toEqual(["auto:true"]);
    expect(valueOf(row)).toBe("On");
    expect(row.attrs["aria-checked"]).toBe("true");
    row.click();
    expect(log).toEqual(["auto:true", "auto:false"]);
    expect(valueOf(row)).toBe("Off");
  });
  it("Digest time asks for a time and draws again; Show what the digest sent and Settings fold the menu and open theirs", () => {
    const panel = new El();
    const { menu, log } = full();
    const seen: string[] = [];
    drawDigestMenu(panel as unknown as HTMLElement, menu, { fold: () => seen.push("fold"), repaint: () => seen.push("repaint") });
    const [time, , sent, settings] = rowsOf(panel);
    time!.click();
    sent!.click();
    settings!.click();
    expect(log).toEqual(["pickTime", "showSent", "settings"]);
    expect(seen).toEqual(["repaint", "fold", "fold"]);
  });
  it("without the AI layer: Digest time and Settings only (no switch, no billing, no sent log)", () => {
    const panel = new El();
    const { menu } = full({ autoWrite: () => null });
    const { showSent: _s, monthCost: _m, ...noAi } = menu;
    drawDigestMenu(panel as unknown as HTMLElement, noAi, { fold: () => undefined, repaint: () => undefined });
    expect(rowsOf(panel).map(labelOf)).toEqual(["Digest time", "Settings"]);
  });
  it("shows no billing value when the total cannot be read (never a wrong one), and none after the menu was redrawn", async () => {
    for (const cost of [(): Promise<number | null> => Promise.resolve(null), (): Promise<number | null> => Promise.reject(new Error("unreadable"))]) {
      const panel = new El();
      drawDigestMenu(panel as unknown as HTMLElement, full({ monthCost: cost }).menu, { fold: () => undefined, repaint: () => undefined });
      await settle();
      const billing = rowsOf(panel).find((r) => labelOf(r) === "Digest billing this month")!;
      expect(valueOf(billing)).toBe("");
    }
    const gone = new El();
    let release: (n: number | null) => void = () => undefined;
    drawDigestMenu(gone as unknown as HTMLElement, full({ monthCost: () => new Promise((r) => (release = r)) }).menu, { fold: () => undefined, repaint: () => undefined });
    const row = rowsOf(gone)[4]!;
    row.isConnected = false; // the page was drawn again meanwhile
    release(1);
    await settle();
    expect(valueOf(row)).toBe("");
  });
  it("formats money as dollars with two decimals", () => {
    expect(money(0.31)).toBe("$0.31");
    expect(money(0)).toBe("$0.00");
    expect(money(12.5)).toBe("$12.50");
  });
});
