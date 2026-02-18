// clients/lda.js
import { LDA_BASE } from "../config.js";
import { applyLdaSmartParamRewrites } from "../utils/lda.js"; // single source of truth

export function makeLdaClient({ LDA_KEY }) {
  async function get(path, params = {}) {
    const u = new URL(LDA_BASE + "/" + path.replace(/^\//, ""));
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
    }
    u.search = sp.toString() ? "?" + sp.toString() : "";
    applyLdaSmartParamRewrites(u); // now synthesizes qualifying filters when only q/search present

    let delay = 350;
    for (let att = 0; att < 4; att++) {
      try {
        const resp = await fetch(u.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...(LDA_KEY ? { Authorization: `Token ${LDA_KEY}` } : {})
          },
          redirect: "follow",
          cf: { cacheTtl: 120, cacheEverything: true }
        });
        const text = await resp.text();
        if (!resp.ok) {
          // bubble original body to help debugging upstream errors
          throw new Error(`LDA ${resp.status}: ${text.slice(0, 500)}`);
        }
        return JSON.parse(text);
      } catch (e) {
        if (att >= 3) throw e;
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(1500, Math.floor(delay * 1.7));
      }
    }
  }
  return { get };
}
