import { requestUrl } from "obsidian";
import type { RawTransport } from "./http";

/** Obsidian's requestUrl: works on mobile and is not bound by CORS. Non-2xx statuses are returned, not thrown. */
export const obsidianTransport: RawTransport = async (request) => {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.bodyBytes ?? request.body,
    contentType: request.contentType,
    throw: false,
  });
  return { status: response.status, headers: response.headers, text: response.text };
};
