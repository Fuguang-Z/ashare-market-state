/**
 * 页面调度：每分钟一轮（上一轮未结束则跳过），取实时数据 → 拼接到历史 → 状态机试算 → 渲染 → 网页内提醒。
 * 原则：数据缺失就显示「未知」，不把缺失当成震荡，也不触发提醒。
 */
import ds from './datasource.js?v=20261015c';
import { replay, wilderRSI, FAMILIES, PARAMS, POSITION, PREFERENCE_EXCLUDED, alertLevelAt, alertKey } from './engine.js?v=20261015c';

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
  today: { quotes: null, turnover: null, pools: {}, breadth: null, boards: {}, top: null, wide: null },
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
        for (const bd of Object.values(boards)) bd.close.push(null);
      }
      sh.close[i] = a[date].close; sh.high[i] = a[date].high; sh.low[i] = a[date].low;
      amt[i] = a[date].amount + b[date].amount; c985[i] = c[date].close;
      if (date > seed.through) {
        const lim = S.extra?.limits?.[date];
        if (lim) for (const k of Object.keys(limits)) limits[k][i] = isNum(lim[k]) ? lim[k] : null;
        for (const [code, bd] of Object.entries(boards)) { const v = S.extra?.boards?.[code]?.[date]; bd.close[i] = isNum(v) ? v : null; }
      }
    }
  }
  return { dates, sh, amt, c985, limits, boards, seedThrough: seed.through };
}

/** 在历史末尾追加「今天」（盘中试算行）。缺失项为 null。 */
function withToday(H) {
  const t = S.today, date = S.calendar?.date;
  const q = t.quotes?.ok ? t.quotes.rows : null;
  const shq = q?.find(r => r.symbol === 'sh000001'), q985 = q?.find(r => r.symbol === 'sh000985');
  if (!shq || shq.sourceDate !== date) return { H: { ...H, rsi: wilderRSI(H.c985, 12) }, todayAppended: false };
  const amtToday = t.turnover?.ok ? (isNum(t.turnover.projectedFullDay) ? t.turnover.projectedFullDay : t.turnover.cumulativeAmount) : null;
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
  // 同花顺板块轮询
  const n = ALL_BOARDS.length, pick = [];
  for (let k = 0; k < BOARDS_PER_TICK; k++) pick.push(ALL_BOARDS[(S.boardCursor + k) % n]);
  S.boardCursor = (S.boardCursor + BOARDS_PER_TICK) % n;
  const tb = await ds.getTHSBoardToday([...new Set(pick)]);
  for (const r of tb.rows ?? []) S.today.boards[r.code] = r;
  // 成交额前列（领涨集团）：主升状态每轮，其余每 3 轮
  const st = S.result?.final?.state ?? '';
  if (st.startsWith('大主升') || st === '小主升' || S.tick % 3 === 0) { const top = await ds.getTopTurnover(20); if (top.ok) S.today.top = top; }
}

async function wideRound() {
  const tv = await ds.getProjectedTurnover(); if (tv.ok) S.today.turnover = tv;
  const w = await ds.getWideRangeCandidates({ minAmount: 5e8, n: 8 }); if (w.ok) S.today.wide = w;
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
      ex.limits[d] = { up: up.count, down: dn.count, broken: br.count, height: lbc.length ? Math.max(...lbc) : 0, lad3: lbc.filter(v => v >= 3).length };
    }
  }
  for (const c of Object.keys(ex.boards)) for (const day of Object.keys(ex.boards[c])) if (day <= S.seed.through) delete ex.boards[c][day];
  for (const day of Object.keys(ex.limits)) if (day <= S.seed.through) delete ex.limits[day];
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
  if (!S.extra) S.extra = load('extra', { boards: {}, limits: {} });
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
  S.result = { ...out, todayAppended, H, yesterday: confirmedRows.at(-1), stateSince: sinceDate(out.rows) };
  maybeAlert();
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
  '情绪启动': () => '情绪周期启动：按规则半仓，只参与龙头和第一轮补涨。',
  '情绪退潮': () => '情绪退潮：按规则清仓情绪仓位。',
  '主线切换': lead => `主线切换至「${lead}」：按规则调仓，仓位不变。`,
};

function maybeAlert() {
  const r = S.result, f = r?.final; if (!r?.todayAppended || !f?.event) return;
  const p = phaseInfo();
  const fired = load('fired', {});
  const key = alertKey(f, p.alertLevel, fired); if (!key) return;
  fired[key] = Date.now();
  for (const k of Object.keys(fired)) if (!k.startsWith(f.date)) delete fired[k];
  save('fired', fired);
  const text = (EVENT_TEXT[f.event] ?? (() => f.event))(f.leadShown);
  const log = load(`log.${f.date}`, []); log.unshift({ at: new Date().toISOString(), level: p.alertLevel, event: f.event, text }); save(`log.${f.date}`, log.slice(0, 30));
  notify(`【${p.alertLevel}】${f.event}`, text);
}

