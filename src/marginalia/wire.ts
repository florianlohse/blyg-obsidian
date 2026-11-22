// HK3 Marginalia: the pieces joined to the plugin's own parts. Read-only: it asks the Studio's existing client for mentions, reads the posts the reader already
// holds, and reads the note's text; it writes nothing, in the vault or anywhere else.
import type { App } from "obsidian";
import type { Extension } from "@codemirror/state";
import { marginaliaExtension, type MarginaliaMarker } from "../editor/marginaliaExtension";
import { isBlygId } from "../core/ids";
import type { StudioClient } from "../studio/client";
import type { ReadingPost } from "../studio/reading";
import { sameOrigin } from "../ui/readerMentions";
import { closePopover, showPopover, type ReceptionActions } from "../ui/receptionView";
import { MarginaliaLookup, type SourceReader } from "./lookup";
import { buildReception, markersOf, paragraphsOf, parseQuotesOf, type ReceptionRow } from "./reception";
import { ReceptionStore, type ReceptionState } from "./store";

export interface MarginaliaHost {
  app: App;
  /** The Studio's client, or null when there is no Studio set up (nothing is asked then). */
  client(): StudioClient | null;
  /** A post the reader holds, by its id (with its Markdown while the list is live). */
  heldPost(id: string): Promise<ReadingPost | null>;
  refreshPanels(): void;
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
  /** Forget what is held (after a reader refresh or a publish). */
  invalidate(): void;
}

export function createMarginalia(host: MarginaliaHost): Marginalia {
  const read: SourceReader = async (m) => {
    const post = m.sourceId ? await host.heldPost(m.sourceId) : null;
    if (!post || !sameOrigin(post.origin, m.sourceOrigin)) return null;
    return { version: post.version, markdown: post.contentMd.trim() === "" ? null : post.contentMd, withdrawn: post.withdrawn };
  };
  const store = new ReceptionStore(
    {
      mentions: async () => {
        const got = await host.client()?.listInboundMentions(4);
        return got?.kind === "ok" ? { mentions: got.value.mentions, complete: got.value.complete && got.value.unreadable === 0 } : null;
      },
      now: () => Date.now(),
    },
    new MarginaliaLookup(read, parseQuotesOf),
  );
  store.subscribe(() => host.refreshPanels());
  const actions: ReceptionActions = { openPost: (row) => { const url = row.mention.sourcePage; if (url && /^https?:\/\//i.test(url)) window.open(url, "_blank"); } };
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
  const markersFor = (path: string | null, text: string): MarginaliaMarker[] => {
    const id = itemIdOf(path);
    if (id === null || host.client() === null) return [];
    store.request(id);
    const state = store.peek(id);
    if (state?.kind !== "ready") return [];
    if (last && last.state === state && last.text === text) return last.marks;
    const { rows, paragraphs } = rowsOf(state, text);
    const marks = [...markersOf(rows)].flatMap(([index, list]) => { const p = paragraphs[index]; return p ? [{ pos: p.to, rows: list }] : []; });
    last = { state, text, marks };
    return marks;
  };
  return {
    extension: marginaliaExtension({ markersFor, subscribe: (fn) => store.subscribe(fn), open: (anchor, rows) => showPopover(anchor, rows, actions, Date.now()) }),
    reception: async (path) => {
      const id = itemIdOf(path);
      if (id === null || host.client() === null || path === null) return null;
      const file = host.app.vault.getFileByPath(path);
      if (!file) return null;
      store.request(id);
      const state = store.peek(id);
      const text = await host.app.vault.cachedRead(file);
      return { status: state?.kind === "ready" ? "ready" : state?.kind === "failed" ? "failed" : "loading", incomplete: state?.kind === "ready" && !state.complete, rows: rowsOf(state, text).rows, actions };
    },
    invalidate: () => { closePopover(); store.invalidate(); last = null; },
  };
}
