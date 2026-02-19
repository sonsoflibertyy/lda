importimport { json } from "./utils/http.js";
import { resolveAllowedOrigin } from "./utils/misc.js";
import { lastNQuarters, yqToFilters, yqFromReport } from "./utils/time.js";
import { fecNameVariants, normalizeCompanyInput } from "./utils/names.js";
import { makeLdaClient } from "./clients/lda.js";
import { LDA_BASE as DEFAULT_LDA_BASE } from "./config.js";
import { reduceAmendments, aggregateLDA, getRegistrantName, getClientName } from "./aggregators/rollups.js";

function extractLobbyistNames(detail){
  const out = new Set();
  const acts = detail?.lobbying_activities || [];
  for (const a of acts){
    const lobz = a?.lobbyists || [];
    for (const l of lobz){
      const parts = [l.prefix_display, l.first_name, l.nickname, l.middle_name, l.last_name, l.suffix_display]
        .map(x => (x||"").trim()).filter(Boolean);
      if (parts.length) out.add(parts.join(" ").replace(/\s+/g," "));
    }
  }
  return Array.from(out);
}

export async function handleLdaSummary(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/lda/summary") return null;

  const allowOrigin = resolveAllowedOrigin(env, request.headers.get("Origin"));
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ error: "Missing ?q=<company>" }, 400, allowOrigin);

  const quartersN = Math.max(1, Math.min(16, +(url.searchParams.get("quarters") || 8)));
  const treatLT5k = (url.searchParams.get("treat_lt5k") || "zero").toLowerCase();
  const treatLT5kAsZero = treatLT5k !== "5000";
  const includeLobbyists = url.searchParams.get("include_lobbyists") === "1";
  const maxDetail = Math.max(0, Math.min(40, +(url.searchParams.get("max_detail") || 10)));
  const debug = url.searchParams.get("debug") === "1";

  const qList = lastNQuarters(quartersN);
  const qSet = new Set(qList);
  const LDA_BASE = env?.LDA_BASE || env?.LDA_BASE_URL || DEFAULT_LDA_BASE;
  const lda = makeLdaClient({
    LDA_KEY: env?.LDA_API_KEY || env?.LDA_KEY,
    LDA_BASE,
    timeoutMs: env?.LDA_TIMEOUT_MS
  });

  const variants = fecNameVariants(normalizeCompanyInput(q))
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => (a.length > b.length ? -1 : 1));

  async function fetchQuarterFacetInline(ldaClient, year, period, facetKey, nameVars, seen, maxPages = 2) {
    const out = [];
    for (const name of nameVars) {
      for (let p = 1; p <= maxPages; p++) {
        const j = await ldaClient.get(`/filings/`, {
          [facetKey]: name,
          filing_year: year,
          filing_period: period,
          page: p,
          page_size: 25
        });
        const rows = j?.results || [];
        for (const r of rows) {
          const uuid = r.filing_uuid || r.id;
          if (!uuid || seen.has(uuid)) continue;
          seen.add(uuid);
          out.push(r);
        }
        if (!j?.next || rows.length < 25) break;
      }
      if (out.length) break;
    }
    return out;
  }

  const seen = new Set();
  let rows = [];
  for (const yq of qList) {
    const { year, period } = yqToFilters(yq);
    rows.push(...(await fetchQuarterFacetInline(lda, year, period, "client_name", variants, seen, 2)));
    rows.push(...(await fetchQuarterFacetInline(lda, year, period, "registrant_name", variants, seen, 2)));
  }

  const reduced = reduceAmendments(rows, q, treatLT5kAsZero);
  const agg = aggregateLDA(reduced, qList);

  // optional lobbyist enrichment
  const lobbyistsAgg = new Map();
  const enriched = [];
  if (includeLobbyists && maxDetail > 0) {
    const detailTargets = reduced.filter((r) => qSet.has(yqFromReport(r))).slice(0, maxDetail);
    for (const r of detailTargets) {
      const uuid = r.filing_uuid || r.id;
      if (!uuid) continue;
      const detail = await lda.get(`/filings/${uuid}/`);
      const names = extractLobbyistNames(detail);
      const yq = yqFromReport(r);
      if (yq && names.length) {
        if (!lobbyistsAgg.has(yq)) lobbyistsAgg.set(yq, new Map());
        const mm = lobbyistsAgg.get(yq);
        for (const n of names) mm.set(n, (mm.get(n) || 0) + 1);
      }
      enriched.push({
        filing_uuid: uuid,
        quarter: yq,
        dt_posted: r.dt_posted || r.filed_date || null,
        amount_effective: r.__effAmt || 0,
        attrib: r.__attrib,
        registrant: getRegistrantName(r),
        client: getClientName(r),
        filing_detail_proxy: `${url.origin}/lda/filings/${uuid}/`,
        filing_document_url: detail?.filing_document_url || null,
        lobbyists: names
      });
    }
  }

  const lobbyists_by_quarter = qList.map((qtr) => {
    const mm = lobbyistsAgg.get(qtr) || new Map();
    return {
      quarter: qtr,
      lobbyists: Array.from(mm.entries()).map(([name, count]) => ({ name, count }))
    };
  });

  const payload = {
    ok: true,
    company: q,
    quarters: qList,
    totals_by_quarter: qList.map((x) => ({ quarter: x, total: agg.byQ.get(x) || 0 })),
    total_quarters: agg.total8Q,
    kept_quarter_rows: agg.kept8Q,
    all_income_5y: agg.allIncome,
    all_expenses_5y: agg.allExpenses,
    rows_scanned: rows.length,
    rows_kept: reduced.length,
    note:
      "Totals include BOTH hired firms (client→income) and in-house (registrant→expenses); per filing we take max(nonzero(income,expenses)) to avoid LD-2 double-counting."
  };
  if (includeLobbyists) {
    payload.lobbyists_by_quarter = lobbyists_by_quarter;
    payload.filings_sample = enriched;
  }
  if (debug) {
    payload.sample = reduced.slice(0, 20).map((r) => ({
      filing_uuid: r.filing_uuid || r.id,
      filing_year: r.filing_year ?? r.report_year,
      filing_type: r.filing_type,
      filing_period: r.filing_period,
      dt_posted: r.dt_posted,
      mapped_yq: yqFromReport(r),
      income: r.income,
      expenses: r.expenses,
      attrib: r.__attrib,
      client: getClientName(r),
      registrant: getRegistrantName(r)
    }));
  }

  return json(payload, 200, allowOrigin);
}
