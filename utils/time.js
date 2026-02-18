// src/utils/time.js

/* Last completed even cycle (e.g., 2025 -> 2024) */
export function latestEvenCycleUTC() {
  const y = new Date().getUTCFullYear();
  return y % 2 === 0 ? y : y - 1;
}

/* n most-recent quarters as ["YYYY-Q#"] ending with current quarter */
export function lastNQuarters(n) {
  const out = [];
  const d = new Date();
  let y = d.getUTCFullYear();
  let q = Math.floor(d.getUTCMonth() / 3) + 1;
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-Q${q}`);
    q--;
    if (q === 0) {
      q = 4;
      y--;
    }
  }
  return out;
}

export function yqToFilters(yq) {
  const [ys, qs] = yq.split("-Q");
  const map = {
    1: "first_quarter",
    2: "second_quarter",
    3: "third_quarter",
    4: "fourth_quarter"
  };
  return { year: +ys, period: map[+qs] };
}

export function yqFromReport(r) {
  const y = r.report_year ?? r.filing_year ?? r.year ?? null;
  let q = (r.report_quarter ?? r.quarter ?? "").toString().replace(/[^\d]/g, "");

  if (!q && r.filing_period) {
    const fp = String(r.filing_period).toLowerCase();
    const map = {
      first_quarter: 1,
      second_quarter: 2,
      third_quarter: 3,
      fourth_quarter: 4,
      mid_year: 2,
      year_end: 4
    };
    if (map[fp]) q = String(map[fp]);
  }

  if (
    !q &&
    r.filing_type_display &&
    /(\d)(st|nd|rd|th)\s+Quarter/i.test(String(r.filing_type_display))
  ) {
    q = RegExp.$1;
  }

  if (!q && r.dt_posted) {
    const m = new Date(r.dt_posted).getUTCMonth();
    q = String(Math.floor(m / 3) + 1);
  }

  return y && q ? `${y}-Q${q}` : null;
}

/* basic date utils, handy later */
export function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

export function addDays(d, n) {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

export function dateDiffDays(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return NaN;
  const ms = a.getTime() - b.getTime();
  return Math.round(ms / 86400000);
}
