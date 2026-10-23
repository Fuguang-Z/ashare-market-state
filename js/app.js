/**
 * 页面调度：每分钟一轮（上一轮未结束则跳过），取实时数据 → 拼接到历史 → 状态机试算 → 渲染 → 网页内提醒。
 * 原则：数据缺失就显示「未知」，不把缺失当成震荡，也不触发提醒。
 */
import ds, { OVERSEAS } from './datasource.js?v=20261023a';
import { replay, wilderRSI, FAMILIES, GATE_BOARDS, PARAMS, POSITION, PREFERENCE_EXCLUDED, alertLevelAt, alertKey, themeTop } from './engine.js?v=20261023a';
import { cycleReplay, cycleSegments, cyclePosition, emoAlertEvents, CYCLE_PARAMS, FAMILY_LABEL, labelBoard, splitThemes } from './cycle.js?v=20261023a';
import { decodePools, decodeKline, featFromRows } from './seedpools.js?v=20261023a';

const TICK_MS = 60000;
const BOARDS_PER_TICK = 12;   // 同花顺板块实时：每轮 12 个（数据层同花顺请求间隔约 3 秒，约 36 秒；约 4 分钟轮完一圈，门槛指数排最前）
const QUICK_MS = 15000;        // 指数与成交额（腾讯，实测数据延迟 0–4 秒、不限流）每 15 秒单独刷新一次，东财请求仍按 60 秒一轮
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
  stockK: {}, kQueue: new Set(), emo: null, hotPool: null, hotLive: {}, hotRank: {}, hotTick: 0,
  calendar: null, tick: 0, busy: false, boardCursor: 0, result: null, lastError: null, lastTickAt: null,
  extra: null,               // 种子之后的已完成日补数：{ boards:{code:{date:close}}, limits:{date:{...}} }，缓存在浏览器
  backfill: { missing: [], boardsDone: 0, limitsDone: 0, complete: true },
  boardK: null, boardKFail: {},          // 板块卡迷你 K 线：{ date, rows:{code:[[日期,开,高,低,收]]} }（已完成日，按日缓存在浏览器）
  overseas: null, overseasFail: {}, overseasQ: null, overseasFile: null, overseasFileDay: null,   // 外围科技：日 K 按日缓存；日韩盘中现价；每日更新写的日 K 文件
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
  // 涨跌停统计：同花顺涨停池（涨停、跌停、炸板数取源 today 统计；连板取「N天N板」与「首板」标签），与历史数据同口径
  const lim = t.themes?.date === date ? t.themes : null;
  const lbc = lim ? lim.rows.map(r => r.consecutive).filter(isNum) : [];
  const cnt = k => (lim && isNum(lim.counts?.[k]) ? lim.counts[k] : null);
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
      up: [...H.limits.up, cnt('up')], down: [...H.limits.down, cnt('down')],
      broken: [...H.limits.broken, cnt('broken')],
      height: [...H.limits.height, lim ? (lbc.length ? Math.max(...lbc) : 0) : null],
      lad3: [...H.limits.lad3, lim ? lbc.filter(v => v >= 3).length : null],
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
/**
 * 板块强弱的大类（展示用，不参与状态机判定）：本地数据近一年各轮行情的热门方向。
 * 只有大科技多轮发酵、按分支列出；其余一律归纳为大类。今日/近 5 日 = 成员板块等权。
 */
const SECTORS = [
  { name: '大科技', branch: true, boards: ['881121', '886042', '886033', '881129', '885959', '881270', '886112', '886050'] },
  { name: '商业航天', boards: ['886078', '885574'] },   // 商业航天、卫星导航，不再展开分支
  { name: '军工', boards: ['885700', '881166', '881276'] },
  { name: 'AI应用', boards: ['881272', '886108', '881275', '881164'] },   // 含传媒
  { name: '低空经济', boards: ['886067'] },
  { name: '智能驾驶', boards: ['885736', '881125', '881126'] },   // 无人驾驶、汽车整车、汽车零部件
  { name: '机器人', boards: ['885517'] },
  { name: '医药', boards: ['881140', '881141', '881175', '886015'] },
  { name: '新能源', boards: ['881281', '885710', '881279', '881280'] },
  { name: '资源', boards: ['881169', '885530', '885343', '885914'], pref: true },
  { name: '房地产', boards: ['881153'] },
  { name: '电力', boards: ['881145'] },
  { name: '金融', boards: ['881155', '881157', '881156'] },
  { name: '消费零售', boards: ['881158', '881124', '885800'] },   // 零售、消费电子、消费电子概念
  { name: '农业', boards: ['881101', '881103'] },
];
// 东财热门板块 → 大类（关键词，先到先得）
const SECTOR_KEYS = [
  ['商业航天', ['航天', '卫星', '空间站', '火箭', '北斗']],
  ['低空经济', ['低空', '飞行汽车', 'eVTOL', '无人机', '通用航空']],
  ['军工', ['军工', '兵装', '航空装备', '航海装备', '国防', '军民融合', '航母', '大飞机', '民爆', '船舶', '军用']],
  ['智能驾驶', ['驾驶', '汽车', '车联网', '车牌', '压铸', '热管理', '整车', '零部件', '车路']],
  ['消费零售', ['消费电子', '零售', '商超', '百货', '电商', '免税', '食品', '白酒', '饮料', '家电', '鸡肉', '乳业', '折叠屏', '可穿戴']],
  ['大科技', ['半导体', '芯片', '存储', 'CPO', '光模块', 'PCB', '元件', 'MLCC', '算力', '通信', '电子', '服务器', '液冷', '光刻', '先进封装']],
  ['AI应用', ['AI', '软件', '游戏', '数据要素', '多模态', '智能体', '营销', '短剧', '传媒', '出版', '影视', '文化', '图书']],
  ['机器人', ['机器人', '减速器', '具身']],
  ['医药', ['药', '医', 'CRO', '生物', '疫苗']],
  ['新能源', ['电池', '锂', '光伏', '风电', '储能', '固态', '氢', '燃料电池']],
  ['资源', ['黄金', '贵金属', '稀土', '煤', '有色', '铜', '钨', '锗']],
  ['房地产', ['地产', '房产', '物业', '租售', '租赁', '建材', '装修', '水泥']],
  ['电力', ['电力', '火电', '绿电', '水电', '核电', '电网', '电设备']],
  ['金融', ['银行', '证券', '保险', '券商', '金融']],
  ['农业', ['农业', '种业', '粮食', '养殖', '种植', '猪', '渔', '化肥']],
];
const sectorOfName = name => SECTOR_KEYS.find(([, ks]) => ks.some(k => name.includes(k)))?.[0] ?? null;
const EXTRA_BOARDS = [...new Set(SECTORS.flatMap(x => x.boards))].filter(c => !ALL_BOARDS.includes(c));
const POLL_BOARDS = [...Object.values(GATE_BOARDS), ...ALL_BOARDS, ...EXTRA_BOARDS];   // 大主升门槛的两个同花顺指数排最前，盘中先取到

async function ordinaryRound() {
  const date = S.calendar.date;
  const q = await ds.getIndexQuotes(); if (q.ok || !S.today.quotes) S.today.quotes = q;
  const tv = await ds.getProjectedTurnover(); if (tv.ok || !S.today.turnover) S.today.turnover = tv;
  // 同花顺涨停池：涨停/跌停/炸板统计、连板梯队、题材（情绪周期）；东财额度留给热门板块
  const th = await ds.getTHSLimitThemes(date);
  if (th.ok && !th.partial) S.today.themes = { date, rows: th.rows, counts: th.counts, top: themeTop(th.rows.map(r => r.reasonText)) };
  await hotRound();
  // 同花顺板块轮询
  const n = POLL_BOARDS.length, pick = [];
  for (let k = 0; k < BOARDS_PER_TICK; k++) pick.push(POLL_BOARDS[(S.boardCursor + k) % n]);
  S.boardCursor = (S.boardCursor + BOARDS_PER_TICK) % n;
  const uniq = [...new Set(pick)];
  for (let k = 0; k < uniq.length; k += 10) {   // 数据层每次最多 10 个
    const tb = await ds.getTHSBoardToday(uniq.slice(k, k + 10));
    for (const r of tb.rows ?? []) S.today.boards[r.code] = r;
  }
  // 成交额前列（领涨集团）：主升状态每轮，其余每 3 轮
  const st = S.result?.final?.state ?? '';
  if (st.startsWith('大主升') || S.emo?.active || S.tick % 3 === 0) { const top = await ds.getTopTurnover(20); if (top.ok) S.today.top = top; }
}

async function wideRound() {
  const tv = await ds.getProjectedTurnover(); if (tv.ok) S.today.turnover = tv;
  const w = await ds.getWideRangeCandidates({ minAmount: 5e8, n: 8 }); if (w.ok) S.today.wide = w;
}

