/** 种子里压缩存放的涨停池 / 周期日 K 解码（网页与一致性测试共用） */
export function decodePools(lp) {
  const out = {};
  if (!lp) return out;
  for (const [d, list] of Object.entries(lp.days)) {
    const day = {};
    for (const [c, tis] of list) day[c] = [lp.names[c] ?? c, tis.map(t => lp.themes[t])];
    out[d] = day;
  }
  return out;
}
export function decodeKline(ck, dates) {
  const out = {};
  for (const [c, rows] of Object.entries(ck ?? {})) {
    const m = {}; for (const [i, close, high, low] of rows) m[dates[i]] = { close, high, low }; out[c] = m;
  }
  return out;
}
/** 指数线逐日结果 → 情绪周期所需特征 */
export function featFromRows(rows) {
  const f = {};
  for (const r of rows) f[r.date] = { state: r.state, hExpand: r.hExpand === true, down: r.dn ?? null, lad3: r.lad3 ?? null, event: r.event ?? null, lead: r.leadShown };
  return f;
}
