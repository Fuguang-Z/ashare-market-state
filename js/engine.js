/**
 * 市场阶段判定引擎（纯函数，无网络）。
 * replay(history) 用已完成的日数据逐日回放仓位状态机；evaluate(history, today) 在回放结果上叠加当日实时数据，
 * 当日缺数据的条件记为 unknown（null），unknown 不会触发任何状态切换或提醒。
 */

export const PARAMS = Object.freeze({
  VR_UP: 1.05, VR_UP_SOFT: 1.20, VR_STALL: 1.15, AMT60_K: 0.95,
  FAM_TOP: 6, FAM_MIN_IN_TOP: 2, FAM_MIN_IN_TOP5D: 3, FAM_5D_UP: 5.0, FAM_5D_DOWN: -6.0,
  OS_RSI: 35, PANIC_DOWN: 70, PANIC_RSI: 30,
  H_MIN: 5, LOSS_DOWN: 15, RETREAT_DOWN: 30, LAD3_MIN: 3, EXIT_H_DROP: 3, EXIT_LAD3_MAX: 2, EXIT_BROKEN_RATE: 0.5,
  RISK_NEED: 2, F1_LOOKBACK: 40, WARMUP: 20, CYCLE_WINDOW: 40, CYCLE_VOID: 5, THEME_MIN: 10,
  GATE_MA: 10,
});
/** 大主升硬门槛：同花顺全A、同花顺热股、昨日成交前十（代替通达信昨成交20）收盘都在 10 日线上才允许共振爆发；全A 跌破 10 日线即清仓（与回测 stage2_state.py 一致） */
export const GATE_BOARDS = Object.freeze({ qa: '883957', hot: '883910', z10: '883902' });

/** 主题族群（同花顺原生板块代码）；顺序即平局时的优先顺序。 */
export const FAMILIES = Object.freeze({
  '科技硬件': ['881121', '886042', '886033', '881129', '885959', '881270', '881124', '885800', '886112', '886050'],
  '航天军工': ['886078', '885574', '885700'],
  'AI软件': ['881272', '886108', '881275'],
  '新能源': ['881281', '885710', '881279', '881280'],
  '医药': ['881140', '881141', '881175', '886015'],
  '金融': ['881155', '881157', '881156'],
  '资源': ['881169', '885530', '885343', '885914'],
  '地产电力': ['881153', '881145'],
  '机器人': ['885517'],
});
export const PREFERENCE_EXCLUDED = Object.freeze(['资源']);
/** 涨停题材口径：剔除业绩、国企、重组等非题材词（与回测 themes.py 同一列表） */
export const GENERIC_THEME = Object.freeze(['业绩', '增长', '预增', '季报', '年报', '中报', '央企', '国企', '国资', '回购', '控制权', '重组', '收购', '并购', '摘帽',
  '次新', '小盘', '超跌', '谐音', '生肖', '情绪', '分红', '定增', '复牌', '扭亏', '协议', '入主', '股权', '资产注入', '举牌',
  '送转', '员工持股', '借壳', '更名', '字辈', '营收', '净利', '亏损', '拟', '重大', '合作', '基地', '项目', '订单']);
/** 当日同题材涨停集中度：reasons 为涨停池 reason_type 列表 → { name, count } */
export function themeTop(reasons) {
  const c = new Map();
  for (const r of reasons) {
    const set = new Set(String(r ?? '').split(/[+＋、,，]/).filter(t => t && !GENERIC_THEME.some(g => t.includes(g))));
    for (const t of set) c.set(t, (c.get(t) ?? 0) + 1);
  }
  let name = null, count = 0;
  for (const [t, n] of c) if (n > count) { name = t; count = n; }   // 并列取先出现者（与 Python Counter.most_common 一致）
  return { name, count };
}
/** 指数线（机构）仓位档位；情绪线仓位见 cycle.js cyclePosition */
export const POSITION = Object.freeze({ '大主升': '重仓', '大主升-减仓': '半仓', '震荡': '空仓', '筑底': '空仓', '主跌': '空仓' });
/** 指数线仓位档位查询 */
export const positionOf = state => POSITION[state];

const FAMILY_OF = Object.fromEntries(Object.entries(FAMILIES).flatMap(([f, cs]) => cs.map(c => [c, f])));
const isNum = v => typeof v === 'number' && Number.isFinite(v);

export function ma(x, n, i) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) { if (!isNum(x[k])) return null; s += x[k]; }
  return s / n;
}
export function pct(x, i, k = 1) {
  return i >= k && isNum(x[i]) && isNum(x[i - k]) && x[i - k] !== 0 ? (x[i] / x[i - k] - 1) * 100 : null;
}

