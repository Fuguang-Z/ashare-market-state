/**
 * A 股公开行情数据层。纯 ES module，无账号、无代理、无判定逻辑。
 * 金额为元；pct 是已经乘 100 的百分数。fetchedAt 只是接收时间，不冒充行情时间。
 * D2 / D6 日 K 按单证券请求；D9 可选日 K。用 beginRefresh() 为一轮请求设置预算。
 */

export const INDEXES = Object.freeze([
  { symbol: 'sh000001', name: '上证指数', secid: '1.000001' },
  { symbol: 'sz399001', name: '深证成指', secid: '0.399001' },
  { symbol: 'sz399006', name: '创业板指', secid: '0.399006' },
  { symbol: 'sh000688', name: '科创50', secid: '1.000688' },
  { symbol: 'sh000300', name: '沪深300', secid: '1.000300' },
  { symbol: 'sh000905', name: '中证500', secid: '1.000905' },
  { symbol: 'sh000852', name: '中证1000', secid: '1.000852' },
  { symbol: 'sh000985', name: '中证全指', secid: '1.000985' },
]);
export const ETFS = Object.freeze([
  { symbol: 'sh510300', name: '沪深300ETF', secid: '1.510300' },
  { symbol: 'sh510050', name: '上证50ETF', secid: '1.510050' },
  { symbol: 'sh510500', name: '中证500ETF', secid: '1.510500' },
  { symbol: 'sh512100', name: '中证1000ETF', secid: '1.512100' },
  { symbol: 'sh588000', name: '科创50ETF', secid: '1.588000' },
  { symbol: 'sz159915', name: '创业板ETF', secid: '0.159915' },
]);
const ALL_SYMBOLS = [...INDEXES, ...ETFS];
const QUOTE_FIELDS = 'f2,f3,f6,f12,f13,f14,f17,f18,f124';
const BOARD_FIELDS = 'f2,f3,f6,f12,f14,f20,f104,f105,f128,f140,f124';
const POOL_NAMES = { up: 'getTopicZTPool', down: 'getTopicDTPool', broken: 'getTopicZBPool', yesterday: 'getYesterdayZTPool' };
const EXPECTED_POOLS = Object.keys(POOL_NAMES);
export const TOP_TURNOVER_SCOPE = 'CN_A_SH_SZ_CDR';
let callbackSerial = 0;
let tencentScriptQueue = Promise.resolve();

/** 全模块共享限速队列；成功与失败请求都占位，启动间隔至少1.1秒并加抖动。 */
export function createRequestScheduler({ sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = () => performance.now(), random = Math.random } = {}) {
  let tail = Promise.resolve(), lastStart = -Infinity;
  return task => {
    const run = async () => {
      const gap = 1100 + Math.floor(Math.max(0, Math.min(1, random())) * 200);
      const remaining = Math.max(0, gap - (clock() - lastStart));
      if (remaining > 0) await sleep(remaining);
      lastStart = clock();
      return task();
    };
    const result = tail.then(run, run);
    tail = result.catch(() => {});
    return result;
  };
}
const sharedRequestScheduler = createRequestScheduler();

// 来源：探测/official-calendar.json 的官方公告转录，仅包含可公开的日期和 URL。
const HOLIDAY_RANGES = [
  ['2025-01-01', '2025-01-01'], ['2025-01-28', '2025-02-04'], ['2025-04-04', '2025-04-06'],
  ['2025-05-01', '2025-05-05'], ['2025-05-31', '2025-06-02'], ['2025-10-01', '2025-10-08'],
  ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'], ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'], ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];
export const OFFICIAL_CALENDAR = Object.freeze({
  start: '2025-01-01', end: '2026-12-31', verifiedOn: '2026-10-14', unscheduledClosuresVerified: false,
  holidays: Object.freeze(HOLIDAY_RANGES.flatMap(([start, end]) => {
    const rows = [];
    for (let day = Date.parse(`${start}T00:00:00Z`); day <= Date.parse(`${end}T00:00:00Z`); day += 86400000) rows.push(new Date(day).toISOString().slice(0, 10));
    return rows;
  })),
  source: Object.freeze([
    'https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20241223_10767110.shtml',
    'https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml',
    'https://www.sse.com.cn/disclosure/announcement/general/c/c_20260915_10832273.shtml',
    'https://dataclouds.cninfo.com.cn/sjother2/regulatory/2025/20251222/50b258f0d89b4076b459eb746a7e100d.pdf',
  ]),
  sessionSource: 'https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20260424_10816492.shtml',
});