/* ---------------- 热门板块池 ---------------- */
// 入池规则与 研究/历史数据/hot_boards.py 一致：概念前 20 且 ≥3%（剔除统计性伪板块）、行业前 10 且 ≥2.5%（剔除三级细分）
const HOT_RULE = { concept: { top: 20, min: 3.0 }, industry: { top: 10, min: 2.5 } };
const HOT_KEEP = 5;   // 近期热点保留 5 个交易日（2026-10-21 用户改，原 10）
const HOT_EXCLUDE = ['昨日', '连板', '涨停', '跌停', '热股', '融资', '融券', '沪股通', '深股通', '标准普尔', '标普', 'MSCI', '富时', '重仓', '预增', '预盈', '预亏',
  '破净', '低价', '次新', '送转', 'ST', '注册制', '创业板综', '上证', '深证', '中证', 'HS300', '沪深300', 'AH股', 'B股', '百元', '转债', 'QFII',
  '社保', '基金', '茅指数', '宁组合', '做市', '北交所', '专精特新', '股权激励', '举牌', '高送转', '参股', '壳资源', '央企改革', '国企改革', '地方国资',
  '证金', '汇金', '养老金', '保险重仓', '券商重仓', '机构', '龙虎榜', '回购', '分拆', '退市', '超跌', '贬值受益', '升值受益', '长江三角', '京津冀', '粤港澳',
  '雄安', '西部大开发', '成渝', '东北振兴', '自贸区', '一带一路', '核准制', '季报', '年报', '中报', '业绩'];
function hotToday() {
  const out = [];
  for (const type of ['concept', 'industry']) {
    const r = S.hotRank[type]; if (!r || r.date !== S.calendar?.date) continue;
    let rank = 0;
    for (const x of r.rows) {
      if (type === 'concept' && HOT_EXCLUDE.some(k => x.name.includes(k))) continue;
      if (type === 'industry' && x.name.endsWith('Ⅲ')) continue;
      rank++;
      if (rank <= HOT_RULE[type].top && isNum(x.pct) && x.pct >= HOT_RULE[type].min) out.push({ ...x, type, rank });
    }
  }
  return out;
}
/** 盘中：每轮一次东财请求——轮流取概念/行业排行第 1 页（识别今日新入池）与池内板块批量报价 */
async function hotRound() {
  S.hotTick++;
  const k = S.hotTick % 3, today = S.calendar?.date;
  if (k !== 0) {
    const type = k === 1 ? 'concept' : 'industry';
    const r = await ds.getBoardRanking({ type, page: 1 });
    if (r.ok) { S.hotRank[type] = { date: today, at: Date.now(), rows: r.rows }; for (const x of r.rows) S.hotLive[x.code] = { ...x, type, at: Date.now() }; }
  } else {
    const codes = (S.hotPool?.boards ?? []).map(b => b.code).filter(c => !S.hotLive[c] || Date.now() - S.hotLive[c].at > 120000).slice(0, 60);
    if (codes.length) { const q = await ds.getBoardQuotes(codes); if (q.ok) for (const x of q.rows) S.hotLive[x.code] = { ...S.hotLive[x.code], ...x, type: S.hotLive[x.code]?.type ?? x.type, at: Date.now() }; }
  }
}
/** 大类行：成员板块等权（今日、近 5 日链乘）；科技类附分支；按东财当日热门 / 近 10 日热门板块标注热点 */
function sectorRows(j, fs, strictLast = false) {
  const H = S.result.H, today = S.calendar?.date;
  const ret = (c, d) => { const x = H.boards[c]?.close; return x && isNum(x[d]) && isNum(x[d - 1]) ? x[d] / x[d - 1] - 1 : null; };
  const mean = v => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  const one = c => { const p1 = ret(c, j); let k = 1, ok = true; for (let d = j - 4; d <= j; d++) { const r = ret(c, d); if (r === null) { ok = false; break; } k *= 1 + r; } return { p1: p1 === null ? null : p1 * 100, p5: ok ? (k - 1) * 100 : null }; };
  const hotT = {}, hotR = {};
  for (const x of hotToday()) { const s = sectorOfName(x.name); if (s) (hotT[s] ??= []).push(x.name); }
  // 近期热点：最近一次上榜后不足 HOT_KEEP 个交易日（与热门池出池规则一致；池子没按时更新时页面也照样过期）
  const since = d => (S.result?.H?.dates ?? []).filter(x => x > d).length + (S.result?.H?.dates?.includes(today) ? 0 : 1);
  for (const b of S.hotPool?.boards ?? []) { const s = sectorOfName(b.name); if (s && b.lastHotDate && b.lastHotDate !== today && since(b.lastHotDate) < HOT_KEEP) { const d = b.lastHotDate.slice(5); if (!hotR[s] || hotR[s] < d) hotR[s] = d; } }
  if (S.hotPool?.asOf === today) for (const b of S.hotPool.boards) if (b.lastHotDate === today) { const s = sectorOfName(b.name); if (s && !(hotT[s] ?? []).includes(b.name)) (hotT[s] ??= []).push(b.name); }
  const key = fs.k === 'fT' ? 'p1' : 'p5';
  const rows = SECTORS.map(sec => {
    // 最新一天（盘中今日）成员须全部到齐才算大类均值，避免只用部分板块；更早的日子沿用「有数据的成员等权」
    const day = d => { const v = sec.boards.map(c => ret(c, d)); return strictLast && d === j && v.some(x => x === null) ? null : mean(v.filter(x => x !== null)); };
    const r1 = day(j); let k = 1, ok = true;
    for (let d = j - 4; d <= j; d++) { const r = day(d); if (r === null) { ok = false; break; } k *= 1 + r; }
    const branches = sec.branch ? sec.boards.map(c => ({ name: S.seed.boards[c]?.name ?? c, ...one(c) }))
      .sort((a, b) => (isNum(a[key]) ? 0 : 1) - (isNum(b[key]) ? 0 : 1) || fs.d * ((a[key] ?? 0) - (b[key] ?? 0))) : null;
    const names = sec.boards.map(c => S.seed.boards[c]?.name ?? c).join('、');
    const hs = hotT[sec.name];
    return { name: sec.name, pref: sec.pref, p1: r1 === null ? null : r1 * 100, p5: ok ? (k - 1) * 100 : null, branches,
      hotToday: hs?.length ?? 0, hotRecent: hotR[sec.name] ?? null,
      title: `成分：${names}${hs?.length ? `\n今日热门：${hs.join('、')}` : ''}${hotR[sec.name] ? `\n近期热点：${hotR[sec.name]}` : ''}` };
  });
  rows.sort((a, b) => (isNum(a[key]) ? 0 : 1) - (isNum(b[key]) ? 0 : 1) || fs.d * ((a[key] ?? 0) - (b[key] ?? 0)));
  return rows;
}

/** 收盘后补齐今日板块收盘：每轮最多 2 批 × 10 个 */
async function boardCatchup() {
  const today = S.calendar.date;
  const need = POLL_BOARDS.filter(c => S.today.boards[c]?.sourceDate !== today);
  for (let k = 0; k < 2 && need.length; k++) {
    const tb = await ds.getTHSBoardToday(need.splice(0, 10));
    for (const r of tb.rows ?? []) S.today.boards[r.code] = r;
  }
}

/** 情绪周期需要的个股日 K（高标见顶判断）：每轮最多 4 只 */
async function klineRound() {
  const codes = [...S.kQueue].slice(0, 4);
  const r = await ds.getStockKline(codes, 80);
  for (const [c, bars] of Object.entries(r.rows ?? {})) { S.stockK[c] = { bars, at: S.calendar?.date, time: Date.now() }; S.kQueue.delete(c); }
  for (const f of r.failed ?? []) S.kQueue.delete(f.code);
}

/* ---------------- 迷你 K 线（板块卡、外围科技） ---------------- */
const CHART_BARS = 20;          // 显示根数
const CHART_FETCH = 25;         // 多取 5 根用于 5 日线
const RETRY_MS = 10 * 60000;    // 失败后 10 分钟内不重试
/** 板块卡里的板块：近期已完成日 K 每天每个板块取一次（同花顺，不占东财额度），存浏览器；今日一根用实时轮询的当日 K。 */
async function boardKRound() {
  const f = S.result?.final; if (!f) return;
  const date = S.calendar.date;
  if (S.boardK?.date !== date) S.boardK = { date, rows: {} };
  const need = mainBoards(f).rows.map(b => b.code).filter(c => !S.boardK.rows[c] && Date.now() - (S.boardKFail[c] ?? 0) > RETRY_MS);
  if (!need.length) return;
  const r = await ds.getBoardRecentDaily(need.map(c => `ths:${c}`), CHART_FETCH);
  for (const g of r.groups ?? []) {
    const code = String(g.requestedBoard).replace('ths:', '');
    if (g.ok) S.boardK.rows[code] = g.rows.filter(x => x.date < date).map(x => [x.date, x.open, x.high, x.low, x.close]);
    else S.boardKFail[code] = Date.now();
  }
  if (!r.groups) for (const c of need) S.boardKFail[c] = Date.now();
  save('boardK', S.boardK);
}
/** 外围指数此刻应有的最新日 K 日期（只按周末推算，节假日会多判一次「过期」，最多多取一次） */
const isWeekday = d => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
const prevWeekday = d => { const t = new Date(`${d}T12:00:00Z`); do t.setUTCDate(t.getUTCDate() - 1); while (!isWeekday(t.toISOString().slice(0, 10))); return t.toISOString().slice(0, 10); };
function expectedLast(o, date, hm) {
  if (o.region === '美') return hm >= o.settle ? prevWeekday(date) : prevWeekday(prevWeekday(date));   // 美股北京时间次日清晨收盘
  return isWeekday(date) && hm >= o.settle ? date : prevWeekday(date);
}
/** 外围科技：优先用每日收盘更新写好的 data/overseas_daily.json（东财日 K 由本机统一取，浏览器端常被限流）；
 * 文件缺某个指数、或文件已过期（本机没开机、没跑更新）时才在浏览器取，取不到仍显示文件里的旧数据：每天每个指数一次，过了收定时刻再取一次；每轮最多 2 个请求，其中东财最多 1 个。日韩盘中每轮取一次现价（腾讯）。 */
