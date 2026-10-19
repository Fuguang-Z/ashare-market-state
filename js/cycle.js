/**
 * 情绪周期（第二条线，与指数/机构状态并行）。纯函数，逐行对应回测 研究/回测/cycle.py（一致性测试见 parity/cycle.test.mjs）。
 * 脉络：指数止跌 → 龙头主升、打开高度 → 龙头震荡，补涨开启 → 高标依次见顶、新高标接力 → 龙头反抽双顶 → 情绪退潮。
 * 主线之外可有一条伴生线，随主线周期一起结束。
 */
import { GENERIC_THEME } from './engine.js?v=20261019l';

export const CYCLE_PARAMS = Object.freeze({
  PANIC_DOWN: 30, SHAKE_AMP: 12.0, SHAKE_FROM_HIGH: 2.0, DROP: -5.0, STALL: 3.0, WIN: 3, STRENGTH: 6, STRENGTH_RES: 5, RES_LOOK: 5, HOLD: 3,
  LOOKBACK: 20, AHEAD: 3, IDLE_MAX: 20, CYCLE_MAX: 45, REBOUND_GAP: 5, VOID: 5, DRIVE_MIN: 10, GAIN_MIN: 100, GAIN_WIN: 40,
});

/** 族群显示名与题材归类（与回测 families.py 同一口径） */
export const FAMILY_LABEL = Object.freeze({ '科技硬件': '大科技', '航天军工': '商业航天', 'AI软件': 'AI应用', '新能源': '新能源', '医药': '医药', '金融': '金融', '资源': '资源', '地产电力': '地产电力', '机器人': '机器人' });
const THEME_FAMILY = [
  ['航天军工', ['航天', '卫星', '火箭', '军工', '低空', '北斗']],
  ['科技硬件', ['半导体', '芯片', '存储', 'CPO', '光模块', '光通信', '通信', 'PCB', '覆铜板', '元件', 'MLCC', '消费电子', '算力', '封装', '服务器', '液冷', '光纤', 'HDI', '磷化铟', '玻璃基板', '电子']],
  ['AI软件', ['AI', '软件', '游戏', '传媒', '多模态', '数据要素', 'AIGC', '智能体', '营销', '影视', '短剧', '出版']],
  ['机器人', ['机器人', '具身']],
  ['新能源', ['电池', '锂', '光伏', '风电', '储能', '固态', '氢能']],
  ['医药', ['药', '医', 'CRO', '生物', '疫苗']],
  ['资源', ['黄金', '白银', '贵金属', '稀土', '煤', '有色', '铜', '石油', '油气', '钨', '锗']],
  ['地产电力', ['地产', '房产', '物业', '电力', '绿电', '火电', '水电', '核电']],
  ['金融', ['银行', '证券', '保险', '券商']],
];
export function familyOfTheme(theme) {
  for (const [fam, keys] of THEME_FAMILY) if (keys.some(k => String(theme ?? '').includes(k))) return fam;
  return null;
}
/** 板块按族群归类展示：族群（分支） */
export function labelBoard(board, fam = null) {
  const f = fam ?? familyOfTheme(board);
  if (!f) return board;
  const lab = FAMILY_LABEL[f] ?? f;
  return !board || board === lab ? lab : `${lab}（${board}）`;
}
/** 涨停原因 → 题材列表（剔除非题材词，与回测 themes.split_themes 一致） */
export function splitThemes(reason) {
  return String(reason ?? '').split(/[+＋、,，]/).filter(t => t && !GENERIC_THEME.some(g => t.includes(g)));
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** ≥3 连板段及其强度（首板起 10 个交易日内累计涨停次数），按（首板日、强度降序、代码）排序 */
export function streaks(D, P, minLen = 3, horizon = 10) {
  const idx = new Map(D.map((d, i) => [d, i]));
  const codes = new Set(); for (const d of D) for (const c of Object.keys(P[d] ?? {})) codes.add(c);
  const out = [];
  for (const c of [...codes].sort(cmp)) {
    let run = [];
    const flush = () => {
      if (run.length >= minLen) {
        const i0 = idx.get(run[0]);
        let strength = 0;
        for (let k = i0, n = 0; k < D.length && n < horizon; k++) { if (!P[D[k]]) continue; n++; if (P[D[k]][c]) strength++; }   // 首板起 horizon 个有涨停池的交易日
        const tc = new Map();
        for (const d of run) for (const t of P[d][c][1]) tc.set(t, (tc.get(t) ?? 0) + 1);
        const themes = [...tc].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 3);
        out.push({ code: c, name: P[run[0]][c][0], start: run[0], len: run.length, strength, themes });
      }
      run = [];
    };
    for (const d of D) { if (!P[d]) continue; if (P[d][c]) run.push(d); else flush(); }   // 缺当日涨停池：既不算涨停也不算断板
    flush();
  }
  return out.sort((a, b) => cmp(a.start, b.start) || b.strength - a.strength || cmp(a.code, b.code));
}

