// The right-sidebar panel: follows the active note and says where it stands (R2). Drawing only: what to say is decided by
// src/app/panelState.ts. Built with createEl/text: nothing from a note is ever inserted as HTML.
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { deployLine, type PanelDeploy, type PanelState } from "../app/panelState";

export const BLYG_PANEL_VIEW = "blyg-panel";

/** What the panel asks of the plugin: the current state and the actions its buttons run. */
export interface PanelHost {
  /** The plugin's own version (manifest.json), shown at the foot of the panel so you can tell which build a device runs. */
  version: string;
  loadState(): Promise<PanelState>;
  /** The deploy result of the note that owns this repository path (its newest publish), or null. */
  deploy(path: string | undefined): PanelDeploy | null;
  publish(): Promise<void>;
  withdraw(): Promise<void>;
  /** Delete the Studio draft of a note whose item was never published (asks first). */
  deleteDraft(): Promise<void>;
  /** Publish a note that carries another blyg's record to the Studio as a new item. */
  repost(): Promise<void>;
  /** Replace the note's text with the Studio's working copy of its item (asks first). */
  pull(): Promise<void>;
  openWeb(url: string): void;
  /** Point publishing at the production or the preview branch (the same switch as the command "Toggle production/preview"). */
  setTarget(channel: "production" | "preview"): Promise<void>;
  /** False while the settings are read-only (written by a newer plugin version). */
  canSwitchTarget(): boolean;
  /** Re-check the deploy of this session's newest commit. */
  recheckDeploy(): Promise<void>;
  /** The writing buttons (see `PanelState.write`). */
  newThread(): Promise<void>;
  newNote(): Promise<void>;
  /** "Studio: import new items" (roadmap S7). */
  importFromStudio(): Promise<void>;
  /** "Reply to an item": a new thread that answers the item picked or pasted (roadmap S10). */
  replyToItem(): Promise<void>;
  /** "Make this thread a reply" (roadmap S10). */
  makeReply(): Promise<void>;
  /** "Studio: choose hoppers for this note" (roadmap S13). */
  chooseHoppers(): Promise<void>;
  /** "Studio: use the Studio's hoppers for this note" (roadmap S13). */
  takeHoppers(): Promise<void>;
  makeThread(): Promise<void>;
  /** "Insert quote/link": pick an item, then quote it (threads) or link to it. */
  insertItem(): Promise<void>;
  /** Open the reader (the same as the ribbon icon and the command "Open reader"). */
  openReader(): Promise<void>;
}