function assert(condition, message) { if (!condition) throw new Error(message); }
function numeric(value, name, { nonnegative = false, nullable = false } = {}) {
  if (value === null || value === undefined || value === '' || value === '-') {
    if (nullable) return null;
    throw new Error(`${name} 缺失`);
  }
  assert(typeof value === 'number' || (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())), `${name} 不是有效数值`);
  const result = Number(value);
  assert(Number.isFinite(result) && (!nonnegative || result >= 0), `${name} 不是有效数值`);
  return result;
}
function integer(value, name, nullable = false) {
  const result = numeric(value, name, { nonnegative: true, nullable });
  assert(result === null || Number.isSafeInteger(result), `${name} 不是非负整数`);
  return result;
}
function dateISO(value) {
  let result = String(value ?? '');
  if (/^\d{8}$/.test(result)) result = `${result.slice(0, 4)}-${result.slice(4, 6)}-${result.slice(6, 8)}`;
  assert(/^\d{4}-\d{2}-\d{2}$/.test(result) && new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) === result, '来源日期格式或日期值无效');
  return result;
}
function chinaClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}:${value.second}` };
}
function quoteTime(value, fetchedAt) {
  if (value === null || value === undefined || value === '' || value === '-') return { sourceDate: null, sourceTime: null, sourceTimeTrust: 'missing' };
  let text;
  if (/^\d{14}$/.test(String(value))) {
    const raw = String(value);
    assert(Number(raw.slice(8, 10)) < 24 && Number(raw.slice(10, 12)) < 60 && Number(raw.slice(12, 14)) < 60, '行情时分秒无效');
    text = `${dateISO(raw.slice(0, 8))}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}+08:00`;
  } else {
    const seconds = numeric(value, '源时间戳', { nonnegative: true });
    assert(seconds >= 946684800 && seconds < 4102444800, '源时间戳不在合理范围');
    const clock = chinaClock(new Date(seconds * 1000));
    text = `${clock.date}T${clock.time}+08:00`;
  }
  assert(Number.isFinite(Date.parse(text)), '行情时间无效');
  assert(Date.parse(text) <= Date.parse(fetchedAt) + 60000, '行情时间超过接收时间');
  return { sourceDate: text.slice(0, 10), sourceTime: text, sourceTimeTrust: 'source-reported' };
}
function metadata(source, fetchedAt, extra = {}) {
  return { source, fetchedAt, sourceDate: null, sourceTime: null, sourceTimeTrust: 'missing', ...extra };
}
function failure(reason, source, fetchedAt, extra = {}) {
  return { ok: false, reason, ...metadata(source, fetchedAt), ...extra };
}
function url(base, params = {}) {
  const result = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) result.searchParams.set(key, String(value));
  return result.toString();
}
function assertJSONPEnvironment() {
  assert(typeof document !== 'undefined' && typeof window !== 'undefined', '当前环境没有浏览器 DOM；请使用 transport 注入测试或在网页运行');
}

/** 标准 JSONP：唯一回调，8 秒截止，成功/失败/超时均清理。 */
export function jsonp(requestURL, { callbackParam = 'cb', timeoutMs = 8000, charset = 'utf-8' } = {}) {
  assertJSONPEnvironment();
  assert(new URL(requestURL).protocol === 'https:', '公开源必须使用 HTTPS');
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 8000, 'JSONP 超时须为 1–8000 毫秒');
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? Math.random().toString(36).slice(2);
  const callback = `__ashare_jsonp_${Date.now()}_${++callbackSerial}_${random}`;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onerror = null;
      script.onload = null;
      script.remove();
      delete window[callback];
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`JSONP 请求超时（${timeoutMs} ms）`)), timeoutMs);
    window[callback] = value => finish(null, value);
    script.charset = charset;
    script.async = true;
    script.onerror = () => finish(new Error('JSONP 加载失败（网络、CSP、来源限制或服务拒绝）'));
    script.onload = () => { if (!settled) finish(new Error('响应未调用约定 JSONP 回调')); };
    script.src = url(requestURL, { [callbackParam]: callback });
    document.head.appendChild(script);
  });
}

/** 有明确 CORS 支持的公开 JSON；不携带登录态、不跟随重定向。 */
export async function corsJSON(requestURL) {
  assert(new URL(requestURL).protocol === 'https:', '公开源必须使用 HTTPS');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(requestURL, { mode: 'cors', credentials: 'omit', redirect: 'error', signal: controller.signal });
    assert(response.ok, `公开接口 HTTP ${response.status}`);
    const text = await response.text();
    assert(text.length <= 5000000, '公开接口响应超过 5 MB 上限');
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

/** 腾讯 qt 返回 v_sh... 赋值脚本，不冒充 cb= JSONP；GBK 由浏览器脚本解码。 */
export function tencentQuoteScript(symbols) {
  assertJSONPEnvironment();
  assert(Array.isArray(symbols) && symbols.length > 0 && symbols.length <= 30 && symbols.every(s => /^(sh|sz)\d{6}$/.test(s)), '腾讯报价代码列表无效');
  const run = () => new Promise((resolve, reject) => {
    const old = new Map(symbols.map(symbol => [`v_${symbol}`, { present: Object.hasOwn(window, `v_${symbol}`), value: window[`v_${symbol}`] }]));
    const script = document.createElement('script');
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const values = Object.fromEntries(symbols.map(symbol => [symbol, window[`v_${symbol}`]]));
      script.remove();
      script.onerror = null;
      script.onload = null;
      for (const [key, previous] of old) previous.present ? (window[key] = previous.value) : delete window[key];
      error ? reject(error) : resolve(values);
    };
    for (const key of old.keys()) delete window[key];
    const timer = setTimeout(() => finish(new Error('腾讯报价脚本 8 秒超时')), 8000);
    script.charset = 'gbk';
    script.async = true;
    script.onerror = () => finish(new Error('腾讯报价脚本加载失败'));
    script.onload = () => finish(null);
    script.src = `https://qt.gtimg.cn/q=${symbols.join(',')}`;
    document.head.appendChild(script);
  });
  const pending = tencentScriptQueue.then(run, run);
  tencentScriptQueue = pending.catch(() => {});
  return pending;
}

export function parseTencentQuotes(raw, symbols, { source = 'tencent:qt', fetchedAt = new Date().toISOString() } = {}) {
  assert(raw && typeof raw === 'object', '腾讯响应不是报价映射');
  return symbols.map(symbol => {
    const fields = String(raw[symbol] ?? '').split('~');
    assert(fields.length >= 38 && fields[2] === symbol.slice(2), `腾讯 ${symbol} 标识或字段数量不符`);
    const price = numeric(fields[3], 'price', { nonnegative: true });
    assert(price > 0, '行情价格为零或缺失');
    return {
      symbol, code: fields[2], name: fields[1], price,
      previousClose: numeric(fields[4], 'previousClose', { nonnegative: true }),
      open: numeric(fields[5], 'open', { nonnegative: true }),
      pct: numeric(fields[32], 'pct'),
      amount: numeric(fields[37], 'amount 万元', { nonnegative: true }) * 10000,
      ...metadata(source, fetchedAt, quoteTime(fields[30], fetchedAt)),
    };
  });
}

function eastRows(raw) {
  assert(raw && Number(raw.rc ?? 0) === 0 && raw.data && typeof raw.data === 'object', '东财业务响应失败或 data 缺失');
  const rows = Array.isArray(raw.data.diff) ? raw.data.diff : Object.values(raw.data.diff ?? {});
  assert(rows.length <= 10000 && rows.every(row => row && typeof row === 'object'), '东财列表结构无效');
  return rows;
}

export function parseEastmoneyQuotes(raw, symbols, { source = 'eastmoney:push2', fetchedAt = new Date().toISOString() } = {}) {
  const rows = eastRows(raw);
  return symbols.map(symbol => {
    const row = rows.find(item => String(item.f12) === symbol.slice(2) && Number(item.f13) === (symbol.startsWith('sh') ? 1 : 0));
    assert(row, `东财缺少 ${symbol}`);
    const price = numeric(row.f2, 'price', { nonnegative: true });
    assert(price > 0, '行情价格为零或缺失');
    return {
      symbol, code: String(row.f12), name: String(row.f14 ?? ''), price,
      previousClose: numeric(row.f18, 'previousClose', { nonnegative: true, nullable: true }),
      open: numeric(row.f17, 'open', { nonnegative: true, nullable: true }), pct: numeric(row.f3, 'pct'),
      amount: numeric(row.f6, 'amount 元', { nonnegative: true }),
      ...metadata(source, fetchedAt, quoteTime(row.f124, fetchedAt)),
    };
  });
}

