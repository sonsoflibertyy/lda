// src/utils/misc.js

export function resolveAllowedOrigin(env, requestOrigin) {
  const cfg = (env?.ALLOWED_ORIGINS || "*").trim();
  if (cfg === "*") return "*";
  const list = cfg.split(",").map((s) => s.trim()).filter(Boolean);
  if (!requestOrigin) return list[0] || "*";
  return list.includes(requestOrigin) ? requestOrigin : (list[0] || "*");
}

export function getFECKey(env, sp, headers) {
  const envKey =
    env?.FEC_API_KEY ||
    env?.FEC_KEY ||
    env?.FEC ||
    env?.["FEC: Key"] ||
    "";
  if (envKey) return envKey;
  const h = new Headers(headers || {});
  const headerKey = h.get("x-fec-key") || h.get("X-FEC-Key");
  if (headerKey) return headerKey;
  const q =
    sp?.get?.("api_key") ||
    sp?.get?.("apikey") ||
    sp?.get?.("key") ||
    sp?.get?.("fec_key");
  return q || "";
}

export function getLDAKey(env, sp, headers) {
  const envKey =
    env?.LDA_API_KEY ||
    env?.LDA_KEY ||
    env?.["LDA: Key"] ||
    "";
  if (envKey) return envKey;
  const h = new Headers(headers || {});
  const headerKey = h.get("x-lda-key") || h.get("X-LDA-Key");
  if (headerKey) return headerKey;
  const q =
    sp?.get?.("lda_key") ||
    sp?.get?.("api_key") ||
    sp?.get?.("apikey") ||
    sp?.get?.("key");
  return q || "";
}

/* handy small utils for aggregations */

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function isPositiveNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0;
}

export function sumByPositive(rows, keyFn, valFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const v = Number(valFn(r) || 0);
    if (!k || !Number.isFinite(v) || v <= 0) continue;
    const cur = m.get(k) || { total: 0, items: 0 };
    cur.total += v;
    cur.items += 1;
    m.set(k, cur);
  }
  return m;
}

/**
 * Turn a Map<id, payload> into a sorted array.
 * `lookup` is optional and should return an object with at least { name?, type?, designation? }.
 *
 * We destructure instead of doing meta.name directly so TypeScript
 * doesn’t complain about "Property 'name' does not exist on type '{}'."
 */
export function mapToSortedArray(map, lookup = null) {
  const rows = [];
  for (const [id, payload] of map.entries()) {
    const total = typeof payload === "number" ? payload : payload.total || 0;
    const items = typeof payload === "number" ? 0 : payload.items || 0;

    const meta = lookup ? lookup(id) : null;
    const {
      name = null,
      type = null,
      designation = null
    } = meta || {};

    rows.push({
      id,
      name,
      type,
      designation,
      total: +Number(total).toFixed(2),
      items
    });
  }

  rows.sort((a, b) => b.total - a.total || b.items - a.items);
  return rows;
}

export function parseAliasMap(sp = new URLSearchParams()) {
  const m = new Map();
  const vals = sp.getAll("alias");
  for (const v of vals) {
    const s = String(v || "");
    const arrow = s.indexOf("->");
    if (arrow > 0) {
      const from = s.slice(0, arrow).trim();
      const to = s.slice(arrow + 2).trim();
      if (from && to) m.set(from.toUpperCase(), to);
    }
  }
  return m;
}
