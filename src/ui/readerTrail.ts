// The posts you left by following a quote, each with how far down you were: Back reopens the last one at that place. Pure bookkeeping.
import type { ReadingPost } from "../studio/reading";

export interface TrailStep { post: ReadingPost; top: number }

export class Trail {
  private steps: TrailStep[] = [];
  get length(): number { return this.steps.length; }
  push(post: ReadingPost, top: number): void { this.steps.push({ post, top: Math.max(0, top) }); }
  pop(): TrailStep | undefined { return this.steps.pop(); }
  clear(): void { this.steps = []; }
}
