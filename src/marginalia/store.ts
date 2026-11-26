// HK3 Marginalia: what a note's item has received, asked once and kept in memory for a few minutes (never in the vault: a stranger's words are not stored).
// Reads only. A failure is its own state, never an empty list.
import type { InboundMention } from "../studio/reading";
import { MarginaliaLookup, type MarginaliaEntry } from "./lookup";

export type ReceptionState =
  | { kind: "loading" }
  | { kind: "ready"; entries: MarginaliaEntry[]; /** False when the Studio's list of mentions was cut off: there may be more. */ complete: boolean; at: number }
  | { kind: "failed"; at: number };

export interface ReceptionStoreDeps {
  /** The owner's inbound mentions OF ONE ITEM, verified and visible only (the client's method with the item filter); null when the Studio could not be asked. */
  mentions(itemId: string): Promise<{ mentions: InboundMention[]; complete: boolean } | null>;
  now(): number;
}

const READY_MS = 5 * 60_000;
const FAILED_MS = 60_000;

export class ReceptionStore {
  private readonly states = new Map<string, ReceptionState>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ReceptionStoreDeps, private readonly lookup: MarginaliaLookup) {}

  peek(itemId: string): ReceptionState | undefined {
    return this.states.get(itemId);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Forget what is held (a publish or a reader refresh may have changed it); the next `request` asks again. */
  invalidate(): void {
    this.states.clear();
  }

  /** Start looking an item up unless a fresh answer (or a lookup under way) is held. Returns at once; listeners hear when it is done. */
  request(itemId: string): void {
    const have = this.states.get(itemId);
    if (have) {
      if (have.kind === "loading") return;
      if (this.deps.now() - have.at < (have.kind === "ready" ? READY_MS : FAILED_MS)) return;
    }
    // Keep showing the old answer while a new one is fetched; only a first lookup shows "loading".
    if (!have) this.states.set(itemId, { kind: "loading" });
    void this.run(itemId, have);
  }

  private async run(itemId: string, previous: ReceptionState | undefined): Promise<void> {
    let next: ReceptionState;
    try {
      const got = await this.deps.mentions(itemId);
      if (got === null) next = { kind: "failed", at: this.deps.now() };
      else {
        const entries = await this.lookup.lookup(got.mentions, itemId);
        next = { kind: "ready", entries, complete: got.complete, at: this.deps.now() };
      }
    } catch {
      next = { kind: "failed", at: this.deps.now() };
    }
    // A failed refresh keeps the older good answer rather than replacing it with nothing.
    if (next.kind === "failed" && previous?.kind === "ready") next = { ...previous, at: this.deps.now() };
    this.states.set(itemId, next);
    for (const fn of [...this.listeners]) fn();
  }
}
