// src/utils/names.js

export function normName(s) {
  return (s || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/\bINCORPORATED\b/g, " INC")
    .replace(/\bCOMPANY\b/g, " CO")
    .replace(/\bL\.?L\.?C\.?\b/g, " LLC")
    .replace(/\bL\.?P\.?\b/g, " LP")
    .replace(/\bCORPORATION\b/g, " CORP")
    .replace(/[.,]/g, " ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCompanyInput(s) {
  const t = String(s || "").trim();
  const low = t.toLowerCase();

  const map = {
    "phizer": "pfizer",
    "pfiser": "pfizer",
    "pfzier": "pfizer",
    "phiser": "pfizer",
    "phier": "pfizer",
    "phizzer": "pfizer",
    "pfizer inc": "pfizer",
    "pfizer, inc": "pfizer"
  };

  return map[low] || t;
}

export function fecNameVariants(company) {
  const base = normName(company);

  const short = base
    .replace(
      /\b(LLC|L L C|LP|L P|PLC|LTD|LIMITED|INC|CORP|CORPORATION|HOLDINGS?|GROUP|CO|COMPANY)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  const set = new Set([base]);
  if (short) set.add(short);

  const incForms = [];
  if (short) {
    incForms.push(
      `${short} INC`,
      `${short} INC.`,
      `${short}, INC`,
      `${short}, INC.`
    );
  }

  if (/\bINC\b(?!\.)/.test(base)) set.add(base.replace(/\bINC\b/g, "INC."));
  if (/\bINC\.\b/.test(base)) set.add(base.replace(/\bINC\.\b/g, "INC"));

  for (const f of incForms) set.add(f);

  return Array.from(set)
    .filter(Boolean)
    .filter((s) => s.length >= 3);
}

/**
 * Committee metadata lookup.
 * Always returns a safe object to prevent undefined crashes.
 */
export function makeCommitteeLookup(committees) {
  const store = new Map();

  for (const c of committees || []) {
    if (c && c.committee_id) {
      store.set(c.committee_id, c);
    }
  }

  return (id) => {
    const c = id ? store.get(id) : undefined;
    return {
      id: id || null,
      name: c?.name || null,
      designation: c?.designation || null,
      designation_full: c?.designation_full || null,
      committee_type: c?.committee_type || null,
      type: c?.committee_type || null
    };
  };
}

/**
 * Candidate metadata lookup.
 * Always returns a safe object.
 */
export function makeCandidateLookup(candidates) {
  const store = new Map();

  for (const c of candidates || []) {
    if (c && c.candidate_id) {
      store.set(c.candidate_id, c);
    }
  }

  return (id) => {
    const c = id ? store.get(id) : undefined;
    return {
      id: id || null,
      name: c?.name || null,
      party: c?.party || null,
      office: c?.office || null,
      state: c?.state || null,
      district: c?.district || null
    };
  };
}

export function isCandidateCommittee(meta) {
  if (!meta) return false;
  const d = String(meta.designation || "").toUpperCase();
  // P = principal campaign committee, A = authorized
  return d === "P" || d === "A";
}

export function isCandidateCommitteeType(t = "") {
  const T = String(t || "").toUpperCase();
  // H = House, S = Senate, P = President
  return T === "H" || T === "S" || T === "P";
}
