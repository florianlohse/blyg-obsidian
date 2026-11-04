import { Notice, type App } from "obsidian";
import type { Clock, Keychain, Notifier, Random, Timers } from "./ports";

export function obsidianKeychain(app: App): Keychain {
  return {
    available: () => typeof app.secretStorage?.getSecret === "function",
    get: (name) => (typeof app.secretStorage?.getSecret === "function" ? app.secretStorage.getSecret(name) : null),
  };
}

export const obsidianNotifier: Notifier = {
  notice: (message, durationMs) => void new Notice(message, durationMs),
};

export const systemClock: Clock = { now: () => new Date() };

export const webRandom: Random = {
  bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
};

export const windowTimers: Timers = {
  after: (ms, fn) => {
    const handle = window.setTimeout(fn, ms);
    return () => window.clearTimeout(handle);
  },
};
