// The text of an item as readers see it, to choose a passage from: one of this Studio's own items (its published version) or an item
// imported from another blyg (what this Studio holds of it). Writes nothing.
import { selectionText } from "../core/textContent";
import type { Quotable } from "../publish/items";
import { M } from "../publish/messages";
import { studioFailureOutcome } from "../publish/studio";
import { refused } from "../publish/types";
import type { StudioClient } from "./client";
import type { StudioPick } from "./picker";

export async function readQuotable(client: StudioClient, pick: StudioPick): Promise<Quotable> {
  const { id } = pick;
  if (pick.subscriptionId !== null) {
    const got = await client.getImported(pick.subscriptionId, id);
    if (got.kind !== "ok") return { ok: false, outcome: studioFailureOutcome("Reading the item", got) };
    if (got.value.state === "tombstone") return { ok: false, outcome: refused(M.studioNotQuotableTombstone(id)) };
    return { ok: true, id, version: got.value.version, kind: got.value.kind, html: got.value.contentHtml, text: selectionText(got.value.contentHtml) };
  }
  const got = await client.getItem(id);
  if (got.kind !== "ok") return { ok: false, outcome: studioFailureOutcome("Reading the item", got) };
  const item = got.value;
  if (item.status === "withdrawn") return { ok: false, outcome: refused(M.withdrawnItem("This item", id)) };
  if (!item.published) return { ok: false, outcome: refused(M.studioNotQuotableDraft(id)) };
  if (item.published.contentHtml === "") return { ok: false, outcome: refused(M.docUnreadable("This item", id, 200)) };
  return {
    ok: true,
    id,
    version: item.published.version,
    kind: item.kind,
    html: item.published.contentHtml,
    text: selectionText(item.published.contentHtml),
  };
}
