import { describe, expect, it } from "vitest";
import { PassageDock } from "../src/ui/passageDock";

type Rect = { top: number; bottom: number; width: number; height: number };

/** A dock element that records its custom properties; no DOM is needed for the lift arithmetic. */
function fakeDock(rect: Rect) {
  const props = new Map<string, string>();
  const el = {
    style: { removeProperty: (k: string) => void props.delete(k) },
    setCssProps: (p: Record<string, string>) => { for (const [k, v] of Object.entries(p)) props.set(k, v); },
    getBoundingClientRect: () => rect,
  };
  return { el: el as unknown as HTMLElement, props };
}

function dockWith(bar: { rect: Rect; shown: boolean } | null) {
  const root = {
    ownerDocument: {
      querySelector: () => (bar ? { offsetParent: bar.shown ? {} : null, getBoundingClientRect: () => bar.rect } : null),
    },
  } as unknown as HTMLElement;
  const dock = new PassageDock(root, {} as never);
  return (el: HTMLElement) => (dock as unknown as { clearNavbar(e: HTMLElement): void }).clearNavbar(el);
}

const navbar: Rect = { top: 700, bottom: 780, width: 390, height: 80 };

describe("passage dock: lift above the mobile navbar", () => {
  it("lifts by the overlap, as a custom property for styles.css", () => {
    const { el, props } = fakeDock({ top: 640, bottom: 740.4, width: 390, height: 100 });
    dockWith({ rect: navbar, shown: true })(el);
    expect(props.get("--blyg-dock-lift")).toBe("41px");
  });
  it("clears a stale lift when there is no overlap any more", () => {
    const { el, props } = fakeDock({ top: 560, bottom: 660, width: 390, height: 100 });
    props.set("--blyg-dock-lift", "41px");
    dockWith({ rect: navbar, shown: true })(el);
    expect(props.has("--blyg-dock-lift")).toBe(false);
  });
  it("sets nothing when the bar is absent or not displayed (tablet, desktop)", () => {
    for (const bar of [null, { rect: navbar, shown: false }]) {
      const { el, props } = fakeDock({ top: 640, bottom: 740, width: 390, height: 100 });
      props.set("--blyg-dock-lift", "41px");
      dockWith(bar)(el);
      expect(props.size).toBe(0);
    }
  });
});