export function parseEastmoneyDaily(raw, symbol, { source = 'eastmoney:push2his', fetchedAt = new Date().toISOString(), minBars = 60 } = {}) {
  assert(raw && Number(raw.rc ?? 0) === 0 && raw.data && Array.isArray(raw.data.klines), '东财日 K 结构或业务状态无效');
  assert(String(raw.data.code) === symbol.replace(/^(sh|sz)/, ''), '日 K 证券代码不符');
  assert(raw.data.klines.length >= minBars && raw.data.klines.length <= 2000, `有效日 K 不足 ${minBars} 根或响应过大`);
  let previous = '';
  const rows = raw.data.klines.map(line => {
    const fields = String(line).split(',');
    assert(fields.length >= 7, '日 K 字段不足');
    const date = dateISO(fields[0]);
    assert(date > previous && date <= chinaClock(new Date(fetchedAt)).date, '日 K 日期重复、乱序或位于未来');
    previous = date;
    const open = numeric(fields[1], 'open'), close = numeric(fields[2], 'close');
    const high = numeric(fields[3], 'high'), low = numeric(fields[4], 'low');
    assert(low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close), '日 K OHLC 关系无效');
    return {
      symbol, date, open, high, low, close,
      amount: numeric(fields[6], '日 K amount 元', { nonnegative: true }),
      pct: numeric(fields[8], '日 K pct', { nullable: true }),
      ...metadata(source, fetchedAt, { sourceDate: date, sourceTimeTrust: 'source-daily-date' }),
    };
  });
  return { symbol, rows, adjustment: 'none', ...metadata(source, fetchedAt, { sourceDate: rows.at(-1).date, sourceTimeTrust: 'source-daily-date' }) };
}

/** 腾讯 newfqkline 的 index 8 是万元；旧六列 fqkline 不具备成交额，禁止补算。 */
export function parseTencentDaily(raw, symbol, { source = 'tencent:newfqkline', fetchedAt = new Date().toISOString(), minBars = 60, count = 80 } = {}) {
  assert(raw && Number(raw.code) === 0 && raw.data && raw.data[symbol], '腾讯日 K 状态或证券标识无效');
  const sourceRows = raw.data[symbol].day;
  assert(Array.isArray(sourceRows) && sourceRows.length >= minBars && sourceRows.length <= 2000, `腾讯未返回至少 ${minBars} 根未复权日 K`);
  let previous = '';
  const rows = sourceRows.slice(-count).map(fields => {
    assert(Array.isArray(fields) && fields.length >= 9, '腾讯旧六列日 K 没有成交额，不满足此数据契约');
    const date = dateISO(fields[0]);
    assert(date > previous && date <= chinaClock(new Date(fetchedAt)).date, '腾讯日 K 日期重复、乱序或位于未来');
    previous = date;
    const open = numeric(fields[1], 'open'), close = numeric(fields[2], 'close');
    const high = numeric(fields[3], 'high'), low = numeric(fields[4], 'low');
    assert(low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close), '腾讯日 K OHLC 关系无效');
    return { symbol, date, open, high, low, close, amount: numeric(fields[8], '腾讯日 K amount 万元', { nonnegative: true }) * 10000, pct: null, ...metadata(source, fetchedAt, { sourceDate: date, sourceTimeTrust: 'source-daily-date' }) };
  });
  return { symbol, rows, adjustment: 'none', ...metadata(source, fetchedAt, { sourceDate: rows.at(-1).date, sourceTimeTrust: 'source-daily-date' }) };
}

export function parseBoardList(raw, type, { source = 'eastmoney:push2', fetchedAt = new Date().toISOString() } = {}) {
  assert(['industry', 'concept'].includes(type), '板块类型无效');
  const rows = eastRows(raw);
  const total = integer(raw.data.total, '板块总数');
  assert(rows.length === total && total > 0, `板块分页不完整：取得 ${rows.length}/${total}，禁止当作全量列表`);
  const codes = new Set();
  return rows.map(row => {
    const code = String(row.f12);
    assert(/^BK\d{4,6}$/.test(code) && !codes.has(code), '板块代码无效或重复');
    codes.add(code);
    return {
      code, name: String(row.f14 ?? ''), type, pct: numeric(row.f3, '板块 pct'),
      amount: numeric(row.f6, '板块 amount 元', { nonnegative: true }),
      marketCap: numeric(row.f20, '板块总市值 元', { nonnegative: true, nullable: true }),
      up: integer(row.f104, '上涨家数', true), down: integer(row.f105, '下跌家数', true),
      leader: { code: row.f140 == null || row.f140 === '-' ? null : String(row.f140), name: row.f128 == null || row.f128 === '-' ? null : String(row.f128) },
      ...metadata(source, row.__receivedAt ?? fetchedAt, quoteTime(row.f124, row.__receivedAt ?? fetchedAt)),
    };
  });
}

export function parseLimitPool(raw, kind, requestedDate, { source = 'eastmoney:push2ex', fetchedAt = new Date().toISOString() } = {}) {
  assert(EXPECTED_POOLS.includes(kind), '涨跌停池类型无效');
  const expected = dateISO(requestedDate);
  assert(raw && Number(raw.rc ?? 0) === 0 && raw.data && Array.isArray(raw.data.pool), '涨跌停池 data/pool 缺失，不能解释为零只');
  // 第一方专题前端由 date 请求参数选择历史；qdate 不是每个响应池的交易日标识。
  // 证据：https://quote.eastmoney.com/ztb/newstatic/build/detail.js（frontparams.date）。
  const actual = expected;
  const responseQdate = raw.data.qdate ?? null;
  const codes = new Set();
  const declaredTotal = raw.data.tc == null ? null : integer(raw.data.tc, '专题池总数');
  assert(declaredTotal !== null && declaredTotal === raw.data.pool.length, `专题池分页不完整：取得 ${raw.data.pool.length}/${declaredTotal ?? '未知'}`);
  assert(declaredTotal > 0, '专题池为空，不能区分真实零家与该历史日期不可用，保留未知');
  const rows = raw.data.pool.map(row => {
    const code = String(row.c ?? '');
    assert(/^\d{6}$/.test(code) && !codes.has(code), '涨跌停池代码无效或重复');
    codes.add(code);
    return {
      code, name: String(row.n ?? ''), pct: numeric(row.zdp, '涨跌停池 pct', { nullable: true }),
      amount: numeric(row.amount, '涨跌停池 amount 元', { nonnegative: true, nullable: true }),
      price: row.p == null ? null : numeric(row.p, '涨跌停池 price 千分元', { nonnegative: true }) / 1000,
      consecutiveLimitUps: integer(row.lbc, '连续涨停数', true),
      industry: row.hybk == null || row.hybk === '' ? null : String(row.hybk),
      concepts: null,
      responseQdate, dateEvidence: 'request-parameter-contract',
      ...metadata(source, fetchedAt, { sourceDate: actual, sourceTimeTrust: 'request-parameter-contract' }),
    };
  });
  return { kind, date: actual, responseQdate, dateEvidence: 'request-parameter-contract', rows, count: rows.length, scope: '东方财富涨跌停专题池，排除范围以供应商规则为准，不代表全 A 股', ...metadata(source, fetchedAt, { sourceDate: actual, sourceTimeTrust: 'request-parameter-contract' }) };
}

