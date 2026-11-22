// The words the reader's Studio calls (app/readerService.ts) show to the person, in one place.
import { M } from "../publish/messages";

/** The one line shown when there is no Studio yet; other build problems (a missing token, a bad address) keep their own words. */
export const readerNotConfigured = "Connect your Studio to read followed blygs: Settings → Blyg.";

/** Why there is no Studio to ask, in the reader's words. */
export const readerBuildMessage = (message: string): string => (message === M.studioNotConfigured ? readerNotConfigured : message);

export const readerText = {
  backedOff: (minutes: number): string => `The Studio is not answering; the reader tries again in about ${minutes} min (Refresh asks now).`,
  pollForbidden: "Your token cannot ask the Studio to check for new posts (it needs the permission “owner:manage”). The list shows what the Studio already has.",
  pollFailed: "The Studio could not be asked to check for new posts. The list shows what it already has.",
  pollUnreachable: "The Studio could not be reached to check for new posts.",
  listFailed: "The Studio could not list what you read.",
  loadUnreachable: "The Studio could not be reached.",
  mentionsUnavailable: "Mentions are not available.",
  unreadable: (n: number): string => `${n} could not be read.`,
} as const;