let flashTimer = null;
function notify(title, body) {
  try { if (load('alertsOn', false) && 'Notification' in window && Notification.permission === 'granted') new Notification(title, { body }); } catch { /* 忽略 */ }
  clearInterval(flashTimer); let n = 0; const orig = 'A股市场状态';
  flashTimer = setInterval(() => { document.title = n++ % 2 ? orig : `【提醒】${title}`; if (n > 30) { clearInterval(flashTimer); document.title = orig; } }, 1000);
  showToast(title, body);
}
function showToast(title, body) {
  const el = $('#toast'); el.innerHTML = `<strong>${esc(title)}</strong><p>${esc(body)}</p><button type="button" aria-label="关闭">知道了</button>`;
  el.hidden = false; el.querySelector('button').onclick = () => { el.hidden = true; };
}

/* ---------------- 渲染 ---------------- */

const STAGE_META = {
  '大主升': { cls: 'up', name: '大主升', sub: '机构或情绪趋势，与指数共振' },
  '大主升-减仓': { cls: 'up', name: '大主升 · 风险期', sub: '主线仍在，风险信号叠加' },
  '小主升': { cls: 'emo', name: '小主升', sub: '情绪板块，节奏快、持续短' },
  '震荡': { cls: 'flat', name: '震荡', sub: '无主线，轮动混沌' },
  '筑底': { cls: 'flat', name: '震荡 · 筑底', sub: '主跌结束，等待共振' },
  '主跌': { cls: 'down', name: '主跌', sub: '领跌板块带动指数下行' },
};
const ACTION = {
  '大主升': '按规则：可参与，重仓；首次分歧时加仓',
  '大主升-减仓': '按规则：降至半仓，破位即清仓',
  '小主升': '按规则：半仓，只参与龙头与第一轮补涨',
  '震荡': '按规则：观望（空仓），或小仓套利',
  '筑底': '按规则：观望（空仓），不抄底，等待共振',
  '主跌': '按规则：观望（空仓），不抄底',
};

function mark(v) { return v === true ? '<span class="ok" aria-label="满足">✓</span>' : v === false ? '<span class="no" aria-label="不满足">✗</span>' : '<span class="unk" aria-label="数据未知">?</span>'; }
function condRow(v, label, reading) { return `<li>${mark(v)}<span class="c-label">${esc(label)}</span><span class="c-read">（${reading}）</span></li>`; }
function group(title, items) {
  const known = items.filter(x => x[0] !== null).length, hit = items.filter(x => x[0] === true).length;
  return `<section class="cgroup"><h3>${esc(title)}<span class="count">满足 ${hit}/${items.length}${known < items.length ? ` · 未知 ${items.length - known}` : ''}</span></h3><ul>${items.map(x => condRow(...x)).join('')}</ul></section>`;
}
const F1_TEXT = ['未触发超跌', '① 超跌', '② 首次反弹触及 5 日线', '③ 回落二次探底', '④ 再次站上均线'];

