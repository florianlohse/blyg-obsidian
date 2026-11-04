import type { GithubHttp, RawRequest, RawResponse, RawTransport } from "../src/platform/http";
import { createGithubHttp } from "../src/platform/http";
import type { Keychain, Timers } from "../src/platform/ports";

export const TOKEN = "github_pat_TESTTOKEN0123456789abcdefghijklmnop";

/** Timers that never fire: requests complete normally. */
export const idleTimers: Timers = { after: () => () => {} };

/** Timers that fire at once: any request that has not already settled times out. */
export const instantTimers: Timers = {
  after: (_ms, fn) => {
    queueMicrotask(fn);
    return () => {};
  },
};

export function fakeKeychain(secrets: Record<string, string>, available = true): Keychain {
  return { available: () => available, get: (name) => secrets[name] ?? null };
}

export interface FakeGithub {
  http: GithubHttp;
  requests: RawRequest[];
}

/** A scripted GitHub: `handler` decides the answer for each request; every request is recorded. */
export function fakeGithub(handler: (req: RawRequest) => Partial<RawResponse> | Error): FakeGithub {
  const requests: RawRequest[] = [];
  const transport: RawTransport = (req) => {
    requests.push(req);
    const answer = handler(req);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ status: 200, headers: {}, text: "", ...answer });
  };
  return { http: createGithubHttp({ transport, timers: idleTimers }), requests };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Partial<RawResponse> => ({
  status,
  headers,
  text: JSON.stringify(body),
});
