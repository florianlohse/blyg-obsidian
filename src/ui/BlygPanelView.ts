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
  quoteInNewThread(): Promise<void>;
  continueThread(): Promise<void>;
  makeThread(): Promise<void>;
  insertQuote(): Promise<void>;
  insertLink(): Promise<void>;
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

    // Normal text with a coloured edge and a green check when everything is fine (never colour on colour, see styles.css).
    const status = root.createDiv({ cls: `blyg-pane-status${state.ok ? " blyg-pane-status-ok" : ""}` });
    const headline = status.createDiv({ cls: `blyg-pane-headline blyg-pane-${state.status}` });
    if (state.ok) headline.createSpan({ cls: "blyg-pane-check", text: "✓" });
    headline.createSpan({ text: state.headline });
    for (const line of state.notes) status.createDiv({ cls: "blyg-pane-note", text: line });

    this.drawStudioWarnings(root, state);
    this.drawWriteButtons(root, state);

    const facts = root.createEl("dl", { cls: "blyg-pane-facts" });
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

    if (state.hint) root.createDiv({ cls: "blyg-pane-hint", text: state.hint });
    if (state.hoppers?.differ) {
      root.createDiv({ cls: "blyg-pane-hint", text: "The note's hoppers differ from the Studio's. Publishing or sending the note applies the changes you made in the note; “Use the Studio's hoppers” takes the Studio's into the note." });
    }

    this.drawDeploy(root, state);
    // Publish, Withdraw and Open on web mean something only for a note in a publish folder; elsewhere the status above is all there is.
    if (state.route && state.status !== "not-markdown") this.drawButtons(root, state);
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

  /** Writing: make a new note or thread, quote the open note into a new thread, continue the open thread. Grayed out when it does not apply. */
  private drawWriteButtons(root: HTMLElement, state: PanelState): void {
    const w = state.write;
    const box = root.createDiv({ cls: "blyg-pane-write" });
    box.createDiv({ cls: "blyg-pane-write-title", text: "Write" });
    const row = box.createDiv({ cls: "blyg-pane-buttons" });
    const button = (text: string, enabled: boolean, action: () => Promise<void>): void => {
      const el = row.createEl("button", { text });
      el.disabled = !enabled || this.busy;
      el.addEventListener("click", () => void this.run(action));
    };
    button("New thread", w.canCreate, () => this.host.newThread());
    button("New fragment", w.canCreate, () => this.host.newNote());
    if (w.canImport) button("Import from Studio", true, () => this.host.importFromStudio());
    if (w.canReply) button("Reply to item", true, () => this.host.replyToItem());
    if (w.canMakeReply) button("Make reply", true, () => this.host.makeReply());
    // The rest act on an open Blyg note: outside the Blyg folders they would only be dead buttons, so they are not drawn at all.
    if ((state.route?.mode !== "blyg" && state.route?.mode !== "studio") || state.status === "not-markdown") return;
    button("Quote in thread", w.canQuoteInThread, () => this.host.quoteInNewThread());
    button("Continue thread", w.canContinue, () => this.host.continueThread());
    button("Make thread", w.canMakeThread, () => this.host.makeThread());
    button("Insert quote", w.canInsertQuote, () => this.host.insertQuote());
    button("Insert link", w.canInsertLink, () => this.host.insertLink());
    // A grey "Insert quote" on a fragment is correct (only a thread can quote), but it looked like a fault in the device test: say why.
    if (!w.canInsertQuote && state.kind === "fragment") {
      box.createDiv({
        cls: "blyg-pane-hint",
        text: state.item
          ? "Insert quote works in threads only. This note is a published fragment, and the kind of a published item never changes: start a new thread with Quote in thread."
          : "Insert quote works in threads only. This note is a fragment: tap Make thread to turn it into a thread (possible until it is published).",
      });
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

  private drawButtons(root: HTMLElement, state: PanelState): void {
    const row = root.createDiv({ cls: "blyg-pane-buttons" });
    const button = (text: string, enabled: boolean, cls: string | undefined, onClick: () => void): void => {
      const el = row.createEl("button", { text, ...(cls ? { cls } : {}) });
      el.disabled = !enabled || this.busy;
      el.addEventListener("click", onClick);
    };
    if (state.showRepost) button("Repost to Studio", state.canRepost, "mod-cta", () => void this.run(() => this.host.repost()));
    button(state.publishLabel, state.canPublish, state.emphasizePublish ? "mod-cta" : undefined, () => void this.run(() => this.host.publish()));
    if (state.showPull) button("Replace this note with the online text", state.canPull, undefined, () => void this.run(() => this.host.pull()));
    if (state.showWithdraw) button("Withdraw", state.canWithdraw, "mod-warning", () => void this.run(() => this.host.withdraw()));
    if (state.showDelete) button("Delete draft", state.canDelete, "mod-warning", () => void this.run(() => this.host.deleteDraft()));
    if (state.hoppers) {
      button("Hoppers…", true, undefined, () => void this.run(() => this.host.chooseHoppers()));
      if (state.hoppers.differ) button("Use the Studio's hoppers", state.hoppers.canTake, undefined, () => void this.run(() => this.host.takeHoppers()));
    }
    if (state.showOpenWeb) {
      button("Open on web", state.canOpenWeb, undefined, () => {
        if (state.webUrl) this.host.openWeb(state.webUrl);
      });
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
