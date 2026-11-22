// "Blygs I follow" (HK7): the blygs the Studio follows, with the Studio's own status for each; follow a blyg from a pasted address, rename one,
// stop following one (after saying what the Studio then deletes). Everything happens at the Studio first; the list is read again after each change.
// Plain text only; the steps and the words are in app/followFlow.ts.
import { Modal, Setting, type App } from "obsidian";
import type { StudioClient } from "../studio/client";
import type { StudioFollowed, StudioFollowProposal } from "../studio/subscriptions";
import { confirmFollow, followedName, followText, hostOf, loadFollowed, proposeFollow, renameFollowed, statusLine, unfollow, unfollowQuestion, type Step } from "../app/followFlow";

export interface SubscriptionsDeps {
  /** A Studio client for the settings as they are now, or why there is none. */
  build: () => { ok: true; studio: { client: StudioClient } } | { ok: false; message: string };
  now?: () => number;
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
  private subs: StudioFollowed[] | null = null;
  private complete = true;
  /** One line under the title: what went wrong, or what was done. */
  private message = "";
  private address: string;
  private busy = false;

  constructor(app: App, private readonly deps: SubscriptionsDeps) {
    super(app);
    this.address = deps.prefill ?? "";
  }

  override onOpen(): void {
    this.setTitle(followText.title);
    this.render();
    void this.reload();
  }

  override onClose(): void {
    this.contentEl.empty();
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

  private async reload(): Promise<void> {
    const got = await this.run(loadFollowed);
    if (got === null) return;
    if (got.ok) {
      this.subs = got.value.subscriptions;
      this.complete = got.value.complete;
    } else this.message = got.message;
    this.render();
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
      .setDesc("Paste the address of a blyg. Your Studio shows you what it found before it follows.")
      .addText((t) => {
        t.setPlaceholder("https://…").setValue(this.address).onChange((v) => void (this.address = v));
        t.inputEl.setAttr("inputmode", "url");
        t.inputEl.setAttr("autocapitalize", "none");
      })
      .addButton((b) => b.setButtonText("Look up").setCta().setDisabled(this.busy).onClick(() => void this.propose()));
    if (this.subs === null) {
      if (this.message === "") el.createDiv({ cls: "blyg-note", text: "Reading your Studio…" });
      return;
    }
    if (this.subs.length === 0) el.createDiv({ cls: "blyg-note", text: followText.empty });
    for (const sub of this.subs) {
      const row = new Setting(el).setName(followedName(sub)).setDesc(`${sub.origin}\n${statusLine(sub, (this.deps.now ?? Date.now)())}`);
      row.descEl.addClass("blyg-follow-desc");
      row.addButton((b) => b.setButtonText("Rename").setDisabled(this.busy).onClick(() => this.show({ kind: "rename", sub })));
      row.addButton((b) => b.setButtonText("Unfollow").setDestructive().setDisabled(this.busy).onClick(() => this.show({ kind: "unfollow", sub })));
    }
    if (!this.complete) el.createDiv({ cls: "blyg-note", text: followText.incomplete });
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
      this.show({ kind: "list" }, followText.following(followedName(got.value)));
      void this.reload();
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
      this.show({ kind: "list" }, "");
      void this.reload();
    };
    new Setting(el)
      .setName("Name")
      .setDesc(`The name you see for ${sub.origin}. It changes nothing for the blyg.`)
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
            this.show({ kind: "list" }, got.ok ? `No longer following ${followedName(sub)}.` : got.message);
            void this.reload();
          })();
        }),
      )
      .addButton((b) => b.setButtonText("Keep following").setCta().onClick(() => this.show({ kind: "list" })));
  }
}

export function openSubscriptions(app: App, deps: SubscriptionsDeps): void {
  new SubscriptionsModal(app, deps).open();
}
