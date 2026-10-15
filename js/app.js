/**
 * 页面调度：每分钟一轮（上一轮未结束则跳过），取实时数据 → 拼接到历史 → 状态机试算 → 渲染 → 网页内提醒。
 * 原则：数据缺失就显示「未知」，不把缺失当成震荡，也不触发提醒。
 */
import ds from './datasource.js?v=20261016d';
import { replay, wilderRSI, FAMILIES, PARAMS, POSITION, PREFERENCE_EXCLUDED, alertLevelAt, alertKey, themeTop } from './engine.js?v=20261016d';
import { cycleReplay, cycleSegments, cyclePosition, CYCLE_PARAMS, FAMILY_LABEL, labelBoard, splitThemes } from './cycle.js?v=20261016d';
import { decodePools, decodeKline, featFromRows } from './seedpools.js?v=20261016d';

const TICK_MS = 60000;
const BOARDS_PER_TICK = 8;
const STORE = 'ashare-market-state.v1';
const $ = sel => document.querySelector(sel);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const fmtPct = (v, d = 2) => isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}%` : '—';
const fmtYi = v => isNum(v) ? (v >= 1e12 ? `${(v / 1e12).toFixed(2)} 万亿` : `${(v / 1e8).toFixed(1)} 亿`) : '—';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  seed: null, etfMap: null, sourceMap: null,
  indexDaily: null,          // { sh000001: rows, sz399001: rows, sh000985: rows }（已完成日）
  today: { quotes: null, turnover: null, pools: {}, breadth: null, boards: {}, top: null, wide: null, themes: null },
  stockK: {}, kQueue: new Set(), emo: null,
  calendar: null, tick: 0, busy: false, boardCursor: 0, result: null, lastError: null, lastTickAt: null,
  extra: null,               // 种子之后的已完成日补数：{ boards:{code:{date:close}}, limits:{date:{...}} }，缓存在浏览器
  backfill: { missing: [], boardsDone: 0, limitsDone: 0, complete: true },
};

function load(key, fallback) { try { return JSON.parse(localStorage.getItem(`${STORE}.${key}`)) ?? fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(`${STORE}.${key}`, JSON.stringify(value)); } catch { /* 存储不可用时只影响提醒去重 */ } }

async function staticJSON(name) {
  const res = await fetch(new URL(`../data/${name}`, import.meta.url), { credentials: 'omit', cache: 'no-cache' });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  return res.json();
}

/* ---------------- 历史拼装 ---------------- */

/** 以种子为底，指数用实时日 K（已完成日）覆盖/延长；种子之后的板块与涨跌停用页面补数（S.extra）。 */
function buildHistory() {
  const seed = S.seed; if (!seed) return null;
  const dates = [...seed.dates];
  const sh = { close: [...seed.index.sh000001.close], high: [...seed.index.sh000001.high], low: [...seed.index.sh000001.low] };
  const amt = [...seed.index.amount], c985 = [...seed.index.sh000985.close];
  const limits = Object.fromEntries(Object.entries(seed.limits).map(([k, v]) => [k, [...v]]));
  if (!limits.theme) limits.theme = dates.map(() => null);
  const themeName = seed.limitThemeName ? [...seed.limitThemeName] : dates.map(() => null);
  const boards = Object.fromEntries(Object.entries(seed.boards).map(([c, b]) => [c, { close: [...b.close] }]));
  const today = S.calendar?.date;
  const d = S.indexDaily;
  if (d?.sh000001 && d?.sz399001 && d?.sh000985) {
    const by = rows => Object.fromEntries(rows.filter(r => r.date < today).map(r => [r.date, r]));
    const a = by(d.sh000001), b = by(d.sz399001), c = by(d.sh000985);
    for (const date of Object.keys(a).sort()) {
      if (!b[date] || !c[date]) continue;
      let i = dates.indexOf(date);
      if (i < 0) {
        if (date < dates.at(-1)) continue;          // 种子窗口以前的日子不插入
        dates.push(date); i = dates.length - 1;
        sh.close.push(null); sh.high.push(null); sh.low.push(null); amt.push(null); c985.push(null);
        for (const k of Object.keys(limits)) limits[k].push(null);
        themeName.push(null);
        for (const bd of Object.values(boards)) bd.close.push(null);
      }
      sh.close[i] = a[date].close; sh.high[i] = a[date].high; sh.low[i] = a[date].low;
      amt[i] = a[date].amount + b[date].amount; c985[i] = c[date].close;
      if (date > seed.through) {
        const lim = S.extra?.limits?.[date];
        if (lim) { for (const k of Object.keys(limits)) limits[k][i] = isNum(lim[k]) ? lim[k] : null; themeName[i] = lim.themeName ?? null; }
        for (const [code, bd] of Object.entries(boards)) { const v = S.extra?.boards?.[code]?.[date]; bd.close[i] = isNum(v) ? v : null; }
      }
    }
  }
  limits.themeName = themeName;   // 非数值序列，单独挂载
  return { dates, sh, amt, c985, limits, boards, seedThrough: seed.through };
}

/** 在历史末尾追加「今天」（盘中试算行）。缺失项为 null。 */
function withToday(H) {
  const t = S.today, date = S.calendar?.date;
  const q = t.quotes?.ok ? t.quotes.rows : null;
  const shq = q?.find(r => r.symbol === 'sh000001'), q985 = q?.find(r => r.symbol === 'sh000985');
  if (!shq || shq.sourceDate !== date) return { H: { ...H, rsi: wilderRSI(H.c985, 12) }, todayAppended: false };
  // 全天量能：盘中用预估；午休或报价暂时不新鲜时沿用当日最后一次预估；15:00 后用来源报告的累计额；否则未知
  const tv = t.turnover;
  if (tv?.ok && tv.estimated && isNum(tv.projectedFullDay)) t.lastProjected = { date, value: tv.projectedFullDay };
  let amtToday = null; t.amtSource = null;
  if (tv?.ok && tv.estimated && isNum(tv.projectedFullDay)) { amtToday = tv.projectedFullDay; t.amtSource = '全天预估'; }
  else if (tv?.ok && tv.phase === 'reported-observation-only' && tv.sourceDate === date && isNum(tv.cumulativeAmount)) { amtToday = tv.cumulativeAmount; t.amtSource = '收盘成交额'; }
  else if (t.lastProjected?.date === date) { amtToday = t.lastProjected.value; t.amtSource = '全天预估·沿用'; }
  const pools = t.pools[date] ?? {};
  const up = pools.up, down = pools.down, broken = pools.broken;
  const lbc = up?.rows?.map(r => r.consecutiveLimitUps).filter(isNum) ?? [];
  const boards = {};
  for (const [c, b] of Object.entries(H.boards)) {
    const live = t.boards[c];
    boards[c] = { close: [...b.close, live && live.sourceDate === date ? live.close : null] };
  }
  const c985 = [...H.c985, q985?.sourceDate === date ? q985.price : null];
  const out = {
    dates: [...H.dates, date],
    sh: { close: [...H.sh.close, shq.price], high: [...H.sh.high, shq.high ?? shq.price], low: [...H.sh.low, shq.low ?? shq.price] },
    amt: [...H.amt, amtToday], c985,
    limits: {
      up: [...H.limits.up, up ? up.count : null], down: [...H.limits.down, down ? down.count : null],
      broken: [...H.limits.broken, broken ? broken.count : null],
      height: [...H.limits.height, up ? (lbc.length ? Math.max(...lbc) : 0) : null],
      lad3: [...H.limits.lad3, up ? lbc.filter(v => v >= 3).length : null],
      theme: [...H.limits.theme, t.themes?.date === date ? t.themes.top.count : null],
      themeName: [...H.limits.themeName, t.themes?.date === date ? t.themes.top.name : null],
    },
    boards,
  };
  out.rsi = wilderRSI(out.c985, 12);
  return { H: out, todayAppended: true };
}

/* ---------------- 数据轮 ---------------- */

const ALL_BOARDS = Object.values(FAMILIES).flat();

async function ordinaryRound() {
  const date = S.calendar.date;
  const q = await ds.getIndexQuotes(); if (q.ok || !S.today.quotes) S.today.quotes = q;
  const tv = await ds.getProjectedTurnover(); if (tv.ok || !S.today.turnover) S.today.turnover = tv;
  // 东财每分钟 3 次：涨停、跌停、炸板；每 3 轮把炸板换成涨跌分布
  const kinds = S.tick % 3 === 2 ? ['up', 'down'] : ['up', 'down', 'broken'];
  const pools = await ds.getLimitPools({ date, kinds });
  const store = S.today.pools[date] ?? (S.today.pools = { [date]: {} })[date];
  for (const [k, v] of Object.entries(pools.pools ?? {})) if (v?.ok) store[k] = v;
  if (S.tick % 3 === 2) { const b = await ds.getMarketBreadth(); if (b.ok) S.today.breadth = b; }
  // 同花顺涨停池：题材集中度（板块效应）与情绪龙头
  const th = await ds.getTHSLimitThemes(date);
  if (th.ok) S.today.themes = { date, rows: th.rows, top: themeTop(th.rows.map(r => r.reasonText)) };
  // 同花顺板块轮询
  const n = ALL_BOARDS.length, pick = [];
  for (let k = 0; k < BOARDS_PER_TICK; k++) pick.push(ALL_BOARDS[(S.boardCursor + k) % n]);
  S.boardCursor = (S.boardCursor + BOARDS_PER_TICK) % n;
  const tb = await ds.getTHSBoardToday([...new Set(pick)]);
  for (const r of tb.rows ?? []) S.today.boards[r.code] = r;
  // 成交额前列（领涨集团）：主升状态每轮，其余每 3 轮
  const st = S.result?.final?.state ?? '';
  if (st.startsWith('大主升') || S.emo?.active || S.tick % 3 === 0) { const top = await ds.getTopTurnover(20); if (top.ok) S.today.top = top; }
}

async function wideRound() {
  const tv = await ds.getProjectedTurnover(); if (tv.ok) S.today.turnover = tv;
  const w = await ds.getWideRangeCandidates({ minAmount: 5e8, n: 8 }); if (w.ok) S.today.wide = w;
}

/** 情绪周期需要的个股日 K（高标见顶判断）：每轮最多 4 只 */
async function klineRound() {
  const codes = [...S.kQueue].slice(0, 4);
  const r = await ds.getStockKline(codes, 80);
  for (const [c, bars] of Object.entries(r.rows ?? {})) { S.stockK[c] = { bars, at: S.calendar?.date, time: Date.now() }; S.kQueue.delete(c); }
  for (const f of r.failed ?? []) S.kQueue.delete(f.code);
}

/** 种子过期时补齐「种子之后、今天之前」的板块收盘与涨跌停统计。每轮限量，进度存浏览器，刷新页面不重复取。 */
function missingDates() {
  const rows = S.indexDaily?.sh000001 ?? [];
  return rows.map(r => r.date).filter(d => d > S.seed.through && d < S.calendar.date);
}
async function backfillRound() {
  const miss = missingDates();
  const ex = S.extra;
  // 板块：每次最多 6 个，本轮两批
  const needBoards = ALL_BOARDS.filter(c => miss.some(d => !isNum(ex.boards[c]?.[d])));
  for (let k = 0; k < 2 && needBoards.length; k++) {
    const chunk = needBoards.splice(0, 6);
    const r = await ds.getBoardRecentDaily(chunk.map(c => `ths:${c}`), Math.min(60, miss.length + 1));
    for (const g of r.groups ?? []) {
      if (!g.ok) continue;
      const code = String(g.requestedBoard).replace('ths:', '');
      ex.boards[code] = ex.boards[code] ?? {};
      for (const row of g.rows) if (miss.includes(row.date)) ex.boards[code][row.date] = row.close;
    }
  }
  // 涨跌停：每轮一个交易日（东财每分钟 3 次）
  const d = miss.find(x => !ex.limits[x]);
  if (d) {
    const p = await ds.getLimitPools({ date: d, kinds: ['up', 'down', 'broken'] });
    const up = p.pools?.up, dn = p.pools?.down, br = p.pools?.broken;
    if (up?.ok && dn?.ok && br?.ok) {
      const lbc = up.rows.map(r => r.consecutiveLimitUps).filter(isNum);
      const th = await ds.getTHSLimitThemes(d), tt = th.ok ? themeTop(th.rows.map(r => r.reasonText)) : null;
      if (th.ok) ex.pools[d] = th.rows.map(r => [r.code, r.name, r.reasonText]);
      ex.limits[d] = { up: up.count, down: dn.count, broken: br.count, height: lbc.length ? Math.max(...lbc) : 0, lad3: lbc.filter(v => v >= 3).length, theme: tt?.count ?? null, themeName: tt?.name ?? null };
    }
  }
  for (const c of Object.keys(ex.boards)) for (const day of Object.keys(ex.boards[c])) if (day <= S.seed.through) delete ex.boards[c][day];
  for (const day of Object.keys(ex.limits)) if (day <= S.seed.through) delete ex.limits[day];
  for (const day of Object.keys(ex.pools ?? {})) if (day <= S.seed.through) delete ex.pools[day];
  save('extra', ex);
  updateBackfill();
}
function updateBackfill() {
  const miss = missingDates(), ex = S.extra;
  const boardsDone = ALL_BOARDS.filter(c => miss.every(d => isNum(ex.boards[c]?.[d]))).length;
  const limitsDone = miss.filter(d => ex.limits[d]).length;
  S.backfill = { missing: miss, boardsDone, limitsDone, complete: !miss.length || (boardsDone === ALL_BOARDS.length && limitsDone === miss.length), tooOld: miss.length > 55 };
}

async function warmup() {
  if (!S.seed) S.seed = await staticJSON('market_seed.json');
  if (!S.timeline) S.timeline = await staticJSON('regime_timeline.json').catch(() => null);
  if (!S.etfMap) S.etfMap = await staticJSON('board_etf_map.json').catch(() => null);
  if (!S.sourceMap) S.sourceMap = await staticJSON('board_source_map.json').catch(() => null);
  if (!S.indexDaily || S.indexDaily.date !== S.calendar.date) {
    const d = { date: S.calendar.date };
    for (const symbol of ['sh000001', 'sz399001', 'sh000985']) {
      const r = await ds.getIndexDaily({ symbol, count: 160 });
      if (!r.ok) throw new Error(`${symbol} 日K：${r.reason}`);
      d[symbol] = r.rows;
    }
    S.indexDaily = d;
  }
  if (!S.seedPools) { S.seedPools = decodePools(S.seed.limitPools); S.seedK = decodeKline(S.seed.cycleKline, S.seed.dates); }
  if (!S.extra) S.extra = load('extra', { boards: {}, limits: {} });
  if (!S.extra.pools) S.extra.pools = {};
  updateBackfill();
}

async function tick() {
  if (S.busy) return;
  S.busy = true;
  try {
    S.calendar = await ds.getTradingCalendar();
    ds.beginRefresh();
    const needWarm = !S.seed || !S.indexDaily || S.indexDaily.date !== S.calendar.date;
    if (needWarm) await warmup();
    // 种子过期时先补数（最多 20 轮；补不齐的日期按缺失显示，不估算）
    if (!needWarm && !S.backfill.complete && !S.backfill.tooOld && (S.backfill.attempts ?? 0) <= 20) {
      S.backfill.attempts = (S.backfill.attempts ?? 0) + 1;
      const q = await ds.getIndexQuotes(); if (q.ok || !S.today.quotes) S.today.quotes = q;
      const tv = await ds.getProjectedTurnover(); if (tv.ok || !S.today.turnover) S.today.turnover = tv;
      const attempts = S.backfill.attempts; await backfillRound(); S.backfill.attempts = attempts;
    } else if (!needWarm && (S.calendar.refreshRecommended || !S.today.quotes)) {
      const st = S.result?.final?.state;
      if (S.tick % 5 === 4 && (st === '震荡' || st === '筑底') && S.calendar.isTradingDay) await wideRound();
      else await ordinaryRound();
      S.tick++;
    }
    if (!needWarm && S.kQueue.size) await klineRound();
    S.lastError = null;
  } catch (e) { S.lastError = String(e.message ?? e); }
  finally {
    S.lastTickAt = new Date();
    try { evaluate(); } catch (e) { S.lastError = `判定失败：${e.message}`; }
    render();
    S.busy = false;
  }
}

/* ---------------- 判定与提醒 ---------------- */

function evaluate() {
  const base = buildHistory(); if (!base) return;
  const { H, todayAppended } = withToday(base);
  const out = replay(H, PARAMS);
  const confirmedRows = todayAppended ? out.rows.slice(0, -1) : out.rows;
  const since = sinceDate(out.rows);
  S.result = { ...out, todayAppended, H, yesterday: confirmedRows.at(-1), stateSince: since, stateDays: since ? out.rows.filter(r => r.date >= since).length : null };
  try { evaluateEmotion(H, out.rows); } catch (e) { S.emo = { error: String(e.message ?? e) }; }
  maybeAlert();
  maybeEmoAlert();
}
/** 情绪线：种子窗口 + 补数日 + 今日涨停池回放情绪周期；种子日期之前的周期以复盘时间线为准 */
function evaluateEmotion(H, rows) {
  const dates = H.dates, today = S.calendar?.date, through = S.seed.through;
  const pools = {};
  for (const d of dates) {
    if (d <= through) { if (S.seedPools[d]) pools[d] = S.seedPools[d]; continue; }
    const raw = d === today ? (S.today.themes?.date === today ? S.today.themes.rows.map(r => [r.code, r.name, r.reasonText]) : null) : S.extra.pools?.[d];
    if (raw) pools[d] = Object.fromEntries(raw.map(([c, n, t]) => [c, [n, splitThemes(t)]]));
  }
  const kline = c => {
    const a = S.seedK[c], b = S.stockK[c]?.bars;
    return a || b ? { ...(a ?? {}), ...(b ?? {}) } : null;
  };
  const startAfter = S.seed.cycleStartAfter ?? null;
  const { cycles: live, missing } = cycleReplay({ dates, pools, kline, feat: featFromRows(rows), startAfter });
  const fixed = (S.timeline?.cycles ?? []).filter(c => !startAfter || c.start <= startAfter);
  const all = [...fixed, ...live];
  const last = all.at(-1), lastDate = dates.at(-1);
  const active = last && !last.end ? last : null;
  // 需要最新日 K 的个股：周期回放缺失的 + 活跃周期的当前高标（种子之后的交易日）
  for (const c of missing) S.kQueue.add(c);
  if (active) for (const ln of [active.main, active.comp]) if (ln) {
    const c = ln.chain.at(-1).code, have = S.stockK[c];
    if (lastDate > through && (!have || have.at !== today || (S.calendar?.refreshRecommended && Date.now() - have.time > 5 * 60000))) S.kQueue.add(c);
  }
  let phase = '无情绪周期', since = null;
  if (active) { const n = active.main.rounds.length; phase = n ? `第${n}轮补涨` : '情绪主升'; since = n ? active.main.rounds.at(-1).start : active.start; }
  else if (last?.end && !last.voided) {
    const k = dates.indexOf(last.end);
    if (k >= 0 && dates.length - 1 - k <= 10) { phase = '退潮'; since = last.end; }
  }
  // 今日盘中信号（预警）：当前高标见顶、龙头反抽
  const hints = [];
  if (active && S.result.todayAppended) {
    const P = CYCLE_PARAMS, todayPool = pools[today] ?? {};
    for (const [ln, nm] of [[active.main, '主线'], [active.comp, '伴生线']]) {
      if (!ln) continue;
      const h = ln.chain.at(-1), bars = kline(h.code), i = dates.length - 1;
      const r = bars?.[dates[i]], p = bars?.[dates[i - 1]];
      if (!r || !p || todayPool[h.code]) continue;
      const chg = (r.close / p.close - 1) * 100, amp = (r.high - r.low) / p.close * 100, fh = (r.close / r.high - 1) * 100;
      const sig = amp >= P.SHAKE_AMP && fh <= -P.SHAKE_FROM_HIGH ? '巨震' : chg <= P.DROP ? '大跌' : (nm === '伴生线' || ln.chain.length === 1) && chg < P.STALL && !pools[dates[i - 1]]?.[h.code] ? '滞涨' : null;
      if (sig) hints.push({ kind: '高标见顶', line: nm, name: h.name, signal: sig, firsts: Object.entries(todayPool).filter(([c]) => !ln.chain.some(x => x.code === c)).slice(0, 4).map(([, v]) => v[0]) });
    }
    if (active.main.rounds.length && todayPool[active.leader.code]) hints.push({ kind: '龙头反抽', name: active.leader.name });
  }
  S.emo = { cycles: all, active, last, phase, since, position: cyclePosition(phase), hints, lastDate };
}

function sinceDate(rows) {
  const last = rows.at(-1); if (!last) return null;
  for (let k = rows.length - 1; k >= 0; k--) if (rows[k].state !== last.state) return rows[k + 1]?.date ?? null;
  return rows[0].date;
}

function phaseInfo() {
  const c = S.calendar; if (!c?.ok) return { label: '日历未知', alertLevel: null };
  const t = c.time.slice(0, 5);
  if (!c.isTradingDay) return { label: '休市', alertLevel: null };
  if (t < '09:30') return { label: '盘前', alertLevel: null };
  if (t < '10:30') return { label: '观察期（10:30 后开始预警）', alertLevel: null };
  if (t >= '11:30' && t < '13:00') return { label: '午间休市', alertLevel: null };
  if (t >= '15:00') return { label: '收盘 · 定格', alertLevel: null };
  const level = alertLevelAt(t, c.isTradingDay);
  return { label: level === '确认' ? '尾盘 · 确认' : '盘中 · 预警', alertLevel: level };
}

const EVENT_TEXT = {
  '共振爆发': lead => `共振爆发：主线族群「${lead}」。按规则：可快速提升至重仓（1–2 笔），优先领涨集团或对应 ETF${PREFERENCE_EXCLUDED.includes(lead) ? '（该族群为偏好不参与）' : ''}。`,
  '风险降仓': () => '风险信号叠加：按规则降至半仓。',
  '破位清仓': () => '主线破位：按规则清仓观望。',
  '转入主跌': () => '指数转入主跌：按规则空仓，不抄底。',
  '主跌结束（企稳）': () => '指数站上 5 日线，主跌暂告段落：转入筑底，继续空仓等待共振。',
  '主线切换': lead => `主线切换至「${lead}」：按规则调仓，仓位不变。`,
};

function eventText(ev, lead) {
  return (EVENT_TEXT[ev] ?? (() => ev))(lead);
}

function maybeAlert() {
  const r = S.result, f = r?.final; if (!r?.todayAppended || !f?.event) return;
  const p = phaseInfo();
  const fired = load('fired', {});
  const key = alertKey(f, p.alertLevel, fired); if (!key) return;
  fired[key] = Date.now();
  for (const k of Object.keys(fired)) if (!k.startsWith(f.date)) delete fired[k];
  save('fired', fired);
  const text = eventText(f.event, f.leadShown);
  const log = load(`log.${f.date}`, []); log.unshift({ at: new Date().toISOString(), level: p.alertLevel, event: f.event, text }); save(`log.${f.date}`, log.slice(0, 30));
  notify(`【${p.alertLevel}】${f.event}`, text);
}

function maybeEmoAlert() {
  const e = S.emo, r = S.result, today = S.calendar?.date;
  if (!e?.cycles || !r?.todayAppended) return;
  const p = phaseInfo(); if (!p.alertLevel) return;
  const evs = [];
  const a = e.active, c = a ?? e.last;
  if (a && a.start === today) evs.push(['情绪主升', `情绪周期启动：龙头 ${a.leader.name}（${labelBoard(a.leader.board)}）打开高度。按规则情绪仓位半仓，只参与龙头与第一轮补涨。`]);
  if (a) for (const ln of [a.main, a.comp]) for (const rd of ln?.rounds ?? []) {
    const known = load('emoRounds', {}), key = `${a.start}|${ln === a.main ? 'M' : 'C'}|${rd.round}|${rd.code}`;
    if (known[key]) continue;
    known[key] = today; save('emoRounds', known);
    if (rd.topDate > (S.seed.through ?? '')) evs.push([ln === a.main ? `第${rd.round}轮补涨` : '伴生线接力', `${rd.topOf} ${rd.signal}，新高标 ${rd.name}（${rd.board ?? '—'}）自 ${rd.start.slice(5)} 起接力。${ln === a.main ? (rd.round === 1 ? '按规则第一轮补涨轻仓。' : '第二轮及以后补涨按规则观望。') : ''}`]);
  }
  if (c?.end === today && !c.voided) evs.push(['情绪退潮', `情绪周期结束（${c.endReason}）：按规则清掉情绪仓位，退潮期不开仓。`]);
  for (const h of e.hints) {
    if (h.kind === '高标见顶') evs.push([`${h.line}高标见顶`, `${h.line}高标 ${h.name} 今日${h.signal}：留意新一轮补涨启动（今日首板：${h.firsts.join('、') || '—'}）。`]);
    if (h.kind === '龙头反抽') evs.push(['龙头反抽', `龙头 ${h.name} 反抽涨停：周期进入末段，当前高标断板即退潮。`]);
  }
  const fired = load('fired', {});
  for (const [ev, text] of evs) {
    const key = `${today}|情绪|${ev}|${p.alertLevel}`;
    if (fired[key]) continue;
    fired[key] = Date.now(); save('fired', fired);
    const log = load(`log.${today}`, []); log.unshift({ at: new Date().toISOString(), level: p.alertLevel, event: `情绪：${ev}`, text }); save(`log.${today}`, log.slice(0, 30));
    notify(`【${p.alertLevel}】情绪：${ev}`, text);
  }
}

let flashTimer = null;
function notify(title, body) {
  try { if (load('alertsOn', false) && 'Notification' in window && Notification.permission === 'granted') new Notification(title, { body }); } catch { /* 忽略 */ }
  clearInterval(flashTimer); let n = 0; const orig = 'A股市场状态';
  flashTimer = setInterval(() => { document.title = n++ % 2 ? orig : `【提醒】${title}`; if (n > 30) { clearInterval(flashTimer); document.title = orig; } }, 1000);
  showToast(title, body);
}
function showToast(title, body) {
  const el = $('#toast');
  // 手机端：右上角 ×；PC 端：保留「知道了」按钮（两个按钮由 CSS 按屏宽只显示其一）
  el.innerHTML = `<button type="button" class="toast-x" aria-label="关闭">×</button><strong title="${esc(title)}">${esc(title)}</strong><p title="${esc(body)}">${esc(body)}</p><button type="button" class="toast-ok" aria-label="关闭">知道了</button>`;
  el.hidden = false; el.querySelectorAll('.toast-x,.toast-ok').forEach(b => { b.onclick = () => { el.hidden = true; }; });
}

/* ---------------- 渲染 ---------------- */

const APP_VERSION = '2026.10.16d';
const STAGE_META = {
  '大主升': { cls: 'up', name: '大主升', sub: '机构或情绪趋势，与指数共振' },
  '大主升-减仓': { cls: 'up', name: '大主升', sub: '主线仍在，风险信号叠加' },
  '震荡': { cls: 'flat', name: '震荡', sub: '无主线，轮动混沌' },
  '筑底': { cls: 'flat', name: '筑底', sub: '主跌结束，震荡等待共振' },
  '主跌': { cls: 'down', name: '主跌', sub: '领跌板块带动指数下行' },
};
const ACTION = {
  '大主升': '按规则：可参与，重仓；首次分歧时加仓',
  '大主升-减仓': '按规则：降至半仓，破位即清仓',
  '震荡': '按规则：观望（空仓），或小仓套利',
  '筑底': '按规则：观望（空仓），不抄底，等待共振',
  '主跌': '按规则：观望（空仓），不抄底',
};
const F1_STEPS = ['超跌', '首次反弹', '二次探底', '再站均线'];
const cls3 = v => (v === true ? 'y' : v === false ? 'n' : 'u');
const sign = v => (isNum(v) ? (v > 0 ? 'r' : v < 0 ? 'g' : '') : '');

/** 条件分组：每项 [状态, 完整名称, 短名称（手机标签）, 读数] */
function emoRead() {
  const e = S.emo; if (!e?.cycles) return '周期数据未就绪';
  const a = e.active;
  if (!a) return e.phase === '退潮' ? `退潮中（${e.last.leader.name} 周期 ${e.last.end.slice(5)} 结束）` : '无（多在指数震荡时出现）';
  const h = a.main.chain.at(-1), c = a.comp?.chain.at(-1);
  return `龙头 ${a.leader.name} · ${e.phase}${h.code !== a.leader.code ? `（高标 ${h.name}）` : ''}${c ? ` · 伴生 ${c.name}` : ''}`;
}
function condGroups(f) {
  const P = PARAMS, lead = f.leadShown, today = S.result.todayAppended;
  const volText = isNum(f.vr) ? `${fmtYi(f.amt)}${today && S.today.amtSource ? `（${S.today.amtSource}）` : ''}，${f.vr.toFixed(2)} 倍 20 日均量` : '量能未知';
  const famRead = isNum(f.f5?.[lead]) ? `${FAMILY_LABEL[lead] ?? lead} 近5日 ${fmtPct(f.f5[lead], 1)}，今日前6含 ${f.cnt}、5日前6含 ${f.cnt5}` : '板块数据未就绪';
  const syncRead = isNum(f.fT?.[lead]) && isNum(f.p1) ? `指数 ${fmtPct(f.p1)}，${lead} ${fmtPct(f.fT[lead])}` : '未知';
  const f1v = f.f1full ? true : f.f1part ? null : false;
  const holding = f.state.startsWith('大主升');
  const riskItem = (name, short, read) => [holding ? (f.risk.includes(name) ? true : f.riskUnknown.includes(name) ? null : false) : null, name, short, holding ? read : '仅在主升状态检查'];
  return [
    { key: 'res', title: '共振条件', items: [
      [f.A1, '指数站上 5 日线和 10 日线，5 日线上拐', '站上均线', isNum(f.close) ? `上证 ${f.close.toFixed(2)}，MA5 ${f.m5?.toFixed(2) ?? '—'}，MA10 ${f.m10?.toFixed(2) ?? '—'}` : '未知'],
      [isNum(f.vr) ? f.volOk === true : null, f.f1full ? `量能放大（≥ ${P.VR_UP} 倍）` : f.f1part ? `量能放大（未完成二次探底，需 ≥ ${P.VR_UP_SOFT} 倍）` : '量能放大（超跌后须先出现第一波反弹）', '量能放大', volText],
      [f.volVsDecline, '量能不低于此前下跌阶段', '量超下跌段', isNum(f.a60) ? `前 60 日均量 ${fmtYi(f.a60)}` : '60 日均量不足'],
      [f.collective, '主线族群集体走强', '主线集体走强', famRead],
      [f.sync, '主线与指数同步上涨', '主线同步', syncRead],
      [f1v, '已完成二次探底', '二次探底', f.f1 ? `进度：${F1_STEPS.slice(0, f.f1).join(' → ')}` : '近期未出现超跌'],
    ] },
    { key: 'down', title: '主跌条件', items: [
      [f.D1, '指数在 5 日线下，5 日线下拐', '破5日线', isNum(f.close) && isNum(f.m5) ? `上证 ${f.close.toFixed(2)}，MA5 ${f.m5.toFixed(2)}` : '未知'],
      [f.mainFall, '最弱族群仍在领跌', '弱族领跌', isNum(f.f5?.[f.weak]) ? `${f.weak} 近5日 ${fmtPct(f.f5[f.weak], 1)}，今日 ${fmtPct(f.fT[f.weak])}` : '未知'],
    ] },
    { key: 'emo', title: '情绪条件', items: [
      [f.hExpand, '连板高度拓展', '高度拓展', isNum(f.h) ? `最高 ${f.h} 板，前5日最高 ${f.hmax5 ?? '—'} 板` : '未知'],
      [f.noLoss, '无明显亏钱效应', '无亏钱效应', isNum(f.dn) ? `跌停 ${f.dn} 家（≤ ${P.LOSS_DOWN}）` : '跌停数未知'],
      [f.ladderOk, '连板梯队完整（排除独立妖股）', '梯队完整', isNum(f.lad3) ? `3 连板以上 ${f.lad3} 只` : '未知'],
      [S.emo?.active ? true : false, '情绪周期进行中', '情绪周期', emoRead()],
    ] },
    { key: 'risk', title: '风险信号', items: [
      riskItem('指数放量滞涨', '放量滞涨', isNum(f.vr) ? `量比 ${f.vr.toFixed(2)}，涨跌 ${fmtPct(f.p1)}` : '—'),
      riskItem('指数顶背离', '顶背离', isNum(f.rsi) ? `全指 RSI12 ${f.rsi.toFixed(1)}` : '—'),
      riskItem('主线族巨震', '主线巨震', `${lead} 今日 ${fmtPct(f.fT?.[lead])}`),
      riskItem('主线族连续2日跌破5日线', '主线破5日线', `${lead}`),
      riskItem('跌停扩散', '跌停扩散', `跌停 ${f.dn ?? '—'} 家`),
    ] },
    { key: 'ref', title: '参考', items: [
      [f.panic, '恐慌盘出现（见底区提示）', '恐慌盘', isNum(f.dn) && isNum(f.rsi) ? `跌停 ${f.dn} 家，全指 RSI12 ${f.rsi.toFixed(1)}` : '未知'],
      [isNum(f.rsi) ? f.rsi < 30 : null, '指数超跌', '指数超跌', isNum(f.rsi) ? `中证全指 RSI12 ${f.rsi.toFixed(1)}（${rsiZone(f.rsi)}${isNum(rsiStreak()) ? ` 连续 ${rsiStreak()} 天` : ''}；<30 超跌，>70 超买）` : '未知'],
      [isNum(f.brokenRate) ? f.brokenRate >= P.EXIT_BROKEN_RATE : null, '炸板率 ≥ 50%（情绪退潮）', '炸板≥50%', isNum(f.brokenRate) ? `炸板率 ${(f.brokenRate * 100).toFixed(0)}%` : '未知'],
    ] },
  ];
}
const ICON = { y: '✓', n: '✗', u: '?' };
function itemHTML([v, label, short, read], mobile = false) {
  const c = cls3(v);
  const tag = mobile ? 'button' : 'li';
  const state = c === 'y' ? '满足' : c === 'n' ? '不满足' : '数据未知';
  return `<${tag}${mobile ? ` type="button" aria-label="${esc(label)}，${state}，${esc(read)}"` : ''} class="ci ${c}" data-label="${esc(label)}" data-read="${esc(read)}" title="${esc(label)}：${esc(read)}"><span class="ic ${c}" aria-label="${state}">${ICON[c]}</span><span class="lab"><span class="full">${esc(label)}</span><span class="short">${esc(short)}</span></span><span class="rd">${esc(read)}</span></${tag}>`;
}
function countHTML(items) {
  const hit = items.filter(x => x[0] === true).length, unk = items.filter(x => x[0] !== true && x[0] !== false).length;
  return `<span class="cnt"><b>${hit}</b>/${items.length}${unk ? ` · ?${unk}` : ''}</span>`;
}
function groupCard(g, extra = '') {
  const no = { res: '01', down: '02', emo: '03', risk: '04', ref: '05' }[g.key];
  return `<section class="card condition-card desk-only ${extra}" data-group="${g.key}"><h3><span class="section-no" aria-hidden="true">${no}</span>${esc(g.title)}${countHTML(g.items)}</h3><ul class="cl">${g.items.map(item => itemHTML(item)).join('')}</ul></section>`;
}
function mobileConds(groups) {
  return `<section class="card conds mob-only" aria-label="全部判定条件，点按查看读数">${groups.map(g => `<div class="mgroup" data-group="${g.key}"><span class="gt">${esc(g.title.replace('条件', '').replace('信号', ''))}${countHTML(g.items)}</span>${g.items.map(item => itemHTML(item, true)).join('')}</div>`).join('')}</section>`;
}

function etfFor(code) {
  const theme = S.sourceMap?.themes?.find(t => t.matches?.some(m => m.chartCode === code));
  const et = theme && S.etfMap?.themes?.find(t => t.id === theme.id);
  const c = et?.candidates?.filter(x => x.status === 'verified' && x.eligibleForDefault).sort((a, b) => b.meanAmount20Yuan - a.meanAmount20Yuan)[0];
  return c ? { name: c.name, code: c.code, index: c.trackingIndex, asOf: S.etfMap.asOf } : null;
}
function boardStats(fam) {
  const H = S.result.H, i = H.dates.length - 1;
  return FAMILIES[fam].filter(c => H.boards[c]).map(c => {
    const s = H.boards[c].close;
    return { code: c, name: S.seed.boards[c]?.name ?? c, fam,
      p1: isNum(s[i]) && isNum(s[i - 1]) ? (s[i] / s[i - 1] - 1) * 100 : null,
      p5: isNum(s[i]) && isNum(s[i - 5]) ? (s[i] / s[i - 5] - 1) * 100 : null };
  });
}
function mainBoards(f) {
  if (f.state.startsWith('大主升') || (f.collective === true && f.state !== '主跌'))
    return { role: '主流板块', rows: boardStats(f.leadShown).sort((a, b) => (b.p5 ?? -99) - (a.p5 ?? -99)).slice(0, 2).map(x => ({ ...x, etf: etfFor(x.code) })) };
  if (f.state === '主跌' || f.mainFall === true)
    return { role: '领跌板块', rows: boardStats(f.weak).sort((a, b) => (a.p5 ?? 99) - (b.p5 ?? 99)).slice(0, 2) };
  return { role: '主流板块', rows: [] };
}

const rsiZone = v => (v < 30 ? '超跌' : v > 70 ? '超买' : '正常');
/** RSI 当前区域（超跌 / 正常 / 超买）已连续几个交易日（含今天的盘中值）。 */
function rsiStreak() {
  const arr = S.result?.H?.rsi ?? [];
  let k = arr.length - 1; while (k >= 0 && !isNum(arr[k])) k--;
  if (k < 0) return null;
  const zone = rsiZone(arr[k]); let n = 0;
  for (; k >= 0 && isNum(arr[k]) && rsiZone(arr[k]) === zone; k--) n++;
  return n;
}
/** 行情连接状态：按指数报价的来源时间判断新鲜度；午休、盘前盘后、休市单独标注。 */
function connState() {
  const c = S.calendar, q = S.today.quotes;
  if (!c?.ok) return { cls: 'off', text: '连接中…' };
  if (!c.isTradingDay) return { cls: 'off', text: '休市' };
  const t = c.time.slice(0, 5);
  const inSession = (t >= '09:15' && t < '11:31') || (t >= '13:00' && t < '15:01');
  const lastOk = q?.ok ? Date.parse(q.rows[0]?.sourceTime ?? '') : NaN;
  const pageStale = !S.lastTickAt || Date.now() - S.lastTickAt.getTime() > 3 * 60000;
  if (!inSession) return { cls: 'off', text: t >= '11:31' && t < '13:00' ? '午间休市' : '非交易时段' };
  if (!q?.ok || pageStale || !Number.isFinite(lastOk)) return { cls: 'bad', text: '行情断开' };
  const ageMin = (Date.now() - lastOk) / 60000;
  if (ageMin <= 3) return { cls: 'ok', text: '行情已连接' };
  if (ageMin <= 10) return { cls: 'lag', text: `行情延迟 ${Math.round(ageMin)} 分钟` };
  return { cls: 'bad', text: '行情断开' };
}
function heroHTML(f) {
  const meta = STAGE_META[f.state] ?? { cls: 'flat', name: f.state, sub: '' };
  const r = S.result, y = r.yesterday;
  const pref = f.state.startsWith('大主升') && PREFERENCE_EXCLUDED.includes(f.leadShown);
  const days = r.stateDays ? `第 ${r.stateDays} 个交易日` : '';
  const kpi = (lab, val, c = '', note = '') => `<div class="kpi"><span>${lab}</span><b class="${c}">${val}</b>${note ? `<small class="kpi-note">${note}</small>` : ''}</div>`;
  const yAmt = r.todayAppended ? y?.amt : null;
  const vsY = isNum(f.amt) && isNum(yAmt) && yAmt > 0 ? (f.amt / yAmt - 1) * 100 : null;
  const steps = F1_STEPS.map((_, k) => `<i class="${f.f1 > k ? 'on' : ''}"></i>`).join('');
  const lastAlert = load(`log.${S.calendar?.date}`, [])[0];
  return `<section class="card hero ${meta.cls}">
    <div class="hero-heading"><i class="state-dot" aria-hidden="true"></i>指数线（机构）<span class="eyebrow">MARKET STATE</span></div>
    <div class="hero-top"><div class="stage">${esc(meta.name)}</div><div class="position-block"><span class="position-label">指数仓位</span><span class="pos">${esc(POSITION[f.state] ?? '—')}</span></div></div>
    <p class="sub">${esc(meta.sub)}${r.stateSince ? ` · <span>自 ${esc(r.stateSince)} 起 ${days}</span>` : ''}</p>
    <div class="act">${esc(pref ? '主线为偏好不参与的族群（外围驱动）：按规则观望' : ACTION[f.state])}</div>
    <div class="kpis">
      ${kpi('上证指数', isNum(f.close) ? `${f.close.toFixed(2)} <small class="${sign(f.p1)}">${fmtPct(f.p1)}</small>` : '—', '')}
      ${kpi(r.todayAppended && S.today.amtSource ? `全天量能（${S.today.amtSource.replace('全天', '')}）` : '成交额', isNum(f.amt) ? `${fmtYi(f.amt).replace(' ', '')} <small>×${isNum(f.vr) ? f.vr.toFixed(2) : '—'}</small>` : '—', '',
        r.todayAppended ? (isNum(vsY) ? `较昨日 <span class="${sign(vsY)}">${fmtPct(vsY, 1)}</span>` : '较昨日 —') : '')}
      ${kpi('全指 RSI12', isNum(f.rsi) ? `${f.rsi.toFixed(1)} <small>${rsiZone(f.rsi)}${isNum(rsiStreak()) ? `（连续 ${rsiStreak()} 天）` : ''}</small>` : '—', isNum(f.rsi) && f.rsi < 30 ? 'g' : isNum(f.rsi) && f.rsi > 70 ? 'r' : '', '（&lt;30 超跌 · &gt;70 超买）')}
    </div>
    <div class="steps" title="二次探底进度">${steps}</div>
    <div class="steps-lab">${F1_STEPS.map(s => `<span>${s}</span>`).join('')}</div>
    ${r.todayAppended && f.event ? `<div class="tent">今日试算：${esc(f.event)}（昨日确认：${esc(STAGE_META[y?.state]?.name ?? '—')}）${phaseInfo().alertLevel ? '' : '，10:30 前只观察'}</div>`
      : lastAlert ? `<div class="tent">最近提醒 ${esc(new Date(lastAlert.at).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5))}：${esc(lastAlert.event)}</div>` : ''}
  </section>`;
}
function boardsHTML(f) {
  const mb = mainBoards(f);
  const rows = mb.rows.map(b => `<div class="bd"><div><span class="nm">${esc(b.name)}</span><span class="tag">${esc(FAMILY_LABEL[b.fam] ?? b.fam)}${PREFERENCE_EXCLUDED.includes(b.fam) ? ' · 偏好不参与' : ''}</span></div>
    <div class="v"><small>今日</small><span class="${sign(b.p1)}">${fmtPct(b.p1)}</span></div><div class="v"><small>5日</small><span class="${sign(b.p5)}">${fmtPct(b.p5, 1)}</span></div>
    ${b.etf ? `<div class="etf" title="跟踪 ${esc(b.etf.index)}；按截至 ${esc(b.etf.asOf)} 的 20 日成交额选取">ETF：${esc(b.etf.name)}（${esc(b.etf.code)}）· ${esc(b.etf.index)}</div>` : ''}</div>`).join('');
  return `<section class="card board-card"><h3>${mb.role}<span class="cnt">最多 2 个</span></h3>${rows || '<p class="muted">无主线：未出现集体走强且与指数同步的族群</p>'}</section>`;
}
function extraHTML(f) {
  if ((f.state.startsWith('大主升') || S.emo?.active) && S.today.top?.ok) {
    const lg = S.today.top.rows.filter(x => isNum(x.pct) && x.pct >= 3).slice(0, 6);
    return `<section class="card fill desk-only"><h3>领涨集团<span class="cnt">成交额前20 · 涨幅≥3%</span></h3>${lg.length ? `<table class="mini"><thead><tr><th>名称</th><th>涨幅</th><th>成交额</th></tr></thead><tbody>${lg.map(x => `<tr><td>${esc(x.name)}</td><td class="r">${fmtPct(x.pct)}</td><td>${fmtYi(x.amount)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">暂无满足条件的个股</p>'}<p class="note">仅展示客观行情，不构成投资建议</p></section>`;
  }
  if (f.state === '震荡' || f.state === '筑底') {
    const H = S.result.H, lowNow = H.sh.low.at(-1), prev = H.sh.low.slice(-21, -1).filter(isNum);
    const rebound = S.result.todayAppended && isNum(lowNow) && prev.length && lowNow <= Math.min(...prev) * 1.003 && f.close >= lowNow * 1.005;
    const w = S.today.wide;
    return `<section class="card fill desk-only"><h3>小仓套利</h3><p class="muted">${rebound ? '指数破位后被拉回：按规则可小仓博宽基 ETF 回拉，空间有限' : '暂无指数破位拉回机会'}</p>
      ${w?.ok ? `<table class="mini"><thead><tr><th>宽幅候选</th><th>振幅</th><th>20日均</th><th>堆量</th><th>反包</th></tr></thead><tbody>${w.rows.slice(0, 5).map(x => `<tr><td>${esc(x.name)}</td><td>${x.currentAmplitudePct.toFixed(1)}%</td><td>${x.averageAmplitude20Pct.toFixed(1)}%</td><td>${x.accumulationRatio.toFixed(2)}</td><td>${x.reversalCount20}</td></tr>`).join('')}</tbody></table><p class="note">只列客观数据，约每 5 分钟更新</p>` : '<p class="note">宽幅震荡候选约每 5 分钟扫描一次</p>'}</section>`;
  }
  const tb = Object.values(S.today.boards).filter(b => b.sourceDate === S.calendar?.date).length;
  const partial = S.result.todayAppended && tb < ALL_BOARDS.length;
  const src = partial && S.result.yesterday ? S.result.yesterday : f;   // 板块未载入完整时，用昨日收盘排序，避免只显示部分族群
  const fams = Object.keys(FAMILIES).filter(k => isNum(src.f5?.[k])).sort((a, b) => src.f5[b] - src.f5[a]);
  f = { ...f, f5: src.f5, fT: src.fT };
  return `<section class="card fill desk-only mob-extra"><h3>族群强弱<span class="cnt">${partial ? `截至昨日 · 今日板块载入 ${tb}/${ALL_BOARDS.length}` : '近 5 日排序'}</span></h3><table class="mini"><thead><tr><th>族群</th><th>今日</th><th>近5日</th></tr></thead><tbody>${fams.map((k, idx) => `<tr class="${idx >= 3 && idx < fams.length - 3 ? 'mid' : ''}"><td>${esc(FAMILY_LABEL[k] ?? k)}${PREFERENCE_EXCLUDED.includes(k) ? ' <small class="muted">偏好不参与</small>' : ''}</td><td class="${sign(f.fT[k])}">${fmtPct(f.fT[k])}</td><td class="${sign(f.f5[k])}">${fmtPct(f.f5[k], 1)}</td></tr>`).join('')}</tbody></table>
    <div class="fam-line mob-only"><p><b>强</b>${fams.slice(0, 2).map(k => `${esc(k)} <span class="num ${sign(f.f5[k])}">${fmtPct(f.f5[k], 1)}</span>`).join('　')}</p><p><b>弱</b>${fams.slice(-2).reverse().map(k => `${esc(k)} <span class="num ${sign(f.f5[k])}">${fmtPct(f.f5[k], 1)}</span>`).join('　')}</p></div></section>`;
}
const segName = st => (st === '大主升-减仓' ? '大主升·减仓' : st);
function segTag(g) {
  const parts = [];
  if (g.leader) parts.push(`龙头 ${g.leader}`);
  if (g.board) parts.push(`${g.state === '主跌' ? '领跌' : '板块'} ${g.board}${g.state === '主跌' && isNum(g.boardMove) ? ` ${fmtPct(g.boardMove, 1)}` : ''}`);
  if (g.note) parts.push(g.note);
  const s2 = g.second ? `；第二主线 ${[g.second.leader && `龙头 ${g.second.leader}`, g.second.board && `板块 ${g.second.board}`].filter(Boolean).join(' · ')}` : '';
  return parts.join(' · ') + s2;
}
/** 指数线：复盘时间线 + 之后由引擎逐日结果续接 */
function indexSegs() {
  const tl = S.timeline?.index ?? [], through = S.timeline?.through ?? '';
  const segs = tl.map(g => ({ ...g }));
  for (const r of S.result.rows.filter(x => x.date > through)) {
    const last = segs.at(-1);
    if (last && last.state === r.state) { last.end = r.date; continue; }
    const g = { start: r.date, end: r.date, state: r.state };
    if (r.state.startsWith('大主升')) g.board = labelBoard(null, r.leadShown);
    else if (r.state === '主跌') g.board = labelBoard(null, r.weak);
    segs.push(g);
  }
  return segs;
}
const dspan = (g, now = false) => `${g.start.slice(2).replace(/-/g, '.')}${now ? '–至今' : g.end && g.end !== g.start ? `–${g.end.slice(5).replace('-', '.')}` : ''}`;
function logHTML() {
  const log = load(`log.${S.calendar?.date}`, []).slice(0, 2);
  const idxSegs = indexSegs().reverse();
  const icls = st => (st.startsWith('大主升') ? 'up' : st === '主跌' ? 'down' : 'flat');
  const emoSegs = S.emo?.cycles ? cycleSegments(S.emo.cycles, S.emo.lastDate).reverse() : [];
  const emoItem = (g, k) => {
    const tag = [];
    if (g.phase === '情绪主升' || g.phase === '情绪试探') { tag.push(`龙头 ${g.leader}`, labelBoard(g.board)); if (g.resonance) tag.push('情绪·机构·指数共振'); if (g.phase === '情绪试探') tag.push('5 日内指数转入主跌，未成周期'); }
    else if (g.phase === '退潮') tag.push(`${g.cycleLeader} 周期：${g.reason ?? '结束'}`);
    else tag.push(`高标 ${g.leader}`, g.board ?? '—', `${g.topOf}${g.signal}`);
    if (g.comp && g.phase !== '退潮') tag.push(`伴生 ${g.comp.join('→')}`);
    if (labelBoard(g.cycleBoard ?? g.board ?? '').startsWith('资源')) tag.push('偏好不参与');
    const pos = g.phase === '情绪试探' || g.phase === '退潮' ? '空仓' : cyclePosition(g.phase);
    return `<li class="${g.phase === '退潮' ? 'down' : g.phase === '情绪试探' ? 'flat' : 'up'}"><time>${esc(dspan(g, k === 0 && (!g.end || g.open)))}</time><span class="event"><b class="st">${esc(g.phase)}</b>（${esc(pos)}）<small>（${esc(tag.filter(Boolean).join(' · '))}）</small></span></li>`;
  };
  const cur = idxSegs[0], ep = S.emo?.phase;
  const now = `机构线 <b>${esc(segName(cur?.state ?? '—'))}期</b> · 情绪线 <b>${esc(!ep ? '—' : ep === '无情绪周期' ? '无周期' : `${ep}期`)}</b>`;
  return `<section class="card condition-card log-card desk-only"><h3><span class="section-no" aria-hidden="true">00</span>提醒与切换<span class="cnt">近一年 · 指数线 ${idxSegs.length} 段 · 情绪周期 ${S.emo?.cycles?.length ?? 0} 个</span><span class="cnt now-h">${now}</span></h3><div class="log-top"><ul class="log ${log.length ? 'hot' : 'idle'}">
    ${log.map(x => `<li class="${x.level === '确认' ? 'lv-ok' : 'lv-warn'}${Date.now() - new Date(x.at).getTime() < 30 * 60000 ? ' fresh' : ''}" title="${esc(x.text ?? '')}"><time>${esc(new Date(x.at).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5))}</time><b class="lv">${esc(x.level)}</b><span class="event">${esc(x.event)}</span></li>`).join('') || '<li class="muted">今日暂无状态切换</li>'}</ul><span class="now-tag">现状：${now}</span></div>
    <div class="tl2"><div class="tlcol"><h4>指数线（机构）</h4><ul class="log tl">${idxSegs.map((g, k) => { const t = segTag(g); return `<li class="${icls(g.state)}"><time>${esc(dspan(g, k === 0))}</time><span class="event"><b class="st">${esc(segName(g.state))}</b>（${esc(POSITION[g.state] ?? '—')}）${t ? `<small>（${esc(t)}）</small>` : ''}</span></li>`; }).join('')}</ul></div>
    <div class="tlcol"><h4>情绪线</h4><ul class="log tl">${emoSegs.map(emoItem).join('') || '<li class="muted">近一年无情绪周期</li>'}</ul></div></div></section>`;
}