/** Wilder RSI：前 n 个变化的均值作初值，之后 (n-1)/n 平滑；不足 n 个变化为 null。 */
export function wilderRSI(closes, n = 12) {
  const out = closes.map(() => null);
  let g = 0, l = 0, count = 0, started = false, prev = null;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    if (!isNum(c)) { continue; }
    if (prev === null) { prev = c; continue; }
    const d = c - prev; prev = c;
    const gain = Math.max(d, 0), loss = Math.max(-d, 0);
    if (!started) {
      g += gain; l += loss; count++;
      if (count === n) { g /= n; l /= n; started = true; out[i] = g + l === 0 ? 50 : 100 * g / (g + l); }
    } else {
      g = (g * (n - 1) + gain) / n; l = (l * (n - 1) + loss) / n;
      out[i] = g + l === 0 ? 50 : 100 * g / (g + l);
    }
  }
  return out;
}

/** 族群指数：成员板块当日涨跌幅等权均值逐日连乘（起点 1）。只计入当日与前一日都有收盘的成员。 */
export function familyIndex(boards, length) {
  const out = {};
  for (const [f, codes] of Object.entries(FAMILIES)) {
    const members = codes.filter(c => boards[c]);
    const seq = []; let level = null;
    for (let i = 0; i < length; i++) {
      const rets = [];
      for (const c of members) {
        const s = boards[c].close;
        if (i > 0 && isNum(s[i]) && isNum(s[i - 1]) && s[i - 1] !== 0) rets.push(s[i] / s[i - 1] - 1);
      }
      if (level === null) level = members.some(c => isNum(boards[c].close[i])) ? 1 : null;
      else if (rets.length) level *= 1 + rets.reduce((a, b) => a + b, 0) / rets.length;
      seq.push(level);
    }
    out[f] = seq;
  }
  return out;
}

const argMax = (obj, keys) => keys.reduce((best, k) => (obj[k] ?? -99) > (obj[best] ?? -99) ? k : best, keys[0]);
const argMin = (obj, keys) => keys.reduce((best, k) => (obj[k] ?? 99) < (obj[best] ?? 99) ? k : best, keys[0]);
const maxDefined = arr => { const v = arr.filter(isNum); return v.length ? Math.max(...v) : null; };

/**
 * 计算第 i 日的全部特征。所有输入都可能为 null；任何依赖缺失的布尔特征返回 null（unknown）。
 * H: { dates, sh:{close,high,low}, amt, rsi, limits:{up,down,broken,height,lad3}, boards:{code:{close}} }, FI: familyIndex 结果。
 */
