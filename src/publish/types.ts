import type { ContentsClient } from "../github/contents";
import type { Clock, Logger, NoteEditPort, Random, SiteReader, VaultPort, Yaml } from "../platform/ports";
import type { Route } from "../settings/schema";
import type { StudioAddress } from "../studio/address";
import type { StudioClient } from "../studio/client";
import type { PendingDrafts } from "../studio/pending";

export type Channel = "production" | "preview";

/** The slice of the settings the publish services read. */
export interface PublishSettings {
  /** Which channel the writes go to: shown in every preview and recorded on notes published to the test channel. */
  channel: Channel;
  /** The branch every write goes to: `github.branch` for production, `github.previewBranch` for preview. */
  branch: string;
  /** What to do about wikilinks to vault notes that no route publishes (their titles would leak). */
  outsideLinks: "block" | "warn" | "off";
  itemsDir: string;
  /** The identity origin of the blyg on the active channel ("https://example.com/blyg/"): stamped on snapshots, where items are read. */
  origin: string;
  fragmentCharCap: number;
  /** Threads have no cap; above this many characters the publish only warns (contract §3.3). */
  threadSoftCap: number;
  attachmentsDir: string;
  routes: Route[];
  /** R2 wishlist: a whitespace-only difference in a plain file counts as "no changes". Off at parity. */
  ignoreTrailingWhitespace: boolean;
}

/** How one wikilink in the text was judged (shown in the preview, so the verdict is never a black box). */
export interface LinkReport {
  target: string;
  embed: boolean;
  /**
   * published — a note inside a publish folder; outside — a note no publish folder covers; file — not a note (an image,
   * a PDF); unresolved — no such note in the vault.
   */
  kind: "published" | "outside" | "file" | "unresolved";
  /** The vault path it resolved to, when it did. */
  path?: string;
  /** The link is written with a folder path (`[[folder/Name]]`); the site uses only the last part, readers see it as typed. */
  folder?: boolean;
}

/** One quote of a thread, as the write preview lists it. */
export interface PreviewQuote {
  id: string;
  version: number;
  kind: "fragment" | "thread";
  /** The passage for a partial quote; null for a whole quotation. */
  passage: string | null;
  /** The first words of the source, so the author sees what is being quoted. */
  excerpt: string;
  /** new — not in the published thread yet; unchanged; moved — the source has a newer version than the published thread holds. */
  change: "new" | "unchanged" | "moved";
  fromVersion?: number;
}

/** What a write will change, shown to the user before anything is committed (decided: every changing write). */
export interface WritePreview {
  action: "create" | "update" | "withdraw" | "plain-create" | "plain-update" | "studio-conflict" | "studio-pull" | "draft" | "delete-draft";
  channel: Channel;
  branch: string;
  /** Repo path that will be written. */
  path: string;
  noteName: string;
  /** What is being written: "fragment" or "thread" for a Blyg item, else the route's label ("essay", "page", …). */
  label: string;
  id?: string;
  fromVersion?: number;
  toVersion?: number;
  /** What the repo holds now (the body for items, the whole file for plain routes); null when the file is new. */
  before: string | null;
  /** What it will hold after this write. */
  after: string;
  /** Readable frontmatter changes (Blyg items). */
  changes: string[];
  /** Every wikilink in the text that will be published, and how it was judged. */
  links: LinkReport[];
  /**
   * True for Blyg notes. There the site's pages turn `[[wikilinks]]` into links to essays (by name), while the feed other
   * blygs read keeps them as typed.
   */
  blygNote: boolean;
  /** Threads: what is quoted and which items are linked. Absent for fragments and plain files. */
  thread?: { quotes: PreviewQuote[]; itemLinks: Array<{ id: string; label: string; isNew: boolean }> };
  commitMessage: string;
  /** "studio-pull" only: the block ids (`^id`) in the note that the replacement removes, each with the start of its paragraph. */
  blockIds?: Array<{ id: string; excerpt: string }>;
  /**
   * Set for a publish through a Studio: the window then names the Studio instead of a branch, shows the Studio's own rendering, and
   * the button says "Publish". `branch`, `path` and `commitMessage` hold the Studio's address, the item's page (or "new item") and "".
   * `quotes`: what a thread quotes, as the Studio resolved it. `askNote`: the window offers the optional change note (an update, or a repost's first version); `noteDefault` is what the field starts with.
   * For the action "studio-conflict" `before` is the Studio's working copy and `after` the note's text; the choice is to overwrite, not, or to take the Studio's copy instead.
   * For "draft" (a drafts-only route) the window says that nothing goes live; `before` is the Studio's working copy (null for a new draft).
   * For "delete-draft" `before` is the draft's text and `after` is empty; the draft and the note's record of it go, the note keeps its text.
   * For "studio-pull" `before` is the note's text and `after` the Studio's copy that would replace it; nothing is sent to the Studio.
   */
  studio?: { host: string; html: string; quotes?: StudioQuoteLine[]; askNote?: boolean; noteDefault?: string; repost?: { id: string; origin: string | null; version: number | null } };
}

