// src/routes/lda-proxy.js
import { json, withCORS, jsonHeaders, passthroughHeaders } from "./utils/http.js";
import { resolveAllowedOrigin } from "./utils/misc.js";
import { LDA_BASE as DEFAULT_LDA_BASE } from "./config.js";
import { applyLdaSmartParamRewrites } from "./utils/lda.js";


/** Treat blank params as missing. */
function hasMeaningfulParam(params, key) {
  if (!params || !key) return false;
  if (!params.has(key)) return false;
  const value = params.get(key);
  return value !== null && String(value).trim() !== "";
}


/** Paging synonyms so we don't set both variants. */
const PARAM_SYNONYMS = new Map([
  ["per_page", ["page_size"]],
  ["page_size", ["per_page"]],
  ["sort", ["ordering"]],
  ["ordering", ["sort"]],
]);


function hasParamOrSyn(params, key) {
  if (hasMeaningfulParam(params, key)) return true;
  const alts = PARAM_SYNONYMS.get(key);
  return !!(alts && alts.some((alt) => hasMeaningfulParam(params, alt)));
}


const PAGING_PARAM_KEYS = new Set(["page", "page_size", "per_page", "ordering", "sort"]);


/** true if any non-paging param has a value (q/search DO count in general flows). */
function hasNonPagingFilter(params, ignoreKeys = PAGING_PARAM_KEYS) {
  if (!params) return false;
  for (const [key, value] of params) {
    if (ignoreKeys.has(key)) continue;
    if (value !== null && String(value).trim() !== "") return true;
  }
  return false;
}


/** LD-203 qualifying groups: exactly one in each; IDs beat strings. */
const CONTRIBUTION_QUALIFYING_GROUPS = [
  ["registrant_id", "registrant", "registrant_name"],
  ["lobbyist_id", "contributor", "contributor_name"],
  ["payee"],
  ["honoree"],
];


/** LD-203 secondary date/year constraints to preserve across pages. */
const CONTRIBUTION_SECONDARY_KEYS = [
  "contribution_year",
  "contribution_date",
  "contribution_date_after",
  "contribution_date_before",
];


/** Returns true if params already include ANY LD-203 qualifying filter (ignores q/search). */
function hasQualifyingContribFilter(params) {
  if (!params) return false;
  for (const group of CONTRIBUTION_QUALIFYING_GROUPS) {
    if (group.some((key) => hasMeaningfulParam(params, key))) return true;
  }
  return CONTRIBUTION_SECONDARY_KEYS.some((key) => hasMeaningfulParam(params, key));
}


/** Copy one value per exclusive group from seed→target; then copy other non-paging seed filters. */
function copySeedFilters(targetParams, seedParams, groups = [], ignoreKeys = PAGING_PARAM_KEYS) {
  const groupedKeys = new Set();
  const satisfiedGroups = new Set();


  groups.forEach((group, idx) => {
    group.forEach((key) => groupedKeys.add(key));
    if (group.some((key) => hasMeaningfulParam(targetParams, key))) {
      satisfiedGroups.add(idx);
    }
  });


  groups.forEach((group, idx) => {
    if (satisfiedGroups.has(idx)) return;
    const seedKey = group.find((key) => hasMeaningfulParam(seedParams, key));
    if (!seedKey) return;
    targetParams.set(seedKey, seedParams.get(seedKey));
    satisfiedGroups.add(idx);
  });


  for (const [key, value] of seedParams) {
    if (ignoreKeys.has(key)) continue;
    if (groupedKeys.has(key)) continue;
    if (value === null || String(value).trim() === "") continue;
    if (hasMeaningfulParam(targetParams, key)) continue;
    targetParams.set(key, value);
  }
}


/** Drop weaker strings when *_id is present inside the same exclusive group. */
function normalizeExclusiveGroups(params) {
  if (hasMeaningfulParam(params, "registrant_id")) {
    params.delete("registrant");
    params.delete("registrant_name");
  }
  if (hasMeaningfulParam(params, "lobbyist_id")) {
    params.delete("contributor");
    params.delete("contributor_name");
  }
}


/** Dedupe paging synonyms (prefer page_size over per_page, ordering over sort). */
function dedupePagingSynonyms(params) {
  if (params.has("page_size") && params.has("per_page")) params.delete("per_page");
  if (params.has("ordering") && params.has("sort")) params.delete("sort");
}