/**
 * dates: 交易日；pools: {date: {code: [name, themes[]]}}；kline: code → {date: {close, high, low}}（缺失返回 null，并记入 missing）；
 * feat: {date: {state, hExpand, down, lad3, event, lead}}（指数线逐日结果）。
 * startAfter：只在该日之后识别新周期（之前的周期以复盘时间线为准）。
 * 返回 { cycles, missing:Set<code>（整只无日 K）, stale:Map<code, date>（有日 K 但缺该日及之前所需日期） }。
 */
export function cycleReplay({ dates: D, pools: P, kline, feat, params = CYCLE_PARAMS, startAfter = null }) {
  const prm = params, idx = new Map(D.map((d, i) => [d, i]));
  const ST = streaks(D, P), STRONG = ST.filter(s => s.strength >= prm.STRENGTH);
  const missing = new Set(), stale = new Map(), Kc = new Map();
  const need = (c, d) => { if (!stale.has(c) || stale.get(c) < d) stale.set(c, d); };
  const k = c => { if (!Kc.has(c)) { const v = kline(c); if (!v) missing.add(c); Kc.set(c, v ?? {}); } return Kc.get(c); };
  const lim = (c, d) => !!(d && P[d] && P[d][c]);
  const bar = (c, i) => {
    const kk = k(c), r = kk[D[i]], p = i ? kk[D[i - 1]] : null;
    if (!r) need(c, D[i]);
    if (!r || !p) return null;
    const pc = p.close;
    return { chg: (r.close / pc - 1) * 100, amp: (r.high - r.low) / pc * 100, fromHigh: (r.close / r.high - 1) * 100 };
  };

  function leaderAt(i) {
    const lo = Math.max(0, i - prm.LOOKBACK), hi = Math.min(D.length - 1, i + prm.AHEAD);
    const win = D.slice(lo, hi + 1);
    const hits = new Map(), names = new Map(), own = new Map();
    for (const d of win) for (const [c, [n, th]] of Object.entries(P[d] ?? {})) {
      hits.set(c, (hits.get(c) ?? 0) + 1); names.set(c, n);
      const o = own.get(c) ?? new Map(); own.set(c, o);
      for (const t of new Set(th)) o.set(t, (o.get(t) ?? 0) + 1);
    }
    let best = null;
    for (const [c, n] of [...hits].sort((a, b) => cmp(a[0], b[0]))) {
      const o = own.get(c);
      if (n < 3 || !o || !o.size) continue;
      let ok = false; for (let j = i; j <= hi; j++) if (lim(c, D[j])) { ok = true; break; }
      if (!ok) continue;
      const main = [...o].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0][0];
      const mates = new Set();
      for (let j = lo; j <= hi; j++) {
        if (!lim(c, D[j])) continue;
        for (const jj of [j, j + 1]) if (jj < D.length) for (const [x, [, th]] of Object.entries(P[D[jj]] ?? {})) if (x !== c && th.includes(main)) mates.add(x);
      }
      if (mates.size < prm.DRIVE_MIN) continue;
      const kk = k(c);
      if (!kk[D[hi]]) need(c, D[hi]);
      const cw = win.filter(d => kk[d]).map(d => kk[d].close);
      const base = []; for (let j = Math.max(0, i - prm.GAIN_WIN); j <= i; j++) if (kk[D[j]]) base.push(kk[D[j]].close);
      if (!cw.length || !base.length) continue;
      const gain = (Math.max(...cw) / Math.min(...base) - 1) * 100;
      if (gain < prm.GAIN_MIN) continue;
      const key = [gain, mates.size];
      const better = !best || key[0] > best.key[0] || (key[0] === best.key[0] && (key[1] > best.key[1] || (key[1] === best.key[1] && c < best.code)));
      if (better) best = { key, code: c, name: names.get(c), board: main };
    }
    return best && { code: best.code, name: best.name, board: best.board, drive: best.key[1], gain: Math.round(best.key[0] * 10) / 10, gainRaw: best.key[0] };
  }
  const newLine = (code, name, start, board = null) => ({ chain: [{ code, name, start, board }], rounds: [], hLimits: 0, lastRound: idx.get(start) });
  function signal(line, i, allowStall) {
    const hc = line.chain.at(-1).code, d = D[i];
    if (lim(hc, d) || line.hLimits < 2 || (feat[d].down ?? 0) >= prm.PANIC_DOWN) return null;
    const b = bar(hc, i);
    if (!b) return null;
    if (b.amp >= prm.SHAKE_AMP && b.fromHigh <= -prm.SHAKE_FROM_HIGH) return '巨震';
    if (b.chg <= prm.DROP) return '大跌';
    if (allowStall && b.chg < prm.STALL && !lim(hc, D[i - 1])) return '滞涨';
    return null;
  }
  function inTheme(s, board) {
    const si = idx.get(s.start);
    for (let j = si; j < Math.min(D.length, si + s.len); j++) if ((P[D[j]]?.[s.code]?.[1] ?? []).includes(board)) return true;
    return false;
  }
  function successor(line, i, used, board = null) {
    const hc = line.chain.at(-1).code, isHead = line.chain.length === 1;
    const cands = [];
    for (const s of (board ? ST : STRONG)) {
      const si = idx.get(s.start);
      if (!(i <= si && si < i + prm.WIN) || used.has(s.code)) continue;
      if (board && (s.strength < prm.STRENGTH_RES || !inTheme(s, board))) continue;
      if (!isHead) { let held = false; for (let j = si; j < Math.min(D.length, si + prm.HOLD); j++) if (lim(hc, D[j])) { held = true; break; } if (held) continue; }
      cands.push(s);
    }
    cands.sort((a, b) => idx.get(a.start) - idx.get(b.start) || b.strength - a.strength || cmp(a.code, b.code));
    return cands[0] ?? null;
  }
  function resonance(i, L) {
    const fam = familyOfTheme(L.board);
    for (let j = i; j < Math.min(D.length, i + prm.RES_LOOK + 1); j++) {
      const f = feat[D[j]];
      if (f && String(f.state).startsWith('大主升') && f.lead === fam) return true;
    }
    return false;
  }
  const trig = f => ['震荡', '筑底'].includes(f.state) && f.hExpand === true && f.down !== null && f.down !== undefined && f.down <= 15 && (f.lad3 ?? 0) >= 3;
  const fresh = (d, L, i) => ({ start: d, leader: L, resonance: resonance(i, L), main: newLine(L.code, L.name, d, L.board), comp: null, rebound: null, end: null });

  const cycles = []; let cur = null;
  for (let i = 0; i < D.length; i++) {
    const d = D[i], f = feat[d];
    if (!f || !P[d]) continue;   // 缺当日涨停池：不处理（缺失 ≠ 未涨停）
    if (!cur) {
      if (startAfter && d <= startAfter) continue;   // 之前的周期由复盘时间线给出
      const L = trig(f) ? leaderAt(i) : null;
      if (L) cur = fresh(d, L, i);
      continue;
    }
    if (!cur.main.rounds.length && trig(f)) {
      const L2 = leaderAt(i), L1 = cur.leader;
      if (L2 && L2.code !== L1.code && L2.drive * L2.gainRaw > L1.drive * L1.gainRaw) { cur = fresh(d, L2, i); continue; }
    }
    const M = cur.main, Lc = cur.leader.code;
    const used = new Set(); for (const ln of [M, cur.comp]) if (ln) for (const x of ln.chain) used.add(x.code);
    if (i - idx.get(cur.start) <= prm.VOID && f.event === '转入主跌') {
      Object.assign(cur, { end: d, endReason: '启动后 5 日内指数转入主跌，情绪试探', voided: true }); cycles.push(cur); cur = null; continue;
    }
    if (!cur.comp && (lim(Lc, d) || lim(Lc, D[i - 1]))) {
      for (const s of (cur.resonance ? ST : STRONG)) {
        if (s.start === d && !used.has(s.code) && (!cur.resonance || (s.strength >= prm.STRENGTH_RES && inTheme(s, cur.leader.board)))) {
          cur.comp = newLine(s.code, s.name, d, s.themes.length ? s.themes[0][0] : null); used.add(s.code); break;
        }
      }
    }
    for (const ln of [M, cur.comp]) if (ln && lim(ln.chain.at(-1).code, d)) ln.hLimits++;
    if (M.rounds.length && !cur.rebound && lim(Lc, d)) {
      let last = -1; for (let j = idx.get(cur.start); j < i; j++) if (lim(Lc, D[j])) last = j;
      if (last < 0 || i - last >= prm.REBOUND_GAP) cur.rebound = d;
    }
    if (cur.rebound && !lim(M.chain.at(-1).code, d)) { Object.assign(cur, { end: d, endReason: '龙头反抽，周期结束' }); cycles.push(cur); cur = null; continue; }
    if (i - M.lastRound > prm.IDLE_MAX || i - idx.get(cur.start) > prm.CYCLE_MAX) {
      Object.assign(cur, { end: d, endReason: i - M.lastRound > prm.IDLE_MAX ? '高标断档，周期自然结束' : `周期满 ${prm.CYCLE_MAX} 日` });
      cycles.push(cur); cur = null; continue;
    }
    for (const [ln, isComp] of [[cur.comp, true], [M, false]]) {
      if (!ln) continue;
      const sig = signal(ln, i, isComp || ln.chain.length === 1);
      if (!sig) continue;
      if (!isComp && ln.chain.length === 1 && !cur.leaderTop) cur.leaderTop = { date: d, signal: sig };   // 龙头首次见顶信号：情绪仓位由半仓转观望
      const s = successor(ln, i, used, cur.resonance ? cur.leader.board : null);
      if (!s) continue;
      const old = ln.chain.at(-1);
      ln.rounds.push({ round: ln.rounds.length + 1, start: s.start, code: s.code, name: s.name, board: s.themes.length ? s.themes[0][0] : null, topOf: old.name, topDate: d, signal: sig });
      ln.chain.push({ code: s.code, name: s.name, start: s.start });
      ln.lastRound = idx.get(s.start); ln.hLimits = 0; used.add(s.code);
    }
  }
  if (cur) cycles.push(cur);
  return { cycles, missing, stale };
}