/** One quote of a thread for the window: the item, the passage (null: all of it), whether it lives in another blyg, and how the note labelled it. */
export interface StudioQuoteLine {
  id: string;
  version: number;
  passage: string | null;
  remote: boolean;
  label: string | null;
}

/** The user's answer to a window: no, yes, or yes with a change note (Studio updates only; the GitHub paths only look at the truth of it). */
export type Confirmation =
  | boolean
  | {
      note: string;
      /** Only the Studio's "copy was changed there" window: take the Studio's text into the note instead. */
      pull?: boolean;
      /** Only the pull window, when the note has block ids: append them to the end of the note (in a private comment) before they are lost. */
      appendIds?: boolean;
    };

/** What a publish to a Studio needs besides the common dependencies: only present when the Studio settings are usable. */
export interface StudioDeps {
  client: StudioClient;
  address: StudioAddress;
  pending: PendingDrafts;
}

export interface PublishDeps {
  settings: PublishSettings;
  /** Asked before every write that changes something. Resolve false to cancel: nothing is committed. */
  confirm: (preview: WritePreview) => Promise<Confirmation>;
  /** The GitHub client for Blyg and Plain routes. Absent in a Studio-only setup (no route needs it); then `githubProblem` says why. */
  github?: ContentsClient;
  /** Why there is no `github` (not set up, or no token on this device): what a refused GitHub publish says. */
  githubProblem?: string;
  /** Routes of mode "studio" publish through this. Absent when no usable Studio is set up (the publish is then refused). */
  studio?: StudioDeps;
  /** Why there is no `studio` (no usable address, no token on this device): what a refused Studio publish says. */
  studioProblem?: string;
  vault: VaultPort;
  /** Replacing a note's text (pulling a Studio's copy into it). Absent in callers that never do (tests). */
  edit?: NoteEditPort;
  yaml: Yaml;
  clock: Clock;
  random: Random;
  /** Reads item documents from the site (threads and item links need the quoted items' rendered HTML). */
  site?: SiteReader;
  logger?: Logger;
  /**
   * Plain routes: told "this text is on the branch now" after a commit and after a "No changes" (the repo already holds it), so
   * the panel can say "published". Its failure never fails a publish.
   */
  rememberPublished?: (branch: string, path: string, text: string) => Promise<void>;
}

export interface Outcome {
  /**
   * committed — something was written to GitHub; published — an item went live in a Studio (nothing to watch: Studio publishes at
   * once); noop — nothing to do; refused — stopped by a local rule before any write; failed — a GitHub, Studio or network problem
   * (nothing written, unless `notices` say otherwise).
   */
  status: "committed" | "published" | "noop" | "refused" | "failed" | "cancelled";
  /** What to tell the user, in order (the macro showed each as a notice). */
  notices: string[];
  /** `sha` is the commit GitHub made (what the deploy checks run on); `branch` is where it went. */
  commit?: { path: string; message: string; branch: string; sha?: string };
  id?: string;
  version?: number;
  /** The commit landed but the local note's frontmatter could not be updated: fix it by hand before republishing. */
  localStampFailed?: boolean;
}

/** The commit record of a committed outcome; `sha` is left out when GitHub did not report one. */
export const commitRecord = (path: string, message: string, branch: string, sha: string | undefined): NonNullable<Outcome["commit"]> => ({
  path,
  message,
  branch,
  ...(sha ? { sha } : {}),
});

export const refused = (message: string): Outcome => ({ status: "refused", notices: [message] });
export const failed = (message: string): Outcome => ({ status: "failed", notices: [message] });
export const noop = (message: string): Outcome => ({ status: "noop", notices: [message] });
export const cancelled = (message: string): Outcome => ({ status: "cancelled", notices: [message] });