/**
 * Carry forward missing filters and paging knobs from the original request
 * into an upstream next/prev URL. Prevents 400s on later pages where the
 * API demands a qualifying filter (esp. on /contributions).
 */
function carryForwardLdaFilters(targetUrl, seedUrl, upstreamPath) {
  if (!seedUrl) return;
  try {
    const seed = seedUrl instanceof URL ? seedUrl : new URL(seedUrl);
    const targetParams = targetUrl.searchParams;
    const seedParams = seed.searchParams;


    const p = String(upstreamPath || "").replace(/^\/api\/v1/i, "").toLowerCase();


    // Paging knobs from seed when missing on target (synonym-aware).
    ["page", "page_size", "per_page", "ordering", "sort"].forEach((key) => {
      if (!hasMeaningfulParam(seedParams, key)) return;
      if (hasParamOrSyn(targetParams, key)) return;
      targetParams.set(key, seedParams.get(key));
    });


    if (p.startsWith("/contributions")) {
      // Bring one member per qualifier group and any secondary date filters.
      copySeedFilters(targetParams, seedParams, CONTRIBUTION_QUALIFYING_GROUPS);
      for (const key of CONTRIBUTION_SECONDARY_KEYS) {
        if (!hasMeaningfulParam(seedParams, key)) continue;
        if (hasMeaningfulParam(targetParams, key)) continue;
        targetParams.set(key, seedParams.get(key));
      }


      // If there's STILL no qualifying filter (q/search don't count), inject one:
      if (!hasQualifyingContribFilter(targetParams)) {
        let injected = false;


        // 1) Prefer a seed qualifier inside any group (IDs first via group order).
        for (const group of CONTRIBUTION_QUALIFYING_GROUPS) {
          const seedKey = group.find((key) => hasMeaningfulParam(seedParams, key));
          if (!seedKey) continue;
          const val = seedParams.get(seedKey);
          if (val !== null && String(val).trim() !== "") {
            targetParams.set(seedKey, val);
            injected = true;
            break;
          }
        }


        // 2) Else promote q/search → registrant.
        if (!injected) {
          const qsKey = hasMeaningfulParam(seedParams, "q")
            ? "q"
            : hasMeaningfulParam(seedParams, "search")
            ? "search"
            : null;
          if (qsKey) {
            const val = seedParams.get(qsKey);
            if (val !== null && String(val).trim() !== "") {
              targetParams.set("registrant", val);
              injected = true;
            }
          }
        }


        // 3) Final safety: broad date window.
        if (!injected) {
          if (!hasMeaningfulParam(targetParams, "contribution_date_after")) {
            targetParams.set("contribution_date_after", "1900-01-01");
          }
          if (!hasMeaningfulParam(targetParams, "contribution_date_before")) {
            targetParams.set("contribution_date_before", "2100-01-01");
          }
        }
      }


      normalizeExclusiveGroups(targetParams);
      dedupePagingSynonyms(targetParams);


    } else if (p.startsWith("/filings")) {
      // Ensure at least one non-paging filter persists across pages.
      const FILING_GROUPS = [
        ["registrant_id", "registrant", "registrant_name"],
        ["client_id", "client", "client_name"],
      ];
      copySeedFilters(targetParams, seedParams, FILING_GROUPS);


      if (!hasNonPagingFilter(targetParams)) {
        for (const [k, v] of seedParams) {
          if (PAGING_PARAM_KEYS.has(k)) continue;
          if (v === null || String(v).trim() === "") continue;
          if (hasMeaningfulParam(targetParams, k)) continue;
          targetParams.set(k, v);
          break;
        }
      }


      dedupePagingSynonyms(targetParams);
    }
  } catch {
    // ignore; fall back to upstream-provided URL if needed
  }
}


/** Map Senate absolute/relative next/prev URLs back through this Worker and carry forward filters. */
function mapLdaAbsoluteToProxy(u, proxyOrigin, seedUrl, ldaBase) {
  try {
    const parsed = new URL(u, ldaBase + "/");


    if (/lda\.senate\.gov$/i.test(parsed.hostname) && /^\/api\/v1\//i.test(parsed.pathname)) {
      const proxied = new URL(`${proxyOrigin}/lda${parsed.pathname.replace(/^\/api\/v1/i, "")}`);
      proxied.search = parsed.search;
      carryForwardLdaFilters(proxied, seedUrl, parsed.pathname);
      return proxied.toString();
    }


    if (/lda\.senate\.gov$/i.test(parsed.hostname) && /^\/filings\/api\/public\//i.test(parsed.pathname)) {
      const proxied = new URL(`${proxyOrigin}/lda${parsed.pathname.replace(/^\/filings\/api\/public/i, "")}`);
      proxied.search = parsed.search;
      carryForwardLdaFilters(proxied, seedUrl, parsed.pathname);
      return proxied.toString();
    }
  } catch {}
  return u;
}


