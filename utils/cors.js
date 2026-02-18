// src/utils/cors.js
// Global CORS utilities used by worker.js (and safe for route imports too).

export const EXPOSE_HEADERS = [
  "Location",
  "Link",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
  "Retry-After",
  "CF-Cache-Status",
  "ETag",
  "Last-Modified",
  "X-OpenFEC-Request-Id",
  "X-Request-Id",
  "X-Timeout-Ms",
];

// ---- helpers ----
function appendVary(existing, value) {
  const base = (existing || "").trim();
  if (!base) return value;
  const parts = base
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.includes(value)) return base;
  return `${base}, ${value}`;
}

function isRequestLike(x) {
  return !!(
    x &&
    typeof x === "object" &&
    x.headers &&
    typeof x.headers.get === "function"
  );
}

function normalizeOrigin(origin) {
  return (origin || "").trim();
}

// ---- origin selection ----
export function pickAllowedOrigin(request, env) {
  const origin = normalizeOrigin(request?.headers?.get?.("Origin") || "");

  const allowListRaw =
    env?.ALLOWED_ORIGINS ||
    env?.CORS_ALLOWED_ORIGINS ||
    env?.ALLOWED_ORIGIN ||
    "";

  const allowList = String(allowListRaw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // If no allowlist configured, be permissive (reflect Origin when present)
  if (!allowList.length) return origin || "*";

  // If allowlist configured, only allow exact matches
  if (origin && allowList.includes(origin)) return origin;

  // ✅ IMPORTANT: do NOT return "null" (that hard-breaks browser fetch).
  // For beta UI integration, fall back to "*".
  // If you want strict lock-down, change this back to "null" once ALLOWED_ORIGINS is correct.
  return "*";
}

// ---- headers ----
// Backwards compatible signature:
// - corsHeaders(origin)
// - corsHeaders(origin, request)
export function corsHeaders(origin = "*", request = null) {
  const reqHeaders =
    request?.headers?.get?.("access-control-request-headers") ||
    request?.headers?.get?.("Access-Control-Request-Headers") ||
    "content-type, authorization, accept";

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": reqHeaders,
    "access-control-max-age": "86400",
    "access-control-expose-headers": EXPOSE_HEADERS.join(", "),
    vary: "Origin",
  };
}

// Backwards compatible:
// - corsPreflight(originString)
// - corsPreflight(request, env)
export function corsPreflight(arg1 = "*", env = null) {
  if (isRequestLike(arg1)) {
    const request = (arg1);
    const origin = pickAllowedOrigin(request, env);
    return new Response(null, { status: 204, headers: corsHeaders(origin, request) });
  }

  const origin = typeof arg1 === "string" ? arg1 : "*";
  return new Response(null, { status: 204, headers: corsHeaders(origin, null) });
}

// Backwards compatible:
// - withCORS(resp)
// - withCORS(request, resp, env)
export function withCORS(arg1, arg2, arg3) {
  // Worker usage: withCORS(request, resp, env)
  if (isRequestLike(arg1)) {
    const request = /** @type {Request} */ (arg1);
    const resp = /** @type {Response} */ (arg2);
    const env = arg3;

    // Safety: if handler returned non-Response, wrap it
    const safeResp = resp instanceof Response ? resp : new Response(String(resp || ""), { status: 200 });

    const origin = pickAllowedOrigin(request, env);
    const add = corsHeaders(origin, request);

    const headers = new Headers(safeResp.headers);
    for (const [k, v] of Object.entries(add)) headers.set(k, v);

    // Preserve any existing Vary and ensure Origin is included
    headers.set("vary", appendVary(headers.get("vary"), "Origin"));

    return new Response(safeResp.body, {
      status: safeResp.status,
      statusText: safeResp.statusText,
      headers,
    });
  }

  // Legacy usage: withCORS(resp)
  if (arg1 instanceof Response) return arg1;

  // If someone passed null/undefined, return something safe instead of null
  if (arg1 == null) return new Response(null, { status: 204 });

  return arg1;
}
