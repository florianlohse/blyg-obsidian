// Where the Daily page put each post the last time it drew today's edition (the section's name as the page shows it: "Front page" for the lead block, a section, "Other",
// "Mixed bag"). The reader's "In the digest: <section>" chip asks here first, so it names the heading the post is really under; only when the Daily has not drawn the edition in
// this session does it fall back to what the edition record says (postSection.ts). Module memory, ids and names only, never stored.
import type { InDigest } from "./postSection";

let held: { edition: number; of: Map<string, string> } | null = null;

/** The page drew `edition` with these posts under these headings; null: it drew no sections (the plain page), so the chip has nothing to say from here. */
export function publishPlacement(edition: number | undefined, of: Map<string, string> | null): void {
  held = edition !== undefined && of ? { edition, of } : null;
}
export function placedSection(postId: string, edition: number | undefined): InDigest | null {
  const name = held && edition !== undefined && held.edition === edition ? held.of.get(postId) : undefined;
  return name && edition !== undefined ? { edition, section: name } : null;
}
