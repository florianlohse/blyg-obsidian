// Everything the publish services say. R2 wording: honest about what happened ("committed", never "live": the site
// deploys only after its checks pass) and names the branch. Changing wording means updating the tests that pin it.
import type { Channel } from "./types";

const deploys = (channel: Channel): string =>
  channel === "preview"
    ? "The preview site deploys after its checks pass (about 1–2 minutes)."
    : "The site deploys after its checks pass (about 1–2 minutes).";

export const M = {
  noChanges: "No changes since the last publish — nothing was committed.",
  cancelled: "Cancelled — nothing was committed.",
  emptyBody: "Note body is empty — nothing to publish.",
  emptyNote: "Note is empty — nothing to publish.",
  tooLong: (length: number, cap: number) =>
    `Note is ${length} chars, over the ${cap}-char fragment cap — shorten before publishing (the site's checks would reject it anyway).`,
  notInRoute: (path: string, prefixes: string[]) =>
    `Refusing to publish "${path}" — it is not in a publishable folder. Routes: ${prefixes.join(", ")}`,
  withdrawNotBlyg: (path: string) => `Refusing to withdraw "${path}" — it is not in a Blyg folder.`,
  notMarkdown: (name: string) => `Refusing: "${name}" is not a Markdown file.`,
  unusablePath: (path: string) => `Refusing: unusable path "${path}".`,
  noDestination: (label: string) => `Refusing: the route "${label}" has no repository folder set.`,
  insideBlygFolder: (destPath: string) => `Refusing: "${destPath}" is inside the Blyg folder.`,
  invalidId: (value: string) =>
    `Refusing: the note's blyg_id (${value.slice(0, 40)}) is not a valid Blyg id. Fix or remove it by hand.`,
  notPublished: (errors: string[]) => `Not published — ${errors.join(" ")}`,
  unclosedComment: (line: number) =>
    `Not published — a %% comment opens on line ${line} of the note and never closes, so the rest of the note might be private. Close it or remove the %%.`,
  outsideLinks: (names: string[]) =>
    `Not published — the note has links the site cannot honour: ${names.join(", ")}. A link to a note outside the publish folders would put its title on the site; a link to a note that does not exist yet is dead text. Fix or remove the links, or set "Links to unpublished notes" to Warn in the plugin settings.`,
  outsideLinksWarning: (names: string[]) => `the note has links the site cannot honour: ${names.join(", ")}.`,
  previewNote: (path: string) =>
    `Refusing: "${path}" was published to the preview (test) channel. Publishing it to production would treat it as a republish of an item that does not exist there. Use a new note for production.`,
  noIdToWithdraw: "This note has no blyg_id — nothing published to withdraw. Publish it first.",
  committedMissing: (id: string, path: string, branch: string) =>
    `This note has blyg_id ${id} locally but nothing committed at ${path} on ${branch} — looks like an earlier publish didn't finish, or it was published to another channel. Not auto-recovering; check the repo by hand.`,
  withdrawCommittedMissing: (id: string, path: string, branch: string) =>
    `blyg_id ${id} is set locally but nothing is committed at ${path} on ${branch} — not auto-recovering, check the repo by hand.`,
  noFrontmatter: "Committed note on GitHub has no parseable frontmatter — see console, not auto-recovering.",
  malformedCommitted: (problem: string) =>
    `The committed note on GitHub looks damaged (${problem}) — not auto-recovering, check the repo by hand.`,
  unexpectedGet: (status: number) => `Unexpected GET status ${status} — see console.`,
  networkRead: "Network or parse error reading the committed note — see console.",
  networkSite: "Network error reading the site — see console. Nothing was committed, safe to retry.",
  networkReadPlain: "Network error reading the committed file — see console.",
  networkWrite: "Network error publishing — see console. Local note untouched, safe to retry.",
  networkWritePlain: "Network error publishing — see console. Nothing changed, safe to retry.",
  networkWithdraw: "Network error withdrawing — see console. Local note untouched, safe to retry.",
  conflict: (status: number) =>
    `${status} — someone else changed this in the meantime (probably the other device). Nothing was committed. Re-run to pick up the latest state.`,
  writeNotFound: (branch: string) =>
    `Publish failed: 404 — the repository or the branch "${branch}" was not found (or the token cannot see it). Nothing was committed.`,
  publishFailed: (status: number) => `Publish failed: ${status} — see console.`,
  withdrawFailed: (status: number) => `Withdraw failed: ${status} — see console.`,
  publishedNew: (id: string, version: number, branch: string, channel: Channel) =>
    `Committed v${version} to ${branch} (new id ${id}). ${deploys(channel)}`,
  publishedUpdate: (version: number, branch: string, channel: Channel) =>
    `Committed v${version} to ${branch}. ${deploys(channel)}`,
  withdrawn: (version: number, branch: string, channel: Channel) =>
    `Withdrawn: committed v${version} to ${branch}. ${deploys(channel)}`,
  alreadyWithdrawn: "Already withdrawn — nothing was committed.",
  stampFailedNew: (id: string, branch: string) =>
    `Committed ${id} v1 to ${branch}, but writing the local frontmatter failed — see console. Fix the local file by hand before republishing.`,
  stampFailedUpdate: (id: string, version: number, branch: string) =>
    `Committed ${id} v${version} to ${branch}, but writing the local frontmatter failed — see console. Fix the local file by hand.`,
  stampFailedWithdraw: (id: string, version: number, branch: string) =>
    `Withdrew ${id} v${version} on ${branch}, but writing the local frontmatter failed — see console. Fix the local file by hand.`,
  plainDone: (verb: "update" | "publish", label: string, rel: string, branch: string, channel: Channel) =>
    `Committed ${verb === "update" ? "update to" : "new"} ${label} “${rel}” to ${branch}. ${deploys(channel)}`,
  commentsLeftOut: (n: number) => `Left out ${n} Obsidian comment${n === 1 ? "" : "s"} (%%…%%) — they are never published.`,
  headsUp: (warnings: string[]) => `Heads-up: ${warnings.join(" ")}`,
  missingImages: (dir: string, shown: string) =>
    `embedded images not found in ${dir} (the plugin does not upload images yet): ${shown}.`,

  // ---- threads and item links (R3) ----
  unknownKind: (value: string) => `Refusing: blyg_kind is “${value.slice(0, 30)}”. Use “thread”, or remove the property for a fragment.`,
  kindChanged: (id: string, localKind: string, committedKind: string) =>
    `Not published — this note is a ${localKind}, but ${id} is already published as a ${committedKind}, and the kind of a published item never changes. Restore blyg_kind, or start a new fragment or thread.`,
  needsOrigin: (channel: Channel) =>
    `Not published — a thread (or a link to another item) needs the blyg address of the ${channel === "preview" ? "preview" : "production"} site, like https://example.com/blyg/. Set it in Settings → Blyg.`,
  needsSite: "Not published — the plugin has no way to read the site here. This is a bug; please report it.",
  emptyThread: "Thread body is empty — nothing to publish.",
  threadSoftCap: (length: number, cap: number) => `this thread is ${length} characters, over the soft limit of ${cap}.`,
  grammarRefused: (problems: string[]) => `Not published — ${problems.length === 1 ? "a line" : "some lines"} the plugin cannot be sure about: ${problems.join(" · ")}`,
  fragmentQuotes: (line: number) =>
    `Not published — line ${line} quotes another item, which only a thread can do. Add the property blyg_kind: thread before the first publish (the kind of a published item never changes), or take the line out.`,
  itemProblems: (problems: string[]) =>
    `Not published — ${problems.length === 1 ? "one problem" : `${problems.length} problems`} with what this note quotes or links to:\n${problems.map((p) => `• ${p}`).join("\n")}`,
  noSuchItem: (what: string, id: string, branch: string) =>
    `${what}: no published item ${id} on ${branch}. For now only your own published items can be quoted or linked.`,
  withdrawnItem: (what: string, id: string) => `${what}: ${id} is withdrawn, so it cannot be quoted or linked. Take it out.`,
  notDeployed: (what: string, id: string, committed: number, served: number | null) =>
    served === null
      ? `${what}: ${id} v${committed} is committed but the site does not serve it yet. Wait a minute or two and publish again.`
      : `${what}: ${id} v${committed} is committed but the site still serves v${served}. Wait a minute or two and publish again.`,
  serverNewer: (what: string, id: string, committed: number, served: number) =>
    `${what}: the site serves ${id} v${served} but the repository holds v${committed}. Check the repository by hand.`,
  docKind: (what: string, id: string, committed: string, served: string) =>
    `${what}: ${id} is a ${committed} in the repository but the site serves it as ${served}. Wait for the deploy or check by hand.`,
  docUnreadable: (what: string, id: string, status: number) =>
    status === 200
      ? `${what}: the site's document for ${id} is not in the expected form.`
      : `${what}: the site answered ${status} for ${id}.`,
  badAddress: (what: string, origin: string) => `${what}: the blyg address “${origin.slice(0, 60)}” is not usable. It must be a public https address.`,
  quoteUnsupported: (line: number, reason: string) =>
    `Line ${line}: this passage cannot be published as written: ${reason}. Delete the quoted lines and insert the passage again with “Insert quote”, which writes it safely.`,
  quoteEmpty: (line: number) => `Line ${line}: the quote under this directive is empty.`,
  quoteNotFound: (line: number, id: string, version: number, hasQuotes: boolean) =>
    `Line ${line}: the quoted passage is not in ${id} v${version}${hasQuotes ? ". It contains a quotation mark or apostrophe: the site shows those as curly characters, so a passage typed with straight ones does not match. Insert it with “Insert quote”, which copies the exact text" : ". The source may have changed since you quoted it, or the passage was retyped. Insert it again with “Insert quote”"}.`,
  lazyQuote: (lines: number[]) =>
    `Line ${lines.slice(0, 3).join(", ")}${lines.length > 3 ? ", …" : ""} sits directly under a quote with no “>” and no blank line before it. Studio 0.50 and later read such a line as part of the QUOTED passage (older ones as your own words), so the same note would publish differently. Nothing was sent. Add a blank line after the quote, or put “>” in front of the line.`,
  embedsLeft: (problems: string[]) =>
    `Not published — the site shows notes as plain text, so an embed would appear as literal brackets and the site would refuse to deploy it: ${problems.join(" · ")}. Only a whole line that embeds a published fragment or thread, in a thread, is a quote. Remove the embed (images cannot be published in notes yet).`,
  embedNotPublished: (name: string) => `“${name}” is not published yet. Publish it first, then the note that quotes or links to it.`,
  embedWithdrawn: (name: string) => `“${name}” is withdrawn, so it cannot be quoted or linked. Take it out.`,
  embedNotBlyg: (name: string) => `“${name}” is an essay or a page. Only Blyg items (fragments and threads) can be quoted: on the site an embed shows as plain text.`,
  embedForm: (inner: string) =>
    `![[${inner.slice(0, 50)}]] embeds a heading, a block or a size. Only a whole note can be published as a quote: embed the whole note, or use “Insert quote” for a passage.`,
  closure: (chain: string[]) =>
    `Not published — this thread would quote itself through ${chain.map((id) => id.slice(0, 8)).join(" → ")}…. A thread cannot quote a thread that quotes it.`,

  // ---- Studio (S2) ----
  studioCancelled: "Cancelled — nothing was published and the Studio was not changed.",
  githubNotSetUp: "Not published — this folder publishes to a GitHub site, and GitHub is not set up. Open Settings → Blyg → GitHub, or move the note to a Studio folder.",
  studioNotConfigured: "Not published — no usable Studio is set up. Open Settings → Blyg → Studio: address and token.",
  studioLinks: (names: string[]) =>
    `Not published — the note has links the Studio would show as plain text: ${names.join(", ")}. Only notes published in the Studio can be linked: publish the note first, or take the link out.`,
  studioNotInStudio: (name: string, origin: string | null) =>
    origin === null
      ? `“${name}” was published to your site's old blyg (or has no Studio record), so the Studio does not have it. Repost it to the Studio first (the Repost to Studio button in the panel, or the command “Studio: repost this note”), then the note that quotes or links to it.`
      : `“${name}” belongs to another blyg (${origin}), not to the Studio set up now, so it cannot be quoted or linked by name. Quote it from the picker (it lists the Studio's own items and the blygs you read) or take it out.`,
  studioQuoteDamaged: (name: string, problem: string) => `“${name}” has a damaged Studio record: ${problem}. Fix the note's properties first.`,
  studioOtherRecord: (id: string, origin: string | null) =>
    origin === null
      ? `Not published — this note already has the id ${id} from the old blyg on your site, not from the Studio. Publishing would not update that item. Use the Repost to Studio button in the panel (or the command “Studio: repost this note”) to publish it as a new item (the old one stays where it is), or start a new note.`
      : `Not published — this note belongs to another blyg (${origin}), not to the Studio set up now. Switch the Studio settings back, or start a new note.`,
  studioInvalidRecord: (problem: string) => `Not published — ${problem}. Fix or remove the property by hand.`,
  studioItemMissing: (id: string, host: string) =>
    `Not published — the Studio at ${host} has no item ${id}. It may have been deleted there, or the note belongs to a different Studio. Nothing was changed.`,
  studioKindFixed: (id: string, localKind: string, studioKind: string) =>
    `Not published — this note is a ${localKind}, but ${id} is a ${studioKind} in the Studio, and the kind of a published item never changes.`,
  studioChangedThereCancelled: (id: string) =>
    `Cancelled — the working copy of ${id} was changed in the Studio since this note last sent it. It was left as it is, and so is the note. Look at it in the Studio, or publish again and choose to overwrite it.`,
  studioPullDone: (id: string, named: number, left: number) =>
    `The note now holds the Studio's copy of ${id}.${named > 0 ? ` ${named} link${named === 1 ? "" : "s"} to other items show by note name again.` : ""}${left > 0 ? ` ${left} stay${left === 1 ? "s" : ""} as an id (no note of yours holds it), which is fine.` : ""} Nothing was sent to the Studio.`,
  studioPullIds: (n: number, appended: boolean) =>
    `${n} block id${n === 1 ? "" : "s"} (^…) of the old text ${n === 1 ? "is" : "are"} gone, so ![[note#^id]] links and Resurface marks that point to ${n === 1 ? "it" : "them"} stop working.${appended ? " The id" + (n === 1 ? " was" : "s were") + " written to the end of the note in a private %% comment." : ""}`,
  studioDraftsOnlyNoRepost: "This folder only sends drafts, so it cannot repost. Move the note to a normal Studio folder to repost it.",
  studioDraftsOnlyNoWithdraw: "This folder only sends drafts and never withdraws. Withdraw from a normal Studio folder, or in the Studio.",
  studioDraftsOnlyWithdrawn: (id: string) => `${id} is withdrawn in the Studio. A drafts-only folder does not bring it back: use a normal Studio folder.`,
  studioDraftNoChanges: "The Studio's working copy already has this text — nothing to send.",
  studioDraftSent: (id: string) => `Draft sent to the Studio (${id}). It is not published: only you can see it in the Studio.`,
  studioDraftUpdated: (id: string, version: number) => `The Studio's working copy of ${id} now has this text. Version ${version} stays as it was published; nothing went live.`,
  studioDraftDeleted: (id: string) => `Draft ${id} deleted from the Studio. The note keeps its text; its Studio record was removed.`,
  studioDraftPublished: (id: string) => `${id} was published, so it cannot be deleted: a published address stays up for good. Withdraw it instead.`,
  studioDraftNotStudio: (path: string) => `“${path}” is not in a Studio folder, so there is no Studio draft to delete.`,
  studioNoDraftToDelete: "This note has no draft in the Studio.",
  studioPullNotStudio: (path: string) => `“${path}” is not in a Studio folder, so there is no Studio copy to bring over.`,
  studioPullSame: "The note already says what the Studio's working copy says — nothing to bring over.",
  studioPullCancelled: "Cancelled — the note was left as it is.",
  studioPullNoRecord: "Nothing to bring over — this note has no item in your Studio yet.",
  studioPullChangedMeanwhile: "The note changed while the window was open, so it was left as it is. Try again.",
  studioPullNoEdit: "This build cannot replace a note's text here.",
  studioImportUnreachable: "Could not reach the Studio to read its items. Nothing was imported.",
  studioImportNone: "Every item in the Studio already has a note — nothing to import.",
  studioImportNothing: (skipped: number) =>
    skipped > 0 ? `Nothing was imported: ${skipped} item${skipped === 1 ? " has" : "s have"} a note by now, or no free name.` : "Nothing was imported.",
  studioImportDone: (n: number, folder: string, named: number) =>
    `Imported ${n} item${n === 1 ? "" : "s"} from the Studio into “${folder}”.${named > 0 ? ` ${named} link${named === 1 ? "" : "s"} to other items show by note name.` : ""} Nothing was sent to the Studio.`,
  studioImportSkipped: (n: number) => `${n} item${n === 1 ? " was" : "s were"} left out: a note holds ${n === 1 ? "it" : "them"} by now, or no free name was found.`,
  studioImportFailed: (made: number, folder: string) =>
    `Importing stopped: a note could not be created in “${folder}”.${made > 0 ? ` The ${made} note${made === 1 ? "" : "s"} made before stay${made === 1 ? "s" : ""}, complete.` : ""} Nothing was sent to the Studio. Try again.`,
  studioImportIncomplete: "The Studio holds more items than the plugin reads at once (5000): only the newest were checked.",
  studioImportCancelled: "Cancelled — nothing was imported.",
  lookupNotHere: "This Studio has no item with that address.",
  lookupIdUnknown: "An id alone only finds your own items and items of blygs this Studio is subscribed to. For any other blyg, paste the item's address (\"Copy url\").",
  lookupOwnDraft: "That item of yours is not published yet, so nobody can answer or quote it. Publish it first.",
  lookupWithdrawn: "That item was withdrawn: there is nothing left to quote. A reply can still be made in the Studio.",
  lookupNotHeld: "The Studio holds no such item. If it is a blyg you read, let the Studio fetch it (Subscriptions → poll) and try again.",
  lookupNotServed: "That blyg does not serve an item with this id.",
  lookupNotAnItem:
    "That address is not recognised as an item of a blyg. Paste the address of the item itself (it ends in /f/… or /t/…, or is a page of the Studio's reader), or search for its words.",
  stubNeedsThread: "Not sent — blyg_stub_of is set, but a reply must be a thread. Make the note a thread, or remove blyg_stub_of.",
  stubInvalid: (problem: string) => `Not sent — ${problem}.`,
  stubReply: (label: string) => `Stub: a reply to ${label}`,
  stubCannotQuote:
    "That item is of a blyg you do not read, and quoting follows reading: subscribe to that blyg in the Studio first. You can still reply to it with “Reply to an item”.",
  hoppersInvalid: (problem: string) => `Not sent — ${problem}. Fix it in the note's properties, or choose the hoppers with “Studio: choose hoppers for this note”.`,
  hoppersChange: (added: string[], removed: string[]) =>
    `Hoppers: ${[...added.map((n) => `+ ${n}`), ...removed.map((n) => `− ${n}`)].join(", ")}`,
  hoppersDone: (added: string[], removed: string[]) =>
    `Hoppers changed in the Studio: ${[...added.map((n) => `added to “${n}”`), ...removed.map((n) => `taken out of “${n}”`)].join(", ")}.`,
  hoppersNoteChanged: (studio: string[]) =>
    `The note's hoppers were changed while this was being sent, so they were left as you typed them. The Studio now holds: ${studio.length === 0 ? "no hoppers" : studio.join(", ")}. The next send applies your change.`,
  hoppersOnlyText: "The text has no changes, so no new version was made.",
  hoppersNoPermission:
    "Hoppers not changed: the Studio token lacks the permission owner:manage. Create a token with it in the Studio (More → Client access) and put it into the keychain entry; the note keeps its hoppers and the next send tries again.",
  hoppersIncomplete: (names: string[]) => `Not checked: ${names.join(", ")} holds more items than the plugin reads (1,000), so it cannot tell whether this item is in it. That hopper was left as it is; change it in the Studio.`,
  hoppersFailed: (detail: string) => `Hoppers not changed (${detail}). The text was sent; the next send tries the hoppers again.`,
  hoppersPicked: (names: string[]) =>
    names.length === 0 ? "The note is in no hopper now. The Studio changes when you publish or send the note." : `Hoppers for this note: ${names.join(", ")}. The Studio changes when you publish or send the note.`,
  hoppersTaken: (names: string[]) => (names.length === 0 ? "The note now says what the Studio says: in no hopper." : `The note now says what the Studio says: ${names.join(", ")}.`),
  hoppersNotPublished: "This note has no item in your Studio yet: its hoppers are applied when you first send it.",
  studioPendingPublished: (id: string) =>
    `Not published — an earlier attempt created ${id} in the Studio and published it, but this note was never marked. It differs from what is published now, so the plugin will not guess. Add blyg_id: ${id} and blyg_origin to the note by hand, or remove the item from the Studio.`,
  studioPreviewProblems: (problems: string[]) =>
    `Not published — the Studio's preview names ${problems.length === 1 ? "a problem" : `${problems.length} problems`}:\n${problems.map((p) => `• ${p}`).join("\n")}`,
  studioUnauthorized:
    "The Studio rejected the token (wrong, expired or revoked). In the Studio: More → Client access → create a REST token with the permissions owner:read, owner:draft and owner:publish, and paste it into the keychain entry.",
  studioForbidden: (message: string) =>
    `The Studio refused: the token lacks a permission for this${message ? ` (${message})` : ""}. It needs owner:read, owner:draft and owner:publish.`,
  studioRefused: (what: string, message: string, problems: string[]) =>
    `${what}: the Studio refused${message ? ` — “${message}”` : ""}${problems.length > 0 ? `:\n${problems.map((p) => `• ${p}`).join("\n")}` : ""}`,
  studioConflict: (what: string) => `${what}: the item changed in the Studio while this was happening, so nothing was changed. Send again to see the Studio's copy.`,
  studioChangedWhilePublishing: (id: string) =>
    `The text in the Studio changed while publishing (${id}). Nothing was published and the note is untouched. Send again: you will see the Studio's copy first.`,
  studioError: (what: string, status: number, message: string) => `${what}: the Studio answered ${status}${message ? ` — “${message}”` : ""}.`,
  studioNetworkSafe: "Network error talking to the Studio — see console. Nothing was published and the Studio was not changed; safe to retry.",
  studioNetworkAfterSend: (id: string) =>
    `Network error while publishing — see console. The text may be saved as a draft of ${id} in the Studio but is not published; publishing again picks it up. The note is untouched.`,
  studioPublishedNew: (id: string, version: number, url: string) => `Published to the Studio: new item ${id}, version ${version}. ${url}`,
  studioPublishedUpdate: (version: number, url: string) => `Published to the Studio: version ${version}. ${url}`,
  studioWarning: (warning: string) => `The Studio says: ${warning}`,
  studioStampFailed: (id: string, version: number, origin: string) =>
    `Published ${id} v${version} to the Studio, but writing the note's properties failed — see console. Add blyg_id: ${id} and blyg_origin: ${origin} to the note by hand, or the next publish may not find it.`,
  studioRecovered: (id: string, version: number) => `The Studio already had this text as ${id} (version ${version}); the note is marked again. Nothing was published.`,
  studioNotQuotableDraft: (id: string) => `${id} has no published version in the Studio yet, so it cannot be quoted or linked. Publish it first.`,
  studioNotQuotableTombstone: (id: string) => `The blyg that published ${id} has withdrawn it, so it cannot be quoted or linked.`,
  studioSearchFailed: "The Studio's search is not available right now — only your own notes are listed.",
  studioReposted: (id: string, version: number, url: string, oldId: string) => `Reposted to the Studio as a new item ${id}, version ${version}. The old item ${oldId} is untouched. ${url}`,
  studioRepostNotNeeded: (id: string) => `This note already belongs to the Studio (${id}). Nothing to repost: use Publish or Update.`,
  studioRepostNothing: "This note has no record of another blyg, so there is nothing to repost. Use Publish.",
  studioRepostNotStudio: (path: string) => `Refusing to repost “${path}” — it is not in a Studio folder.`,
  studioWithdrawn: (version: number, url: string) => `Withdrawn in the Studio: version ${version}. The address stays up as “withdrawn”. ${url}`,
  studioNothingToWithdraw: (id: string) => `${id} was never published in the Studio, so there is nothing to withdraw. Delete the draft in the Studio if you do not want it.`,
  studioWithdrawCancelled: "Cancelled — nothing was withdrawn.",
  studioWithdrawStampFailed: (id: string, version: number) =>
    `Withdrew ${id} (version ${version}) in the Studio, but writing the note's properties failed — see console. Add blyg_withdrawn: true to the note by hand.`,
} as const;