function statusChips() {
  const p = phaseInfo(), c = S.calendar, r = S.result, out = [];
  const live = S.calendar?.refreshRecommended && S.today.quotes?.ok;
  out.push(`<span class="chip"><i class="live ${live ? '' : 'off'}"></i><b class="num">${esc(c?.time?.slice(0, 5) ?? '--:--')}</b> ${esc(p.label)}</span>`);
  const q = S.today.quotes;
  out.push(`<span class="chip ${q?.ok ? '' : 'warn'}">指数 <b class="num">${q?.ok ? esc(q.rows[0]?.sourceTime?.slice(11, 16) ?? '') : '未取得'}</b></span>`);
  const tb = Object.values(S.today.boards).filter(b => b.sourceDate === c?.date).length;
  out.push(`<span class="chip ${r?.todayAppended && tb < 34 ? 'warn' : ''}">板块今日 <b class="num">${tb}/${ALL_BOARDS.length}</b></span>`);
  const tv = S.today.turnover;
  const yAmt = r?.todayAppended ? r.yesterday?.amt : null;
  const vsY = tv?.estimated && isNum(tv.projectedFullDay) && isNum(yAmt) && yAmt > 0 ? (tv.projectedFullDay / yAmt - 1) * 100 : null;
  if (tv) out.push(`<span class="chip ${tv.ok ? '' : 'warn'}">量能 ${tv.estimated ? `累计 <b class="num">${fmtYi(tv.cumulativeAmount)}</b> · 预估 <b class="num">${fmtYi(tv.projectedFullDay)}</b>${isNum(vsY) ? ` <span class="num ${sign(vsY)}">较昨日 ${fmtPct(vsY, 1)}</span>` : ''} <span class="num">(${fmtYi(tv.interval?.low)}–${fmtYi(tv.interval?.high)})</span>` : tv.ok ? `累计 <b class="num">${fmtYi(tv.cumulativeAmount)}</b>` : '未知'}</span>`);
  const bf = S.backfill;
  if (bf.missing?.length && !bf.complete) out.push(bf.tooOld ? '<span class="chip warn">历史种子过旧，请更新网站</span>' : `<span class="chip warn">补齐历史：板块 ${bf.boardsDone}/${ALL_BOARDS.length} · 涨跌停 ${bf.limitsDone}/${bf.missing.length} 天</span>`);
  if (S.lastError) out.push(`<span class="chip err" title="${esc(S.lastError)}">数据源异常</span>`);
  return out.join('');
}
function footHTML() {
  const c = S.calendar, q = S.today.quotes, bf = S.backfill;
  const hist = bf.missing?.length && bf.complete ? bf.missing.at(-1) : S.seed?.through ?? '—';
  const tb = Object.values(S.today.boards).filter(b => b.sourceDate === c?.date).length;
  const tv = S.today.turnover;
  return `<span class="ver">v${APP_VERSION}</span><span>历史数据截至 <b class="num">${esc(hist)}</b></span>
    <span>实时 <b class="num">${q?.ok ? esc(q.rows[0]?.sourceTime?.slice(11, 16) ?? '—') : '—'}</b></span>
    <span>页面更新 <b class="num">${S.lastTickAt ? S.lastTickAt.toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</b></span>
    <span class="mob-only">板块 ${tb}/${ALL_BOARDS.length}${tv?.estimated ? ` · 预估 ${fmtYi(tv.projectedFullDay)}` : ''}${S.lastError ? ' · <span class="r">数据源异常</span>' : ''}</span>
    <span class="disc" title="本页面按预先设定的规则，对公开行情数据做自动判定。盘中结论为试算，10:30 后状态切换发出预警，14:40 后仍成立发出确认，收盘后定格。数据缺失时显示「?」，不会因此判为震荡或发出提醒。个股只列客观数据，仓位只显示规则档位，不构成投资建议，不提供下单。成交额口径：上证指数 + 深证成指。">规则自动判定，盘中为试算 · 数据缺失显示「?」不触发提醒 · 不构成投资建议，不提供下单</span>`;
}