/** Deeply rewrite JSON payload next/previous links and preserve *_source for debugging. */
function rewritePayloadDeep(node, proxyOrigin, seedUrl, ldaBase) {
  if (Array.isArray(node)) return node.map((n) => rewritePayloadDeep(n, proxyOrigin, seedUrl, ldaBase));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if ((k === "next" || k === "previous") && typeof v === "string") {
        out[`${k}_source`] = v;
        out[k] = mapLdaAbsoluteToProxy(v, proxyOrigin, seedUrl, ldaBase);
        continue;
      }
      out[k] = rewritePayloadDeep(v, proxyOrigin, seedUrl, ldaBase);
    }
    return out;
  }
  return node;
}

function normName(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function parseAmount(x) {
  const n = Number(String(x ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function flattenLd203Items(filingRows, yearFilter) {
  const year = /^\d{4}$/.test(String(yearFilter || "")) ? String(yearFilter) : null;
  const items = [];

  for (const r of filingRows || []) {
    const lobbyist = r?.lobbyist || {};
    const lobbyist_name =
      [lobbyist.first_name, lobbyist.middle_name, lobbyist.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() || r?.lobbyist_name || null;

    for (const item of r?.contribution_items || []) {
      const tx = {
        filing_uuid: r?.filing_uuid || r?.id || null,
        filing_document_url: r?.filing_document_url || null,
        dt_posted: r?.dt_posted || null,
        filing_year: r?.filing_year || null,
        registrant_name: r?.registrant?.name || r?.registrant_name || null,
        lobbyist_name,
        contribution_type: item?.contribution_type || item?.contribution_type_display || null,
        contributor_name: item?.contributor_name || null,
        payee_name: item?.payee_name || null,
        honoree_name: item?.honoree_name || null,
        amount: item?.amount || null,
        date: item?.date || null,
      };

      if (year && !(String(tx.date || "").startsWith(`${year}-`))) continue;
      items.push(tx);
    }
  }

  return items;
}

function pickGroupName(row) {
    return row?.payee_name || row?.honoree_name || "UNKNOWN";
}


function pickAmount(row) {
  return row?.amount;
}


function pickDate(row) {
  return row?.date || null;
}


function pickFilingLink(row, requestUrl) {
  if (row?.filing_document_url) {
    try {
      return new URL(row.filing_document_url, requestUrl.origin).toString();
    } catch {
      return row.filing_document_url;
    }
  }
  if (row?.filing_uuid) return `${requestUrl.origin}/lda/filings/${row.filing_uuid}/`;
  return null;
}


function dedupeAndCountLinks(rows, requestUrl, maxLinks = 10) {
  const counts = new Map();
  for (const row of rows || []) {
    const link = pickFilingLink(row, requestUrl);
    if (!link) continue;
    counts.set(link, (counts.get(link) || 0) + 1);
  }
  const all = [...counts.entries()]
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url));
  return {
    filing_links: all.slice(0, maxLinks),
    filing_links_more: Math.max(0, all.length - maxLinks),
  };
}


function aggregateLd203(rows, requestUrl) {
  const groups = new Map();
  let total_amount = 0;

  for (const row of rows || []) {
    const display = pickGroupName(row);
    const normalized = normName(display);
    const type = row?.contribution_type ? String(row.contribution_type) : "";
    const key = type ? `${normalized}::${type}` : normalized;
    const amount = parseAmount(pickAmount(row));
    const txDate = pickDate(row);

    total_amount += amount;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        payee_or_honoree: display,
        type: type || undefined,
        total_amount: 0,
        tx_count: 0,
        first_date: txDate || null,
        last_date: txDate || null,
        _rows: [],
      });
    }

    const group = groups.get(key);
    group.total_amount += amount;
    group.tx_count += 1;
    group._rows.push(row);
    if (txDate) {
      if (!group.first_date || txDate < group.first_date) group.first_date = txDate;
      if (!group.last_date || txDate > group.last_date) group.last_date = txDate;
    }
  }

  const summarized = [...groups.values()]
    .map((group) => {
      const links = dedupeAndCountLinks(group._rows, requestUrl, 10);
      return {
        key: group.key,
        payee_or_honoree: group.payee_or_honoree,
        type: group.type,
        total_amount: Number(group.total_amount.toFixed(2)),
        tx_count: group.tx_count,
        first_date: group.first_date,
        last_date: group.last_date,
        filing_links: links.filing_links,
        filing_links_more: links.filing_links_more,
      };
    })
    .sort((a, b) => b.total_amount - a.total_amount || b.tx_count - a.tx_count);

  return {
    groups: summarized,
    groups_count: summarized.length,
    total_amount: Number(total_amount.toFixed(2)),
  };
}