/**
 * 情绪提醒事件（纯函数）。known：{key: 首次识别日}，跨日持久化；返回本次应提醒的事件与更新后的 known。
 * - 周期启动、补涨/伴生接力：以「首次识别日 = 今天」为准（历史归属日可能早于今天，如龙头需后几日确认），同一天的预警和确认都会发；
 * - 只提醒种子日期之后的事件（更早的属于复盘历史）。
 */
export function emoAlertEvents({ active, last, hints = [] }, today, known = {}, seedThrough = '') {
  const k = { ...known }, evs = [];
  const firstSeen = key => { if (!k[key]) k[key] = today; return k[key] === today; };
  const a = active, c = active ?? last;
  if (a && a.start > seedThrough && firstSeen(`C|${a.start}|${a.leader.code}`))
    evs.push(['情绪主升', `情绪周期启动${a.start === today ? '' : `（自 ${a.start.slice(5)} 起）`}：龙头 ${a.leader.name}（${labelBoard(a.leader.board)}）打开高度。按规则情绪仓位半仓，龙头出现见顶信号即转观望；补涨不参与。`]);
  if (a?.leaderTop && a.leaderTop.date > seedThrough && firstSeen(`T|${a.start}|${a.leaderTop.date}`))
    evs.push(['龙头见顶', `龙头 ${a.leader.name} ${a.leaderTop.date === today ? '今日' : a.leaderTop.date.slice(5)} ${a.leaderTop.signal}：按规则情绪仓位由半仓转观望。`]);
  if (a) for (const ln of [a.main, a.comp]) for (const rd of ln?.rounds ?? []) {
    const isMain = ln === a.main;
    if (rd.topDate <= seedThrough || !firstSeen(`R|${a.start}|${isMain ? 'M' : 'C'}|${rd.round}|${rd.code}`)) continue;
    evs.push([isMain ? `第${rd.round}轮补涨` : '伴生线接力', `${rd.topOf} ${rd.signal}，新高标 ${rd.name}（${rd.board ?? '—'}）自 ${rd.start.slice(5)} 起接力。${isMain ? '补涨按规则观望。' : ''}`]);
  }
  if (c?.end === today && !c.voided) evs.push(['情绪退潮', `情绪周期结束（${c.endReason}）：按规则清掉情绪仓位，退潮期不开仓。`]);
  for (const h of hints) {
    if (h.kind === '高标见顶') evs.push(h.isLeader ? ['龙头见顶', `龙头 ${h.name} 今日盘中${h.signal}：收盘仍成立则情绪仓位由半仓转观望。`]
      : [`${h.line}高标见顶`, `${h.line}高标 ${h.name} 今日${h.signal}：留意新一轮补涨启动（今日首板：${h.firsts.join('、') || '—'}）。`]);
    if (h.kind === '龙头反抽') evs.push(['龙头反抽', `龙头 ${h.name} 反抽涨停：周期进入末段，当前高标断板即退潮。`]);
  }
  return { events: evs, known: k };
}

