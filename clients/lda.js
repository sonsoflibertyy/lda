import { LDA_BASE as DEFAULT_LDA_BASE } from "../config.js";
import { applyLdaSmartParamRewrites } from "../utils/lda.js";

export function makeLdaClient({ LDA_KEY, LDA_BASE, timeoutMs } = {}) {
  const base = LDA_BASE || DEFAULT_LDA_BASE;
  const parsedTimeout = Number(timeoutMs);
  const effectiveTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 60000;

  async function get(path, params = {}) {
    const u = new URL(base + "/" + path.replace(/^\//, ""));
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
    }
    u.search = sp.toString() ? "?" + sp.toString() : "";
    applyLdaSmartParamRewrites(u);

    let delay = 350;
    for (let att = 0; att < 4; att++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort("LDA upstream timeout"), effectiveTimeoutMs);
      try {
        const resp = await fetch(u.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...(LDA_KEY ? { Authorization: `Token ${LDA_KEY}` } : {})
          },
          redirect: "follow",
          cf: { cacheTtl: 120, cacheEverything: true },
          signal: ac.signal
        });
        const text = await resp.text();
        if (!resp.ok) throw new Error(`LDA ${resp.status}: ${text.slice(0, 500)}`);
        return JSON.parse(text);
      } catch (e) {
        const msg = String(e?.message || e || "");
        const isTimeout = e?.name === "AbortError" || msg.includes("timeout");
        if (isTimeout) {
          throw new Error(`LDA 504: upstream timeout after ${effectiveTimeoutMs}ms`);
        }
        if (att >= 3) throw e;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(1500, Math.floor(delay * 1.7));
        } finally {
        clearTimeout(timer);
      }
    }
  }
  return { get };
}