function renderConditions(f) {
  if (!f) return '<p class="muted">等待数据…</p>';
  const P = PARAMS, lead = f.leadShown, nm = esc;
  const today = S.result.todayAppended;
  const volText = isNum(f.vr) ? `${fmtYi(f.amt)}${today && S.today.turnover?.estimated ? '（全天预估）' : ''}，为 20 日均量 ${f.vr.toFixed(2)} 倍` : '量能未知';
  const a60 = isNum(f.a60) ? `前 60 日均量 ${fmtYi(f.a60)}` : '60 日均量不足';
  const famRead = isNum(f.f5?.[lead]) ? `${nm(lead)} 近 5 日 ${fmtPct(f.f5[lead], 1)}，今日前 6 板块含 ${f.cnt} 个、5 日前 6 含 ${f.cnt5} 个` : '板块数据未知';
  const syncRead = isNum(f.fT?.[lead]) && isNum(f.p1) ? `指数 ${fmtPct(f.p1)}，${nm(lead)} ${fmtPct(f.fT[lead])}` : '未知';
  const f1v = f.f1full ? true : f.f1part ? null : false;
  const res = [
    [f.A1, '指数站上 5 日线和 10 日线，5 日线上拐', isNum(f.close) ? `上证 ${f.close.toFixed(2)}，MA5 ${f.m5?.toFixed(2) ?? '—'}，MA10 ${f.m10?.toFixed(2) ?? '—'}` : '未知'],
    [isNum(f.vr) ? (f.volOk === true) : null, f.f1full ? `量能放大（≥ ${P.VR_UP} 倍 20 日均量）` : f.f1part ? `量能放大（二次探底未完成，需 ≥ ${P.VR_UP_SOFT} 倍）` : `量能放大（超跌后须先出现第一波反弹）`, volText],
    [f.volVsDecline, '量能不低于此前下跌阶段', a60],
    [f.collective, '主线族群集体走强', famRead],
    [f.sync, '主线与指数同步上涨', syncRead],
    [f1v, '已完成二次探底', `${F1_TEXT[f.f1] ?? '—'}${f.f1part ? '；进行中，需更大量能' : ''}`],
  ];
  const holding = f.state.startsWith('大主升');
  const riskNames = ['指数放量滞涨', '指数顶背离', '主线族巨震', '主线族连续2日跌破5日线', '跌停扩散'];
  const risk = riskNames.map(n => [holding ? (f.risk.includes(n) ? true : f.riskUnknown.includes(n) ? null : false) : null, n, holding ? (n === '跌停扩散' ? `跌停 ${f.dn ?? '—'} 家` : n === '主线族巨震' ? `${nm(lead)} 今日 ${fmtPct(f.fT?.[lead])}` : '—') : '仅在主升状态检查']);
  const weakRead = isNum(f.f5?.[f.weak]) ? `${nm(f.weak)} 近 5 日 ${fmtPct(f.f5[f.weak], 1)}，今日 ${fmtPct(f.fT[f.weak])}` : '未知';
  const down = [
    [f.D1, '指数在 5 日线下，5 日线下拐', isNum(f.close) && isNum(f.m5) ? `上证 ${f.close.toFixed(2)}，MA5 ${f.m5.toFixed(2)}` : '未知'],
    [f.mainFall, '最弱族群仍在领跌', weakRead],
  ];
  const emo = [
    [f.hExpand, '连板高度拓展', isNum(f.h) ? `最高 ${f.h} 板，前 5 日最高 ${f.hmax5 ?? '—'} 板` : '未知'],
    [f.noLoss, '无明显亏钱效应', isNum(f.dn) ? `跌停 ${f.dn} 家（≤ ${P.LOSS_DOWN}）` : '跌停数未知'],
    [f.ladderOk, '连板梯队完整（排除独立妖股）', isNum(f.lad3) ? `3 连板以上 ${f.lad3} 只` : '未知'],
  ];
  const ref = [
    [f.panic, '恐慌盘出现（见底区提示）', isNum(f.dn) && isNum(f.rsi) ? `跌停 ${f.dn} 家，全指 RSI12 ${f.rsi.toFixed(1)}` : '未知'],
    [isNum(f.rsi) ? f.rsi < 30 : null, '指数超跌', isNum(f.rsi) ? `中证全指 RSI12 ${f.rsi.toFixed(1)}` : '未知'],
    [isNum(f.brokenRate) ? f.brokenRate >= P.EXIT_BROKEN_RATE : null, '炸板率 ≥ 50%（情绪退潮）', isNum(f.brokenRate) ? `${(f.brokenRate * 100).toFixed(0)}%` : '未知'],
  ];
  const tierText = isNum(f.amt) ? (f.amt >= 2.5e12 ? '≥ 2.5 万亿' : f.amt >= 2e12 ? '2–2.5 万亿' : f.amt >= 1.6e12 ? '1.6–2 万亿' : '< 1.6 万亿（地量）') : '—';
  const breadth = S.today.breadth?.ok ? `涨 ${S.today.breadth.up} / 跌 ${S.today.breadth.down}` : '—';
  return group('共振条件', res) + group('风险信号', risk) + group('主跌条件', down) + group('情绪条件', emo) + group('参考', ref)
    + `<p class="refline">成交额档位：${tierText} · 涨跌家数：${breadth}</p>`;
}

function etfFor(code) {
  const theme = S.sourceMap?.themes?.find(t => t.matches?.some(m => m.chartCode === code));
  const et = theme && S.etfMap?.themes?.find(t => t.id === theme.id);
  const c = et?.candidates?.filter(x => x.status === 'verified' && x.eligibleForDefault).sort((a, b) => b.meanAmount20Yuan - a.meanAmount20Yuan)[0];
  return c ? { name: c.name, code: c.code, index: c.trackingIndex, asOf: S.etfMap.asOf } : null;
}