/** N2：沪深A股及CDR（不含B股、北交所）的成交额前n名。 */
export function parseTopTurnover(raw, n = 20, { source = 'eastmoney:push2delay', fetchedAt = new Date().toISOString() } = {}) {
  assert(Number.isSafeInteger(n) && n >= 1 && n <= 100, '成交额排名数量须为1–100');
  const all = eastRows(raw), total = integer(raw.data.total, '排名股票范围总数');
  assert(total >= n && all.length >= n, `成交额排名样本不足 ${n} 只`);
  const seen = new Set();
  let previousAmount = Infinity;
  const rows = all.slice(0, n).map((row, index) => {
    const code = String(row.f12 ?? ''), market = Number(row.f13);
    assert((market === 1 && /^(60|68)\d{4}$/.test(code)) || (market === 0 && /^(00|30)\d{4}$/.test(code)), '成交额排名混入非沪深A股/CDR证券');
    const symbol = `${market === 1 ? 'sh' : 'sz'}${code}`;
    assert(!seen.has(symbol), '成交额排名存在重复证券'); seen.add(symbol);
    const amount = numeric(row.f6, '个股成交额 元', { nonnegative: true });
    assert(amount <= previousAmount, '成交额排名未按金额降序返回'); previousAmount = amount;
    const industry = row.f100 == null || row.f100 === '-' || row.f100 === '' ? null : String(row.f100);
    assert(industry, `${code} 所属行业字段缺失`);
    return { rank: index + 1, symbol, code, name: String(row.f14 ?? ''), amount, pct: numeric(row.f3, '个股 pct'), industry,
      ...metadata(source, fetchedAt, quoteTime(row.f124, fetchedAt)) };
  });
  return { rows, n, ranking: 'amount-desc', scope: TOP_TURNOVER_SCOPE, scopeLabel: '沪深 A 股及 CDR，包含 ST，不含 B 股及北交所',
    coverage: { complete: true, expected: n, received: rows.length, universeCount: total },
    isFinal: null, finality: { confirmed: false, evidence: null },
    ...metadata(source, fetchedAt, commonTime(rows)) };
}

/** 新浪 hs_a 可保留真实排名样本，但没有交易日期及行业，不能升级为完整N2。 */
export function parseSinaTopTurnover(raw, n = 20, { source = 'sina:hs-a-turnover', fetchedAt = new Date().toISOString() } = {}) {
  assert(Array.isArray(raw) && raw.length >= n && raw.length <= 100, `新浪成交额排名不足 ${n} 只或结构无效`);
  const seen = new Set(); let previousAmount = Infinity;
  const rows = raw.slice(0, n).map((row, index) => {
    const symbol = String(row.symbol ?? ''), code = String(row.code ?? '');
    assert(/^(sh|sz)\d{6}$/.test(symbol) && symbol.slice(2) === code && !seen.has(symbol), '新浪排名代码无效或重复'); seen.add(symbol);
    const amount = numeric(row.amount, '新浪 amount 元', { nonnegative: true });
    assert(amount <= previousAmount, '新浪排名未按成交额降序'); previousAmount = amount;
    return { rank: index + 1, symbol, code, name: String(row.name ?? ''), amount, pct: numeric(row.changepercent, '新浪 pct'), industry: null,
      tickTime: /^\d{2}:\d{2}:\d{2}$/.test(String(row.ticktime ?? '')) ? String(row.ticktime) : null,
      ...metadata(source, fetchedAt, { sourceTimeTrust: 'time-of-day-only-no-trade-date' }) };
  });
  return { ok: false, partial: true, reason: '新浪返回真实排名样本，但缺少行业和交易日期，hs_a范围尚未核验，不能作为完整两市前20日终快照',
    rows, n, ranking: 'amount-desc', scope: 'SINA_HS_A_UNVERIFIED', scopeLabel: '新浪 hs_a 节点（覆盖范围待核）', scopeVerified: false,
    missingFields: ['industry', 'sourceDate'], coverage: { complete: false, expected: n, received: rows.length }, isFinal: null,
    ...metadata(source, fetchedAt) };
}

/** 同花顺备用池保留本源范围；“13天9板”不能换成连续9板。 */
export function parseTHSLimitPool(raw, requestedDate, { source = 'ths:limit-up-pool', fetchedAt = new Date().toISOString() } = {}) {
  assert(raw && Number(raw.status_code) === 0 && raw.data && Array.isArray(raw.data.info), '同花顺涨停池结构或业务状态无效');
  const actual = dateISO(raw.data.date);
  assert(actual === dateISO(requestedDate), '同花顺涨停池请求日期不符');
  const total = integer(raw.data.page?.total, '同花顺涨停池总数');
  assert(total === raw.data.info.length, '同花顺涨停池分页不完整');
  const seen = new Set();
  const rows = raw.data.info.map(row => {
    const code = String(row.code ?? '');
    assert(/^\d{6}$/.test(code) && !seen.has(code), '同花顺涨停股代码无效或重复');
    seen.add(code);
    const label = String(row.high_days ?? '');
    const consecutive = /^(\d+)天\1板$/.exec(label);
    return { code, name: String(row.name ?? ''), price: numeric(row.latest, '同花顺 price 元', { nonnegative: true, nullable: true }),
      pct: numeric(row.change_rate, '同花顺 pct', { nullable: true }), amount: null,
      consecutiveLimitUps: consecutive ? Number(consecutive[1]) : null, limitLabel: label || null,
      industry: null, concepts: null, reasonText: row.reason_type == null ? null : String(row.reason_type),
      ...metadata(source, fetchedAt, { sourceDate: actual, sourceTimeTrust: 'source-pool-date' }) };
  });
  return { kind: 'up', date: actual, rows, count: rows.length, scope: '同花顺 HS,GEM2STAR 专题池；与东财排除规则可能不同', missingFields: ['amount', 'industry', 'concepts', '部分非连续板的 consecutiveLimitUps'], ...metadata(source, fetchedAt, { sourceDate: actual, sourceTimeTrust: 'source-pool-date' }) };
}

/** 必须全量分页且每只股票有涨跌值；停牌/缺字段不能自动算成平盘。 */
export function parseMarketBreadth(raw, { source = 'eastmoney:push2', fetchedAt = new Date().toISOString(), scope = '沪深京 A 股' } = {}) {
  const rows = eastRows(raw);
  const total = integer(raw.data.total, '全市场总数');
  assert(rows.length === total && total > 0, `全市场列表不完整：取得 ${rows.length}/${total}`);
  const seen = new Set();
  let up = 0, down = 0, flat = 0, missing = 0;
  for (const row of rows) {
    const key = `${row.f13}.${row.f12}`;
    assert(!seen.has(key) && /^\d{6}$/.test(String(row.f12)), '全市场代码重复或无效');
    seen.add(key);
    const pct = numeric(row.f3, '个股 pct', { nullable: true });
    if (pct === null) missing++;
    else if (pct > 0) up++;
    else if (pct < 0) down++;
    else flat++;
  }
  assert(missing === 0, `有 ${missing} 只停牌或缺少涨跌值，不能给出完整上涨/下跌/平盘家数`);
  return { up, down, flat, total, scope, ...metadata(source, fetchedAt) };
}

