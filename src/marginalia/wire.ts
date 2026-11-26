// HK3 Marginalia: the pieces joined to the plugin's own parts. Read-only: it asks the Studio's existing client for mentions, reads the posts the reader already
// holds, and reads the note's text; it writes nothing, in the vault or anywhere else.
import type { App, Plugin } from "obsidian";
import type { Extension } from "@codemirror/state";
import { marginaliaExtension, type MarginaliaMarker } from "../editor/marginaliaExtension";
import { receptionBottomExtension } from "../editor/receptionBottomExtension";
import { isBlygId } from "../core/ids";
import type { StudioClient } from "../studio/client";
import type { ReadingPost } from "../studio/reading";
import { postFromPeekItem } from "../app/shareOpen";
import { BLYG_READER_VIEW, BlygReaderView } from "../ui/ReaderView";
import { sameOrigin } from "../ui/readerMentions";
import { closePopover, showPopover, type ReceptionActions } from "../ui/receptionView";
import { parseQuotesFromHtml } from "./htmlQuotes";
import { MarginaliaLookup } from "./lookup";
import { registerReadingSection } from "./reading";
import { makeSourceReader } from "./sourceRead";
import { buildReception, markGroups, paragraphsOf, parseQuotesOf, type ReceptionRow } from "./reception";
import { ReceptionStore, type ReceptionState } from "./store";

export interface MarginaliaHost {
  app: App;
  /** The Studio's client, or null when there is no Studio set up (nothing is asked then). */
  client(): StudioClient | null;
  /** A post the reader holds, by its id (with its Markdown while the list is live). */
  heldPost(id: string): Promise<ReadingPost | null>;
  refreshPanels(): void;
  /** Open (or bring forward) the reader. */
  openReader(): Promise<void>;
  /** The two display switches (settings `marginalia`), read each time something is drawn. */
  options(): { markers: boolean; bottom: boolean };
}

/** What the panel's Reception section draws. */
export interface ReceptionPanel {
  status: "loading" | "ready" | "failed";
  /** The Studio's list of mentions was cut off: there may be more than shown. */
  incomplete: boolean;
  rows: ReceptionRow[];
  actions: ReceptionActions;
}

export interface Marginalia {
  extension: Extension;
  /** The panel's data for the note at `path`; null when the note is not a published item of this Studio. */
  reception(path: string | null): Promise<ReceptionPanel | null>;
  /** The same for a note whose text is at hand (the editor's), without reading the file; asks for the lookup the first time. */
  receptionFor(path: string | null, text: string): ReceptionPanel | null;
  /** Draw the Reception section at the end of a published note in Reading view (a post processor of `plugin`). */
  registerReading(plugin: Plugin): void;
  /** Forget what is held (after a reader refresh or a publish). */
  invalidate(): void;
}

export function createMarginalia(host: MarginaliaHost): Marginalia {
  const read = makeSourceReader(host);
  const store = new ReceptionStore(
    {
      mentions: async (itemId) => {
        const got = await host.client()?.listInboundMentions(4, itemId);
        return got?.kind === "ok" ? { mentions: got.value.mentions, complete: got.value.complete && got.value.unreadable === 0 } : null;
      },
      now: () => Date.now(),
    },
    new MarginaliaLookup(read, parseQuotesOf, parseQuotesFromHtml),
  );
  store.subscribe(() => host.refreshPanels());
  // "Open post": in the reader (the held copy, else a peek, as the share entry does); the web page only when the reader cannot open it.
  const openOnWeb = (url: string | null): void => { if (url && /^https?:\/\//i.test(url)) window.open(url, "_blank"); };
  const actions: ReceptionActions = {
    openPost: (row) => {
      const m = row.mention;
      void (async () => {
        try {
          let post = m.sourceId ? await host.heldPost(m.sourceId) : null;
          if (post && !sameOrigin(post.origin, m.sourceOrigin)) post = null;
          if (!post && m.sourceOrigin && m.sourceId) {
            const peek = await host.client()?.peekItem(m.sourceOrigin, m.sourceId);
            if (peek?.kind === "ok") post = postFromPeekItem(peek.value, m.sourceAuthorName ?? "", Date.now());
          }
          if (post) {
            await host.openReader();
            const view = host.app.workspace.getLeavesOfType(BLYG_READER_VIEW).map((l) => l.view).find((v): v is BlygReaderView => v instanceof BlygReaderView);
            if (view) return void view.openPost(post);
          }
        } catch {
          // falls through to the web page
        }
        openOnWeb(m.sourcePage);
      })();
    },
  };
  const itemIdOf = (path: string | null): string | null => {
    const file = path === null ? null : host.app.vault.getFileByPath(path);
    const id = file ? (host.app.metadataCache.getFileCache(file)?.frontmatter?.blyg_id as unknown) : null;
    return typeof id === "string" && isBlygId(id) ? id : null;
  };
  const rowsOf = (state: ReceptionState | undefined, text: string): { rows: ReceptionRow[]; paragraphs: ReturnType<typeof paragraphsOf> } => {
    const paragraphs = paragraphsOf(text);
    return { rows: state?.kind === "ready" ? buildReception(state.entries, paragraphs) : [], paragraphs };
  };
  // The editor asks on every change of the text: the last answer is kept for the same state and text.
  let last: { state: ReceptionState | undefined; text: string; marks: MarginaliaMarker[] } | null = null;
  const panelOf = (id: string, text: string): ReceptionPanel => {
    store.request(id);
    const state = store.peek(id);
    return { status: state?.kind === "ready" ? "ready" : state?.kind === "failed" ? "failed" : "loading", incomplete: state?.kind === "ready" && !state.complete, rows: rowsOf(state, text).rows, actions };
  };
  const receptionFor = (path: string | null, text: string): ReceptionPanel | null => {
    const id = itemIdOf(path);
    return id === null || host.client() === null ? null : panelOf(id, text);
  };
  const markersFor = (path: string | null, text: string): MarginaliaMarker[] => {
    if (!host.options().markers) return [];
    const id = itemIdOf(path);
    if (id === null || host.client() === null) return [];
    store.request(id);
    const state = store.peek(id);
    if (state?.kind !== "ready") return [];
    if (last && last.state === state && last.text === text) return last.marks;
    const { rows, paragraphs } = rowsOf(state, text);
    const marks = markGroups(rows, paragraphs, text);
    last = { state, text, marks };
    return marks;
  };
  return {
    extension: [
      marginaliaExtension({ markersFor, subscribe: (fn) => store.subscribe(fn), open: (anchor, rows) => showPopover(anchor, rows, actions, Date.now()) }),
      receptionBottomExtension({ receptionFor: (path, text) => (host.options().bottom ? receptionFor(path, text) : null), enabled: () => host.options().bottom, subscribe: (fn) => store.subscribe(fn) }),
    ],
    receptionFor,
    registerReading: (plugin) => registerReadingSection(plugin, { receptionFor, enabled: () => host.options().bottom, subscribe: (fn) => store.subscribe(fn) }),
    reception: async (path) => {
      const id = itemIdOf(path);
      if (id === null || host.client() === null || path === null) return null;
      const file = host.app.vault.getFileByPath(path);
      if (!file) return null;
      return panelOf(id, await host.app.vault.cachedRead(file));
    },
    invalidate: () => { closePopover(); store.invalidate(); last = null; },
  };
}
