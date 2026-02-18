import { yqFromReport } from "../utils/time.js";

const pluck = (o, path) => { try { return path.split(".").reduce((v,k)=> (v && k in v ? v[k] : undefined), o); } catch { return undefined; } };

export function getClientName(r){
  return (r.client_name || pluck(r,"client.client_name") || pluck(r,"client.organization_name") || pluck(r,"client.name") || "");
}
export function getRegistrantName(r){
  return (r.registrant_name || pluck(r,"registrant.registrant_name") || pluck(r,"registrant.organization_name") || pluck(r,"registrant.name") || "");
}

function pickAmounts(r){
  const toNum = (v)=> {
    if (v === null || v === undefined || v === false) return 0;
    const s = String(v).replace(/[$,]/g,"").trim();
    const n = +s;
    return Number.isFinite(n) ? n : 0;
  };
  return { income: toNum(r.income), expenses: toNum(r.expenses) };
}
function keyQuarter(r){
  const ry = r.report_year ?? r.filing_year ?? r.year ?? "";
  let rq = (r.report_quarter ?? r.quarter ?? "").toString().replace(/[^\d]/g,"");
  if (!rq && r.filing_period){
    const fp = String(r.filing_period).toLowerCase();
    const map = { first_quarter: 1, second_quarter: 2, third_quarter: 3, fourth_quarter: 4, mid_year: 2, year_end: 4 };
    if (map[fp]) rq = String(map[fp]);
  }
  const rid = r.registrant_id || pluck(r,"registrant.registrant_id") || pluck(r,"registrant.id") || "";
  const cid = r.client_id || pluck(r,"client.client_id") || pluck(r,"client.id") || "";
  return `${rid}|${cid}|${ry}|${rq}`;
}

export function reduceAmendments(rows, company, treatLT5kAsZero=true){
  const groups=new Map();
  for (const r of rows){
    const key=keyQuarter(r); if (!key.includes("|")) continue;
    const {income,expenses}=pickAmounts(r);
    const amt=Math.max(income,expenses);
    const lt5 = !!(r.income_less_than_5k||r.expenses_less_than_5k||r.less_than_5k);
    const effAmt = (amt||0) || (lt5 && !treatLT5kAsZero ? 5000 : 0);

    // attribute: try to infer whether this quarter row is income-side or expense-side
    const attrib = "income"; // conservative default for summary
    const cand = {
      ...r,
      __effAmt: effAmt,
      __hasNum: (amt>0),
      __filed: Date.parse(r.dt_posted || r.filed_date || 0),
      __attrib: attrib
    };
    const cur=groups.get(key);
    if (!cur){ groups.set(key,cand); continue; }
    if ((cand.__hasNum && !cur.__hasNum) || (cand.__effAmt>cur.__effAmt) || (cand.__filed>cur.__filed)) groups.set(key,cand);
  }
  return Array.from(groups.values());
}

export function aggregateLDA(rows, qList){
  const byQ=new Map(qList.map(q=>[q,0])); let kept=0, inc=0, exp=0;
  for (const r of rows){
    const yq=yqFromReport(r); const amt=r.__effAmt||0;
    if (r.__attrib==="income") inc+=amt; else if (r.__attrib==="expenses") exp+=amt;
    if (byQ.has(yq)){ byQ.set(yq, byQ.get(yq)+amt); kept++; }
  }
  const total=Array.from(byQ.values()).reduce((a,b)=>a+b,0);
  return {byQ, kept8Q:kept, total8Q:total, allIncome:inc, allExpenses:exp};
}