function getLdaAuthHeader(request, env) {
  const LDA_KEY =
    request.headers.get("x-lda-key") ||
    request.headers.get("X-LDA-Key") ||
    (env && (env["LDA_API_KEY"] || env["LDA_KEY"]));
  return LDA_KEY ? `Token ${LDA_KEY}` : null;
}


async function fetchLd203AllRows(request, env, ldaBase, requestUrl, options = {}) {
  const { maxRows = 20000, maxPages = 200, yearParam = null } = options;
  const authToken = getLdaAuthHeader(request, env);
  const seedUrl = new URL(requestUrl.toString());
  const initial = new URL(`${ldaBase}/contributions`);
  initial.search = requestUrl.search;
   if (
    /^\d{4}$/.test(String(yearParam || "")) &&
    !hasMeaningfulParam(initial.searchParams, "contribution_date_after") &&
    !hasMeaningfulParam(initial.searchParams, "contribution_date_before")
  ) {
    initial.searchParams.set("contribution_date_after", `${yearParam}-01-01`);
    initial.searchParams.set("contribution_date_before", `${yearParam}-12-31`);
  }
  applyLdaSmartParamRewrites(initial);

  const rows = [];
  let pageCount = 0;
  let nextUrl = initial;
  let warning;

  while (nextUrl && pageCount < maxPages && rows.length < maxRows) {
    pageCount += 1;

    const headers = new Headers({ Accept: "application/json" });
    if (authToken) headers.set("Authorization", authToken);

    const resp = await fetch(
      new Request(nextUrl.toString(), {
        method: "GET",
        headers,
        redirect: "follow",
      })
    );

    const data = await resp.json();
    if (!resp.ok) {
      return { errorResp: json(data, resp.status), rows: [] };
    }

    const pageRows = Array.isArray(data?.results) ? data.results : [];
    const remaining = maxRows - rows.length;
    rows.push(...pageRows.slice(0, remaining));

    if (rows.length >= maxRows) {
      warning = `Capped at max_rows=${maxRows}`;
      break;
    }

    if (!data?.next) {
      nextUrl = null;
      break;
    }

    const parsedNext = new URL(data.next, `${ldaBase}/`);
    carryForwardLdaFilters(parsedNext, seedUrl, parsedNext.pathname);
    nextUrl = parsedNext;
  }

  if (!warning && nextUrl && pageCount >= maxPages) {
    warning = `Capped at max_pages=${maxPages}`;
  }

  return { rows, warning, pageCount };
}