function mainBoards(f) {
  if (!f) return [];
  const H = S.result.H, i = H.dates.length - 1;
  const pick = fam => FAMILIES[fam].filter(c => H.boards[c]).map(c => {
    const s = H.boards[c].close, b = S.seed.boards[c];
    const p1 = isNum(s[i]) && isNum(s[i - 1]) ? (s[i] / s[i - 1] - 1) * 100 : null;
    const p5 = isNum(s[i]) && isNum(s[i - 5]) ? (s[i] / s[i - 5] - 1) * 100 : null;
    return { code: c, name: b?.name ?? c, fam, p1, p5 };
  });
  if (f.state.startsWith('大主升') || (f.collective === true && f.state !== '主跌')) return pick(f.leadShown).sort((a, b) => (b.p5 ?? -99) - (a.p5 ?? -99)).slice(0, 2).map(x => ({ ...x, role: '主线', etf: etfFor(x.code) }));
  if (f.state === '主跌' || f.mainFall === true) return pick(f.weak).sort((a, b) => (a.p5 ?? 99) - (b.p5 ?? 99)).slice(0, 2).map(x => ({ ...x, role: '领跌' }));
  return [];
}

function renderRight(f) {
  if (!f) return '<p class="muted">正在回放历史与获取实时数据…</p>';
  const meta = STAGE_META[f.state] ?? { cls: 'flat', name: f.state, sub: '' };
  const r = S.result, y = r.yesterday;
  const tentative = r.todayAppended && f.event;
  const pref = f.state.startsWith('大主升') && PREFERENCE_EXCLUDED.includes(f.leadShown);
  let html = `<section class="stage ${meta.cls}">
    <div class="stage-top"><span class="stage-name">${esc(meta.name)}</span><span class="pos">${esc(POSITION[f.state])}</span></div>
    <p class="stage-sub">${esc(meta.sub)}${r.stateSince ? ` · 自 ${esc(r.stateSince)} 起` : ''}</p>
    <p class="action">${esc(pref ? '主线族群为偏好不参与（外围驱动），按规则：观望' : ACTION[f.state])}</p>
    ${tentative ? `<p class="tentative">今日试算：${esc(f.event)}（昨日收盘确认状态：${esc(STAGE_META[y?.state]?.name ?? y?.state ?? '—')}）。${esc(phaseInfo().alertLevel ? '' : '10:30 前只观察，不提醒。')}</p>` : ''}
  </section>`;
  const mb = mainBoards(f);
  html += `<section class="card"><h3>${mb[0]?.role === '领跌' ? '领跌板块' : '主流板块'}<span class="count">最多 2 个</span></h3>`;
  html += mb.length ? `<ul class="boards">${mb.map(b => `<li><div><strong>${esc(b.name)}</strong><span class="fam">${esc(b.fam)}${PREFERENCE_EXCLUDED.includes(b.fam) ? ' · 偏好不参与' : ''}</span></div>
      <div class="nums"><span>今日 ${fmtPct(b.p1)}</span><span>近 5 日 ${fmtPct(b.p5, 1)}</span></div>
      ${b.etf ? `<div class="etf">对应 ETF：${esc(b.etf.name)}（${esc(b.etf.code)}）<small>跟踪 ${esc(b.etf.index)}；按截至 ${esc(b.etf.asOf)} 的 20 日成交额选取</small></div>` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">无主线（未出现集体走强且与指数同步的族群）。</p>';
  html += '</section>';
  if ((f.state.startsWith('大主升') || f.state === '小主升') && S.today.top?.ok) {
    const lg = S.today.top.rows.filter(x => isNum(x.pct) && x.pct >= 3).slice(0, 8);
    html += `<section class="card"><h3>领涨集团<span class="count">成交额前 20 中涨幅 ≥ 3%</span></h3>${lg.length ? `<table class="tbl"><thead><tr><th>名称</th><th>涨幅</th><th>成交额</th></tr></thead><tbody>${lg.map(x => `<tr><td>${esc(x.name)}</td><td class="up-t">${fmtPct(x.pct)}</td><td>${fmtYi(x.amount)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">暂无满足条件的个股。</p>'}<p class="note">客观数据，按成交额排序；不构成买卖建议。</p></section>`;
  }
  if (f.state === '震荡' || f.state === '筑底') {
    const lowNow = S.result.H.sh.low.at(-1), prevLows = S.result.H.sh.low.slice(-21, -1).filter(isNum);
    const rebound = r.todayAppended && isNum(lowNow) && prevLows.length && lowNow <= Math.min(...prevLows) * 1.003 && f.close >= lowNow * 1.005;
    html += `<section class="card"><h3>小仓套利</h3><p>${rebound ? '指数盘中跌破或触及近 20 日低点后被拉回：按规则可小仓博宽基 ETF 回拉，空间有限。' : '指数未出现破位拉回，暂无指数回拉机会。'}</p>`;
    const w = S.today.wide;
    html += w?.ok ? `<table class="tbl"><thead><tr><th>名称</th><th>今日振幅</th><th>20 日均振幅</th><th>堆量倍数</th><th>反包次数</th></tr></thead><tbody>${w.rows.map(x => `<tr><td>${esc(x.name)}</td><td>${x.currentAmplitudePct.toFixed(1)}%</td><td>${x.averageAmplitude20Pct.toFixed(1)}%</td><td>${x.accumulationRatio.toFixed(2)}</td><td>${x.reversalCount20}</td></tr>`).join('')}</tbody></table><p class="note">宽幅震荡候选：成交额前 200 中振幅居前、持续堆量的个股，只列客观数据。约每 5 分钟更新。</p>` : '<p class="muted">宽幅震荡候选约每 5 分钟扫描一次，盘中可见。</p>';
    html += '</section>';
  }
  const log = load(`log.${S.calendar?.date}`, []);
  html += `<section class="card"><h3>今日提醒</h3>${log.length ? `<ul class="log">${log.map(x => `<li><time>${esc(new Date(x.at).toLocaleTimeString('zh-CN', { hour12: false }))}</time><b>${esc(x.level)}</b> ${esc(x.text)}</li>`).join('')}</ul>` : '<p class="muted">今日暂无状态切换。</p>'}</section>`;
  const ev = S.result.events.slice(-6).reverse();
  html += `<section class="card"><h3>近期状态切换</h3><ul class="log">${ev.map(e => `<li><time>${esc(e.date)}</time>${esc(e.event)} → ${esc(STAGE_META[e.to]?.name ?? e.to)}（${esc(e.position)}）</li>`).join('')}</ul></section>`;
  return html;
}

function renderStatus() {
  const p = phaseInfo(), c = S.calendar, r = S.result;
  const parts = [`<span class="chip">${esc(c?.date ?? '')} ${esc(c?.time?.slice(0, 5) ?? '')} · ${esc(p.label)}</span>`];
  const q = S.today.quotes;
  parts.push(`<span class="chip ${q?.ok ? '' : 'warn'}">指数${q?.ok ? `：${esc(q.rows[0]?.sourceTime?.slice(11, 16) ?? '')}` : '：未取得'}</span>`);
  const tb = Object.values(S.today.boards).filter(b => b.sourceDate === c?.date).length;
  parts.push(`<span class="chip ${r?.todayAppended && tb < 10 ? 'warn' : ''}">板块今日 ${tb}/${ALL_BOARDS.length}</span>`);
  const tv = S.today.turnover;
  if (tv) parts.push(`<span class="chip ${tv.ok ? '' : 'warn'}">量能${tv.estimated ? `：累计 ${fmtYi(tv.cumulativeAmount)}，全天预估 ${fmtYi(tv.projectedFullDay)}（区间 ${fmtYi(tv.interval?.low)}–${fmtYi(tv.interval?.high)}）` : tv.ok ? `：累计 ${fmtYi(tv.cumulativeAmount)}` : '：未知'}</span>`);
  const bf = S.backfill;
  if (bf.missing?.length) parts.push(bf.complete ? `<span class="chip">已补齐 ${esc(bf.missing.at(-1))} 前历史</span>`
    : bf.tooOld ? '<span class="chip warn">历史种子过旧（超过 55 个交易日），请更新网站</span>'
    : `<span class="chip warn">补齐历史中：板块 ${bf.boardsDone}/${ALL_BOARDS.length}，涨跌停 ${bf.limitsDone}/${bf.missing.length} 天</span>`);
  if (S.lastError) parts.push(`<span class="chip err" title="${esc(S.lastError)}">数据源异常：${esc(S.lastError.slice(0, 60))}</span>`);
  return parts.join('');
}

function render() {
  const f = S.result?.final;
  $('#status').innerHTML = renderStatus();
  $('#conditions').innerHTML = renderConditions(f);
  $('#summary').innerHTML = renderRight(f);
  $('#updated').textContent = S.lastTickAt ? `页面更新 ${S.lastTickAt.toLocaleTimeString('zh-CN', { hour12: false })}` : '';
  const alertsOn = load('alertsOn', false);
  $('#alert-btn').textContent = alertsOn ? '提醒已开启' : '开启网页提醒';
  $('#alert-btn').setAttribute('aria-pressed', String(alertsOn));
}

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
