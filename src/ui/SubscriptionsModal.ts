// "Sources" (HK7): the blygs the Studio follows, with the Studio's own status for each; follow a blyg from a pasted address, rename one, stop following one
// (after saying what the Studio then deletes). Everything happens at the Studio first. The list is shown at once from what was kept the last time and is read
// once, silently, per opening (app/followedList.ts); a change updates the list from the Studio's answer, without another read.
// Plain text only; the steps and the words are in app/followFlow.ts.
import { Modal, Setting, type App } from "obsidian";
import type { StudioClient } from "../studio/client";
import type { StudioFollowed, StudioFollowProposal } from "../studio/subscriptions";
import { confirmFollow, followedName, followText, hostOf, proposeFollow, renameFollowed, statusLine, unfollow, unfollowQuestion, type Step } from "../app/followFlow";
import { FollowedList, type FollowedStore } from "../app/followedList";
import { relativeTime } from "./readerFeed";

export interface SubscriptionsDeps {
  /** A Studio client for the settings as they are now, or why there is none. */
  build: () => { ok: true; studio: { client: StudioClient } } | { ok: false; message: string };
  now?: () => number;
  /** Where the list is kept between openings (none: it is read every time and not kept). */
  store?: FollowedStore;
  /** An address to start with (from a post of a blyg that needs a look before it is followed). */
  prefill?: string;
}

type View =
  | { kind: "list" }
  | { kind: "rename"; sub: StudioFollowed }
  | { kind: "unfollow"; sub: StudioFollowed }
  | { kind: "proposal"; url: string; proposal: StudioFollowProposal };

class SubscriptionsModal extends Modal {
  private view: View = { kind: "list" };
  private readonly list: FollowedList;
  private freshEl: HTMLElement | null = null;
  private rowsEl: HTMLElement | null = null;
  /** One line under the title: what went wrong, or what was done. */
  private message = "";
  private address: string;
  private busy = false;

  constructor(app: App, private readonly deps: SubscriptionsDeps) {
    super(app);
    this.address = deps.prefill ?? "";
    const store = deps.store ?? { read: async () => null, write: () => undefined };
    this.list = new FollowedList({ store, build: deps.build, ...(deps.now ? { now: deps.now } : {}), onChange: () => this.listChanged() });
  }

  override onOpen(): void {
    this.setTitle(followText.title);
    this.render();
    void this.list.open();
  }

  override onClose(): void {
    this.list.close();
    this.contentEl.empty();
  }

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The list or its freshness changed: only the list is drawn again, so the scroll position stays and a field being typed in is not touched. */
  private listChanged(): void {
    if (this.view.kind !== "list" || this.rowsEl === null) return;
    this.drawFresh();
    this.drawRows();
  }

  private client(): StudioClient | null {
    const built = this.deps.build();
    if (built.ok) return built.studio.client;
    this.message = built.message;
    return null;
  }

  /** Run a step with the client; keeps the screen from being used twice at once. */
  private async run<T>(step: (client: StudioClient) => Promise<Step<T>>): Promise<Step<T> | null> {
    if (this.busy) return null;
    const client = this.client();
    if (!client) {
      this.render();
      return null;
    }
    this.busy = true;
    this.render();
    try {
      return await step(client);
    } finally {
      this.busy = false;
    }
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    if (this.message !== "") el.createDiv({ cls: "blyg-note blyg-follow-message", text: this.message });
    switch (this.view.kind) {
      case "list":
        return this.drawList(el);
      case "rename":
        return this.drawRename(el, this.view.sub);
      case "unfollow":
        return this.drawUnfollow(el, this.view.sub);
      case "proposal":
        return this.drawProposal(el, this.view.url, this.view.proposal);
    }
  }

  private show(view: View, message = ""): void {
    this.view = view;
    this.message = message;
    this.render();
  }

  private drawList(el: HTMLElement): void {
    new Setting(el)
      .setName("Follow a blyg")
      .setDesc("Enter the address of a blyg. Your Studio shows what it found before it follows.")
      .addText((t) => {
        t.setPlaceholder("Address of a blyg, https://…").setValue(this.address).onChange((v) => void (this.address = v));
        t.inputEl.setAttr("inputmode", "url");
        t.inputEl.setAttr("autocapitalize", "none");
        t.inputEl.setAttr("aria-label", "Address of the blyg to follow");
      })
      .addButton((b) => b.setButtonText("Follow").setDisabled(this.busy).onClick(() => void this.propose()));
    this.freshEl = el.createDiv({ cls: "blyg-follow-fresh" });
    this.rowsEl = el.createDiv({ cls: "blyg-follow-rows" });
    this.drawFresh();
    this.drawRows();
  }

  /** One small muted line: how old the list on the screen is. */
  private drawFresh(): void {
    const el = this.freshEl;
    if (el === null) return;
    const f = this.list.fresh;
    const when = (ms: number | null): string => (ms === null ? "" : relativeTime(new Date(ms).toISOString(), this.nowMs()));
    let text = "";
    if (f.kind === "updating" && f.savedAt !== null) text = `updated ${when(f.savedAt)} · updating…`;
    else if (f.kind === "updated") text = `updated ${when(f.at)}`;
    else if (f.kind === "failed") text = f.savedAt !== null ? `could not update · last updated ${when(f.savedAt)}` : "could not update";
    el.setText(text);
    if (f.kind === "failed") el.setAttr("title", f.message);
    else el.removeAttribute("title");
  }