function commonTime(rows) {
  const dates = [...new Set(rows.map(row => row.sourceDate))];
  const times = [...new Set(rows.map(row => row.sourceTime))];
  return { sourceDate: dates.length === 1 ? dates[0] : null, sourceTime: times.length === 1 ? times[0] : null, sourceTimeTrust: rows.every(row => row.sourceDate) ? 'see-items' : 'missing' };
}
function selectedSymbol(value, available) {
  const item = available.find(row => row.symbol === value || row.symbol.slice(2) === value);
  assert(item, `不支持的证券代码：${value}`);
  return item;
}

/**
 * transport({id,kind,url,symbols}) 仅供可信调用方或离线测试注入。
 * calendar = {start,end,holidays:[YYYY-MM-DD],source:[官方公告 URL]}。
 * 未经核对的 D3 总额与交易日历默认返回缺失，不拿指数成分成交额/工作日替代。
 */
export function createDataSource({ transport = null, calendar = OFFICIAL_CALENDAR, now = () => new Date(), maxRequests = 20, requestScheduler = sharedRequestScheduler } = {}) {
  assert(Number.isSafeInteger(maxRequests) && maxRequests >= 1, '请求预算无效');
  let used = 0;
  let roundMax = maxRequests;
  const cache = new Map();
  const pending = new Map();
  const fetched = () => now().toISOString();
  const defaultTransport = request => request.kind === 'tencent-script' ? tencentQuoteScript(request.symbols) : request.kind === 'cors-json' ? corsJSON(request.url) : jsonp(request.url);
  const execute = transport ?? defaultTransport;

  async function request(spec) {
    assert(used < roundMax, `本轮 ${roundMax} 次请求预算已用完；请复用缓存或将历史预热分批运行`);
    used++;
    return requestScheduler(() => execute(spec));
  }
  async function cached(key, ttl, work) {
    const value = cache.get(key);
    const instant = now().getTime();
    if (value && instant >= value.at && instant - value.at < ttl) return { ...structuredClone(value.value), cached: true, cacheAgeMs: instant - value.at };
    if (pending.has(key)) return pending.get(key);
    const task = work().then(result => {
      if (result.ok) cache.set(key, { at: now().getTime(), value: structuredClone(result) });
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }
  async function fallback(candidates, parser) {
    const attempts = [];
    for (const candidate of candidates) {
      const started = Date.now();
      try {
        const raw = await request(candidate);
        const at = fetched();
        const data = await parser(raw, candidate, at);
        attempts.push({ source: candidate.id, ok: data.ok !== false, elapsedMs: Date.now() - started, ...(data.reason ? { reason: data.reason } : {}) });
        return { ok: true, ...metadata(candidate.id, at), ...data, attempts };
      } catch (error) {
        attempts.push({ source: candidate.id, ok: false, elapsedMs: Date.now() - started, reason: String(error.message ?? error) });
        if (used >= roundMax) break;
      }
    }
    return failure(attempts.map(item => `${item.source}：${item.reason}`).join('；'), attempts.at(-1)?.source ?? null, fetched(), { attempts });
  }
  function eastCandidates(path, params, history = false) {
    const hosts = history ? ['push2his.eastmoney.com'] : ['push2delay.eastmoney.com', 'push2.eastmoney.com'];
    return hosts.map((host, index) => ({
      id: `eastmoney:${history ? 'push2his' : (index ? 'push2' : 'push2delay')}`,
      kind: 'jsonp', url: url(`https://${host}/api/${path}`, params),
      sameProvider: true,
    }));
  }
  async function quotes(symbols) {
    const key = `quotes:${[...symbols].sort().join(',')}`;
    return cached(key, 15000, () => fallback([
      { id: 'tencent:qt', kind: 'tencent-script', url: `https://qt.gtimg.cn/q=${symbols.join(',')}`, symbols },
      ...eastCandidates('qt/ulist.np/get', { fltt: 2, fields: QUOTE_FIELDS, secids: symbols.map(symbol => `${symbol.startsWith('sh') ? 1 : 0}.${symbol.slice(2)}`).join(',') }).slice(0, 1),
    ], (raw, source, at) => {
      const rows = source.kind === 'tencent-script' ? parseTencentQuotes(raw, symbols, { source: source.id, fetchedAt: at }) : parseEastmoneyQuotes(raw, symbols, { source: source.id, fetchedAt: at });
      return { rows, ...commonTime(rows) };
    }));
  }
  async function daily(symbol, secid, count) {
    assert(Number.isSafeInteger(count) && count >= 60 && count <= 1000, '日 K 根数须为 60–1000');
    const key = `daily:${symbol}:${count}`;
    // 盘中短缓存；盘后也不把早盘缓存延长到六小时，更不改写来源日期。
    const candidates = eastCandidates('qt/stock/kline/get', {
      secid, klt: 101, fqt: 0, beg: 0, end: 20500101, lmt: count,
      fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    }, true);
    if (/^(sh|sz)\d{6}$/.test(symbol)) candidates.push({ id: 'tencent:newfqkline', kind: 'cors-json', url: url('https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get', { param: `${symbol},day,,,${count},` }) });
    return cached(key, 60000, () => fallback(candidates, (raw, candidate, at) => candidate.id.startsWith('tencent') ? parseTencentDaily(raw, symbol, { source: candidate.id, fetchedAt: at, minBars: 60, count }) : parseEastmoneyDaily(raw, symbol, { source: candidate.id, fetchedAt: at, minBars: 60 })));
  }
  async function safe(work) {
    try { return await work(); }
    catch (error) { return failure(String(error.message ?? error), null, fetched()); }
  }

  /** D1 / N1 八个指数一次批量请求（含中证全指000985）。 */
  async function getIndexQuotes() { return safe(() => quotes(INDEXES.map(row => row.symbol))); }
  /** D2 单个指数日 K；调用方按需遍历 INDEXES，避免每分钟重取全部历史。 */
  async function getIndexDaily({ symbol = 'sh000001', count = 80 } = {}) {
    return safe(() => { const item = selectedSymbol(symbol, INDEXES); return daily(item.symbol, item.secid, count); });
  }
  /** D3：只有核实“沪深 A 股股票合计、不含北交所”的直接口径才会启用。 */
  async function getMarketTurnover({ date = null } = {}) {
    return failure('尚无实测通过且口径已核验的沪深两市合计成交额公开浏览器源；各指数附带量额的统计范围尚未核实，不能直接相加作为正式两市总额', null, fetched(), {
      requestedDate: date, scope: '沪深 A 股股票，不含北交所', amount: null, history: null,
    });
  }
  /** D4 全市场涨跌平：必须取得全量，截断页绝不当全市场。 */
  async function getMarketBreadth() {
    return safe(() => cached('breadth', 15000, () => fallback(eastCandidates('qt/clist/get', {
      pn: 1, pz: 10000, po: 1, np: 1, fltt: 2, fid: 'f12',
      fs: 'm:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23,m:0 t:81 s:2048', fields: 'f3,f12,f13',
    }), (raw, candidate, at) => parseMarketBreadth(raw, { source: candidate.id, fetchedAt: at }))));
  }
  /** D5 全部行业和概念板块；每页100条，自动分页并核验总数和唯一性。 */
  async function getBoards({ type = 'all' } = {}) {
    return safe(async () => {
      assert(['all', 'industry', 'concept'].includes(type), '板块类型无效');
      const types = type === 'all' ? ['industry', 'concept'] : [type];
      const groups = [];
      for (const current of types) groups.push(await cached(`boards:${current}`, 15000, () => fallback(eastCandidates('qt/clist/get', {
        pn: 1, pz: 100, po: 1, np: 1, fltt: 2, fid: 'f12', fs: `m:90 t:${current === 'industry' ? 2 : 3} f:!50`, fields: BOARD_FIELDS,
      }), async (raw, candidate, at) => {
        const total = integer(raw?.data?.total, '板块总数');
        assert(total > 0 && total <= 3000, '板块总数超出支持范围');
        const rows = eastRows(raw).map(row => ({ ...row, __receivedAt: at }));
        const pages = Math.ceil(total / 100);
        assert(roundMax - used >= pages - 1, `板块全量需 ${pages} 页，当前请求预算不足`);
        for (let page = 2; page <= pages; page++) {
          const next = await request({ ...candidate, url: url(candidate.url, { pn: page }) });
          assert(Number(next?.data?.total) === total, '板块分页期间总数变化，请稍后重取');
          rows.push(...eastRows(next).map(row => ({ ...row, __receivedAt: fetched() })));
        }
        return { rows: parseBoardList({ ...raw, data: { ...raw.data, diff: rows } }, current, { source: candidate.id, fetchedAt: at }), type: current, fetchedAt: fetched(), pageCount: pages, paginationAtomic: false, scope: '东方财富多层行业/概念分类，可能存在层级交叠，领涨股可能含 B 股；不可直接相加作全市场', warning: '排序固定为代码；分页非原子快照，各页可能相差数秒' };
      })));
      const failed = groups.filter(group => !group.ok);
      if (failed.length) return failure(failed.map(group => group.reason).join('；'), groups.map(group => group.source), fetched(), { groups });
      return { ok: true, rows: groups.flatMap(group => group.rows), groups, ...metadata(groups.map(group => group.source), fetched()) };
    });
  }
  /** D6 单个东财 BK 板块日 K，不自动遍历所有板块。 */
  async function getBoardDaily({ code, count = 80 } = {}) {
    return safe(() => { assert(/^BK\d{4,6}$/.test(code ?? ''), '请提供有效 BK 板块代码'); return daily(code, `90.${code}`, count); });
  }
  /** D7 四类池；日期必须显式传入，不用请求日期冒充响应日期。 */
  async function getLimitPools({ date, kinds = EXPECTED_POOLS } = {}) {
    return safe(async () => {
      const requestedDate = dateISO(date);
      assert(requestedDate <= chinaClock(now()).date, '不能请求未来涨跌停池');
      assert(Array.isArray(kinds) && kinds.length > 0 && new Set(kinds).size === kinds.length && kinds.every(kind => EXPECTED_POOLS.includes(kind)), '涨跌停池列表无效');
      const pools = {};
      for (const kind of kinds) {
        const candidates = [
          { id: 'eastmoney:push2ex', kind: 'jsonp', url: url(`https://push2ex.eastmoney.com/${POOL_NAMES[kind]}`, {
          // ut 是公开网页客户端固定标识，不是用户账号、会话 cookie 或私有密钥。
          ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt', Pageindex: 0, pagesize: 10000,
          sort: kind === 'down' ? 'fund:asc' : kind === 'yesterday' ? 'zs:desc' : 'fbt:asc', date: requestedDate.replaceAll('-', ''),
        }) }];
        if (kind === 'up') candidates.push({ id: 'ths:limit-up-pool', kind: 'cors-json', url: url('https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool', {
          page: 1, limit: 200, date: requestedDate.replaceAll('-', ''), field: '199112,10,9001,330329,133971,1968584', order_field: 330329, order_type: 0, filter: 'HS,GEM2STAR',
        }) });
        const pool = await cached(`pool:${kind}:${requestedDate}`, 30000, () => fallback(candidates, (raw, candidate, at) => candidate.id.startsWith('ths:') ? parseTHSLimitPool(raw, requestedDate, { source: candidate.id, fetchedAt: at }) : parseLimitPool(raw, kind, requestedDate, { source: candidate.id, fetchedAt: at })));
        pools[kind] = pool;
      }
      const failed = Object.entries(pools).filter(([, value]) => !value.ok);
      const actualSources = [...new Set(Object.values(pools).map(value => value.source).filter(Boolean))];
      const source = actualSources.length === 1 ? actualSources[0] : actualSources;
      if (failed.length) return failure(failed.map(([kind, value]) => `${kind}：${value.reason}`).join('；'), source, fetched(), { pools, requestedDate });
      return { ok: true, pools, dateEvidence: 'see-pools', ...metadata(source, fetched(), { sourceDate: requestedDate, sourceTimeTrust: 'see-pools' }) };
    });
  }
  /** D8 复用 D7 涨停池行业字段，不猜概念归属，不额外抓个股。 */
  async function getLimitStockSectors({ date } = {}) {
    return safe(async () => {
      const requestedDate = dateISO(date);
      // 行业归属与涨停池共用同一条可过期缓存，不能永久复用本日首次成功的旧池。
      const result = await getLimitPools({ date: requestedDate, kinds: ['up'] });
      const pool = result.pools?.up;
      if (!pool?.ok) return failure(pool?.reason ?? '没有可用涨停池', pool?.source ?? null, fetched());
      if (pool.rows.some(row => !row.industry)) return failure('部分涨停股所属行业缺失；概念归属未取得', pool.source, pool.fetchedAt, { rows: pool.rows });
      return { ok: true, rows: pool.rows.map(({ code, name, industry, source, fetchedAt, sourceDate, sourceTime, sourceTimeTrust, responseQdate, dateEvidence }) => ({ code, name, industry, concepts: null, source, fetchedAt, sourceDate, sourceTime, sourceTimeTrust, responseQdate, dateEvidence })), conceptsAvailable: false, cached: pool.cached === true, cacheAgeMs: pool.cacheAgeMs ?? 0, responseQdate: pool.responseQdate ?? null, dateEvidence: pool.dateEvidence ?? 'source-reported', ...metadata(pool.source, pool.fetchedAt, { sourceDate: pool.sourceDate, sourceTime: pool.sourceTime, sourceTimeTrust: pool.sourceTimeTrust }) };
    });
  }
  /** D9 六只 ETF 实时；includeDaily=true 时仅取选中 ETF 的日 K，避免刷新超预算。 */
  async function getEtfData({ symbol = 'sh510300', includeDaily = true, count = 80 } = {}) {
    return safe(async () => {
      const item = selectedSymbol(symbol, ETFS);
      const realtime = await quotes(ETFS.map(row => row.symbol));
      const history = includeDaily ? await daily(item.symbol, item.secid, count) : null;
      if (!realtime.ok || (history && !history.ok)) return failure([realtime.reason, history?.reason].filter(Boolean).join('；'), [realtime.source, history?.source].filter(Boolean), fetched(), { realtime, daily: history });
      return { ok: true, realtime, daily: history, ...metadata([realtime.source, history?.source].filter(Boolean), fetched(), commonTime(realtime.rows)) };
    });
  }
  /** N2 成交额前n名：排名只取一次；附行业f100，不拿股票get接口的f127替代。 */
  async function getTopTurnover(n = 20) {
    return safe(() => {
      assert(Number.isSafeInteger(n) && n >= 1 && n <= 100, '成交额排名数量须为1–100');
      const candidates = eastCandidates('qt/clist/get', {
        pn: 1, pz: n, po: 1, np: 1, fltt: 2, invt: 2, fid: 'f6',
        fs: 'm:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23', fields: 'f3,f6,f12,f13,f14,f100,f124',
      });
      candidates.push({ id: 'sina:hs-a-turnover', kind: 'cors-json', url: url('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData', {
        page: 1, num: n, sort: 'amount', asc: 0, node: 'hs_a', symbol: '', _s_r_a: 'page',
      }) });
      return cached(`top-turnover:${n}`, 15000, () => fallback(candidates, (raw, candidate, at) => candidate.id.startsWith('sina:') ? parseSinaTopTurnover(raw, n, { source: candidate.id, fetchedAt: at }) : parseTopTurnover(raw, n, { source: candidate.id, fetchedAt: at })));
    });
  }
  /**
   * N3 昨成交20等权平均涨跌幅，不冒充官方指数。
   * snapshot须为前一交易日完整N2：ok、source/sourceDate/fetchedAt/asOf、20条唯一排名、
   * scope=CN_A_SH_SZ_CDR、coverage.complete、isFinal及finality.confirmed/evidence均经审查。
   * 这里只消费快照，不凭盘中排名保存“最终快照”，不猜历史排名。
   */
  async function getYesterdayTopTurnover({ snapshot, tradeDate = chinaClock(now()).date } = {}) {
    return safe(async () => {
      const date = dateISO(tradeDate);
      assert(date <= chinaClock(now()).date, 'N3不能计算未来交易日');
      const day = await getTradingCalendar({ at: `${date}T12:00:00+08:00` });
      assert(day.ok && day.scheduledTradingDay, 'N3目标日不是已核日历覆盖的交易日');
      let previousDate = null;
      for (let offset = 1; offset <= 40; offset++) {
        const candidate = new Date(Date.parse(`${date}T00:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);
        const status = await getTradingCalendar({ at: `${candidate}T12:00:00+08:00` });
        assert(status.ok, '前一交易日超出已核官方日历范围');
        if (status.scheduledTradingDay) { previousDate = candidate; break; }
      }
      assert(previousDate, '无法确定前一交易日');
      assert(snapshot?.ok === true && snapshot.scope === TOP_TURNOVER_SCOPE && snapshot.ranking === 'amount-desc', '缺少口径明确、真实来源的前一交易日前20快照');
      assert(snapshot.sourceDate === previousDate && snapshot.coverage?.complete === true && Array.isArray(snapshot.rows) && snapshot.rows.length === 20, '快照必须恰好是前一交易日完整20只，不能使用部分样本或其他日期');
      assert(typeof snapshot.source === 'string' && snapshot.source.length > 0 && Number.isFinite(Date.parse(snapshot.fetchedAt)) && Number.isFinite(Date.parse(snapshot.asOf)), '快照缺少可审查的source/fetchedAt/asOf');
      const asOf = chinaClock(new Date(snapshot.asOf));
      assert(asOf.date === previousDate && asOf.time >= '15:30:00' && Date.parse(snapshot.fetchedAt) >= Date.parse(snapshot.asOf) && Date.parse(snapshot.fetchedAt) <= now().getTime(), '快照观察时点不是前一交易日盘后或接收时间无效');
      assert(snapshot.isFinal === true && snapshot.finality?.confirmed === true && typeof snapshot.finality.evidence === 'string' && snapshot.finality.evidence.trim().length > 0, '快照日终完成状态缺少独立确认及证据');
      const symbols = [], seen = new Set(); let previousAmount = Infinity;
      snapshot.rows.forEach((row, index) => {
        assert(/^(sh(?:60|68)|sz(?:00|30))\d{4}$/.test(row.symbol ?? '') && row.code === row.symbol.slice(2) && !seen.has(row.symbol), '快照股票代码无效或重复');
        assert(row.rank === index + 1 && row.sourceDate === previousDate && row.source === snapshot.source && Number.isFinite(Date.parse(row.fetchedAt)), '快照逐行排名、来源、日期或接收时间不完整');
        const amount = numeric(row.amount, '昨日快照成交额', { nonnegative: true });
        assert(amount <= previousAmount, '昨日快照不是按成交额降序'); previousAmount = amount;
        seen.add(row.symbol); symbols.push(row.symbol);
      });
      const realtime = await quotes(symbols);
      assert(realtime.ok && realtime.rows?.length === 20, realtime.reason ?? '今日20股报价不完整');
      assert(realtime.rows.every(row => row.sourceDate === date && Number.isFinite(row.pct)), '今日报价日期不一致或涨跌幅缺失，不能以部分样本计算');
      const rows = realtime.rows.map((row, index) => ({ ...row, previousRank: index + 1, previousAmount: snapshot.rows[index].amount }));
      return { ok: true, officialIndex: false, name: '昨日成交额前20等权平均涨跌幅', calculation: 'equal-weight-mean-of-source-pct',
        previousTradeDate: previousDate, sampleCount: 20, meanPct: rows.reduce((sum, row) => sum + row.pct, 0) / 20, rows,
        snapshot: { source: snapshot.source, sourceDate: snapshot.sourceDate, fetchedAt: snapshot.fetchedAt, asOf: snapshot.asOf, finality: snapshot.finality },
        ...metadata([...new Set([snapshot.source, ...rows.map(row => row.source)])], realtime.fetchedAt, { ...commonTime(rows), sourceDate: date }) };
    });
  }
  /** N4允许盘中比值；必须真实总额、同交易日、口径已核且来源时点可比。 */
  async function getBoardTurnoverShare({ board, market, maxSkewMs = 120000 } = {}) {
    return safe(async () => {
      assert(market?.ok === true && market.scopeVerified === true, 'D3两市成交额口径尚未核实或数据缺失，不能计算板块占比');
      assert(board && board.ok !== false && board.source && market.source, '板块或两市成交额来源缺失');
      const date = dateISO(market.sourceDate);
      assert(board.sourceDate === date, '板块与两市成交额交易日不一致或缺失');
      assert(Number.isFinite(maxSkewMs) && maxSkewMs >= 0 && maxSkewMs <= 300000, '允许的源时间差应为0–300000毫秒');
      assert(board.sourceTime && market.sourceTime && Number.isFinite(Date.parse(board.sourceTime)) && Number.isFinite(Date.parse(market.sourceTime)), '缺少可核源时间，无法确认板块和两市成交额时点可比');
      const skewMs = Math.abs(Date.parse(board.sourceTime) - Date.parse(market.sourceTime));
      assert(skewMs <= maxSkewMs, '板块与两市成交额源时点相差过大');
      assert(typeof market.scope === 'string' && market.scope.length > 0 && board.scopeVerified === true && board.marketScope === market.scope && typeof board.scopeEvidence === 'string' && board.scopeEvidence.trim().length > 0, '板块市场范围未核实或与两市成交额范围不相容，不能把未知范围当作已相容');
      assert(chinaClock(new Date(board.sourceTime)).date === date && chinaClock(new Date(market.sourceTime)).date === date && Date.parse(board.sourceTime) <= now().getTime() + 60000 && Date.parse(market.sourceTime) <= now().getTime() + 60000, '源时间与交易日不符或位于未来');
      const numerator = numeric(board.amount, '板块成交额', { nonnegative: true }), denominator = numeric(market.amount, '两市成交额', { nonnegative: true });
      assert(denominator > 0 && numerator <= denominator, '两市成交额须大于0且板块额不能超过同口径市场总额');
      const isFinal = market.isFinal === true && board.isFinal === true;
      return { ok: true, code: board.code ?? null, boardAmount: numerator, marketAmount: denominator, sharePct: numerator / denominator * 100,
        scope: market.scope, scopeVerified: true, sourceSkewMs: skewMs, isFinal, provisional: !isFinal, phase: isFinal ? 'final' : 'intraday-or-unconfirmed-final',
        warning: '单个板块占比；重叠行业或概念占比不可直接相加。此工具不判定45%阈值或行情阶段。',
        ...metadata([board.source, market.source], fetched(), { sourceDate: date, sourceTime: market.sourceTime, sourceTimeTrust: 'derived-from-two-comparable-source-times' }) };
    });
  }
  /** D10 仅对完整官方休市日历覆盖范围给出判断，调休周末也不开市。 */
  async function getTradingCalendar({ at = now() } = {}) {
    return safe(async () => {
      const instant = new Date(at);
      assert(Number.isFinite(instant.getTime()), '待判断时间无效');
      const current = chinaClock(instant);
      assert(calendar && Array.isArray(calendar.holidays) && Array.isArray(calendar.source) && calendar.source.length > 0, '未配置经官方公告核验的完整交易日历；不能把周一至周五直接当交易日');
      const start = dateISO(calendar.start), end = dateISO(calendar.end);
      assert(current.date >= start && current.date <= end, `交易日历未覆盖 ${current.date}，可用范围 ${start} 至 ${end}`);
      const holidays = new Set(calendar.holidays.map(dateISO));
      const weekday = new Date(`${current.date}T12:00:00+08:00`).getUTCDay();
      const isTradingDay = weekday > 0 && weekday < 6 && !holidays.has(current.date);
      const minute = current.time.slice(0, 5);
      const isContinuousTrading = isTradingDay && ((minute >= '09:30' && minute < '11:30') || (minute >= '13:00' && minute < '14:57'));
      const isAuction = isTradingDay && ((minute >= '09:15' && minute < '09:25') || (minute >= '14:57' && minute < '15:00'));
      const afterHoursActive = isTradingDay && minute >= '15:05' && minute < '15:30';
      const phase = !isTradingDay ? 'closed-day' : isAuction ? 'auction' : isContinuousTrading ? 'continuous' : afterHoursActive ? 'after-hours' : minute < '09:30' ? 'before-open' : minute >= '15:30' ? 'after-close' : minute >= '15:00' ? 'after-hours-preparation' : 'midday-break';
      return { ok: true, date: current.date, time: current.time, timezone: 'Asia/Shanghai',
        scheduledTradingDay: isTradingDay, isTradingDay, isContinuousTrading, isAuction,
        isMarketOpen: isContinuousTrading || isAuction || afterHoursActive, phase,
        regularSession: { open: isContinuousTrading || isAuction, continuous: ['09:30–11:30', '13:00–14:57'], auction: ['09:15–09:25', '14:57–15:00'] },
        afterHours: { open: afterHoursActive, start: '15:05', end: '15:30', scope: current.date >= '2026-07-06' ? '沪深 A 股及 ETF 等符合盘后固定价格交易条件的证券' : '仅适用支持盘后固定价格交易的证券，不能推定所有股票', source: calendar.sessionSource ?? null, additionalSource: 'https://docs.static.szse.cn/www/lawrules/rule/trade/current/W020260424690713155663.pdf' },
        refreshRecommended: isTradingDay && minute >= '09:15' && minute <= '15:35',
        dailyDataFinal: null, finalityReason: '年度日历及本机时钟不能证明当日量额已最终完成；应核对行情来源时钟及盘后更新',
        unscheduledClosuresVerified: calendar.unscheduledClosuresVerified === true,
        coverage: { start, end }, verifiedOn: calendar.verifiedOn ?? null,
        ...metadata(calendar.source, fetched(), { sourceTimeTrust: 'official-calendar-rule-plus-device-clock-not-market-observation' }) };
    });
  }
  function beginRefresh({ maxRequests: limit = maxRequests } = {}) {
    assert(pending.size === 0, '仍有请求进行中，不能重置预算');
    assert(Number.isSafeInteger(limit) && limit > 0, '请求预算无效');
    used = 0;
    roundMax = limit;
    return getRequestStats();
  }
  function getRequestStats() { return { requests: used, maxRequests: roundMax, remaining: Math.max(0, roundMax - used), pending: pending.size, cachedEntries: cache.size }; }
  return { getIndexQuotes, getIndexDaily, getMarketTurnover, getMarketBreadth, getBoards, getBoardDaily, getLimitPools, getLimitStockSectors, getEtfData, getTradingCalendar, getTopTurnover, getYesterdayTopTurnover, getBoardTurnoverShare, beginRefresh, getRequestStats };
}

const defaultDataSource = createDataSource();
export const { getIndexQuotes, getIndexDaily, getMarketTurnover, getMarketBreadth, getBoards, getBoardDaily, getLimitPools, getLimitStockSectors, getEtfData, getTradingCalendar, getTopTurnover, getYesterdayTopTurnover, getBoardTurnoverShare, beginRefresh, getRequestStats } = defaultDataSource;
export default defaultDataSource;

