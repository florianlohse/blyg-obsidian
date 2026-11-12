// Images of a note, found in the vault and made ready for a Studio publish (roadmap S6; the pure part is `core/images.ts`).
// `resolveImages` is the one step both the publish and the panel call, so they cannot disagree about what a note's images are.
import { contentHash, sha256HexBytes } from "../core/hash";
import { canonicalImage, canonicalizeStudioMedia, extensionOf, findImageRefs, IMAGE_MAX_BYTES, IMAGE_MIME, replaceRefs } from "../core/images";
import { normalizeContentMd } from "../core/normalize";
import type { BinaryVaultPort, VaultPort } from "../platform/ports";
import { M } from "../publish/messages";

export interface ResolvedImage {
  /** SHA-256 of the file's bytes, lowercase hex. */
  sha256: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  /** The first description the note gave it (may be empty). */
  alt: string;
}

export interface ImageResolution {
  /** The text with every vault picture written in the canonical form; the text as it was when anything is wrong or nothing is embedded. */
  text: string;
  /** Distinct files, in order of first use. */
  images: ResolvedImage[];
  /** What stops the publish, each saying which line; empty when the text may go on. */
  problems: string[];
}

/** Digests of files already read, so the panel does not read an image again until it changes. Keyed by path, size and modified time. */
export type DigestCache = Map<string, string>;
const CACHE_LIMIT = 300;

export interface ImageContext {
  vault: VaultPort;
  /** Absent where images cannot be read (then a note that embeds one is refused with a reason). */
  binary: BinaryVaultPort | undefined;
  fromPath: string;
  /** The vault folder of the note's route (its prefix): an image outside it is never read or sent. */
  folder: string;
  cache?: DigestCache;
}

type Known = { ok: true; image: ResolvedImage } | { ok: false; problem: (line: number) => string };

export async function resolveImages(text: string, ctx: ImageContext): Promise<ImageResolution> {
  const refs = findImageRefs(text);
  if (refs.length === 0) return { text, images: [], problems: [] };
  if (!ctx.binary) return { text, images: [], problems: [M.imagesUnavailable] };
  const binary = ctx.binary;
  const problems: string[] = [];
  const images: ResolvedImage[] = [];
  const memo = new Map<string, Known>();

  const look = async (target: string): Promise<Known> => {
    const resolved = ctx.vault.resolveLink(target, ctx.fromPath);
    const name = target.split("/").pop() ?? target;
    if (!resolved) return { ok: false, problem: (line) => M.imageNotFound(line, target) };
    // Before anything is read: only what lies in the note's own route folder may leave the vault.
    if (ctx.folder === "" || !resolved.path.startsWith(ctx.folder)) return { ok: false, problem: (line) => M.imageOutside(line, name, ctx.folder) };
    const ext = extensionOf(resolved.path);
    const mime = IMAGE_MIME[ext];
    if (!mime) return { ok: false, problem: (line) => M.imageType(line, name, ext) };
    try {
      const info = binary.fileInfo(resolved.path);
      if (info && info.size > IMAGE_MAX_BYTES) return { ok: false, problem: (line) => M.imageTooBig(line, name, info.size) };
      const key = info ? `${resolved.path}|${info.size}|${info.mtime}` : null;
      const cached = key ? ctx.cache?.get(key) : undefined;
      let size = info?.size ?? 0;
      let sha256 = cached;
      if (sha256 === undefined) {
        const bytes = await binary.readBinary(resolved.path);
        size = bytes.byteLength;
        if (size > IMAGE_MAX_BYTES) return { ok: false, problem: (line) => M.imageTooBig(line, name, size) };
        sha256 = await sha256HexBytes(bytes);
        if (key && ctx.cache) {
          if (ctx.cache.size >= CACHE_LIMIT) ctx.cache.clear();
          ctx.cache.set(key, sha256);
        }
      }
      return { ok: true, image: { sha256, path: resolved.path, name: resolved.path.split("/").pop() ?? resolved.path, mime, size, alt: "" } };
    } catch {
      return { ok: false, problem: (line) => M.imageUnreadable(line, name) };
    }
  };

  const replacements: string[] = [];
  for (const ref of refs) {
    let known = memo.get(ref.target);
    if (!known) {
      known = await look(ref.target);
      memo.set(ref.target, known);
    }
    if (!known.ok) {
      problems.push(known.problem(ref.line));
      replacements.push("");
      continue;
    }
    if (!images.some((i) => i.sha256 === known.image.sha256)) images.push({ ...known.image, alt: ref.alt });
    replacements.push(canonicalImage(ref.alt, known.image.sha256));
  }
  if (problems.length > 0) return { text, images: [], problems };
  return { text: replaceRefs(text, refs, replacements), images, problems: [] };
}

/**
 * The hash of text in the form both sides compare: the Studio's media addresses are turned into the canonical form first, so a note that
 * embeds a picture and the Studio's copy of it (which holds the address of the upload) have the same hash. Plain text is hashed as before.
 */
export const studioTextHash = (contentMd: string): Promise<string> => contentHash(normalizeContentMd(canonicalizeStudioMedia(contentMd)));

/** The same for text prepared locally for a send (already normalised: it is hashed as it stands, as before images existed). */
export const localStudioHash = (preparedMd: string): Promise<string> => contentHash(canonicalizeStudioMedia(preparedMd));
