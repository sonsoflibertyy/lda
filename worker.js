
import { json } from "./utils/http.js";
import { corsPreflight, withCORS } from "./utils/cors.js";
import { handleLdaProxy } from "./lda-proxy.js";
import { handleLdaSummary } from "./lda-summary.js";

async function routeRequest(request, env) {
  const originalUrl = new URL(request.url);
  let routedRequest = request;
  let pathname = originalUrl.pathname;

  if (pathname === "/api/lda" || pathname.startsWith("/api/lda/")) {
    const rewrittenUrl = new URL(request.url);
    rewrittenUrl.pathname = pathname.replace(/^\/api\/lda/, "/lda");
    routedRequest = new Request(rewrittenUrl.toString(), request);
    pathname = rewrittenUrl.pathname;
  }

  if (pathname === "/health") return json({ ok: true }, 200);

  if (pathname === "/lda/summary") {
    const resp = await handleLdaSummary(routedRequest, env);
    if (resp) return resp;
  }

  if (pathname === "/lda" || pathname.startsWith("/lda/")) {
    const resp = await handleLdaProxy(routedRequest, env);
    if (resp) return resp;
  }

  return json({ ok: false, error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return corsPreflight(request, env);
    const resp = await routeRequest(request, env, ctx);
    return withCORS(request, resp, env);
  }
};

export { handleLdaProxy, handleLdaSummary };
