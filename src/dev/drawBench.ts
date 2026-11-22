// The development build's command "Reader: draw synthetic posts (timing)" (HK4): draws N invented cards the way the reader's feed does, and says how long it took,
// so the cost of a long list can be timed on a phone. Registered only in a development build (manifest id "blyg-dev"); the release build has no such command.
// It builds cards with the reader's own classes and its own card text (`cardOf`), in a window of its own: it reads nothing from the Studio and writes nothing.
// It is a copy of the shape of the reader's card, not the reader's code: if the card changes a lot, read the numbers with that in mind.
import { FuzzySuggestModal, Modal, Notice, setIcon, type App, type Plugin } from "obsidian";
import { isDevBuildId } from "../studio/devLock";
import type { ReadingPost } from "../studio/reading";
import { cardOf, readingTimeLabel, relativeTime } from "../ui/readerFeed";
import { syntheticPosts } from "./syntheticPosts";
import { registerAuthorStyleCommand } from "./authorStyle";
import type { ReaderContrast } from "../ui/readerLook";

/** The list sizes offered: 1000 and 5000 are the ones asked for; the others give a slope. */
export const BENCH_SIZES = [200, 1000, 3000, 5000, 10000] as const;

export interface DrawTiming {
  count: number;
  /** Making the posts (not part of drawing). */
  generateMs: number;
  /** Building the cards' elements. */
  buildMs: number;
  /** The first layout of the whole list (forced). */
  layoutMs: number;
  /** Until the next frame after that was drawn. */
  frameMs: number;
  /** Elements in the list. */
  elements: number;
}

const round = (n: number): number => Math.round(n);

/** The sentence the command reports. */
export function timingSentence(t: DrawTiming): string {
  const total = t.buildMs + t.layoutMs + t.frameMs;
  return `${t.count} cards, ${t.elements} elements: ${round(total)} ms in all (build ${round(t.buildMs)}, layout ${round(t.layoutMs)}, first frame ${round(t.frameMs)}); making the posts ${round(t.generateMs)} ms.`;
}

/** One card, with the structure and classes of the reader's (ReaderView.fillCard), minus what needs the reader's state (read marks, replies). */
function fillBenchCard(card: HTMLElement, p: ReadingPost, now: number): void {
  card.addClass("blyg-reader-row", "blyg-reader-card");
  const head = card.createDiv({ cls: "blyg-reader-cardhead" });
  const title = head.createDiv({ cls: "blyg-reader-cardtitle" });
  title.createSpan({ cls: "blyg-reader-source", text: p.subscriptionTitle });
  const meta = title.createDiv({ cls: "blyg-reader-meta blyg-reader-cardmeta" });
  [p.authorName, relativeTime(p.created ?? p.observedAt, now), readingTimeLabel(p)].filter((x): x is string => !!x).forEach((piece, i) => {
    if (i > 0) meta.appendText(" · ");
    meta.createSpan({ cls: "blyg-reader-nowrap", text: piece });
  });
  const check = head.createEl("button", { cls: "blyg-reader-btn blyg-reader-check" });
  setIcon(check, "circle");
  const badges = card.createDiv({ cls: "blyg-reader-badges" });
  if (p.isReply) badges.createSpan({ cls: "blyg-reader-badge", text: "reply" });
  else if (p.kind === "thread") badges.createSpan({ cls: "blyg-reader-badge", text: "thread" });
  if (p.readVersion === null) badges.createSpan({ cls: "blyg-reader-badge is-new", text: "unread" });
  const c = cardOf(p);
  if (c.quote) card.createDiv({ cls: "blyg-reader-quote", text: c.quote });
  if (c.words) {
    const excerpt = card.createDiv({ cls: "blyg-reader-excerpt" });
    for (const run of c.runs) {
      excerpt.createSpan({ cls: `${run.bold ? "blyg-reader-b " : ""}${run.italic ? "blyg-reader-i" : ""}`.trim(), text: run.text });
      if (run.breakAfter) excerpt.createEl("br");
    }
  }
  if (c.images > 0) card.createDiv({ cls: "blyg-reader-meta", text: `${c.images} image${c.images === 1 ? "" : "s"}` });
}

const nextFrame = (): Promise<void> => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

/** Draw `count` cards into `into` (emptied first) and time it. */
export async function drawSynthetic(into: HTMLElement, count: number): Promise<DrawTiming> {
  into.empty();
  const g0 = performance.now();
  const posts = syntheticPosts(count);
  const generateMs = performance.now() - g0;
  await nextFrame(); // the empty window is drawn first, so the frame measured below is the list's
  const now = Date.now();
  const b0 = performance.now();
  const col = into.createDiv({ cls: "blyg-reader-stream" });
  for (const p of posts) fillBenchCard(col.createDiv(), p, now);
  const buildMs = performance.now() - b0;
  const l0 = performance.now();
  void into.scrollHeight; // reading a layout property forces the layout now
  const layoutMs = performance.now() - l0;
  const f0 = performance.now();
  await nextFrame();
  await nextFrame();
  const frameMs = performance.now() - f0;
  return { count, generateMs, buildMs, layoutMs, frameMs, elements: col.querySelectorAll("*").length + 1 };
}

class BenchWindow extends Modal {
  constructor(app: App, private readonly count: number) {
    super(app);
  }
  override onOpen(): void {
    this.modalEl.addClass("blyg-bench-modal");
    this.titleEl.setText(`Drawing ${this.count} cards…`);
    const list = this.contentEl.createDiv({ cls: "blyg-reader blyg-bench-list" });
    void drawSynthetic(list, this.count).then((t) => {
      const sentence = timingSentence(t);
      this.titleEl.setText(sentence);
      new Notice(sentence, 0); // stays until dismissed: the list may cover the title on a small screen
    }, (err: unknown) => this.titleEl.setText(`The drawing failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

class SizePicker extends FuzzySuggestModal<number> {
  constructor(app: App) {
    super(app);
    this.setPlaceholder("How many cards to draw?");
  }
  getItems(): number[] {
    return [...BENCH_SIZES];
  }
  getItemText(n: number): string {
    return `${n} cards`;
  }
  onChooseItem(n: number): void {
    new BenchWindow(this.app, n).open();
  }
}

/** Adds the timing command in a development build; nothing in any other. */
export function registerDevCommands(plugin: Plugin, level: () => ReaderContrast = () => "normal", enabled: (id: string) => boolean = () => true): void {
  if (!isDevBuildId(plugin.manifest.id)) return;
  if (enabled("author-look")) registerAuthorStyleCommand(plugin, level);
  if (enabled("reader-timing")) plugin.addCommand({ id: "dev-draw-synthetic-posts", name: "Reader: draw synthetic posts (timing)", callback: () => new SizePicker(plugin.app).open() });
}