export function features(H, FI, i, P = PARAMS) {
  const sh = H.sh.close, hi = H.sh.high, amt = H.amt, rsi = H.rsi, L = H.limits;
  const m5 = ma(sh, 5, i), m10 = ma(sh, 10, i), m5p = ma(sh, 5, i - 1);
  const a20 = ma(amt, 20, i - 1), a60 = ma(amt, 60, i - 1);
  const vr = isNum(amt[i]) && isNum(a20) ? amt[i] / a20 : null;
  const p1 = pct(sh, i), p5sh = pct(sh, i, 5);
  const tri = (ok, v) => (ok ? v : null);
  const A1 = tri(isNum(sh[i]) && isNum(m5) && isNum(m10) && isNum(m5p), sh[i] > m5 && sh[i] > m10 && m5 > m5p);
  const D1 = tri(isNum(sh[i]) && isNum(m5) && isNum(m5p), sh[i] < m5 && m5 < m5p);
  const codes = Object.keys(H.boards).filter(c => FAMILY_OF[c]).sort();   // 只用族群板块（展示用板块不参与判定）
  const pt = {}, p5b = {};
  for (const c of codes) {
    const v = pct(H.boards[c].close, i); if (v !== null) pt[c] = v;
    const v5 = pct(H.boards[c].close, i, 5); if (v5 !== null) p5b[c] = v5;
  }
  const byDesc = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const top = byDesc(pt).slice(0, P.FAM_TOP), top5d = byDesc(p5b).slice(0, P.FAM_TOP);
  const fams = Object.keys(FAMILIES);
  const f5 = {}, fT = {};
  for (const f of fams) {
    // 当日该族群没有任何成员有涨跌数据（如盘中板块尚未轮询到）→ 记为未知，不显示成 0%
    const covered = FAMILIES[f].some(c => H.boards[c] && pct(H.boards[c].close, i) !== null);
    f5[f] = covered ? pct(FI[f], i, 5) : null; fT[f] = covered ? pct(FI[f], i) : null;
  }
  const boardsOk = Object.keys(pt).length >= 10 && fams.some(f => isNum(f5[f]));
  const lead = argMax(f5, fams), weak = argMin(f5, fams);
  const cnt = top.filter(c => FAMILY_OF[c] === lead).length, cnt5 = top5d.filter(c => FAMILY_OF[c] === lead).length;
  const collective = tri(boardsOk && isNum(f5[lead]), f5[lead] >= P.FAM_5D_UP && (cnt >= P.FAM_MIN_IN_TOP || cnt5 >= P.FAM_MIN_IN_TOP5D));
  const sync = tri(isNum(p1) && boardsOk && isNum(fT[lead]), p1 > 0 && (fT[lead] > p1 || (fT[lead] > 0 && isNum(p5sh) && f5[lead] > p5sh)));
  const mainFall = tri(boardsOk && isNum(f5[weak]) && isNum(fT[weak]), f5[weak] <= P.FAM_5D_DOWN && fT[weak] < 0);
  const volVsDecline = tri(isNum(amt[i]), a60 === null ? true : amt[i] >= a60 * P.AMT60_K);
  const h = L.height[i], dn = L.down[i], up = L.up[i], brk = L.broken[i], lad3 = L.lad3[i], theme = L.theme?.[i] ?? null;
  const hmax5 = maxDefined(L.height.slice(Math.max(0, i - 5), i)), hmax10 = maxDefined(L.height.slice(Math.max(0, i - 10), i));
  const hExpand = tri(isNum(h) && hmax5 !== null, h >= Math.max(P.H_MIN, hmax5));
  const noLoss = tri(isNum(dn), dn <= P.LOSS_DOWN);
  const ladderOk = tri(isNum(lad3), lad3 >= P.LAD3_MIN);
  const themeHot = tri(isNum(theme), theme >= P.THEME_MIN);
  const brokenRate = isNum(up) && isNum(brk) && up + brk > 0 ? brk / (up + brk) : null;
  const panic = tri(isNum(dn) && isNum(rsi[i]), dn >= P.PANIC_DOWN && rsi[i] < P.PANIC_RSI);
  const hi20 = i >= 19 ? maxDefined(sh.slice(i - 19, i + 1)) : null;
  let rHi = null; if (i >= 19) { rHi = i - 19; for (let k = i - 19; k < i; k++) if (isNum(sh[k]) && sh[k] > sh[rHi]) rHi = k; }
  const above = x => { if (!x) return null; const m = ma(x, P.GATE_MA, i); return isNum(x[i]) && isNum(m) ? x[i] > m : null; };
  const gA = above(H.boards[GATE_BOARDS.qa]?.close), gHot = above(H.boards[GATE_BOARDS.hot]?.close), gZ10 = above(H.boards[GATE_BOARDS.z10]?.close);
  const gate = gA === false || gHot === false || gZ10 === false ? false : gA && gHot && gZ10 ? true : null;
  return { i, date: H.dates[i], close: sh[i], high: hi[i], m5, m10, m5p, p1, p5sh, amt: amt[i], a20, a60, vr, rsi: rsi[i],
    gA, gHot, gZ10, gate,
    A1, D1, pt, top, top5d, f5, fT, lead, weak, cnt, cnt5, collective, sync, mainFall, volVsDecline,
    h, dn, up, brk, lad3, theme, themeName: H.limits.themeName?.[i] ?? null, themeHot, hmax5, hmax10, hExpand, noLoss, ladderOk, brokenRate, panic, hi20, rHi, boardsOk };
}

/**
 * 提醒时段：10:30 前只观察；10:30–14:40 预警；14:40–15:00 确认；午休、盘前、收盘后、休市不提醒。
 * @param {string} hhmm 北京时间 HH:MM；@param {boolean} tradingDay
 */
export function alertLevelAt(hhmm, tradingDay) {
  if (!tradingDay || hhmm < '10:30' || (hhmm >= '11:30' && hhmm < '13:00') || hhmm >= '15:00') return null;
  return hhmm < '14:40' ? '预警' : '确认';
}
/** 是否应发出提醒：当日试算行有状态切换、处于提醒时段、且同一 日期|事件|新状态|级别 未发过。返回去重键或 null。 */
export function alertKey(row, level, fired = {}) {
  if (!row?.event || !level) return null;
  const key = `${row.date}|${row.event}|${row.state}|${level}`;
  return fired[key] ? null : key;
}