/** 情绪线仓位档位（2026-10-19 按回测改）：情绪主升半仓，龙头出现首次见顶信号（巨震/大跌/滞涨）即转观望；补涨不参与（观望）；其余空仓。
 * 回测见 研究/过渡期回测.md：机械执行原档位（第 1 轮补涨轻仓）亏损，改为龙头见顶即走后与指数线合并 +29.7% → +49.4%。 */
export const cyclePosition = (phase, topped = false) => (phase === '情绪主升' ? (topped ? '观望' : '半仓') : /补涨$/.test(phase) ? '观望' : '空仓');

/** 把周期列表展开成逐段时间线（情绪主升 → 第 N 轮补涨 → 退潮），供界面与提醒使用 */
export function cycleSegments(cycles, lastDate) {
  const segs = [];
  for (const c of cycles) {
    const marks = [{ start: c.start, phase: c.voided ? '情绪试探' : '情绪主升', leader: c.leader.name, board: c.leader.board, leaderTop: c.leaderTop ?? null }];
    for (const r of c.main.rounds) marks.push({ start: r.start, phase: `第${r.round}轮补涨`, leader: r.name, board: r.board, topOf: r.topOf, signal: r.signal, topDate: r.topDate });
    marks.forEach((m, k) => {
      const next = marks[k + 1];
      segs.push({ ...m, end: next ? next.start : (c.end ?? lastDate), cycleStart: c.start, cycleLeader: c.leader.name, cycleBoard: c.leader.board,
        resonance: !!c.resonance, voided: !!c.voided, comp: compAt(c, next ? next.start : (c.end ?? lastDate)), open: !next && !c.end });
    });
    if (c.end && !c.voided) segs.push({ start: c.end, end: nextStart(cycles, c), phase: '退潮', leader: c.leader.name, board: c.leader.board, reason: c.endReason, cycleStart: c.start, cycleLeader: c.leader.name });
  }
  return segs;
}
function nextStart(cycles, c) {
  const k = cycles.indexOf(c);
  return cycles[k + 1]?.start ?? null;
}
function compAt(c, date) {
  if (!c.comp) return null;
  const chain = c.comp.chain.filter(x => x.start <= date);
  return chain.length ? chain.map(x => x.name) : null;
}