  private drawRows(): void {
    const el = this.rowsEl;
    if (el === null) return;
    el.empty();
    const subs = this.list.subs;
    if (subs === null) {
      const f = this.list.fresh;
      if (f.kind === "failed") el.createDiv({ cls: "blyg-note blyg-follow-message", text: f.message });
      else el.createDiv({ cls: "blyg-note", text: "Reading your Studio…" });
      return;
    }
    if (subs.length === 0) el.createDiv({ cls: "blyg-note", text: followText.empty });
    for (const sub of subs) {
      const name = followedName(sub);
      const row = el.createDiv({ cls: "blyg-follow-row" });
      const main = row.createDiv({ cls: "blyg-follow-main" });
      main.createDiv({ cls: "blyg-follow-name", text: name });
      main.createDiv({ cls: "blyg-follow-addr", text: sub.origin });
      main.createDiv({ cls: "blyg-follow-status", text: statusLine(sub, this.nowMs()) });
      const acts = row.createDiv({ cls: "blyg-follow-acts" });
      const rename = acts.createEl("button", { cls: "blyg-linkbtn", text: "Rename in the Studio", attr: { "aria-label": `Rename ${name} in the Studio`, title: "Change the name shown for this blyg. It is kept in your Studio, so it holds on all your devices." } });
      rename.disabled = this.busy;
      rename.addEventListener("click", () => this.show({ kind: "rename", sub }));
      const un = acts.createEl("button", { cls: "blyg-linkbtn blyg-follow-unfollow", text: "Unfollow", attr: { "aria-label": `Unfollow ${name}` } });
      un.disabled = this.busy;
      un.addEventListener("click", () => this.show({ kind: "unfollow", sub }));
    }
    if (!this.list.complete) el.createDiv({ cls: "blyg-note", text: followText.incomplete });
  }

  private async propose(): Promise<void> {
    const got = await this.run((c) => proposeFollow(c, this.address));
    if (got === null) return;
    if (!got.ok) {
      this.message = got.message;
      return this.render();
    }
    this.show({ kind: "proposal", url: got.value.url, proposal: got.value.proposal });
  }

  private drawProposal(el: HTMLElement, url: string, p: StudioFollowProposal): void {
    const what = p.kind === "rss" ? "a feed (not a blyg)" : p.kind === "hopper" ? `one public hopper${p.hopperTitle ? `, “${p.hopperTitle}”,` : ""} of a blyg` : "a blyg";
    el.createEl("p", { text: `Follow “${p.title || hostOf(p.origin || url)}”?` });
    el.createDiv({ cls: "blyg-note", text: `${url} is ${what}. Your Studio would fetch its posts and keep them for you to read.` });
    if (p.siteMismatch) el.createDiv({ cls: "blyg-note", text: followText.siteMismatch });
    const done = async (whole: boolean): Promise<void> => {
      const got = await this.run((c) => confirmFollow(c, url, { wholeBlyg: whole }));
      if (got === null) return;
      if (!got.ok) return this.show({ kind: "list" }, got.message);
      this.address = "";
      this.list.upsert(got.value);
      this.show({ kind: "list" }, followText.following(followedName(got.value)));
    };
    const row = new Setting(el).addButton((b) => b.setButtonText("Follow").setCta().setDisabled(this.busy).onClick(() => void done(false)));
    if (p.kind === "hopper") row.addButton((b) => b.setButtonText(p.blygTitle ? `Follow all of “${p.blygTitle}”` : "Follow the whole blyg").setDisabled(this.busy).onClick(() => void done(true)));
    row.addButton((b) => b.setButtonText("Cancel").onClick(() => this.show({ kind: "list" })));
  }

  private drawRename(el: HTMLElement, sub: StudioFollowed): void {
    let name = followedName(sub);
    const save = async (title: string | null): Promise<void> => {
      const got = await this.run((c) => renameFollowed(c, sub.id, title));
      if (got === null) return;
      if (!got.ok) {
        this.message = got.message;
        return this.render();
      }
      this.list.upsert(got.value);
      this.show({ kind: "list" }, "");
    };
    new Setting(el)
      .setName("Name")
      .setDesc(`The name shown for ${sub.origin}. It is kept in your Studio, so it holds on all your devices, and it changes nothing for the blyg.`)
      .addText((t) => t.setValue(name).onChange((v) => void (name = v)));
    new Setting(el)
      .addButton((b) => b.setButtonText("Save").setCta().setDisabled(this.busy).onClick(() => void save(name)))
      .addButton((b) => b.setButtonText("Use the blyg’s own name").setDisabled(this.busy).onClick(() => void save(null)))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.show({ kind: "list" })));
  }

  private drawUnfollow(el: HTMLElement, sub: StudioFollowed): void {
    const q = unfollowQuestion(followedName(sub));
    el.createEl("p", { text: q.title });
    el.createDiv({ cls: "blyg-note", text: q.body });
    new Setting(el)
      .addButton((b) =>
        b.setButtonText("Unfollow").setDestructive().setDisabled(this.busy).onClick(() => {
          void (async () => {
            const got = await this.run((c) => unfollow(c, sub.id));
            if (got === null) return;
            if (got.ok) this.list.remove(sub.id);
            this.show({ kind: "list" }, got.ok ? `No longer following ${followedName(sub)}.` : got.message);
          })();
        }),
      )
      .addButton((b) => b.setButtonText("Keep following").setCta().onClick(() => this.show({ kind: "list" })));
  }
}

export function openSubscriptions(app: App, deps: SubscriptionsDeps): void {
  new SubscriptionsModal(app, deps).open();
}