/** A timestamp for people: the device's own time zone; text that is not a date is shown as it is. */
export function formatWhen(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** An address without its scheme, for reading: "https://example.com/essays/x/" → "example.com/essays/x/". */
export function shortUrl(url: string): string {
  return url.replace(/^https:\/\//, "");
}

export class BlygPanelView extends ItemView {
  /** Only the newest refresh may draw: a slow read of an earlier note must not overwrite a later one. */
  private drawn = 0;
  private busy = false;
  /** Which collapsible sections are open. The panel is redrawn on every refresh, so a section a person opened must stay open. */
  private readonly openSections = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: PanelHost,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return BLYG_PANEL_VIEW;
  }

  override getDisplayText(): string {
    return "Blyg";
  }

  override getIcon(): string {
    return "send";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("blyg-pane");
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const ticket = ++this.drawn;
    const state = await this.host.loadState();
    if (ticket !== this.drawn) return;
    this.draw(state);
  }

  private draw(state: PanelState): void {
    const root = this.contentEl;
    root.empty();

    this.drawTestMode(root, state);

    this.drawTopRow(root, state);

    // Who this is about, in one muted line: the note's name (without ".md") and whether it is a thread or a fragment.
    if (state.note) {
      const name = state.note.name.replace(/\.md$/i, "");
      root.createDiv({ cls: "blyg-pane-identity", text: state.kind ? `${name} · ${state.kind === "thread" ? "Thread" : "Fragment"}` : name });
    }

    // The status card is also where the note's next step is: one button inside it, only when there is something to do (increment 5b). Normal text
    // with a coloured edge and a green check when everything is fine (never colour on colour, see styles.css).
    const publishable = !!state.route && state.status !== "not-markdown" && state.status !== "studio-missing";
    const status = root.createDiv({ cls: `blyg-pane-status${state.ok ? " blyg-pane-status-ok" : ""}` });
    const headline = status.createDiv({ cls: `blyg-pane-headline blyg-pane-${state.status}` });
    if (state.ok) headline.createSpan({ cls: "blyg-pane-check", text: "✓" });
    headline.createSpan({ text: state.headline });
    for (const line of state.notes) status.createDiv({ cls: "blyg-pane-note", text: line });
    if (state.fragment) {
      // A fragment's length against its limit, counted as a publish counts it: a quiet line, a warning near the limit and over it.
      const { chars, cap } = state.fragment;
      const over = chars - cap;
      status.createDiv({
        cls: `blyg-pane-count${over > 0 ? " is-over" : chars >= cap * 0.9 ? " is-near" : ""}`,
        text: over > 0 ? `${chars} / ${cap} characters: ${over} too many` : `${chars} / ${cap} characters`,
        attr: { title: "The text a publish would send: properties and %% comments are not counted" },
      });
    }
    if (publishable) this.drawDecision(status, state);

    this.drawStudioWarnings(root, state);
    this.drawStartWriting(root, state);
    this.drawWorkOnNote(root, state);
    this.drawDetails(root, state);

    this.drawDeploy(root, state);
    root.createDiv({ cls: "blyg-pane-version", text: `Blyg ${this.host.version}` });
  }

  /** Studio notes: what the Studio said that is not about the note itself. Plain sentences, each on its own line. */
  private drawStudioWarnings(root: HTMLElement, state: PanelState): void {
    const lines = [...(state.studio?.warnings ?? []), ...(state.studio?.unreachable ? ["The Studio could not be reached just now. This is what the note itself says; the Studio’s own state is not known."] : [])];
    if (lines.length > 0) {
      const box = root.createDiv({ cls: "blyg-pane-testmode" });
      for (const line of lines) box.createDiv({ text: line });
    }
    // Transparency only (a newer minor contract): one small muted line, no warning box, no icon.
    for (const note of state.studio?.notes ?? []) root.createDiv({ cls: "blyg-pane-note", text: note });
  }

  /**
   * Shown only while publishing is pointed at the test branch (the "preview" channel exists for developing the plugin and the
   * site, not for everyday use): a short line and the way back. On production, the normal case, there is nothing to see.
   * (New class names "blyg-pane-testmode*": a stale stylesheet cannot paint the old bars.)
   */
  private drawTestMode(root: HTMLElement, state: PanelState): void {
    if (state.channel !== "preview") return;
    const box = root.createDiv({ cls: "blyg-pane-testmode" });
    box.createDiv({ text: `Test mode: publishing goes to the “${state.branch}” branch, not to your real site.` });
    const back = box.createEl("button", { text: "Switch to production" });
    back.disabled = !this.host.canSwitchTarget() || this.busy;
    back.addEventListener("click", () => void this.run(() => this.host.setTarget("production")));
  }

  /** A button in a row; disabled while an action runs. */
  private button(row: HTMLElement, text: string, enabled: boolean, action: () => Promise<void>, cls?: string): void {
    const el = row.createEl("button", { text, ...(cls ? { cls } : {}) });
    el.disabled = !enabled || this.busy;
    el.addEventListener("click", () => void this.run(action));
  }

  /** A folded section (a native details element). It remembers whether it is open across the panel's redraws. */
  private section(root: HTMLElement, key: string, title: string): HTMLElement {
    const box = root.createEl("details", { cls: "blyg-pane-section" });
    box.open = this.openSections.has(key);
    box.createEl("summary", { text: title });
    box.addEventListener("toggle", () => {
      if (box.open) this.openSections.add(key);
      else this.openSections.delete(key);
    });
    return box;
  }

  /** The two actions that belong to the whole Studio, not to the open note: the reader and the import. Drawn once there is a Studio. */
  private drawTopRow(root: HTMLElement, state: PanelState): void {
    const w = state.write;
    if (!w.canReply && !w.canImport) return;
    const row = root.createDiv({ cls: "blyg-pane-buttons blyg-pane-top" });
    if (w.canReply) this.button(row, "Open reader", true, () => this.host.openReader());
    if (w.canImport) this.button(row, "Sync with Studio…", true, () => this.host.importFromStudio());
  }

  /** Start writing: always in sight. A new fragment or thread needs only a Blyg folder; replying needs a Studio. */
  private drawStartWriting(root: HTMLElement, state: PanelState): void {
    const w = state.write;
    const box = root.createDiv({ cls: "blyg-pane-write" });
    box.createDiv({ cls: "blyg-pane-write-title", text: "Start writing" });
    const row = box.createDiv({ cls: "blyg-pane-buttons" });
    this.button(row, "New fragment", w.canCreate, () => this.host.newNote());
    this.button(row, "New thread", w.canCreate, () => this.host.newThread());
    if (w.canReply) this.button(row, "Reply to item…", true, () => this.host.replyToItem());
  }

  /** Work on this note: put an item into it, change its kind, mark it as a reply. Folded; only for a note in a Blyg folder. */
  private drawWorkOnNote(root: HTMLElement, state: PanelState): void {
    // These act on an open Blyg note: outside the Blyg folders they would only be dead buttons, so they are not drawn at all.
    if ((state.route?.mode !== "blyg" && state.route?.mode !== "studio") || state.status === "not-markdown") return;
    const w = state.write;
    const box = this.section(root, "work", "Work on this note");
    const row = box.createDiv({ cls: "blyg-pane-buttons" });
    // Quotes and links come from the Studio's items: with no Studio set up there is nothing to pick from, so the button is not drawn.
    if (state.status !== "studio-missing") this.button(row, "Insert quote/link", w.canInsertLink, () => this.host.insertItem());
    this.button(row, "Make thread", w.canMakeThread, () => this.host.makeThread());
    if (w.canMakeReply) this.button(row, "Mark as reply to…", true, () => this.host.makeReply());
    if (state.hoppers && state.status !== "studio-missing") this.button(row, "Hoppers…", true, () => this.host.chooseHoppers());
  }

  /** Details: the facts about the note, folded; most of the time the status line above says all a person needs. */
  private drawDetails(root: HTMLElement, state: PanelState): void {
    const box = this.section(root, "details", "Details");
    const facts = box.createEl("dl", { cls: "blyg-pane-facts" });
    const fact = (label: string, value: string): void => {
      facts.createEl("dt", { text: label });
      facts.createEl("dd", { text: value });
    };
    if (state.note) fact("Note", state.note.name);
    if (state.route) fact("Route", `${state.route.label} (${state.route.mode === "blyg" ? "Blyg item" : state.route.mode === "studio" ? "Blyg item, in your Studio" : "copied as it is"})`);
    if (state.kind) fact("Kind", state.kind === "thread" ? "Thread" : "Fragment");
    if (state.thread) {
      const { quotes, passages, links } = state.thread;
      fact("Quotes", quotes === 0 ? "none yet" : `${quotes}${passages > 0 ? ` (${passages} passage${passages === 1 ? "" : "s"})` : ""}`);
      if (links > 0) fact("Item links", String(links));
      if (state.thread.remote && state.thread.remote.length > 0) fact("From other blygs", state.thread.remote.join(" · "));
    }
    if (state.stub) {
      fact("Stub", `a reply to ${state.stub.label}`);
      if (state.stub.problem) facts.createEl("dd", { cls: "blyg-pane-warn", text: state.stub.problem });
    }
    if (state.hoppers) {
      const { note, studio, differ } = state.hoppers;
      fact("Hoppers", note === null ? "blyg_hoppers cannot be read" : note.length === 0 ? "none" : note.join(", "));
      if (differ && studio) fact("In the Studio", studio.length === 0 ? "in no hopper" : studio.join(", "));
    }
    if (state.studio?.mentions) {
      const { count, complete } = state.studio.mentions;
      fact("Mentions", count === 0 ? "none yet" : `${count}${complete ? "" : "+"}`);
    }
    if (state.item) {
      fact("Id", state.item.id);
      fact("Version", state.item.version === null ? "—" : String(state.item.version));
      fact("Created", formatWhen(state.item.created));
      fact("Updated", formatWhen(state.item.updated));
    }
    if (state.repoPath) fact("Writes to", state.repoPath);
    if (state.published) fact("Last published", formatWhen(state.published.at));
    if (state.webUrl) {
      facts.createEl("dt", { text: "Link" });
      // An https address the plugin built itself (core/webAddress.ts), shown as a link: a tap opens it like any link in a note.
      facts.createEl("dd").createEl("a", { cls: "external-link", text: shortUrl(state.webUrl), href: state.webUrl });
    }
    if (state.hint) box.createDiv({ cls: "blyg-pane-hint", text: state.hint });
    // Withdraw and Delete draft act on this item and are rare: here, at the foot of the facts, away from the status and the writing buttons.
    const publishable = !!state.route && state.status !== "not-markdown" && state.status !== "studio-missing";
    if (publishable && (state.showWithdraw || state.showDelete)) {
      const row = box.createDiv({ cls: "blyg-pane-buttons" });
      if (state.showWithdraw) this.button(row, "Withdraw", state.canWithdraw, () => this.host.withdraw(), "mod-warning");
      if (state.showDelete) this.button(row, "Delete draft", state.canDelete, () => this.host.deleteDraft(), "mod-warning");
    }
  }

  private drawDeploy(root: HTMLElement, state: PanelState): void {
    const deploy = this.host.deploy(state.deployPath);
    // The deploy belongs to the note whose file was committed: on any other note (or outside the publish folders) there is no box.
    if (deploy?.path !== undefined && deploy.path !== state.deployPath) return;
    const line = deployLine(deploy);
    if (!line) return;
    const box = root.createDiv({ cls: `blyg-pane-deploy${line.attention ? " blyg-pane-deploy-attention" : ""}` });
    box.createDiv({ cls: "blyg-pane-deploy-title", text: "Last deploy" });
    const head = box.createDiv();
    if (deploy?.phase === "done" && deploy.kind === "deployed") head.createSpan({ cls: "blyg-pane-check", text: "✓" });
    head.createSpan({ text: line.headline });
    if (line.detail) box.createDiv({ cls: "blyg-pane-note", text: line.detail });
    if (deploy?.phase === "done") box.createDiv({ cls: "blyg-pane-note", text: `Checked ${formatWhen(deploy.at.toISOString())}` });
    if (deploy?.phase === "done") {
      const again = box.createEl("button", { text: "Check again" });
      again.addEventListener("click", () => void this.run(() => this.host.recheckDeploy()));
    }
  }

  /** The note's next step, inside the status card: the main button (it opens the preview window; only the window's own button sends), only while there is something to send, and the ways out of a mismatch with the Studio. */
  private drawDecision(card: HTMLElement, state: PanelState): void {
    let row: HTMLElement | null = null;
    const button = (text: string, enabled: boolean, cls: string | undefined, onClick: () => void): void => {
      row ??= card.createDiv({ cls: "blyg-pane-buttons blyg-pane-decision" });
      const el = row.createEl("button", { text, ...(cls ? { cls } : {}) });
      el.disabled = !enabled || this.busy;
      el.addEventListener("click", onClick);
    };
    if (state.showRepost) button("Repost to Studio", state.canRepost, "mod-cta", () => void this.run(() => this.host.repost()));
    // A calm note (published, nothing changed) has nothing to send: no button, the green line says it all.
    if (state.emphasizePublish || !state.canPublish) button(state.publishLabel, state.canPublish, state.emphasizePublish ? "mod-cta" : undefined, () => void this.run(() => this.host.publish()));
    if (state.showPull) button("Replace note from Studio", state.canPull, undefined, () => void this.run(() => this.host.pull()));
    if (state.hoppers?.differ) {
      // A difference to settle belongs with the decision, not folded away: the note's hoppers and the Studio's disagree.
      button("Use the Studio's hoppers", state.hoppers.canTake, undefined, () => void this.run(() => this.host.takeHoppers()));
    }
    if (state.showOpenWeb && state.canOpenWeb) {
      button("Open on web", true, undefined, () => {
        if (state.webUrl) this.host.openWeb(state.webUrl);
      });
    }
    if (state.hoppers?.differ) {
      card.createDiv({ cls: "blyg-pane-hint", text: "The note's hoppers differ from the Studio's. Publishing or sending the note applies the changes you made in the note; “Use the Studio's hoppers” takes the Studio's into the note." });
    }
  }

  /** One action at a time: a second tap while the first waits for its window or the network would start a second publish. */
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    await this.refresh();
    try {
      await action();
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }
}
