// src/utils/lda.js
// Utilities for LDA param rewrites. No imports on purpose.

export function applyLdaSmartParamRewrites(u) {
  try {
    const p = u.searchParams;

    // Detect upstream flavor by path
    const pathname = u.pathname || "";
    const isV1 = /^\/api\/v1(\/|$)/i.test(pathname);
    const isPublic = /^\/filings\/api\/public(\/|$)/i.test(pathname);

    // Normalized path for feature gating
    const apiPath = pathname.replace(/^\/api\/v1\/?/, "/").toLowerCase();

    // ---- Normalize year keys ----
    if (!p.has("filing_year")) {
      if (p.has("report_year")) p.set("filing_year", p.get("report_year"));
      else if (p.has("year")) p.set("filing_year", p.get("year"));
    }

    // ---- Common misspellings for company names ----
    const normalizeMiss = (key) => {
      if (!p.has(key)) return;
      const vv = String(p.get(key) || "").trim().toLowerCase();
      if (["phizer", "pfiser", "pfzier", "phiser", "phier", "phizzer"].includes(vv)) p.set(key, "pfizer");
    };

    if (apiPath.startsWith("/clients")) normalizeMiss("client_name");
    if (apiPath.startsWith("/registrants")) normalizeMiss("registrant_name");
    if (apiPath.startsWith("/filings")) {
      normalizeMiss("client_name");
      normalizeMiss("registrant_name");
    }

    // ---- Synonym mapping between public and v1 flavors ----
    if (isV1) {
      // per_page → page_size, sort → ordering
      if (p.has("per_page") && !p.has("page_size")) p.set("page_size", p.get("per_page"));
      if (p.has("sort") && !p.has("ordering")) p.set("ordering", p.get("sort"));

      if (apiPath.startsWith("/filings")) {
        // Promote q → search (nice-to-have; not sufficient for paging by itself)
        if (p.has("q") && !p.has("search")) p.set("search", p.get("q"));

        // --- NEW: ensure a QUALIFYING filter exists when page>1 ---
        // Senate v1 requires a real filter (search/form_type don't count).
        const pageNum = Number(p.get("page") || "1");
        const qualifyingKeys = [
          "registrant_name",
          "client_name",
          "registrant_id",
          "client_id",
          "filing_year",
          "filing_period",
          "dt_posted_after",
          "dt_posted_before",
          "filing_uuid",
          "house_registrant_id",
          "client_id_number"
        ];
        const hasQualifying = qualifyingKeys.some(
          (k) => p.has(k) && String(p.get(k)).trim() !== ""
        );

        if (pageNum > 1 && !hasQualifying) {
          // Derive a broad-but-valid filter from the user's term.
          const term = (p.get("search") || p.get("q") || "").trim();
          if (term && !p.has("registrant_name") && !p.has("client_name")) {
            // Prefer registrant_name (works well for company queries like 'Pfizer').
            p.set("registrant_name", term);
          }
        }
      }

      // Optional tidy-up: drop 'q' if it duplicates 'search'
      if (p.has("q") && p.has("search") && p.get("q") === p.get("search")) p.delete("q");
      // (You can also prune 'per_page'/'sort' if you want cleaner URLs)
      // if (p.has("per_page")) p.delete("per_page");
      // if (p.has("sort")) p.delete("sort");

    } else if (isPublic) {
      // page_size → per_page, ordering → sort, search → q (for public flavor)
      if (p.has("page_size") && !p.has("per_page")) p.set("per_page", p.get("page_size"));
      if (p.has("ordering") && !p.has("sort")) p.set("sort", p.get("ordering"));
      if (p.has("search") && !p.has("q")) p.set("q", p.get("search"));

      // Optional tidy-up to avoid duplicates
      if (p.has("search") && p.has("q") && p.get("search") === p.get("q")) p.delete("search");
      // if (p.has("page_size")) p.delete("page_size");
      // if (p.has("ordering")) p.delete("ordering");
    }

    u.search = "?" + p.toString();
  } catch {
    // no-op
  }
}