/** 逐日回放；返回每日行与事件。today=true 时最后一行用于盘中试算（unknown 不触发切换）。 */
export function replay(H, P = PARAMS) {
  const n = H.dates.length;
  const FI = familyIndex(H.boards, n);
  let state = '震荡', f1 = { stage: 0 }, lastOs = null, leadHold = null;
  const rows = [], events = [];
  const T = v => v === true;   // unknown 视为不成立（不触发）
  for (let i = 0; i < n; i++) {
    const rsiI = H.rsi[i];
    if (i < P.WARMUP) { if (isNum(rsiI) && rsiI < P.OS_RSI) lastOs = i; continue; }
    const F = features(H, FI, i, P);
    // F1：超跌 → 盘中触及 MA5 → 收盘跌回 MA5 下 → 再次满足 A1
    if (isNum(rsiI) && rsiI < P.OS_RSI) { lastOs = i; if (f1.stage === 0 || f1.stage === 4) f1 = { stage: 1 }; }
    else if (f1.stage === 1 && isNum(F.high) && isNum(F.m5) && F.high >= F.m5) f1.stage = 2;
    else if (f1.stage === 2 && isNum(F.close) && isNum(F.m5) && F.close < F.m5) f1.stage = 3;
    else if (f1.stage === 3 && T(F.A1)) f1.stage = 4;
    const f1full = f1.stage === 4 || lastOs === null || i - lastOs > P.F1_LOOKBACK;
    const f1part = f1.stage === 2 || f1.stage === 3;
    const volOk = isNum(F.vr) ? ((f1full && F.vr >= P.VR_UP) || (f1part && F.vr >= P.VR_UP_SOFT)) : null;
    const triggerParts = [F.gate, F.A1, F.collective, F.sync, F.volVsDecline, volOk];
    const trigger = triggerParts.every(T);
    const triggerUnknown = !trigger && triggerParts.some(v => v === null) && !triggerParts.some(v => v === false);
    // 风险信号（针对持有中的主线族）
    const risk = [], riskUnknown = [];
    if (state === '大主升' || state === '大主升-减仓') {
      const Lf = leadHold;
      const chk = (name, ok, v) => { if (!ok) riskUnknown.push(name); else if (v) risk.push(name); };
      chk('指数放量滞涨', isNum(F.vr) && isNum(F.p1) && isNum(F.hi20), F.vr >= P.VR_STALL && Math.abs(F.p1) < 0.3 && F.close >= F.hi20 * 0.99);
      chk('指数顶背离', isNum(F.hi20) && isNum(F.rsi) && F.rHi !== null && isNum(H.rsi[F.rHi]), F.close >= F.hi20 * 0.995 && F.rsi < H.rsi[F.rHi] - 5);
      chk('主线族巨震', isNum(F.fT[Lf]) && isNum(F.p1), F.fT[Lf] <= -3 && F.p1 > -1);
      const fm5 = ma(FI[Lf], 5, i), fm5y = ma(FI[Lf], 5, i - 1);
      chk('主线族连续2日跌破5日线', isNum(fm5) && isNum(fm5y), FI[Lf][i] < fm5 && FI[Lf][i - 1] < fm5y);
      chk('跌停扩散', isNum(F.dn), F.dn >= P.RETREAT_DOWN);
    }
    const prev = state; let ev = null;
    if (state === '大主升' || state === '大主升-减仓') {
      const leadNeg = isNum(F.f5[leadHold]) ? F.f5[leadHold] < 0 : null;
      if (T(F.D1) && (leadNeg === true || T(F.mainFall))) { state = '主跌'; ev = '破位清仓'; }
      else if (F.gA === false) { state = '震荡'; ev = '全A跌破10日线'; }   // 只有确知跌破才离场
      else if (state === '大主升' && risk.length >= P.RISK_NEED) { state = '大主升-减仓'; ev = '风险降仓'; }
      else if (trigger && F.lead !== leadHold) { leadHold = F.lead; ev = '主线切换'; }
    } else if (state === '主跌') {
      if (trigger) { state = '大主升'; ev = '共振爆发'; leadHold = F.lead; }
      else if (isNum(F.close) && isNum(F.m5) && F.close > F.m5) { state = '筑底'; ev = '主跌结束（企稳）'; }
    } else {
      const newLow = isNum(F.close) && i >= 10 && F.close < Math.min(...H.sh.close.slice(i - 10, i).filter(isNum));
      if (trigger) { state = '大主升'; ev = '共振爆发'; leadHold = F.lead; }
      else if (T(F.D1) && (T(F.mainFall) || (isNum(F.p1) && F.p1 <= -1)) && (state === '震荡' || newLow)) { state = '主跌'; ev = '转入主跌'; }
    }
    const shownLead = state.startsWith('大主升') ? leadHold : F.lead;
    const row = { ...F, state, prevState: prev, event: ev, position: positionOf(state), leadShown: shownLead, f1: f1.stage, f1full, f1part,
      volOk, trigger, triggerUnknown, risk, riskUnknown, FI };
    rows.push(row);
    if (ev) events.push({ date: H.dates[i], event: ev, from: prev, to: state, position: positionOf(state), lead: shownLead });
  }
  return { rows, events, final: rows.at(-1) ?? null, FI };
}