export async function handleLdaProxy(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const allowOrigin = resolveAllowedOrigin(env, request.headers.get("Origin"));
  const LDA_BASE = env?.LDA_BASE || env?.LDA_BASE_URL || DEFAULT_LDA_BASE;

  // Convenience: /lda → upstream root with query-only rewrites
  if (path === "/lda" || path === "/lda/") {
    const upstream = new URL(LDA_BASE + "/");
    upstream.search = url.search;
    applyLdaSmartParamRewrites(upstream);
    return forward(upstream, request, allowOrigin, { rewrite: true, env, ldaBase: LDA_BASE });
  }
  if (!path.startsWith("/lda/")) return null;


  // Optional LD-1 alias: /lda/filings/ld1 → /lda/filings/?form_type=LD-1
  let sub = path.replace(/^\/lda\/?/, "");
  if (/^filings\/ld1(\/|$)/i.test(sub)) {
    sub = sub.replace(/^filings\/ld1/i, "filings");
    const p = new URLSearchParams(url.search);
    p.delete("filing_type");
    if (!p.has("form_type")) p.set("form_type", "LD-1");
    const upstream = new URL(LDA_BASE + "/" + sub);
    upstream.search = "?" + p.toString();
    applyLdaSmartParamRewrites(upstream);
    return forward(upstream, request, allowOrigin, { rewrite: true, env, ldaBase: LDA_BASE });
  }


  if (sub.toLowerCase().startsWith("summary")) {
    return json({ error: "Use /lda/summary at the Worker root." }, 400, allowOrigin);
  }

  if (/^ld203(\/|$)/i.test(sub)) {
    const mode = (url.searchParams.get("view") || "rollup").toLowerCase();
    const yearParam = url.searchParams.get("contribution_year");
    // Preserve backward-compatible raw behavior by proxying upstream /contributions.
     if (mode === "raw") {
      const upstreamRaw = new URL(`${LDA_BASE}/contributions`);
      upstreamRaw.search = url.search;
      applyLdaSmartParamRewrites(upstreamRaw);
      return forward(upstreamRaw, request, allowOrigin, { rewrite: true, env, ldaBase: LDA_BASE });
    }

    const { rows, warning, errorResp } = await fetchLd203AllRows(request, env, LDA_BASE, url, { yearParam });
    if (errorResp) return withCORS(errorResp, allowOrigin);
    const flattenedItems = flattenLd203Items(rows);
    const keptItems = flattenLd203Items(rows, yearParam);
    const payeeFilter = url.searchParams.get("payee");
    const filteredRows = hasMeaningfulParam(url.searchParams, "payee")
      ? keptItems.filter((row) => normName(pickGroupName(row)) === normName(payeeFilter))
      : keptItems;

    const aggregated = aggregateLd203(filteredRows, url);
    const body = {
      ok: true,
      view: "rollup",
      registrant:
        url.searchParams.get("registrant") ||
        url.searchParams.get("registrant_name") ||
        url.searchParams.get("registrant_id") ||
        url.searchParams.get("contributor") ||
        url.searchParams.get("contributor_name") ||
        null,
      contribution_year: yearParam || null,
      rows_scanned: {
        filings_scanned: rows.length,
        items_scanned: flattenedItems.length,
        items_kept: keptItems.length,
      },
      groups_count: aggregated.groups_count,
      total_amount: aggregated.total_amount,
      groups: aggregated.groups,
    };
    if (warning) body.warning = warning;
    if (url.searchParams.get("debug") === "1") {
      body.debug = {
        sample_filing: rows[0] || null,
        sample_item: flattenedItems[0] || null,
        keys_item: flattenedItems[0] ? Object.keys(flattenedItems[0]) : [],
        year_param: yearParam || null,
        year_filtering_removed_items: keptItems.length !== flattenedItems.length,
      };
    }
    return withCORS(new Response(JSON.stringify(body), { headers: jsonHeaders() }), allowOrigin);
  }
  const upstream = new URL(LDA_BASE + "/" + sub);
  upstream.search = url.search;
  applyLdaSmartParamRewrites(upstream);
  return forward(upstream, request, allowOrigin, { rewrite: true, env, ldaBase: LDA_BASE });
}


/** Forward to upstream. Optionally rewrite JSON next/prev links using the request URL as seed. */
async function forward(upstream, request, allowOrigin, opts = {}) {
  const { rewrite = false, env = undefined, ldaBase = DEFAULT_LDA_BASE } = opts;


  const headers = new Headers();
  headers.set("Accept", "application/json");


  // Optional upstream auth
  const authToken = getLdaAuthHeader(request, env);
  if (authToken) headers.set("Authorization", authToken);


  // Preserve body Content-Type on non-GET/HEAD
  const reqCt = request.headers.get("content-type");
  if (reqCt && request.method !== "GET" && request.method !== "HEAD") {
    headers.set("content-type", reqCt);
  }


  const upstreamReq = new Request(upstream.toString(), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "follow",
  });


  const resp = await fetch(upstreamReq);
  const respCt = resp.headers.get("content-type") || "";


  if (!respCt.includes("application/json")) {
    return withCORS(
      new Response(resp.body, { status: resp.status, headers: passthroughHeaders(resp.headers) }),
      allowOrigin
    );
  }


  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return withCORS(new Response(text, { status: resp.status, headers: jsonHeaders(resp.headers) }), allowOrigin);
  }


  const requestUrl = new URL(request.url);
  const body = rewrite ? rewritePayloadDeep(data, requestUrl.origin, requestUrl, ldaBase) : data;


  return withCORS(
    new Response(JSON.stringify(body), { status: resp.status, headers: jsonHeaders(resp.headers) }),
    allowOrigin
  );
}
