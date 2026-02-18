// src/utils/http.js
// NOTE: CORS is handled globally in worker.js now.
// Keep these helpers focused on JSON + header passthrough,
// while preserving old function signatures so existing routes don't break.

import { EXPOSE_HEADERS } from "./cors.js";

/**
 * JSON response helper.
 * Signature preserved: json(body, status, allowOrigin)
 * `allowOrigin` is ignored because worker.js applies CORS universally.
 */
export function json(body, status = 200, _allowOrigin = "*") {
  const headers = new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");

  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * CORS wrapper (NO-OP).
 * Preserves compatibility across both call styles found in the codebase:
 *   - withCORS(resp, allowOrigin)
 *   - withCORS(resp, env, request)
 *
 * worker.js is the single source of truth for CORS now.
 */
export function withCORS(resp /*, _a, _b */) {
  return resp;
}

/** Build JSON headers but preserve upstream cache headers */
export function jsonHeaders(upstreamHeaders = new Headers()) {
  const h = new Headers();
  h.set("Content-Type", "application/json; charset=utf-8");

  const cc = upstreamHeaders.get("Cache-Control");
  if (cc) h.set("Cache-Control", cc);

  const etag = upstreamHeaders.get("ETag");
  if (etag) h.set("ETag", etag);

  // If upstream had any of these, keep them (useful for proxies/debugging)
  for (const name of EXPOSE_HEADERS) {
    const val = upstreamHeaders.get(name);
    if (val) h.set(name, val);
  }

  return h;
}

/** Pass through selected headers for non-JSON responses */
export function passthroughHeaders(upstreamHeaders = new Headers()) {
  const h = new Headers();
  const allow = [
    "content-type",
    "content-length",
    "cache-control",
    "etag",
    "last-modified",
    "date",
  ];
  for (const [k, v] of upstreamHeaders.entries()) {
    if (allow.includes(k.toLowerCase())) h.set(k, v);
  }
  return h;
}

export function ensureTrailingSlashIfDirectory(path) {
  const p = String(path || "");
  if (!p) return "/";
  if (/\.[a-z0-9]+$/i.test(p)) return p; // file with extension
  return p.endsWith("/") ? p : p + "/";
}