function render() {
  const f = S.result?.final;
  $('#status').innerHTML = statusChips();
  const cs = connState(); $('#conn').className = `conn ${cs.cls}`; $('#conn').innerHTML = `<i aria-hidden="true"></i>${esc(cs.text)}`;
  $('#foot').innerHTML = footHTML();
  if (!f) {
    $('#col1').innerHTML = '<section class="card hero flat loading-card"><div class="hero-heading"><i class="state-dot" aria-hidden="true"></i>市场阶段<span class="eyebrow">MARKET STATE</span></div><div class="stage">载入中</div><p class="sub">正在回放历史并获取实时数据…</p><div class="loading-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></div></section>';
    $('#col2').innerHTML = ''; $('#col3').innerHTML = ''; return;
  }
  const groups = condGroups(f), G = Object.fromEntries(groups.map(g => [g.key, g]));
  $('#col1').innerHTML = heroHTML(f) + boardsHTML(f) + mobileConds(groups) + extraHTML(f);
  $('#col2').innerHTML = logHTML() + groupCard(G.res) + groupCard(G.down) + `<div class="merge">${groupCard(G.emo)}${groupCard(G.risk)}${groupCard(G.ref)}</div>`;
  $('#col3').innerHTML = groupCard(G.emo) + groupCard(G.risk) + groupCard(G.ref);
  const alertsOn = load('alertsOn', false);
  $('#alert-btn').textContent = alertsOn ? '提醒已开启' : '开启网页提醒';
  $('#alert-btn').setAttribute('aria-pressed', String(alertsOn));
}
document.addEventListener('click', e => {
  const li = e.target.closest('.mgroup .ci'); if (!li) return;
  showToast(li.dataset.label, li.dataset.read);
});

$('#alert-btn').addEventListener('click', async () => {
  const on = !load('alertsOn', false);
  if (on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  save('alertsOn', on);
  if (on) notify('网页提醒已开启（测试）', 'Notification' in window && Notification.permission === 'denied'
    ? '浏览器拒绝了系统通知，只能在页面内弹窗和闪烁标题。可在浏览器网站设置里允许通知。'
    : '状态切换时会系统通知、页面弹窗并闪烁标题。请保持本页面打开（可放在后台标签页）。');
  render();
});

render();
tick();
setInterval(tick, TICK_MS);
