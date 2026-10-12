import { validMovieId, validUserId } from "./domain.mjs";

export const PRIVATE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
});

/** @param {number} status @param {unknown} [data] @param {unknown} [error] */
export function json(status, data = null, error = null) {
  return Response.json({ success: status >= 200 && status < 300, data, error },
    { status, headers: PRIVATE_HEADERS });
}

export function safeNextPath(value) {
  if (typeof value !== "string" || value.length > 150 || /[\\\u0000-\u001f]/u.test(value) ||
      !value.startsWith("/") || value.startsWith("//") || value.includes("?")) return "/profile";
  if (value === "/" || value === "/profile" || value === "/watchlist") return value;
  if (value.startsWith("/movie/") && validMovieId(value.slice(7))) return value;
  return "/profile";
}

export function sameOrigin(request, configuredOrigin) {
  const origin = request.headers.get("origin");
  return typeof origin === "string" && origin === configuredOrigin;
}

export async function readSmallJson(request, maxBytes = 4096) {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type") ?? "")) {
    throw new Error("UNSUPPORTED_MEDIA_TYPE");
  }
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) throw new Error("BODY_TOO_LARGE");
  if (!request.body) throw new Error("INVALID_JSON");
  const reader = request.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("BODY_TOO_LARGE"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let cursor = 0;
    for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_JSON");
    return value;
  } catch (error) {
    if (error?.message === "BODY_TOO_LARGE") throw error;
    throw new Error("INVALID_JSON");
  } finally { reader.releaseLock(); }
}

export function mutationError(error) {
  const code = error?.message;
  if (code === "UNSUPPORTED_MEDIA_TYPE") return json(415, null, { code, message: "Send JSON." });
  if (code === "BODY_TOO_LARGE") return json(413, null, { code, message: "Request is too large." });
  if (["INVALID_JSON", "INVALID_PROFILE", "INVALID_MOVIE_STATUS", "INVALID_RATING",
    "RATING_REQUIRES_WATCHED"].includes(code)) {
    return json(400, null, { code, message: "Check the submitted values and try again." });
  }
  return json(503, null, { code: "PERSONAL_DATA_UNAVAILABLE", message: "Personal data is temporarily unavailable." });
}

export function authenticatedId(value) { return validUserId(value) ? value : null; }