async function overseasRound() {
  const date = S.calendar.date, hm = S.calendar.time.slice(0, 5);
  await applyOverseasFile();
  const stale = o => { const it = S.overseas.items[o.key]; return !it || it.fileStale || (it.at < o.settle && hm >= o.settle) || (it.viaEtf && Date.now() - it.t > 3 * RETRY_MS); };
  let n = 0, east = 0;
  for (const o of OVERSEAS) {
    if (n >= 2 || !stale(o) || Date.now() - (S.overseasFail[o.key] ?? 0) < RETRY_MS || (o.secid && east >= 1)) continue;
    n++; if (o.secid) east++;
    const r = await ds.getOverseasDaily(o.key, CHART_FETCH);
    if (r.ok) S.overseas.items[o.key] = { at: hm, t: Date.now(), rows: r.rows.map(x => [x.date, x.open, x.high, x.low, x.close]), viaEtf: r.viaEtf ?? null };
    else S.overseasFail[o.key] = Date.now();
  }
  if (n) save('overseasK', S.overseas);
  const dow = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  if (!S.overseasQ || (dow >= 1 && dow <= 5 && hm >= '08:00' && hm <= '14:40')) { const q = await ds.getOverseasQuotes(); if (q.ok) S.overseasQ = q; }
}
/** 盘前预判（云端 08:30 生成 data/premarket.json）：每天读一次，只在预测日当天显示 */
async function applyPremarket() {
  // 云端定时常晚到（10-22 计划 08:30、实际 09:10 才推送）：还没拿到当天的就每 5 分钟再取一次，拿到后当天不再取
  const date = S.calendar?.date; if (!date || S.premarket?.forDate === date) return;
  if (Date.now() - (S.pmTry ?? 0) < 5 * 60000) return;
  S.pmTry = Date.now(); S.premarket = await staticJSON('premarket.json').catch(() => S.premarket ?? null);
}
function premarketHTML() {
  const p = S.premarket; if (!p || p.forDate !== S.calendar?.date || !p.probs) return '';
  const pc = v => `${Math.round((v ?? 0) * 100)}%`;
  const items = [['维持', `维持${p.stage}`, 'flat'], ['进入下一阶段', p.next ? `进入${p.next}` : null, 'up'], ['回退', p.prev ? `回退${p.prev}` : null, 'down']]
    .filter(([, label]) => label);
  const top = items.reduce((a, b) => ((p.probs[b[0]] ?? 0) > (p.probs[a[0]] ?? 0) ? b : a));
  // 取整后几项相加须正好 100%（最大余数法）；非零项至少 1%、从最大项里扣（2026-10-23：维持 99.5% + 进入 0.5% 各自四舍五入成了 100% + 1%）
  const raw = items.map(([k]) => (p.probs[k] ?? 0) * 100), fl = raw.map(Math.floor);
  let left = 100 - fl.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - fl[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { fl[i]++; left--; } });
  fl.forEach((v, i) => { if (raw[i] > 0 && v === 0) { fl[i] = 1; fl[fl.indexOf(Math.max(...fl))]--; } });
  const shown = Object.fromEntries(items.map(([k], i) => [k, `${fl[i]}%`]));
  const bt = p.backtest ?? {}, lv = p.live ?? {};
  const hit = isNum(bt.top) ? `回测最可能命中 ${pc(bt.top)}${lv.n ? ` · 实盘 ${lv.hit}/${lv.n}` : ''}` : '';
  const tip = [`盘前阶段预判（${p.forDate}，基于 ${p.basedOn} 收盘；隔夜费城半导体 ${fmtPct(p.sox, 1)}，${p.bucket}档）`,
    ...items.map(([k, label]) => `${label} ${shown[k]}${p.need?.[k] ? `：${p.need[k]}` : ''}`),
    isNum(bt.brier) ? `滚动回测 ${bt.days} 天：Brier ${bt.brier}（只按阶段 ${bt.brierBase}），阶段真变化的日子事前给到 ${pc(bt.chgP)}` : '',
    hit,
    '只列阶段转移概率与历史统计，不构成操作建议'].filter(Boolean).join('\n');
  return `<div class="opp pm" title="${esc(tip)}"><b>盘前</b>${items.map(([k, label, cls]) => `<span class="o ${k === top[0] ? `${cls} pm-max` : ''}">${esc(label)} ${shown[k]}</span>`).join('')}${isNum(bt.top) ? `<span class="pm-hit">（回测命中 ${pc(bt.top)}${lv.n ? ` · 实盘 ${lv.hit}/${lv.n}` : ''}）</span>` : ''}</div>`;   // 只显示三个概率（2026-10-21 用户：费城半导体、回测命中不在行内显示，悬停仍可看）
}
/** 读每日更新写好的外围日 K 文件并套用（页面一打开就调用，不必等第一轮轮询；文件每天只取一次） */
async function applyOverseasFile() {
  const date = S.calendar?.date, hm = S.calendar?.time?.slice(0, 5); if (!date) return;
  if (S.overseas?.date !== date) S.overseas = { date, items: {} };
  if (S.overseasFileDay !== date) { S.overseasFileDay = date; S.overseasFile = await staticJSON('overseas_daily.json').catch(() => null); }
  for (const o of OVERSEAS) {
    const f = S.overseasFile?.items?.[o.key]; if (!f?.rows?.length) continue;
    // 日韩收定前，文件里当天那根是取数时的盘中价，丢掉，由腾讯现价画当天示意
    const rows = f.rows.filter(r => !(o.quote && r[0] === date && hm < o.settle)); if (!rows.length) continue;
    const it = S.overseas.items[o.key], fileLast = rows.at(-1)[0], itLast = it?.rows?.at(-1)?.[0];
    if (!it || it.file || itLast < fileLast || (it.viaEtf && itLast <= fileLast))
      S.overseas.items[o.key] = { at: '99:99', t: Date.now(), rows, viaEtf: null, file: true, fileStale: fileLast < expectedLast(o, date, hm) };
  }
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
  const needBoards = POLL_BOARDS.filter(c => miss.some(d => !isNum(ex.boards[c]?.[d])));
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
  // 涨跌停与涨停池：同花顺一次请求（每轮一个交易日）
  const d = miss.find(x => !ex.limits[x] || !ex.pools?.[x]);
  if (d) {
    const th = await ds.getTHSLimitThemes(d);
    if (th.ok && !th.partial && th.counts && isNum(th.counts.up)) {
      const lbc = th.rows.map(r => r.consecutive).filter(isNum), tt = themeTop(th.rows.map(r => r.reasonText));
      ex.pools[d] = th.rows.map(r => [r.code, r.name, r.reasonText]);
      ex.limits[d] = { up: th.counts.up, down: th.counts.down, broken: th.counts.broken, height: lbc.length ? Math.max(...lbc) : 0, lad3: lbc.filter(v => v >= 3).length, theme: tt.count, themeName: tt.name };
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
  const limitsDone = miss.filter(d => ex.limits[d] && ex.pools?.[d]).length;
  S.backfill = { missing: miss, boardsDone, limitsDone, complete: !miss.length || (boardsDone === ALL_BOARDS.length && limitsDone === miss.length), tooOld: miss.length > 55 };
}

async function warmup() {
  if (!S.seed) S.seed = await staticJSON('market_seed.json');
  if (!S.timeline) S.timeline = await staticJSON('regime_timeline.json').catch(() => null);
  if (!S.hotPool) S.hotPool = await staticJSON('hot_boards.json').catch(() => null);
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
  if (!S.boardK) S.boardK = load('boardK', null);
  if (!S.overseas) S.overseas = load('overseasK', null);
  updateBackfill();
}

/** 快速轮：盘中只刷新腾讯指数报价与成交额，随即重新判定并渲染（主轮在等同花顺等慢请求时照样运行，判定与渲染是同步的，不会交错） */
async function quickTick() {
  if (S.quickBusy || !S.calendar?.refreshRecommended || !S.result) return;
  S.quickBusy = true;
  try {
    const q = await ds.getIndexQuotes(); if (q.ok) S.today.quotes = q;
    const tv = await ds.getProjectedTurnover(); if (tv.ok) S.today.turnover = tv;
    S.lastTickAt = new Date(); evaluate(); render();
  } catch (e) { /* 快速轮失败不影响主轮 */ } finally { S.quickBusy = false; }
}

async function tick() {
  if (S.busy) return;
  S.busy = true;
  try {
    S.calendar = await ds.getTradingCalendar();
    // 页面跨日一直开着：换日后整页重载，重新取种子、盘前预判等当日文件，避免沿用前一天的状态
    S.bootDate ??= S.calendar?.date;
    if (S.calendar?.date && S.calendar.date !== S.bootDate) { location.reload(); return; }
    await applyOverseasFile();   // 外围日 K 文件先套用，页面一打开就有 K 线
    await applyPremarket();
    ds.beginRefresh();
    const needWarm = !S.seed || !S.indexDaily || S.indexDaily.date !== S.calendar.date;
    if (needWarm) {
      await warmup();
      // 预热后立即取一次实时行情，打开页面十几秒内就能看到指数与量能
      const q = await ds.getIndexQuotes(); if (q.ok || !S.today.quotes) S.today.quotes = q;
      const tv = await ds.getProjectedTurnover(); if (tv.ok || !S.today.turnover) S.today.turnover = tv;
    }
    // 种子过期时先补数（最多 20 轮；补不齐的日期按缺失显示，不估算）
    if (!needWarm && !S.backfill.complete && !S.backfill.tooOld && (S.backfill.attempts ?? 0) <= 30) {
      S.backfill.attempts = (S.backfill.attempts ?? 0) + 1;
      const q = await ds.getIndexQuotes(); if (q.ok || !S.today.quotes) S.today.quotes = q;
      const tv = await ds.getProjectedTurnover(); if (tv.ok || !S.today.turnover) S.today.turnover = tv;
      // 先把实时行情显示出来，再慢慢补历史（补一轮约需一分钟，不让页面停在「行情断开」）
      S.lastTickAt = new Date();
      try { evaluate(); } catch (e) { S.lastError = `判定失败：${e.message}`; }
      render();
      const attempts = S.backfill.attempts;
      // 盘中：补历史与实时轮交替，今日板块不必等历史补完
      if (S.calendar.refreshRecommended && attempts % 2 === 0) { await ordinaryRound(); S.tick++; }
      else await backfillRound();
      S.backfill.attempts = attempts;
    } else if (!needWarm && (S.calendar.refreshRecommended || !S.today.quotes)) {
      const st = S.result?.final?.state;
      if (S.tick % 5 === 4 && (st === '震荡' || st === '筑底') && S.calendar.isTradingDay) await wideRound();
      else await ordinaryRound();
      S.tick++;
    }
    if (!needWarm && !S.calendar.refreshRecommended && S.hotTick < 3) await hotRound();
    // 收盘后打开页面：主动取回今日板块收盘（盘中轮询已停），否则板块强弱只能退回上一交易日
    if (!needWarm && S.calendar.isTradingDay && !S.calendar.refreshRecommended && S.calendar.time >= '15:00') await boardCatchup();
    if (!needWarm && S.kQueue.size) await klineRound();
    if (!needWarm) { await boardKRound(); await overseasRound(); }
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
  S.result = { ...out, todayAppended, H, yesterday: confirmedRows.at(-1), stateSince: since, stateDays: since ? out.rows.filter(r => r.date >= since).length : null,
    declineSince: declineCycleStart(out.rows) };
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
  const { cycles: live, missing, stale } = cycleReplay({ dates, pools, kline, feat: featFromRows(rows), startAfter });
  const fixed = (S.timeline?.cycles ?? []).filter(c => !startAfter || c.start <= startAfter);
  const all = [...fixed, ...live];
  const last = all.at(-1), lastDate = dates.at(-1);
  const active = last && !last.end ? last : null;
  // 需要最新日 K 的个股：周期回放缺失的 + 活跃周期的当前高标（种子之后的交易日）
  for (const c of missing) S.kQueue.add(c);
  for (const [c, d] of stale) {
    const have = S.stockK[c];
    if (d > through && !(have?.bars?.[d]) && (!have || Date.now() - have.time > 30 * 60000)) S.kQueue.add(c);
  }
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
    const downToday = S.result.final?.dn;
    for (const [ln, nm] of [[active.main, '主线'], [active.comp, '伴生线']]) {
      if (!ln || (ln.hLimits ?? 0) < 2 || (isNum(downToday) && downToday >= P.PANIC_DOWN)) continue;
      const h = ln.chain.at(-1), bars = kline(h.code), i = dates.length - 1;
      const r = bars?.[dates[i]], p = bars?.[dates[i - 1]];
      if (!r || !p || todayPool[h.code]) continue;
      const chg = (r.close / p.close - 1) * 100, amp = (r.high - r.low) / p.close * 100, fh = (r.close / r.high - 1) * 100;
      const sig = amp >= P.SHAKE_AMP && fh <= -P.SHAKE_FROM_HIGH ? '巨震' : chg <= P.DROP ? '大跌' : (nm === '伴生线' || ln.chain.length === 1) && chg < P.STALL && !pools[dates[i - 1]]?.[h.code] ? '滞涨' : null;
      if (sig) hints.push({ kind: '高标见顶', line: nm, isLeader: nm === '主线' && ln.chain.length === 1, name: h.name, signal: sig, firsts: Object.entries(todayPool).filter(([c]) => !ln.chain.some(x => x.code === c)).slice(0, 4).map(([, v]) => v[0]) });
    }
    if (active.main.rounds.length && todayPool[active.leader.code]) hints.push({ kind: '龙头反抽', name: active.leader.name });
  }
  // 龙头已出现首次见顶信号（回放确认，或今日盘中试算）→ 情绪仓位由半仓转观望
  const topped = !!active?.leaderTop || hints.some(h => h.isLeader);
  S.emo = { cycles: all, active, last, phase, since, topped, position: cyclePosition(phase, topped), hints, lastDate };
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
  if (t >= '11:30' && t < '13:00') return { label: '午间休市', alertLevel: null };
  if (t >= '15:00') return { label: '收盘 · 定格', alertLevel: null };
  const level = alertLevelAt(t, c.isTradingDay);
  return { label: level === '确认' ? '尾盘 · 确认' : '盘中 · 预警', alertLevel: level };
}

const EVENT_TEXT = {
  '共振爆发': lead => `共振爆发：主线板块「${FAMILY_LABEL[lead] ?? lead}」。按规则：可快速提升至重仓（1–2 笔），优先领涨集团或对应 ETF${PREFERENCE_EXCLUDED.includes(lead) ? '（该板块为偏好不参与）' : ''}。`,
  '风险降仓': () => '风险信号叠加：按规则降至半仓。',
  '破位清仓': () => '主线破位：按规则清仓观望。',
  '全A跌破10日线': () => '全A 跌破 10 日线，主升环境破坏：按规则清仓，转入震荡观望。',
  '转入主跌': () => '指数转入主跌：按规则空仓，不抄底。',
  '主跌结束（企稳）': () => '指数站上 5 日线，主跌暂告段落：转入筑底，继续空仓等待共振。',
  '主线切换': lead => `主线切换至「${FAMILY_LABEL[lead] ?? lead}」：按规则调仓，仓位不变。`,
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
  const { events: evs, known } = emoAlertEvents(e, today, load('emoKnown', {}), S.seed.through ?? '');
  for (const k of Object.keys(known)) if (known[k] < S.seed.through) delete known[k];
  save('emoKnown', known);
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

const APP_VERSION = '2026.10.23a';
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
/** 下跌周期起点（2026-10-22 用户规则）：主跌 → 筑底/震荡 → 主跌，中间没有出现反弹（指数站上 5、10 日线且 5 日线上拐）或大主升，
 * 仍算同一下跌周期，领跌板块与「主跌以来」都从最早那段主跌的起点算。与 研究/回测/build_timeline.py 同口径。 */
function declineCycleStart(rows) {
  const last = rows.at(-1); if (!last || last.state !== '主跌') return null;
  let start = null;
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = rows[k];
    if (r.state.startsWith('大主升') || ((r.state === '筑底' || r.state === '震荡') && r.A1 === true)) break;
    if (r.state === '主跌') start = r.date;
  }
  return start;
}
/** 主跌领跌板块是否止跌：当前主跌段（或 30 个交易日内最近一段主跌）区间跌幅最大的板块，站上 5 日线且近 3 日未创主跌以来新低。仅参考，不参与判定 */
function leaderStop() {
  const r = S.result, H = r?.H; if (!H) return null;
  let start = r.final?.state === '主跌' ? (r.declineSince ?? r.stateSince) : null;
  if (!start) {
    const segs = indexSegs(), last = [...segs].reverse().find(g => g.state === '主跌');
    if (last && H.dates.length - 1 - H.dates.indexOf(last.end) <= 30) start = last.start;
  }
  const lead = start ? declineLeaders(start, 1)?.[0] : null; if (!lead) return null;
  const k = H.dates.indexOf(start), all = H.boards[lead.code].close;
  const s = all.slice(k).filter(isNum); if (s.length < 5) return { ok: null, read: `${lead.name} 主跌以来交易日不足 5 天` };
  const cur = s.at(-1), ma5 = s.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const priorLow = s.length > 3 ? Math.min(...s.slice(0, -3)) : Infinity, recentLow = Math.min(...s.slice(-3));
  const above = cur > ma5, noNewLow = recentLow > priorLow;
  return { ok: above && noNewLow, read: `${lead.name} ${above ? '站上' : '低于'} 5 日线，近 3 日${noNewLow ? '未再创新低' : '仍创新低'}` };
}
function condGroups(f) {
  const P = PARAMS, lead = f.leadShown, today = S.result.todayAppended;
  const volText = isNum(f.vr) ? `${fmtYi(f.amt)}${today && S.today.amtSource ? `（${S.today.amtSource}）` : ''}，${f.vr.toFixed(2)} 倍 20 日均量` : '量能未知';
  const famRead = isNum(f.f5?.[lead]) ? `${FAMILY_LABEL[lead] ?? lead} 近5日 ${fmtPct(f.f5[lead], 1)}，今日前6含 ${f.cnt}、5日前6含 ${f.cnt5}` : '板块数据未就绪';
  const syncRead = isNum(f.fT?.[lead]) && isNum(f.p1) ? `指数 ${fmtPct(f.p1)}，${lead} ${fmtPct(f.fT[lead])}` : '未知';
  const f1v = f.f1full ? true : f.f1part ? null : false;
  const g = v => (v === true ? '✓' : v === false ? '×' : '?');
  const gateRead = `全A ${g(f.gA)}　热股 ${g(f.gHot)}　昨成交10 ${g(f.gZ10)}`;
  const holding = f.state.startsWith('大主升');
  const RISK_LABEL = { '主线族巨震': '主线板块巨震', '主线族连续2日跌破5日线': '主线板块连续2日跌破5日线' };   // 引擎内部名 → 显示名
  const riskItem = (name, short, read) => [holding ? (f.risk.includes(name) ? true : f.riskUnknown.includes(name) ? null : false) : null, RISK_LABEL[name] ?? name, short, holding ? read : '仅在主升状态检查'];
  return [
    { key: 'res', title: '共振条件', items: [
      [f.gate, '全A、热股、昨成交10 都在 10 日线上', '主升环境', gateRead, 'gate'],
      [f.A1, '指数站上 5 日线和 10 日线，5 日线上拐', '站上均线', isNum(f.close) ? `上证 ${f.close.toFixed(2)}，MA5 ${f.m5?.toFixed(2) ?? '—'}，MA10 ${f.m10?.toFixed(2) ?? '—'}` : '未知'],
      [isNum(f.vr) ? f.volOk === true : null, f.f1full ? `量能放大（≥ ${P.VR_UP} 倍）` : f.f1part ? `量能放大（未完成二次探底，需 ≥ ${P.VR_UP_SOFT} 倍）` : '量能放大（超跌后须先出现第一波反弹）', '量能放大', volText],
      [f.volVsDecline, '量能不低于此前下跌阶段', '量超下跌段', isNum(f.a60) ? `前 60 日均量 ${fmtYi(f.a60)}` : '60 日均量不足'],
      [f.collective, '主线板块集体走强', '主线集体走强', famRead],
      [f.sync, '主线与指数同步上涨', '主线同步', syncRead],
      [f1v, '已完成二次探底', '二次探底', f.f1 ? `进度：${F1_STEPS.slice(0, f.f1).join(' → ')}` : '近期未出现超跌'],
    ] },
    { key: 'down', title: '主跌条件', items: [
      [f.D1, '指数在 5 日线下，5 日线下拐', '破5日线', isNum(f.close) && isNum(f.m5) ? `上证 ${f.close.toFixed(2)}，MA5 ${f.m5.toFixed(2)}` : '未知'],
      [f.mainFall, '最弱板块仍在领跌', '弱板领跌', isNum(f.f5?.[f.weak]) ? `${FAMILY_LABEL[f.weak] ?? f.weak} 近5日 ${fmtPct(f.f5[f.weak], 1)}，今日 ${fmtPct(f.fT[f.weak])}` : '未知'],
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
      riskItem('主线族巨震', '主线巨震', `${FAMILY_LABEL[lead] ?? lead} 今日 ${fmtPct(f.fT?.[lead])}`),
      riskItem('主线族连续2日跌破5日线', '主线破5日线', `${FAMILY_LABEL[lead] ?? lead}`),
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
function itemHTML([v, label, short, read, extra], mobile = false) {
  const c = cls3(v);
  const tag = mobile ? 'button' : 'li';
  const state = c === 'y' ? '满足' : c === 'n' ? '不满足' : '数据未知';
  return `<${tag}${mobile ? ` type="button" aria-label="${esc(label)}，${state}，${esc(read)}"` : ''} class="ci ${c}${extra ? ` ${extra}` : ''}" data-label="${esc(label)}" data-read="${esc(read)}" title="${esc(label)}：${esc(read)}"><span class="ic ${c}" aria-label="${state}">${ICON[c]}</span><span class="lab"><span class="full">${esc(label)}</span><span class="short">${esc(short)}</span></span><span class="rd">${esc(read)}</span></${tag}>`;
}
function countHTML(items) {
  const hit = items.filter(x => x[0] === true).length, unk = items.filter(x => x[0] !== true && x[0] !== false).length;
  return `<span class="cnt"><b>${hit}</b>/${items.length}${unk ? ` · ?${unk}` : ''}</span>`;
}
function groupCard(g, extra = '') {
  const no = { res: '01', down: '02', emo: '03', risk: '04', ref: '05' }[g.key];
  const idle = g.items.length > 1 && g.items.every(x => x[3] === g.items[0][3]) && g.items[0][3] === '仅在主升状态检查';
  return `<section class="card condition-card desk-only ${extra}${idle ? ' idle' : ''}" data-group="${g.key}"><h3><span class="section-no" aria-hidden="true">${no}</span>${esc(g.title)}${idle ? '<small class="idle-note">仅在主升状态检查</small>' : ''}${g.items.filter(x => x[4] === 'gate').map(x => `<small class="gate-note ${cls3(x[0])}">${esc(x[2])} ${esc(x[3])}</small>`).join('')}${countHTML(g.items)}</h3><ul class="cl">${g.items.map(item => itemHTML(item)).join('')}</ul></section>`;
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
/** 板块涨跌：今日、近 5 日；k 为区间起点下标时另算区间涨跌（起点前一日收盘 → 最新） */
function boardStats(fam, k = null) {
  const H = S.result.H, i = H.dates.length - 1;
  return FAMILIES[fam].filter(c => H.boards[c]).map(c => {
    const s = H.boards[c].close;
    return { code: c, name: S.seed.boards[c]?.name ?? c, fam,
      p1: isNum(s[i]) && isNum(s[i - 1]) ? (s[i] / s[i - 1] - 1) * 100 : null,
      p5: isNum(s[i]) && isNum(s[i - 5]) ? (s[i] / s[i - 5] - 1) * 100 : null,
      pS: k !== null && k > 0 && isNum(s[k - 1]) ? (v => (isNum(v) ? (v / s[k - 1] - 1) * 100 : null))(lastNum(s, i, k)) : null };
  });
}
/** 从 i 往回找最近一个有效收盘（不早于 k）：盘中板块未载入或补数未完成时，区间涨跌先用最新已知收盘 */
function lastNum(s, i, k) { for (let j = i; j >= k; j--) if (isNum(s[j])) return s[j]; return null; }
/** 主跌以来领跌：全部板块按主跌起点至今的区间跌幅排序 */
function declineLeaders(since, n = 3) {
  const k = S.result.H.dates.indexOf(since); if (k < 1) return null;
  return Object.keys(FAMILIES).flatMap(f => boardStats(f, k)).filter(b => isNum(b.pS)).sort((a, b) => a.pS - b.pS).slice(0, n);
}
function mainBoards(f) {
  if (f.state.startsWith('大主升') || (f.collective === true && f.state !== '主跌'))
    return { role: '主流板块', rows: boardStats(f.leadShown).sort((a, b) => (b.p5 ?? -99) - (a.p5 ?? -99)).slice(0, 2).map(x => ({ ...x, etf: etfFor(x.code) })) };
  const ds = S.result.declineSince ?? S.result.stateSince;
  if (f.state === '主跌' && ds) {
    const rows = declineLeaders(ds);
    const same = ds !== S.result.stateSince ? '（中间未反弹，同一下跌周期）' : '';
    if (rows) return { role: '领跌板块', note: `自 ${ds.slice(5)} 主跌以来${same} · 最多 3 个`, since: true, rows };
  }
  if (f.state === '主跌' || f.mainFall === true)
    return { role: '领跌板块', note: '近 5 日最弱板块 · 最多 3 个', rows: boardStats(f.weak).sort((a, b) => (a.p5 ?? 99) - (b.p5 ?? 99)).slice(0, 3) };
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
    <div class="act">${esc(pref ? '主线为偏好不参与的板块（外围驱动）：按规则观望' : ACTION[f.state])}</div>${oppHTML('mob-only')}
    <div class="kpis">
      ${kpi('上证指数', isNum(f.close) ? `${f.close.toFixed(2)} <small class="${sign(f.p1)}">${fmtPct(f.p1)}</small>` : '—', '')}
      ${kpi(r.todayAppended && S.today.amtSource ? `全天量能（${S.today.amtSource.replace('全天', '')}）` : '成交额', isNum(f.amt) ? `${fmtYi(f.amt).replace(' ', '')} <small>×${isNum(f.vr) ? f.vr.toFixed(2) : '—'}</small>` : '—', '',
        r.todayAppended ? (isNum(vsY) ? `较昨日 <span class="${sign(vsY)}">${fmtPct(vsY, 1)}</span>` : '较昨日 —') : '')}
      ${kpi('全指 RSI12', isNum(f.rsi) ? `${f.rsi.toFixed(1)} <small>${rsiZone(f.rsi)}${isNum(rsiStreak()) ? `（连续 ${rsiStreak()} 天）` : ''}</small>` : '—', isNum(f.rsi) && f.rsi < 30 ? 'g' : isNum(f.rsi) && f.rsi > 70 ? 'r' : '', '（&lt;30 超跌 · &gt;70 超买）')}
    </div>
    <div class="steps" title="二次探底进度">${steps}</div>
    <div class="steps-lab">${F1_STEPS.map(s => `<span>${s}</span>`).join('')}</div>
    ${r.todayAppended && f.event ? `<div class="tent">今日试算：${esc(f.event)}（昨日确认：${esc(STAGE_META[y?.state]?.name ?? '—')}）${phaseInfo().alertLevel ? '' : '，非提醒时段'}</div>`
      : lastAlert ? `<div class="tent">最近提醒 ${esc(new Date(lastAlert.at).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5))}：${esc(lastAlert.event)}</div>` : ''}
  </section>`;
}
/** 迷你 K 线（SVG）：红涨绿跌，细线为 5 日均线；盘中未收定的一根画成虚线空心。bars 含前置的 5 日线计算根。 */
function sparkK(all, w = 76, h = 22) {
  if (!all?.length) return `<span class="kspark empty" style="width:${w}px" title="K 线暂缺">—</span>`;
  const bars = all.slice(-CHART_BARS), off = all.length - bars.length;
  const ma = bars.map((_, i) => { const k = off + i; return k >= 4 ? all.slice(k - 4, k + 1).reduce((a, b) => a + b.c, 0) / 5 : null; });
  const hi = Math.max(...bars.map(b => b.h), ...ma.filter(isNum)), lo = Math.min(...bars.map(b => b.l), ...ma.filter(isNum)), span = hi - lo || 1;
  const step = w / CHART_BARS, bw = Math.max(1.4, step * 0.6), x0 = (CHART_BARS - bars.length) * step;
  const y = v => (((hi - v) / span) * (h - 2) + 1).toFixed(1), xc = i => (x0 + i * step + step / 2).toFixed(1);
  const candles = bars.map((b, i) => {
    const top = Math.max(b.o, b.c), bh = Math.max(0.8, Math.abs(y(b.o) - y(b.c)));
    return `<g class="${b.c >= b.o ? 'ku' : 'kd'}${b.live ? ' live' : ''}"><line x1="${xc(i)}" x2="${xc(i)}" y1="${y(b.h)}" y2="${y(b.l)}"/><rect x="${(x0 + i * step + (step - bw) / 2).toFixed(1)}" y="${y(top)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"/></g>`;
  }).join('');
  const pts = ma.map((v, i) => (isNum(v) ? `${xc(i)},${y(v)}` : null)).filter(Boolean).join(' ');
  const last = bars.at(-1);
  const tip = `近 ${bars.length} 个交易日 K 线（${bars[0].date.slice(5)} 至 ${last.date.slice(5)}），细线为 5 日均线${last.live ? (last.approx ? '；最后一根为盘中，只示意昨收到现价' : '；最后一根为盘中') : ''}`;
  return `<svg class="kspark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(tip)}"><title>${esc(tip)}</title>${candles}${pts ? `<polyline class="ma" points="${pts}"/>` : ''}</svg>`;
}
/** 板块近期日 K：已完成日（按日缓存）+ 今日（实时轮询到的当日 K 有开高低才画） */
function boardBars(code) {
  const base = S.boardK?.rows?.[code]; if (!base?.length) return null;
  const bars = base.map(([date, o, h, l, c]) => ({ date, o, h, l, c }));
  const t = S.today.boards[code];
  if (t?.sourceDate === S.calendar?.date && t.sourceDate > bars.at(-1).date && [t.open, t.high, t.low, t.close].every(isNum))
    bars.push({ date: t.sourceDate, o: t.open, h: t.high, l: t.low, c: t.close, live: !!S.calendar?.refreshRecommended });
  return bars;
}
/** 外围指数日 K + 日韩盘中现价：同一天则更新最后一根，否则追加一根示意（腾讯简版报价没有开高低） */
function overseasBars(o) {
  const it = S.overseas?.items?.[o.key]; if (!it?.rows?.length) return null;
  const bars = it.rows.map(([date, op, h, l, c]) => ({ date, o: op, h, l, c }));
  const q = o.quote && S.overseasQ?.rows?.find(r => r.symbol === o.quote), last = bars.at(-1);
  if (q && q.sourceDate === last.date) Object.assign(last, { c: q.price, h: Math.max(last.h, q.price), l: Math.min(last.l, q.price), live: true });
  else if (q && q.sourceDate > last.date) bars.push({ date: q.sourceDate, o: q.previousClose, h: Math.max(q.previousClose, q.price), l: Math.min(q.previousClose, q.price), c: q.price, live: true, approx: true });
  return bars;
}
const barPct = b => (b?.length >= 2 ? (b.at(-1).c / b.at(-2).c - 1) * 100 : null);
/** 外围科技：美日韩科技权重指数，只列客观涨跌与近期 K 线 */
function overseasData() {
  return OVERSEAS.map(o => {
    const bars = overseasBars(o), it = S.overseas?.items?.[o.key], q = o.quote && S.overseasQ?.rows?.find(r => r.symbol === o.quote);
    // 日 K 暂缺（如东财冷却）时，涨跌幅退回腾讯报价
    const last = bars?.at(-1) ?? (q ? { date: q.sourceDate } : null), pct = bars ? barPct(bars) : q?.pct ?? null;
    const when = last ? (last.live ? `${last.date.slice(5)} 盘中` : `${last.date.slice(5)}${bars ? ' 收盘' : ''}`) : '暂无数据';
    const via = it?.viaEtf ? `（以 ${it.viaEtf} ETF 代替）` : '';
    return { o, bars, last, pct, via, title: `${o.region} · ${o.name}${via}：${when} ${fmtPct(pct)}` };
  });
}
function overseasHTML() {
  const rows = overseasData();
  const cells = rows.map(r => `<div class="os" title="${esc(r.title)}"><span class="nm">${esc(r.o.name)}${r.via ? '<sup>*</sup>' : ''}</span><span class="pc ${sign(r.pct)}">${fmtPct(r.pct)}</span>${sparkK(r.bars, 56, 20)}</div>`).join('');
  const dateOf = region => { const l = rows.filter(r => region.includes(r.o.region)).map(r => r.last).find(Boolean); return l ? `${l.date.slice(5)}${l.live ? ' 盘中' : ''}` : '—'; };
  return `<section class="card os-card desk-only" title="美日韩科技权重指数，迷你 K 线为近 ${CHART_BARS} 个交易日"><h3>外围科技<span class="cnt">美 ${dateOf('美')}<br>日韩 ${dateOf('日韩')}</span></h3><div class="os-grid">${cells}</div></section>`;
}
/** 手机：外围科技嵌在板块卡底部，每格两行（名称 / 涨跌 + 小 K 线），省掉单独卡片的高度 */
function overseasInline() {
  const cells = overseasData().map(r => `<div class="osm" title="${esc(r.title)}"><span class="nm">${esc(r.o.name)}${r.via ? '<sup>*</sup>' : ''}</span><span class="pc ${sign(r.pct)}">${fmtPct(r.pct, 1)}</span>${sparkK(r.bars, 34, 14)}</div>`).join('');
  return `<footer class="os-inline mob-only"><b class="os-lab">外围<br>科技</b>${cells}</footer>`;
}
function boardsHTML(f) {
  const mb = mainBoards(f);
  const rows = mb.rows.map(b => `<div class="bd${mb.since ? ' three' : ''}"><div><span class="nm">${esc(b.name)}</span><span class="tag">${esc(FAMILY_LABEL[b.fam] ?? b.fam)}${PREFERENCE_EXCLUDED.includes(b.fam) ? ' · 偏好不参与' : ''}</span></div>
    <div class="v"><small>今日</small><span class="${sign(b.p1)}">${fmtPct(b.p1)}</span></div>${mb.since ? `<div class="v"><small>主跌以来</small><span class="${sign(b.pS)}">${fmtPct(b.pS, 1)}</span></div>` : ''}<div class="v"><small>5日</small><span class="${sign(b.p5)}">${fmtPct(b.p5, 1)}</span></div>${sparkK(boardBars(b.code), 64, 22)}
    ${b.etf ? `<div class="etf" title="跟踪 ${esc(b.etf.index)}；按截至 ${esc(b.etf.asOf)} 的 20 日成交额选取">ETF：${esc(b.etf.name)}（${esc(b.etf.code)}）· ${esc(b.etf.index)}</div>` : ''}</div>`).join('');
  return `<section class="card board-card"><h3>${mb.role}<span class="cnt mid-hide">${esc(mb.note ?? '最多 2 个')}</span><span class="cnt mid-only">${mb.since ? '今日 · 主跌以来 · 5日' : '今日 · 5日'}</span></h3>${rows || '<p class="muted">无主线：未出现集体走强且与指数同步的板块</p>'}${overseasInline()}</section>`;
}
/** 左列下部：板块强弱（任何阶段都显示，固定在上）+ 状态卡（主升/情绪周期 → 领涨集团；震荡/筑底 → 小仓套利；主跌无）。
 * 主跌期板块强弱占满剩余高度；有状态卡时状态卡限高，板块强弱保持固定长度，不会被挤没（2026-10-21 用户要求） */
function extraHTML(f) {
  return sectorHTML(f) + stateCardHTML(f);
}
function stateCardHTML(f) {
  if ((f.state.startsWith('大主升') || S.emo?.active) && S.today.top?.ok) {
    const lg = S.today.top.rows.filter(x => isNum(x.pct) && x.pct >= 3).slice(0, 6);
    return `<section class="card state-card desk-only"><h3>领涨集团<span class="cnt">成交额前20 · 涨幅≥3%</span></h3>${lg.length ? `<table class="mini"><thead><tr><th>名称</th><th>涨幅</th><th>成交额</th></tr></thead><tbody>${lg.map(x => `<tr><td>${esc(x.name)}</td><td class="r">${fmtPct(x.pct)}</td><td>${fmtYi(x.amount)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">暂无满足条件的个股</p>'}<p class="note">仅展示客观行情，不构成投资建议</p></section>`;
  }
  if (f.state === '震荡' || f.state === '筑底') {
    const H = S.result.H, lowNow = H.sh.low.at(-1), prev = H.sh.low.slice(-21, -1).filter(isNum);
    const rebound = S.result.todayAppended && isNum(lowNow) && prev.length && lowNow <= Math.min(...prev) * 1.003 && f.close >= lowNow * 1.005;
    const w = S.today.wide;
    return `<section class="card state-card desk-only"><h3>小仓套利</h3><p class="muted">${rebound ? '指数破位后被拉回：按规则可小仓博宽基 ETF 回拉，空间有限' : '暂无指数破位拉回机会'}</p>
      ${w?.ok ? `<table class="mini"><thead><tr><th>宽幅候选</th><th>振幅</th><th>20日均</th><th>堆量</th><th>反包</th></tr></thead><tbody>${w.rows.slice(0, 5).map(x => `<tr><td>${esc(x.name)}</td><td>${x.currentAmplitudePct.toFixed(1)}%</td><td>${x.averageAmplitude20Pct.toFixed(1)}%</td><td>${x.accumulationRatio.toFixed(2)}</td><td>${x.reversalCount20}</td></tr>`).join('')}</tbody></table><p class="note">只列客观数据，约每 5 分钟更新</p>` : '<p class="note">宽幅震荡候选约每 5 分钟扫描一次</p>'}</section>`;
  }
  return '';
}
function sectorHTML(f) {
  const tb = Object.values(S.today.boards).filter(b => b.sourceDate === S.calendar?.date).length;
  const partial = S.result.todayAppended && tb < ALL_BOARDS.length;
  // 始终用最新一天（盘中即今日），与领跌/主流板块卡同一口径；今日还没轮询到的板块显示「…」，大类须成员全部到齐才计算（2026-10-20 改：
  // 原先今日未齐时整表退回上一交易日，和领跌板块卡的今日数据对不上）。只有最新一天几乎全空（如补数中）才退回最近齐全的一天。
  const H = S.result.H;
  const full = j => POLL_BOARDS.filter(c => isNum(H.boards[c]?.close[j])).length >= POLL_BOARDS.length - 2;
  let j = H.dates.length - 1;
  const live = S.result.todayAppended && H.dates[j] === S.calendar?.date;
  if (!live && !full(j)) { while (j > 0 && !full(j)) j--; }
  const famOf = Object.fromEntries(Object.entries(FAMILIES).flatMap(([fam, cs]) => cs.map(c => [c, fam])));
  const rows = [...new Set(ALL_BOARDS)].filter(c => H.boards[c]).map(c => {
    const x = H.boards[c].close;
    return { code: c, name: S.seed.boards[c]?.name ?? c, fam: famOf[c],
      p1: isNum(x[j]) && isNum(x[j - 1]) ? (x[j] / x[j - 1] - 1) * 100 : null,
      p5: isNum(x[j]) && isNum(x[j - 5]) ? (x[j] / x[j - 5] - 1) * 100 : null };
  });
  // 排序：点表头切换（今日 / 近5日，大→小 / 小→大），选择记在本机
  const fs = load('famSort', { k: 'f5', d: -1 }), key = fs.k === 'fT' ? 'p1' : 'p5';
  rows.sort((a, b) => (isNum(a[key]) ? 0 : 1) - (isNum(b[key]) ? 0 : 1) || fs.d * ((a[key] ?? 0) - (b[key] ?? 0)));
  const byP5 = [...rows].filter(r => isNum(r.p5)).sort((a, b) => b.p5 - a.p5);
  const th = (k, label) => `<th><button type="button" class="sort${fs.k === k ? '' : ' off'}" data-sort="${k}" title="点击按${label}排序：${fs.k === k && fs.d === -1 ? '改为从小到大' : '从大到小'}">${label}<span class="ar">${fs.k === k ? (fs.d === -1 ? '↓' : '↑') : '↕'}</span></button></th>`;
  const head = j < H.dates.length - 1 || partial ? `截至 ${esc(H.dates[j].slice(5))} · 今日板块 ${tb}/${ALL_BOARDS.length}` : `${rows.length} 个板块 · 按${fs.k === 'fT' ? '今日' : '近 5 日'}${fs.d === -1 ? '从大到小' : '从小到大'}`;
  const isToday = H.dates[j] === S.calendar?.date;
  const dayLabel = isToday ? '今日' : H.dates[j].slice(5);
  const sec = sectorRows(j, fs, isToday);
  if (sec.length) {
    const hb = [...sec].filter(r => isNum(r.p5)).sort((a, b) => b.p5 - a.p5);
    const asOf = isToday ? (partial ? `今日 · 轮询中 ${tb}/${ALL_BOARDS.length}` : '今日') : `截至 ${esc(H.dates[j].slice(5))}`;
    const td = (v, d = 2, wait = false) => `<td class="${sign(v)}"${wait && !isNum(v) ? ' title="今日数据轮询中"' : ''}>${wait && !isNum(v) ? '…' : fmtPct(v, d)}</td>`;
    const body = sec.map((r, k) => `<tr class="sec${r.hotToday ? ' hot' : ''}${k >= XP_N ? ' more' : ''}" title="${esc(r.title)}"><td>${esc(r.name)}${r.pref ? ' <small class="muted">偏好不参与</small>' : ''}${r.hotToday ? ` <small class="hot-tag">今日热点 ×${r.hotToday}</small>` : r.hotRecent ? ` <small class="muted">近期热点 ${esc(r.hotRecent)}</small>` : ''}</td>${td(r.p1, 2, isToday)}${td(r.p5, 1, isToday)}</tr>`
      + (r.branches ?? []).map(b => `<tr class="br${k >= XP_N ? ' more' : ''}"><td>└ ${esc(b.name)}</td>${td(b.p1, 2, isToday)}${td(b.p5, 1, isToday)}</tr>`).join('')).join('');
    return `<section class="card fill desk-only mob-extra"><h3>板块强弱<span class="cnt">${sec.length} 个大类 · ${asOf} · 按${fs.k === 'fT' ? dayLabel : '近 5 日'}${fs.d === -1 ? '从大到小' : '从小到大'}</span></h3><table class="mini sec-table xp${S.xp?.sec ? ' open' : ''}"><thead><tr><th>板块</th>${th('fT', dayLabel)}${th('f5', '近5日')}</tr></thead><tbody>${body}</tbody></table>${xpBtn('sec', sec.length, '个大类')}
    <div class="fam-line mob-only"><p><b>强</b>${hb.slice(0, 2).map(r => `${esc(r.name)} <span class="num ${sign(r.p5)}">${fmtPct(r.p5, 1)}</span>`).join('　')}</p><p><b>弱</b>${hb.slice(-2).reverse().map(r => `${esc(r.name)} <span class="num ${sign(r.p5)}">${fmtPct(r.p5, 1)}</span>`).join('　')}</p></div></section>`;
  }
  return `<section class="card fill desk-only mob-extra"><h3>板块强弱<span class="cnt">${head}</span></h3><table class="mini"><thead><tr><th>板块</th>${th('fT', '今日')}${th('f5', '近5日')}</tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.name)} <small class="muted">${esc(FAMILY_LABEL[r.fam] ?? r.fam ?? '')}${PREFERENCE_EXCLUDED.includes(r.fam) ? ' · 偏好不参与' : ''}</small></td><td class="${sign(r.p1)}">${fmtPct(r.p1)}</td><td class="${sign(r.p5)}">${fmtPct(r.p5, 1)}</td></tr>`).join('')}</tbody></table>
    <div class="fam-line mob-only"><p><b>强</b>${byP5.slice(0, 2).map(r => `${esc(r.name)} <span class="num ${sign(r.p5)}">${fmtPct(r.p5, 1)}</span>`).join('　')}</p><p><b>弱</b>${byP5.slice(-2).reverse().map(r => `${esc(r.name)} <span class="num ${sign(r.p5)}">${fmtPct(r.p5, 1)}</span>`).join('　')}</p></div></section>`;
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
  const cur = segs.at(-1);
  if (cur?.state === '主跌') {   // 当前主跌段：用最新行情按主跌起点至今的区间跌幅重算领跌（与领跌板块卡片同口径）
    const lead = declineLeaders(S.result.declineSince ?? cur.start, 1)?.[0];
    if (lead) Object.assign(cur, { board: labelBoard(lead.name, lead.fam), boardMove: lead.pS });
  }
  return segs;
}
const dspan = (g, now = false) => `${g.start.slice(2).replace(/-/g, '.')}${now ? '–至今' : g.end && g.end !== g.start ? `–${g.end.slice(5).replace('-', '.')}` : ''}`;
/** 手机端（≤860 宽）板块强弱与两条时间线只显示最近 XP_N 段，其余点「展开全部」；桌面与中屏是一屏布局，不折叠 */
const XP_N = 5;
const xpBtn = (key, n, unit) => (n > XP_N ? `<button type="button" class="xp-btn" data-xp="${key}">${S.xp?.[key] ? '收起' : `展开全部（共 ${n} ${unit}）`}</button>` : '');
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
    if (g.phase === '情绪主升' && g.leaderTop && g.leaderTop.date <= (g.end ?? '9999')) tag.push(`${g.leaderTop.date.slice(5)} 龙头${g.leaderTop.signal}→观望`);
    const pos = g.phase === '情绪试探' || g.phase === '退潮' ? '空仓' : g.phase === '情绪主升' ? '半仓' : cyclePosition(g.phase);
    return `<li class="${g.phase === '退潮' ? 'down' : g.phase === '情绪试探' ? 'flat' : 'up'}${k >= XP_N ? ' more' : ''}"><time>${esc(dspan(g, k === 0 && (!g.end || g.open)))}</time><span class="event"><b class="st">${esc(g.phase)}</b>（${esc(pos)}）<small>（${esc(tag.filter(Boolean).join(' · '))}）</small></span></li>`;
  };
  const cur = idxSegs[0], ep = S.emo?.phase;
  const st = leaderStop();
  const stopTag = st ? `<span class="stop-tag ${st.ok === true ? 'ok' : ''}" title="下一轮行情的前提：主跌领跌板块先止跌（站上 5 日线且近 3 日未再创新低）。仅参考，不参与判定。">${st.ok === true ? '已止跌' : st.ok === false ? '未止跌' : '止跌待定'}</span>` : '';
  const now = `机构线 <b>${esc(segName(cur?.state ?? '—'))}期</b> · 情绪线 <b>${esc(!ep ? '—' : ep === '无情绪周期' ? '无周期' : `${ep}期`)}</b>${st ? ` · ${stopTag}<span class="stop-read">${esc(st.read)}</span>` : ''}`;
  const nowShort = now.replace(/<span class="stop-read">[\s\S]*?<\/span>/, '');
  return `<section class="card condition-card log-card desk-only"><h3><span class="section-no" aria-hidden="true">00</span>提醒与切换<span class="cnt">近一年 · 指数线 ${idxSegs.length} 段 · 情绪周期 ${S.emo?.cycles?.length ?? 0} 个</span><span class="cnt now-h">${nowShort}</span></h3><div class="log-top"><ul class="log ${log.length ? 'hot' : 'idle'}">
    ${log.map(x => `<li class="${x.level === '确认' ? 'lv-ok' : 'lv-warn'}${Date.now() - new Date(x.at).getTime() < 30 * 60000 ? ' fresh' : ''}" title="${esc(x.text ?? '')}"><time>${esc(new Date(x.at).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5))}</time><b class="lv">${esc(x.level)}</b><span class="event">${esc(x.event)}</span></li>`).join('') || '<li class="muted">今日暂无状态切换</li>'}</ul><span class="now-tag">现状：${now}</span>${oppHTML()}${premarketHTML()}</div>
    <div class="tl2"><div class="tlcol"><h4>指数线（机构）</h4><ul class="log tl xp${S.xp?.idx ? ' open' : ''}">${idxSegs.map((g, k) => { const t = segTag(g); return `<li class="${icls(g.state)}${k >= XP_N ? ' more' : ''}"><time>${esc(dspan(g, k === 0))}</time><span class="event"><b class="st">${esc(segName(g.state))}</b>（${esc(POSITION[g.state] ?? '—')}）${t ? `<small>（${esc(t)}）</small>` : ''}</span></li>`; }).join('')}</ul>${xpBtn('idx', idxSegs.length, '段')}</div>
    <div class="tlcol"><h4>情绪线</h4><ul class="log tl xp${S.xp?.emo ? ' open' : ''}">${emoSegs.map(emoItem).join('') || '<li class="muted">近一年无情绪周期</li>'}</ul>${xpBtn('emo', emoSegs.length, '段')}</div></div></section>`;
}

/** 机会提示（小框）：主跌期不提示；震荡 / 筑底 / 主升期出现机构（共振爆发 → 大主升）或情绪（情绪主升）机会时列出仓位档位。只列档位，不写买卖。 */
function oppHTML(extra = '') {
  const f = S.result?.final, st = f?.state;
  if (!st) return '';
  if (st === '主跌') return extra ? '' : '<div class="opp idle"><b>机会</b><span>主跌期不提示</span></div>';
  const items = [];
  if (st.startsWith('大主升')) {
    const lead = f.leadShown, pref = PREFERENCE_EXCLUDED.includes(lead);
    items.push(`<span class="o ${pref ? 'flat' : 'up'}">机构 · ${esc(segName(st))}（主线 ${esc(FAMILY_LABEL[lead] ?? lead)}）· ${pref ? '偏好不参与' : esc(POSITION[st])}</span>`);
  }
  const e = S.emo, a = e?.active;
  if (a && !a.voided) {
    const pref = labelBoard(a.leader.board ?? '').startsWith('资源');
    const lt = a.leaderTop ? `${a.leaderTop.date.slice(5)} ${a.leaderTop.signal}` : e.hints?.find(h => h.isLeader)?.signal ? `今日盘中${e.hints.find(h => h.isLeader).signal}` : '';
    if (pref) items.push(`<span class="o flat">情绪 · 龙头 ${esc(a.leader.name)}（${esc(labelBoard(a.leader.board))}）· 偏好不参与</span>`);
    else if (e.position === '半仓') items.push(`<span class="o up">情绪 · 情绪主升 龙头 ${esc(a.leader.name)}（${esc(labelBoard(a.leader.board))}）· 半仓，龙头见顶即观望</span>`);
    else items.push(`<span class="o flat">情绪 · 龙头 ${esc(a.leader.name)} ${esc(lt || '已见顶')} · 观望</span>`);
  }
  if (extra && !items.length) return '';   // 手机端只在有机会时显示，替换首卡「按规则」一行
  return `<div class="opp${items.length ? '' : ' idle'}${extra ? ` ${extra}` : ''}"><b>机会</b>${items.join('') || '<span>暂无机构或情绪机会</span>'}</div>`;
}

function statusChips() {
  const p = phaseInfo(), c = S.calendar, r = S.result, out = [];
  const live = S.calendar?.refreshRecommended && S.today.quotes?.ok;
  out.push(`<span class="chip"><i class="live ${live ? '' : 'off'}"></i><b class="num">${esc(c?.time?.slice(0, 5) ?? '--:--')}</b> ${esc(p.label)}</span>`);
  const q = S.today.quotes;
  out.push(`<span class="chip ${q?.ok ? '' : 'warn'}">指数 <b class="num">${q?.ok ? esc(q.rows[0]?.sourceTime?.slice(11, 16) ?? '') : '未取得'}</b></span>`);
  const tb = ALL_BOARDS.filter(code => S.today.boards[code]?.sourceDate === c?.date).length;
  out.push(`<span class="chip ${r?.todayAppended && tb < 34 ? 'warn' : ''}">板块今日 <b class="num">${tb}/${ALL_BOARDS.length}</b></span>`);
  const tv = S.today.turnover;
  const yAmt = r?.todayAppended ? r.yesterday?.amt : null;
  const vsY = tv?.estimated && isNum(tv.projectedFullDay) && isNum(yAmt) && yAmt > 0 ? (tv.projectedFullDay / yAmt - 1) * 100 : null;
  if (tv) out.push(`<span class="chip ${tv.ok ? '' : 'warn'}">量能 ${tv.estimated ? `累计 <b class="num">${fmtYi(tv.cumulativeAmount)}</b> · 预估 <b class="num">${fmtYi(tv.projectedFullDay)}</b>${isNum(vsY) ? ` <span class="num ${sign(vsY)}">较昨日 ${fmtPct(vsY, 1)}</span>` : ''} <span class="num rng">(${fmtYi(tv.interval?.low)}–${fmtYi(tv.interval?.high)})</span>` : tv.ok ? `累计 <b class="num">${fmtYi(tv.cumulativeAmount)}</b>` : '未知'}</span>`);
  const bf = S.backfill;
  if (bf.missing?.length && !bf.complete) out.push(bf.tooOld ? '<span class="chip warn">历史种子过旧，请更新网站</span>' : `<span class="chip warn bf-chip">补齐历史：板块 ${bf.boardsDone}/${ALL_BOARDS.length} · 涨跌停 ${bf.limitsDone}/${bf.missing.length} 天</span>`);
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
    <span class="disc" title="本页面按预先设定的规则，对公开行情数据做自动判定。盘中结论为试算，开盘起状态切换即发出预警，14:40 后仍成立发出确认，收盘后定格。数据缺失时显示「?」，不会因此判为震荡或发出提醒。个股只列客观数据，仓位只显示规则档位，不构成投资建议，不提供下单。成交额口径：上证指数 + 深证成指。">规则自动判定，盘中为试算 · 数据缺失显示「?」不触发提醒 · 不构成投资建议，不提供下单</span>`;
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
  $('#col1').innerHTML = heroHTML(f) + boardsHTML(f) + overseasHTML() + mobileConds(groups) + extraHTML(f);
  $('#col2').innerHTML = logHTML() + groupCard(G.res) + groupCard(G.down) + `<div class="merge">${groupCard(G.emo)}${groupCard(G.risk)}${groupCard(G.ref)}</div>`;
  $('#col3').innerHTML = groupCard(G.emo) + groupCard(G.risk) + groupCard(G.ref);
  const alertsOn = load('alertsOn', false);
  $('#alert-btn').textContent = alertsOn ? '提醒已开启' : '开启网页提醒';
  $('#alert-btn').setAttribute('aria-pressed', String(alertsOn));
}
document.addEventListener('click', e => {
  const xb = e.target.closest('[data-xp]');
  if (xb) { S.xp = { ...(S.xp ?? {}), [xb.dataset.xp]: !S.xp?.[xb.dataset.xp] }; render(); return; }
  const sb = e.target.closest('[data-sort]');
  if (sb) {
    const cur = load('famSort', { k: 'f5', d: -1 }), k = sb.dataset.sort;
    save('famSort', { k, d: cur.k === k ? -cur.d : -1 });
    render(); return;
  }
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
setInterval(quickTick, QUICK_MS);
