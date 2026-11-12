// A fake world for Studio publish tests: the vault of tests/world.ts, a FakeStudio behind the plugin's real http adapter and client,
// and an in-memory record of pending drafts.
import { createContractCache, createStudioClient } from "../../src/studio/client";
import { studioAddress } from "../../src/studio/address";
import { createStudioHttp } from "../../src/studio/http";
import type { PendingDraft, PendingDrafts } from "../../src/studio/pending";
import { deleteDraftNote, publishNote, pullNote, repostNote, withdrawNote } from "../../src/publish/router";
import type { NoteRef } from "../../src/platform/ports";
import type { Outcome } from "../../src/publish/types";
import { idleTimers } from "../helpers";
import { swapBody } from "../../src/core/frontmatter";
import { extractBlock, jsYaml, makeWorld, type World } from "../world";
import { FakeStudio, STUDIO_HOST, STUDIO_TOKEN } from "./fake-studio";

export const STUDIO_ROUTES = [
  { vaultPrefix: "studio/", mode: "studio" as const, label: "Blyg item" },
  { vaultPrefix: "drafts/", mode: "studio" as const, label: "Draft", draftsOnly: true },
  { vaultPrefix: "website/essays/", mode: "plain" as const, dest: "src/content/essays/", label: "essay", requireTitle: true },
];

export interface StudioWorld extends World {
  /** The bytes of image files in the vault (the note map `local` holds a placeholder text for the same path, so links resolve). */
  binaries: Map<string, { bytes: Uint8Array; mtime: number }>;
  /** Put an image file in the vault. */
  addImage(path: string, bytes: Uint8Array): void;
  studio: FakeStudio;
  pendingMap: Map<string, PendingDraft>;
  failPending: { set: boolean };
}

/** `coldGate`: the client has not asked the Studio for its contract yet (the default is a session in which it has, so the wire shows only what a test is about). */
export function makeStudioWorld(init: { vault?: Record<string, string>; coldGate?: boolean } = {}): StudioWorld {
  const world = makeWorld({ ...init, settings: { routes: STUDIO_ROUTES } }) as StudioWorld;
  const studio = new FakeStudio();
  const address = studioAddress({ baseUrl: STUDIO_HOST, mount: "" });
  if (!address) throw new Error("test address");
  const pendingMap = new Map<string, PendingDraft>();
  const failPending = { set: false };
  const pending: PendingDrafts = {
    get: (path) => Promise.resolve(pendingMap.get(path) ?? null),
    set: (path, draft) => (failPending.set ? Promise.reject(new Error("disk full")) : (pendingMap.set(path, draft), Promise.resolve())),
    clear: (path) => (pendingMap.delete(path), Promise.resolve()),
  };
  const http = createStudioHttp({ transport: studio.transport, timers: idleTimers, address });
  world.studio = studio;
  world.binaries = new Map();
  world.addImage = (path, bytes) => {
    world.local.set(path, "(binary)");
    world.binaries.set(path, { bytes, mtime: world.binaries.size + 1 });
  };
  world.deps.images = {
    readBinary: (path) => {
      const file = world.binaries.get(path);
      return file ? Promise.resolve(file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer) : Promise.reject(new Error("no such file"));
    },
    fileInfo: (path) => {
      const file = world.binaries.get(path);
      return file ? { size: file.bytes.byteLength, mtime: file.mtime } : null;
    },
  };
  world.pendingMap = pendingMap;
  world.failPending = failPending;
  world.deps.edit = {
    notesWithBlygId: (id) =>
      [...world.local.keys()]
        .filter((path) => {
          const block = extractBlock(world.local.get(path) ?? "");
          return block !== null && (jsYaml.parse(block) as { blyg_id?: unknown } | undefined)?.blyg_id === id;
        })
        .map((path) => ref(path)),
    linkText: (note) => note.name.replace(/\.md$/, ""),
    replaceBody: (note, expected, replacement) => {
      const swapped = swapBody(world.local.get(note.path) ?? "", expected, replacement);
      if (swapped === null) return Promise.reject(new Error("The note changed meanwhile."));
      world.local.set(note.path, swapped);
      return Promise.resolve();
    },
  };
  const gate = createContractCache();
  if (!init.coldGate) gate.set({ kind: "ok", contract: "5.2.0", newerMinor: false });
  world.deps.studio = { client: createStudioClient({ http, token: STUDIO_TOKEN, gate }), address, pending };
  return world;
}

const ref = (path: string, extension = "md"): NoteRef => ({ path, name: path.split("/").pop() ?? path, extension });
export const tapStudio = (w: World, path: string, extension = "md"): Promise<Outcome> => publishNote(w.deps, ref(path, extension));
export const tapStudioPull = (w: World, path: string): Promise<Outcome> => pullNote(w.deps, ref(path));
export const tapStudioDeleteDraft = (w: World, path: string): Promise<Outcome> => deleteDraftNote(w.deps, ref(path));
export const tapStudioRepost = (w: World, path: string): Promise<Outcome> => repostNote(w.deps, ref(path));
export const tapStudioWithdraw = (w: World, path: string): Promise<Outcome> => withdrawNote(w.deps, ref(path));
