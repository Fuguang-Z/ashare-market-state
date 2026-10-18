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
/**
 * 外围科技指数（只作展示，不参与判定）。日 K：东财 push2his 为主（每个指数一次请求，调用方按日缓存）；
 * 纳指走腾讯；费城半导体在东财不可用时改用跟踪它的 SOXQ ETF（页面注明）。日韩盘中涨跌走腾讯报价。
 * settle：北京时间该时刻之后，当日日 K 视为收定。
 */
export const OVERSEAS = Object.freeze([
  { key: 'SOX', name: '费城半导体', region: '美', secid: '251.SOX', proxy: 'usSOXQ.OQ', settle: '06:00' },
  { key: 'IXIC', name: '纳斯达克', region: '美', tencent: 'usIXIC', settle: '06:00' },
  { key: 'N225', name: '日经225', region: '日', secid: '100.N225', quote: 'gzN225', settle: '14:35' },
  { key: 'KS11', name: '韩国KOSPI', region: '韩', secid: '100.KS11', quote: 'gzKS11', settle: '14:35' },
]);
const ALL_SYMBOLS = [...INDEXES, ...ETFS];
const QUOTE_FIELDS = 'f2,f3,f6,f12,f13,f14,f17,f18,f124';
const BOARD_FIELDS = 'f2,f3,f6,f12,f14,f20,f104,f105,f128,f140,f124';
const POOL_NAMES = { up: 'getTopicZTPool', down: 'getTopicDTPool', broken: 'getTopicZBPool', yesterday: 'getYesterdayZTPool' };
const EXPECTED_POOLS = Object.keys(POOL_NAMES);
export const TOP_TURNOVER_SCOPE = 'CN_A_SH_SZ_CDR';
// 历史包与浏览器的沪深范围标签映射；不接受包含北交所的全A范围。
export const TURNOVER_MARKET_SCOPES = Object.freeze(['CN_A_SH_SZ_CDR', 'CN_A_SH_SZ', 'SH_SZ_A_SHARES_EXCLUDING_BSE']);
let callbackSerial = 0;
let tencentScriptQueue = Promise.resolve();
let assignmentScriptQueue = Promise.resolve();

/** 全模块共享限速队列；成功与失败请求都占位，启动间隔至少3秒并加抖动。 */
export function createRequestScheduler({ sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = () => performance.now(), random = Math.random } = {}) {
  let tail = Promise.resolve(), lastStart = -Infinity;
  return task => {
    const run = async () => {
      const gap = 3000 + Math.floor(Math.max(0, Math.min(1, random())) * 200);
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

/** 每个页面共享的东财滚动窗口，含push2ex；超限交给下一刷新轮，不等待重试。 */
export function createEastmoneyRateLimit({ now = () => Date.now() } = {}) {
  const starts = [];
  const applies = value => new URL(value).hostname.endsWith('.eastmoney.com');
  function check(value, reserve = false) {
    if (!applies(value)) return;
    const time = now();
    while (starts.length && starts[0] <= time - 60000) starts.shift();
    if (starts.length >= 3) { const error = new Error('本页面东财每分钟3次额度已用完，请留待下一刷新轮'); error.deferred = true; error.retryAfterMs = Math.max(0, starts[0] + 60000 - time); throw error; }
    if (reserve) starts.push(time);
  }
  return { check: value => check(value), reserve: value => check(value, true) };
}
const sharedEastmoneyRateLimit = createEastmoneyRateLimit();

export const refreshPlan = Object.freeze({
  version: 1, maxRequestsPerRound: 20, globalStartGapMs: 3000, eastmoneyMaxRequestsPerRollingMinute: 3,
  mainTick: {
    intervalMs: 60000, beginRefreshOncePerTick: true, busyPolicy: '前一轮未结束则跳过当前tick，不并发、不重置预算',
    ordinary: { functionsInOrder: ['getIndexQuotes', 'getProjectedTurnover', 'getMarketBreadth', 'getLimitPools(poolRotation)', 'getBoards', 'getBoardMembers(optional-one-board)'], plannedRequests: 13, hardLimit: 20 },
    everyFifthTick: { replacesOrdinary: true, functionsInOrder: ['getProjectedTurnover', 'getWideRangeCandidates'], plannedRequests: 20, breakdown: { projectionQuote: 1, curveFirstLoad: 1, wideRangeMaximum: 18 }, note: '重轮替代普通轮；不同时运行成员、目录、池或指数整组。先预估后宽幅，宽幅保留18额度' },
    prewarm: '静态映射与已完成K使用独立空闲tick，替代该tick普通轮，不与任何mainTick叠加；一次仍最多20。',
  },
  rounds: [
    { name: 'minute', intervalMs: 60000, functions: ['getIndexQuotes', 'getProjectedTurnover', 'getMarketBreadth', 'getLimitPools', 'getBoards'], maxRequests: 10, note: '先分布1次+轮换池2次，再板块目录；东财额度不足时目录转新浪。静态曲线仅首次读取' },
    { name: 'members', intervalMs: 60000, functions: ['getBoardMembers'], maxRequests: 3, note: '仅普通轮中的可选一个板块；计入同一预算，不单独重置' },
    { name: 'wideRange', intervalMs: 300000, functions: ['getWideRangeCandidates'], maxRequests: 18, note: '每第五tick替代普通轮：2页前200+1批报价+最多15日K；与预估最多2次共20，不重置预算' },
    { name: 'completedDaily', intervalMs: 86400000, functions: ['getBoardRecentDaily'], maxRequests: 13, note: '最多6个板块，仅缓存此前已完成K；当日K与D5报价分开，不冻结盘中K' },
  ],
  poolRotation: [
    { roundModulo2: 0, function: 'getLimitPools', args: { kinds: ['up', 'down'] } },
    { roundModulo2: 1, function: 'getLimitPools', args: { kinds: ['broken', 'yesterday'] } },
  ],
  poolAccumulation: '调用方按sourceDate与kind保存最近成功结果，并显示fetchedAt年龄；不同刷新轮不是同一时点。新交易日清空，失败不冒充新鲜值。D8仅复用up池30秒缓存。',
  afterClose: '停止周期行情轮；保留sourceDate，跨交易日重新验证缓存。无常驻后台程序。',
});

export const EASTMONEY_COOLDOWN_POLICY = Object.freeze({
  key: 'ashare-market-state.eastmoney-cooldown.20261014.v1',
  until: '2026-10-14T23:10:00+08:00', probeIntervalMs: 30 * 60 * 1000,
  hosts: Object.freeze(['push2.eastmoney.com', 'push2delay.eastmoney.com', 'push2his.eastmoney.com']),
});
const cooldownMemory = new Map();
let cooldownLockTail = Promise.resolve();
function coolingError(reason) { const error = new Error(reason); error.cooldownSkipped = true; return error; }
function cooldownStorageDefault() {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
    if (typeof window !== 'undefined') throw new Error('浏览器localStorage不可用');
    return { getItem: key => cooldownMemory.get(key) ?? null, setItem: (key, value) => cooldownMemory.set(key, value) };
  } catch { return { getItem() { throw new Error('localStorage不可用，无法保证跨页面冷却，已暂停东财三源'); }, setItem() { throw new Error('localStorage不可用'); } }; }
}
function withCooldownLock(work) {
  // 统一以异步回调释放锁；Node 24 的同步异常回调会使后续同名锁悬挂。
  const run = () => globalThis.navigator?.locks?.request ? navigator.locks.request(EASTMONEY_COOLDOWN_POLICY.key, async () => work()) : work();
  const task = cooldownLockTail.then(run, run);
  cooldownLockTail = task.catch(() => {});
  return task;
}
/** push2/push2delay/push2his共享冷却组；push2ex不在组中。localStorage只保存公开源状态。 */
export function createEastmoneyCooldown({ now = () => new Date(), storage = cooldownStorageDefault() } = {}) {
  const policy = EASTMONEY_COOLDOWN_POLICY, initialUntil = Date.parse(policy.until);
  const gated = requestURL => policy.hosts.includes(new URL(requestURL).hostname);
  const fresh = () => ({ schema: 2, status: 'cooldown', healthyHosts: [], nextProbeAt: initialUntil, lastRecoveredAt: null, lastFailureAt: null, probeToken: null, reason: '2026-10-14东财IP限流，按六小时冷却政策暂停' });
  function read() {
    const encoded = storage.getItem(policy.key);
    if (!encoded) return fresh();
    let state = JSON.parse(encoded);
    // 旧版组健康状态没有逐主机证据，迁移时保留节流期限但不推定三个主机都恢复。
    if (state?.schema === 1 && Number.isFinite(state.nextProbeAt)) state = { ...fresh(), nextProbeAt: state.nextProbeAt, reason: '旧版状态未记录逐主机恢复，等待独立验证' };
    assert(state?.schema === 2 && ['cooldown', 'probing', 'healthy'].includes(state.status) && Number.isFinite(state.nextProbeAt) && Array.isArray(state.healthyHosts) && state.healthyHosts.every(host => policy.hosts.includes(host)) && new Set(state.healthyHosts).size === state.healthyHosts.length, '东财冷却状态无效，禁止绕过恢复探测');
    return state;
  }
  function write(state) { storage.setItem(policy.key, JSON.stringify(state)); }
  function ensureAllowed(state, host) {
    const time = now().getTime();
    if (time < initialUntil) throw coolingError(`东财push2/push2delay/push2his冷却至${policy.until}；已跳过，不计网络请求`);
    if (!state.healthyHosts.includes(host) && time < state.nextProbeAt) throw coolingError(`东财三源共享冷却，下一次恢复探测不早于${new Date(state.nextProbeAt).toISOString()}；已跳过`);
  }
  async function check(requestURL) {
    if (!gated(requestURL)) return;
    await withCooldownLock(() => {
      let state;
      try { state = read(); } catch (error) { throw coolingError(error.message); }
      ensureAllowed(state, new URL(requestURL).hostname);
    });
  }
  async function before(requestURL) {
    if (!gated(requestURL)) return { gated: false };
    return withCooldownLock(() => {
      let state;
      try { state = read(); } catch (error) { throw coolingError(error.message); }
      const host = new URL(requestURL).hostname;
      ensureAllowed(state, host);
      if (state.healthyHosts.includes(host)) return { gated: true, probe: false, host };
      const time = now().getTime(), probeToken = `${time}-${Math.random().toString(36).slice(2)}`;
      state = { ...state, status: 'probing', nextProbeAt: time + policy.probeIntervalMs, probeToken };
      try { write(state); } catch { throw coolingError('无法持久化东财恢复探测锁，已暂停该请求'); }
      return { gated: true, probe: true, probeToken, host };
    });
  }
  async function settle(ticket, success, reason = '') {
    if (!ticket.gated) return;
    await withCooldownLock(() => {
      const state = read(), time = now().getTime();
      if (ticket.probe && state.probeToken !== ticket.probeToken) return;
      if (success) {
        if (ticket.probe) {
          const healthyHosts = [...new Set([...state.healthyHosts, ticket.host])];
          write({ ...state, status: healthyHosts.length === policy.hosts.length ? 'healthy' : 'cooldown', healthyHosts, lastRecoveredAt: time, lastRecoveredHost: ticket.host, probeToken: null, reason: healthyHosts.length === policy.hosts.length ? null : '仅已验证主机开放，其余主机等待共享恢复探测窗口' });
        }
      } else {
        write({ ...state, status: 'cooldown', healthyHosts: state.healthyHosts.filter(host => host !== ticket.host), nextProbeAt: Math.max(initialUntil, time + policy.probeIntervalMs), lastFailureAt: time, lastFailureHost: ticket.host, probeToken: null, reason: String(reason) });
      }
    });
  }
  async function snapshot() { return withCooldownLock(() => ({ ...read(), cooldownUntil: policy.until, hosts: [...policy.hosts], probeIntervalMs: policy.probeIntervalMs })); }
  return { check, before, settle, snapshot };
}

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
export async function corsJSON(requestURL, { referrerPolicy } = {}) {
  assert(new URL(requestURL).protocol === 'https:', '公开源必须使用 HTTPS');
  assert(referrerPolicy === undefined || referrerPolicy === 'no-referrer', '不支持的公开接口Referrer策略');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(requestURL, { mode: 'cors', credentials: 'omit', redirect: 'error', signal: controller.signal, ...(referrerPolicy ? { referrerPolicy } : {}) });
    assert(response.ok, `公开接口 HTTP ${response.status}`);
    const text = await response.text();
    assert(text.length <= 5000000, '公开接口响应超过 5 MB 上限');
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

/** 公开接口的变量赋值脚本；用浏览器script执行，不使用eval/Function。 */
export function assignmentScript(requestURL, { variable, charset = 'gbk' } = {}) {
  assertJSONPEnvironment();
  assert(new URL(requestURL).protocol === 'https:' && /^[A-Za-z_$][\w$]*$/.test(variable ?? '') && !['__proto__', 'constructor', 'prototype'].includes(variable), '赋值脚本URL或变量名无效');
  const run = () => new Promise((resolve, reject) => {
    const previous = Object.getOwnPropertyDescriptor(window, variable), oldValue = window[variable];
    // 先建立可删除属性，避免第三方var声明留下不可清理的全局绑定。
    if (!previous) Object.defineProperty(window, variable, { value: undefined, configurable: true, writable: true, enumerable: true });
    else window[variable] = undefined;
    const script = document.createElement('script'); let settled = false;
    const finish = error => {
      if (settled) return; settled = true;
      clearTimeout(timer); const value = window[variable];
      script.remove(); script.onerror = null; script.onload = null;
      if (previous) window[variable] = oldValue;
      else if (Object.getOwnPropertyDescriptor(window, variable)?.configurable) delete window[variable];
      else window[variable] = undefined;
      if (!error && (value === undefined || value === null)) error = new Error('赋值脚本未返回约定变量');
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('赋值脚本8秒超时')), 8000);
    script.charset = charset; script.async = true; script.src = requestURL;
    script.onerror = () => finish(new Error('赋值脚本加载失败（网络或来源拒绝）'));
    script.onload = () => finish(null);
    document.head.appendChild(script);
  });
  const task = assignmentScriptQueue.then(run, run); assignmentScriptQueue = task.catch(() => {}); return task;
}

/** 同花顺固定quotebridge回调；串行保留原全局值，不eval响应。 */
export function fixedCallbackScript(requestURL, { callbackName, charset = 'utf-8' } = {}) {
  assertJSONPEnvironment();
  assert(new URL(requestURL).protocol === 'https:' && /^quotebridge_[\w]+$/.test(callbackName ?? ''), '固定回调名称或URL无效');
  const run = () => new Promise((resolve, reject) => {
    const descriptor = Object.getOwnPropertyDescriptor(window, callbackName), old = window[callbackName];
    let value, called = false, finished = false;
    const script = document.createElement('script');
    const finish = error => {
      if (finished) return; finished = true; clearTimeout(timer); script.remove(); script.onload = null; script.onerror = null;
      if (descriptor) window[callbackName] = old; else delete window[callbackName];
      error ? reject(error) : resolve(value);
    };
    window[callbackName] = data => { called = true; value = data; };
    const timer = setTimeout(() => finish(new Error('固定回调脚本8秒超时')), 8000);
    script.src = requestURL; script.charset = charset; script.async = true;
    script.onerror = () => finish(new Error('固定回调脚本加载失败'));
    script.onload = () => finish(called ? null : new Error('固定回调未被调用'));
    document.head.appendChild(script);
  });
  const task = assignmentScriptQueue.then(run, run); assignmentScriptQueue = task.catch(() => {}); return task;
}

/** 腾讯 qt 返回 v_sh... 赋值脚本，不冒充 cb= JSONP；GBK 由浏览器脚本解码。 */
export function tencentQuoteScript(symbols) {
  assertJSONPEnvironment();
  assert(Array.isArray(symbols) && symbols.length > 0 && symbols.length <= 200 && symbols.every(s => /^(sh|sz)\d{6}$|^gz[A-Z0-9]{2,8}$/.test(s)), '腾讯报价代码列表无效');
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
      high: numeric(fields[33], 'high', { nonnegative: true, nullable: true }), low: numeric(fields[34], 'low', { nonnegative: true, nullable: true }),
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

/** 外围指数日 K：行为 [日期, 开, 高, 低, 收]；只校验日期递增与 OHLC 关系（无成交额口径）。 */
export function parseOverseasDaily(rows, key, { source, fetchedAt = new Date().toISOString() } = {}) {
  assert(Array.isArray(rows) && rows.length >= 5 && rows.length <= 400, `${key} 日 K 数量无效`);
  let previous = '';
  const out = rows.map(([d, o, h, l, c]) => {
    const date = dateISO(d);
    assert(date > previous && date <= chinaClock(new Date(fetchedAt)).date, `${key} 日 K 日期重复、乱序或位于未来`);
    previous = date;
    const open = numeric(o, 'open'), high = numeric(h, 'high'), low = numeric(l, 'low'), close = numeric(c, 'close');
    assert(low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close), `${key} 日 K OHLC 无效`);
    return { date, open, high, low, close };
  });
  return { key, rows: out, ...metadata(source, fetchedAt, { sourceDate: out.at(-1).date, sourceTimeTrust: 'source-daily-date' }) };
}

/** 腾讯全球指数简版报价（gz 前缀）：0=代码 1=名称 2=时间 3=现价 4=涨跌 5=涨跌幅；无开高低。 */
export function parseOverseasQuotes(raw, symbols, { source = 'tencent:qt', fetchedAt = new Date().toISOString() } = {}) {
  assert(raw && typeof raw === 'object', '腾讯响应不是报价映射');
  return symbols.map(symbol => {
    const fields = String(raw[symbol] ?? '').split('~');
    assert(fields.length >= 6 && fields[0] === symbol.slice(2), `腾讯 ${symbol} 标识或字段数量不符`);
    const price = numeric(fields[3], 'price', { nonnegative: true }), change = numeric(fields[4], 'change');
    assert(price > 0, '行情价格为零或缺失');
    const sourceDate = dateISO(String(fields[2]).slice(0, 10));
    return { symbol, price, previousClose: price - change, pct: numeric(fields[5], 'pct'), sourceDate, sourceTime: String(fields[2]), source, fetchedAt };
  });
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

/** 新浪列7金额为元：第一方bk100111_2.js展示时/10000，且玻璃行业成分实额求和闭环。 */
export function parseSinaBoards(raw, type, { source = 'sina:board-assignment', fetchedAt = new Date().toISOString() } = {}) {
  assert(['industry', 'concept'].includes(type) && raw && typeof raw === 'object' && !Array.isArray(raw), '新浪板块结构或类型无效');
  const entries = Object.entries(raw);
  assert(entries.length > 0 && entries.length <= 3000, '新浪板块目录为空或超出支持范围');
  return entries.map(([key, value]) => {
    const fields = String(value).split(',');
    assert(fields.length === 13 && fields[0] === key && /^(new_|gn_)[\w]+$/.test(key), '新浪板块字段或代码无效');
    const leaderSymbol = /^(sh|sz)\d{6}$/.test(fields[8]) ? fields[8] : null;
    return { code: key, namespace: 'sina', eastmoneyCode: null, name: fields[1], type,
      members: integer(fields[2], '新浪板块成分数'), pct: numeric(fields[5], '新浪板块 pct', { nullable: true }),
      amount: numeric(fields[7], '新浪板块 amount 元', { nonnegative: true, nullable: true }),
      volumeShares: numeric(fields[6], '新浪板块成交股数', { nonnegative: true, nullable: true }),
      marketCap: null, up: null, down: null,
      leader: { symbol: leaderSymbol, code: leaderSymbol?.slice(2) ?? null, name: fields[12] || null, pct: numeric(fields[9], '新浪领涨股 pct', { nullable: true }), price: numeric(fields[10], '新浪领涨股价格 元', { nonnegative: true, nullable: true }) },
      missingFields: ['marketCap', 'up', 'down', 'sourceDate', 'sourceTime'],
      taxonomy: '新浪行业/概念分类，不自动等同东财BK代码',
      unitEvidence: 'https://i1.sinaimg.cn/cj/finance_js/bk100111_2.js?s=1',
      ...metadata(source, fetchedAt),
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
      responseQdate, dateEvidence: 'first-party-date-request-contract',
      ...metadata(source, fetchedAt, { sourceDate: actual, sourceTimeTrust: 'first-party-date-request-contract' }),
    };
  });
  return { kind, date: actual, responseQdate, dateEvidence: 'first-party-date-request-contract', rows, count: rows.length, scope: '东方财富涨跌停专题池，排除范围以供应商规则为准，不代表全 A 股', ...metadata(source, fetchedAt, { sourceDate: actual, sourceTimeTrust: 'first-party-date-request-contract' }) };
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
    return { rank: index + 1, symbol, code, name: String(row.f14 ?? ''), amount, pct: numeric(row.f3, '个股 pct'), industry,
      ...metadata(source, fetchedAt, quoteTime(row.f124, fetchedAt)) };
  });
  const missingFields = [...(rows.some(row => row.industry === null) ? ['industry'] : []), ...(rows.some(row => row.sourceDate === null) ? ['sourceDate'] : [])];
  return { rows, n, ranking: 'amount-desc', scope: TOP_TURNOVER_SCOPE, scopeLabel: '沪深 A 股及 CDR，包含 ST，不含 B 股及北交所', missingFields, partial: missingFields.length > 0,
    coverage: { complete: true, expected: n, received: rows.length, universeCount: total },
    isFinal: null, finality: { confirmed: false, evidence: null },
    ...metadata(source, fetchedAt, commonTime(rows)) };
}

/** 新浪 hs_a 真实排名作为N2备源；未知交易日期和行业留空，不能作为N3最终快照。 */
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
  return { ok: true, partial: true, warning: '新浪真实hs_a成交额排名；行业及交易日期缺失保持null，不能直接作为N3最终快照',
    rows, n, ranking: 'amount-desc', scope: 'SINA_HS_A_UNVERIFIED', scopeLabel: '新浪 hs_a 节点（覆盖范围待核）', scopeVerified: false,
    missingFields: ['industry', 'sourceDate'], coverage: { complete: true, expected: n, received: rows.length }, usableForFinalSnapshot: false, isFinal: null,
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
      consecutiveLimitUps: label === '首板' ? 1 : consecutive ? Number(consecutive[1]) : null, limitLabel: label || null,
      industry: null, concepts: null, reasonText: row.reason_type == null ? null : String(row.reason_type),
      ...metadata(source, fetchedAt, { sourceDate: actual, sourceTimeTrust: 'source-pool-date' }) };
  });
  return { kind: 'up', date: actual, rows, count: rows.length, scope: '同花顺 HS,GEM2STAR 专题池；与东财排除规则可能不同', missingFields: ['amount', 'industry', 'concepts', '部分非连续板的 consecutiveLimitUps'], ...metadata(source, fetchedAt, { sourceDate: actual, sourceTimeTrust: 'source-pool-date' }) };
}

/** 腾讯前复权日 K → {date: {close, high, low}} */
export function parseStockKline(raw, sym, { fetchedAt = new Date().toISOString() } = {}) {
  assert(raw && Number(raw.code) === 0 && raw.data && raw.data[sym], '腾讯个股日 K 状态或代码无效');
  const src = raw.data[sym].qfqday ?? raw.data[sym].day;
  assert(Array.isArray(src) && src.length > 0, '腾讯个股日 K 为空');
  const bars = {};
  for (const f of src) {
    const date = dateISO(f[0]), close = Number(f[2]), high = Number(f[3]), low = Number(f[4]);
    assert(Number.isFinite(close) && Number.isFinite(high) && Number.isFinite(low) && low > 0 && high >= low, '腾讯个股日 K 数值无效');
    bars[date] = { close, high, low };
  }
  return { ok: true, bars, fetchedAt };
}

/** 同花顺涨停池一页：只取代码、名称、连板标签与题材原文。 */
export function parseTHSLimitThemes(raw, requestedDate, { fetchedAt = new Date().toISOString() } = {}) {
  assert(raw && Number(raw.status_code) === 0 && raw.data && Array.isArray(raw.data.info), '同花顺涨停池结构或业务状态无效');
  assert(dateISO(raw.data.date) === dateISO(requestedDate), '同花顺涨停池请求日期不符');
  const total = integer(raw.data.page?.total, '同花顺涨停池总数');
  const rows = raw.data.info.map(row => {
    const label = String(row.high_days ?? ''), m = /^(\d+)天\1板$/.exec(label);
    return { code: String(row.code ?? ''), name: String(row.name ?? ''), reasonText: row.reason_type == null ? null : String(row.reason_type),
      limitLabel: label || null, consecutive: label === '首板' ? 1 : m ? Number(m[1]) : null };
  });
  const up = raw.data.limit_up_count?.today ?? {}, dn = raw.data.limit_down_count?.today ?? {};
  const counts = { up: Number.isFinite(Number(up.num)) ? Number(up.num) : null, down: Number.isFinite(Number(dn.num)) ? Number(dn.num) : null,
    broken: Number.isFinite(Number(up.open_num)) ? Number(up.open_num) : null, tradeStatus: raw.data.trade_status?.id ?? null };
  return { ok: true, rows, total, counts, fetchedAt };
}

/** 东财板块排行一页（概念或行业）：代码、名称、今日涨跌幅、5 日涨跌幅（源字段 f109）、领涨股。 */
export function parseBoardRanking(raw, type, { source = 'eastmoney:push2', fetchedAt = new Date().toISOString() } = {}) {
  const rows = eastRows(raw).map(r => ({ code: String(r.f12 ?? ''), name: String(r.f14 ?? ''), type,
    pct: Number.isFinite(Number(r.f3)) ? Number(r.f3) : null, p5: Number.isFinite(Number(r.f109)) ? Number(r.f109) : null,
    leader: r.f128 && r.f128 !== '-' ? String(r.f128) : null }));
  assert(rows.every(r => /^BK\d{4}$/.test(r.code) && r.name), '东财板块排行代码或名称无效');
  return { ok: true, rows, total: integer(raw.data.total, '东财板块总数'), type, ...metadata(source, fetchedAt) };
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

/** 正负桶各自相加；±11是涨跌停独立桶，0桶为平盘，不与±10重复。 */
export function parseBreadthDistribution(raw, { source = 'eastmoney:push2ex-distribution', fetchedAt = new Date().toISOString() } = {}) {
  assert(raw && Number(raw.rc) === 0 && raw.data && Array.isArray(raw.data.fenbu), '涨跌分布结构或业务状态无效');
  const sourceDate = dateISO(raw.data.qdate);
  assert(sourceDate <= chinaClock(new Date(fetchedAt)).date, '涨跌分布源日期在未来');
  const buckets = {}, seen = new Set();
  for (const item of raw.data.fenbu) {
    const entries = Object.entries(item ?? {});
    assert(entries.length === 1, '涨跌分布桶结构无效');
    const [key, value] = entries[0], number = Number(key);
    assert(/^-?\d+$/.test(key) && Number.isInteger(number) && number >= -11 && number <= 11 && !seen.has(number), '涨跌分布桶重复或范围无效');
    seen.add(number); buckets[number] = integer(value, '涨跌分布桶家数');
  }
  assert(seen.size === 23 && seen.has(0), '涨跌分布缺少完整正负零桶，不把缺桶填零');
  let up = 0, down = 0;
  for (let number = 1; number <= 11; number++) { up += buckets[number]; down += buckets[-number]; }
  return { up, down, flat: buckets[0], total: up + down + buckets[0], buckets,
    scope: '东财涨跌分布口径（不含ST）', scopeBasis: '口径定稿（2026-10-14）',
    ...metadata(source, fetchedAt, { sourceDate, sourceTimeTrust: 'source-distribution-date' }) };
}

function commonTime(rows) {
  const dates = [...new Set(rows.map(row => row.sourceDate))];
  const times = [...new Set(rows.map(row => row.sourceTime))];
  return { sourceDate: dates.length === 1 ? dates[0] : null, sourceTime: times.length === 1 ? times[0] : null, sourceTimeTrust: rows.every(row => row.sourceDate) ? 'see-items' : 'missing' };
}

export function parseTHSBoardDaily(raw, code, { fetchedAt = new Date().toISOString(), minBars = 1 } = {}) {
  assert(/^88\d{4}$/.test(code) && typeof raw?.data === 'string', '同花顺板块日K代码或结构无效');
  const source = `ths:board:${code}`, lines = raw.data.split(';').filter(Boolean); let previous = '';
  assert(lines.length >= minBars && lines.length <= 500, '同花顺年度日K数量无效');
  const rows = lines.map(line => {
    const fields = line.split(','), date = dateISO(fields[0]);
    assert(date > previous && date <= chinaClock(new Date(fetchedAt)).date, '同花顺日K日期重复、乱序或未来'); previous = date;
    const [open, high, low, close] = fields.slice(1, 5).map(value => numeric(value, '同花顺OHLC'));
    assert(low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close), '同花顺日K OHLC无效');
    return { code, date, open, high, low, close, amount: numeric(fields[6], '同花顺日K金额元', { nonnegative: true }), pct: null,
      ...metadata(source, fetchedAt, { sourceDate: date, sourceTimeTrust: 'source-daily-date' }) };
  });
  return { code, rows, identityEvidence: 'fixed-callback-request-code', ...metadata(source, fetchedAt, { sourceDate: rows.at(-1).date, sourceTimeTrust: 'source-daily-date' }) };
}

/** 同花顺板块当日K（today.js）：1=日期 7=开 8=高 9=低 11=最新 19=成交额元 dt=HHMM。开盘前返回上一交易日，调用方按 sourceDate 判断是否为今天。 */
export function parseTHSBoardToday(raw, code, { fetchedAt = new Date().toISOString() } = {}) {
  assert(/^88\d{4}$/.test(code) && raw && typeof raw === 'object', '同花顺当日K代码或结构无效');
  const row = raw[`bk_${code}`];
  assert(row && typeof row === 'object', '同花顺当日K缺少对应板块');
  const sourceDate = dateISO(row['1']);
  assert(sourceDate <= chinaClock(new Date(fetchedAt)).date, '同花顺当日K日期在未来');
  const close = numeric(row['11'], '同花顺最新价', { nonnegative: true });
  assert(close > 0, '同花顺最新价为零或缺失');
  const dt = /^\d{4}$/.test(String(row.dt ?? '')) ? String(row.dt) : null;
  return { code, name: String(row.name ?? ''), sourceDate, sourceTime: dt ? `${sourceDate}T${dt.slice(0, 2)}:${dt.slice(2)}:00+08:00` : null,
    open: numeric(row['7'], '同花顺开盘', { nonnegative: true, nullable: true }), high: numeric(row['8'], '同花顺最高', { nonnegative: true, nullable: true }),
    low: numeric(row['9'], '同花顺最低', { nonnegative: true, nullable: true }), close, amount: numeric(row['19'], '同花顺成交额元', { nonnegative: true, nullable: true }),
    source: `ths:today:${code}`, fetchedAt, sourceTimeTrust: dt ? 'source-reported-hhmm' : 'source-date-only' };
}

/** 新浪公开节点逐股行情；ticktime没有日期，不能拼接本机日期。 */
export function parseSinaStockRows(raw, { fetchedAt = new Date().toISOString(), sort = 'amount', expectedCount = null } = {}) {
  assert(Array.isArray(raw) && raw.length <= 100 && (expectedCount === null || raw.length === expectedCount), '新浪股票列表分页不完整');
  const seen = new Set(); let prior = Infinity;
  return raw.map((row, index) => {
    const symbol = String(row.symbol ?? ''), code = String(row.code ?? '');
    assert(/^(sh|sz|bj)\d{6}$/.test(symbol) && symbol.slice(2) === code && !seen.has(symbol) && typeof row.name === 'string' && row.name.trim(), '新浪股票代码、名称或唯一性无效'); seen.add(symbol);
    const amount = numeric(row.amount, '新浪成交额元', { nonnegative: true }), pct = numeric(row.changepercent, '新浪pct');
    const ordering = sort === 'changepercent' ? pct : amount;
    assert(ordering <= prior, '新浪股票列表排序不符'); prior = ordering;
    const high = numeric(row.high, '新浪最高价', { nonnegative: true, nullable: true }), low = numeric(row.low, '新浪最低价', { nonnegative: true, nullable: true }), previousClose = numeric(row.settlement, '新浪昨收', { nonnegative: true, nullable: true });
    const amplitudePct = high > 0 && low > 0 && high >= low && previousClose > 0 ? (high - low) / previousClose * 100 : null;
    return { symbol, code, name: row.name, amount, pct, high, low, previousClose, amplitudePct, rank: index + 1,
      tickTime: /^\d{2}:\d{2}:\d{2}$/.test(String(row.ticktime ?? '')) ? row.ticktime : null,
      ...metadata('sina:node-stocks', fetchedAt, { sourceTimeTrust: 'time-of-day-only-no-trade-date' }) };
  });
}

export function calculateWideRangeMetrics(rows, { declinePct = -5 } = {}) {
  assert(Number.isFinite(declinePct) && declinePct < 0 && declinePct > -100, '大跌阈值须在-100到0之间');
  assert(Array.isArray(rows) && rows.length >= 25, '宽幅统计需要至少25根已完成日K，近5与前20互不重叠');
  const sample = rows.slice(-25), recent5 = sample.slice(-5), prior20 = sample.slice(0, 20);
  const amountMean = values => values.reduce((sum, row) => sum + numeric(row.amount, '日K金额', { nonnegative: true }), 0) / values.length;
  const denominator = amountMean(prior20); assert(denominator > 0, '前20日平均成交额为0，不能计算堆量倍数');
  const amplitudes = [], recoveries = [];
  for (let index = 5; index < 25; index++) {
    const current = sample[index], previous = sample[index - 1];
    assert(previous.close > 0 && current.low > 0 && current.high >= current.low, '历史振幅价格无效');
    amplitudes.push((current.high - current.low) / previous.close * 100);
    if (index < 24 && (current.close / previous.close - 1) * 100 <= declinePct && sample[index + 1].close >= previous.close) recoveries.push({ declineDate: current.date, recoveryDate: sample[index + 1].date, declinePct: (current.close / previous.close - 1) * 100, recoveredReferenceClose: previous.close });
  }
  return { averageAmplitude20Pct: amplitudes.reduce((a, b) => a + b, 0) / 20, meanAmount5: amountMean(recent5), previousMeanAmount20: denominator,
    accumulationRatio: amountMean(recent5) / denominator, reversalCount20: recoveries.length, reversals: recoveries,
    windowStart: sample[5].date, windowEnd: sample.at(-1).date, amountBaselineStart: sample[0].date, amountBaselineEnd: sample[19].date,
    definitions: { amplitude: '(high-low)/previousClose*100，最近20个已完成日', accumulation: '最近5日均额/此前不重叠20日均额', reversal: `最近20日中收盘跌幅<=${declinePct}%且下一交易日收盘>=大跌前收盘；两日均须在窗口内` } };
}
function selectedSymbol(value, available) {
  const item = available.find(row => row.symbol === value || row.symbol.slice(2) === value);
  assert(item, `不支持的证券代码：${value}`);
  return item;
}

/** 恢复探测先核对应端点的真实字段，不能以HTTP成功或非空对象解除冷却。 */
function validateEastmoneyRecovery(spec, raw, fetchedAt) {
  assert(raw?.rc != null && Number(raw.rc) === 0 && raw.data && typeof raw.data === 'object', '东财恢复探测未取得有效成功业务响应，继续冷却');
  const target = new URL(spec.url), query = target.searchParams;
  const context = { source: spec.id, fetchedAt };
  if (target.pathname.endsWith('/qt/stock/kline/get')) {
    const secid = query.get('secid') ?? '';
    assert(/^(?:90\.BK\d{4,6}|[01]\.\d{6})$/.test(secid), '恢复日K请求证券代码无效');
    const [market, code] = secid.split('.');
    parseEastmoneyDaily(raw, code.startsWith('BK') ? code : `${market === '1' ? 'sh' : 'sz'}${code}`, context);
    return;
  }
  if (/\/qt\/ulist(?:\.np)?\/get$/.test(target.pathname)) {
    const ids = (query.get('secids') ?? '').split(',');
    assert(ids.length > 0 && ids.every(id => /^[01]\.\d{6}$/.test(id)), '恢复报价请求代码无效');
    const rows = parseEastmoneyQuotes(raw, ids.map(id => `${id.startsWith('1.') ? 'sh' : 'sz'}${id.slice(2)}`), context);
    assert(rows.every(row => row.name.trim().length > 0), '恢复报价证券名称缺失');
    return;
  }
  if (target.pathname.endsWith('/qt/clist/get')) {
    const rows = eastRows(raw), total = integer(raw.data.total, '恢复列表总数');
    const size = integer(query.get('pz'), '恢复分页条数'), page = integer(query.get('pn'), '恢复页码');
    assert(total > 0 && size > 0 && page > 0 && rows.length === Math.min(size, Math.max(0, total - (page - 1) * size)) && rows.length > 0, '恢复列表分页数量不符');
    assert(rows.every(row => typeof row.f14 === 'string' && row.f14.trim().length > 0), '恢复列表证券或板块名称缺失');
    const type = /m:90\s+t:([23])\b/.exec(query.get('fs') ?? '');
    if (type) {
      assert(total <= 3000, '恢复板块总数超出支持范围');
      // 这里只核首页schema；整目录仍由D5逐页验证，避免等待整目录导致恢复锁死。
      parseBoardList({ ...raw, data: { ...raw.data, total: rows.length } }, type[1] === '2' ? 'industry' : 'concept', context);
    } else {
      assert(query.get('fid') === 'f6', '恢复列表端点类型未定义');
      parseTopTurnover(raw, size, context);
    }
    return;
  }
  throw new Error('未定义该东财端点的恢复schema，继续冷却');
}

/**
 * transport({id,kind,url,symbols}) 仅供可信调用方或离线测试注入。
 * calendar = {start,end,holidays:[YYYY-MM-DD],source:[官方公告 URL]}。
 * D3遵循看盘软件常用口径（2026-10-14定稿）；日历仅使用已核官方日期，不把工作日直接当交易日。
 */
export function createDataSource({ transport = null, calendar = OFFICIAL_CALENDAR, now = () => new Date(), maxRequests = 20, requestScheduler = sharedRequestScheduler, sourceCooldown = null, eastmoneyRateLimit = sharedEastmoneyRateLimit, volumeCurve = null, boardSourceMap = null } = {}) {
  assert(Number.isSafeInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 20, '请求预算须为1–20');
  let used = 0;
  let activeOperations = 0;
  let roundMax = maxRequests;
  const cache = new Map();
  const pending = new Map();
  const poolCursors = new Map();
  const fetched = () => now().toISOString();
  const defaultTransport = async request => {
    if (request.kind === 'static-json') {
      assert(new URL(request.url).origin === new URL(import.meta.url).origin && /^https?:$/.test(new URL(request.url).protocol), '公开静态数据须同源HTTP加载');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      try { const response = await fetch(request.url, { credentials: 'omit', signal: controller.signal }); assert(response.ok, `公开静态数据HTTP ${response.status}`); return await response.json(); } finally { clearTimeout(timer); }
    }
    return request.kind === 'tencent-script' ? tencentQuoteScript(request.symbols) : request.kind === 'fixed-callback-script' ? fixedCallbackScript(request.url, { callbackName: request.callbackName }) : request.kind === 'assignment-script' ? assignmentScript(request.url, { variable: request.variable, charset: request.charset ?? 'gbk' }) : request.kind === 'cors-json' ? corsJSON(request.url, { referrerPolicy: request.referrerPolicy }) : jsonp(request.url);
  };
  const execute = transport ?? defaultTransport;
  const cooldown = sourceCooldown ?? createEastmoneyCooldown({ now });

  async function request(spec) {
    // 冷却跳过应立即返回，不排队、不消耗网络预算。
    await cooldown.check(spec.url);
    eastmoneyRateLimit.check(spec.url);
    assert(used < roundMax, `本轮 ${roundMax} 次请求预算已用完；请复用缓存或将历史预热分批运行`);
    return requestScheduler(async () => {
      assert(used < roundMax, `本轮 ${roundMax} 次请求预算已用完`);
      eastmoneyRateLimit.check(spec.url);
      const ticket = await cooldown.before(spec.url);
      eastmoneyRateLimit.reserve(spec.url);
      used++;
      try {
        const raw = await execute(spec);
        if (ticket.probe) validateEastmoneyRecovery(spec, raw, fetched());
        await cooldown.settle(ticket, true);
        return raw;
      } catch (error) {
        await cooldown.settle(ticket, false, error.message ?? error);
        throw error;
      }
    });
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
        attempts.push({ source: candidate.id, ok: false, skipped: error.cooldownSkipped === true || error.deferred === true, deferred: error.deferred === true, retryAfterMs: error.retryAfterMs ?? null, elapsedMs: Date.now() - started, reason: String(error.message ?? error) });
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
    activeOperations++;
    try { return await work(); }
    catch (error) { return failure(String(error.message ?? error), null, fetched()); }
    finally { activeOperations--; }
  }

  /** D1 / N1 八个指数一次批量请求（含中证全指000985）。 */
  async function getIndexQuotes() { return safe(() => quotes(INDEXES.map(row => row.symbol))); }
  /** D2 单个指数日 K；调用方按需遍历 INDEXES，避免每分钟重取全部历史。 */
  async function getIndexDaily({ symbol = 'sh000001', count = 80 } = {}) {
    return safe(() => { const item = selectedSymbol(symbol, INDEXES); return daily(item.symbol, item.secid, count); });
  }
  /** D3：按2026-10-14定稿使用看盘软件常用口径，不冒充交易所精确统计。 */
  async function getMarketTurnover({ date = null } = {}) {
    return safe(async () => {
      let components, result;
      if (date !== null) {
        const requestedDate = dateISO(date);
        assert(requestedDate <= chinaClock(now()).date, '两市历史成交额不能请求未来日期');
        const histories = [];
        for (const symbol of ['sh000001', 'sz399001']) histories.push(await getIndexDaily({ symbol, count: 640 }));
        assert(histories.every(history => history.ok), histories.filter(history => !history.ok).map(history => history.reason).join('；'));
        components = histories.map(history => history.rows.find(row => row.date === requestedDate));
        assert(components.every(Boolean), '指定日期缺少真实指数日K成交额，不插值或估算');
        result = { fetchedAt: fetched(), sourceDate: requestedDate, sourceTime: null, sourceTimeTrust: 'source-daily-date' };
      } else {
        const symbols = ['sh000001', 'sz399001'];
        const quoted = await cached('market-turnover-tencent', 15000, () => fallback([
          { id: 'tencent:qt', kind: 'tencent-script', url: `https://qt.gtimg.cn/q=${symbols.join(',')}`, symbols },
        ], (raw, candidate, at) => ({ rows: parseTencentQuotes(raw, symbols, { source: candidate.id, fetchedAt: at }) })));
        assert(quoted.ok, quoted.reason);
        components = quoted.rows;
        assert(components.every(row => row.sourceDate) && components[0].sourceDate === components[1].sourceDate, '两市组件源日期缺失或不一致');
        result = { fetchedAt: quoted.fetchedAt, ...commonTime(components), cached: quoted.cached === true, cacheAgeMs: quoted.cacheAgeMs ?? 0 };
      }
      const amounts = components.map(row => numeric(row.amount, '真实指数成交额 元', { nonnegative: true }));
      return { ok: true, amount: amounts.reduce((sum, value) => sum + value, 0), scope: '上证指数+深证成指成交额（看盘软件常用口径）',
        scopeCode: 'SH000001_PLUS_SZ399001_SOFTWARE_CONVENTION', scopeBasis: '口径定稿（2026-10-14）', approximate: true, isFinal: null,
        components, ...metadata([...new Set(components.map(row => row.source))], result.fetchedAt), ...result };
    });
  }
  /** D4 按定稿使用东财专题分布（不含ST），不是全A逐股统计。 */
  async function getMarketBreadth() {
    return safe(() => cached('breadth-distribution', 15000, () => fallback([
      { id: 'eastmoney:push2ex-distribution', kind: 'jsonp', url: url('https://push2ex.eastmoney.com/getTopicZDFenBu', { ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt' }) },
    ], (raw, candidate, at) => parseBreadthDistribution(raw, { source: candidate.id, fetchedAt: at }))));
  }
  /** D5 全部行业和概念板块；每页100条，自动分页并核验总数和唯一性。 */
  async function getBoards({ type = 'all' } = {}) {
    return safe(async () => {
      assert(['all', 'industry', 'concept'].includes(type), '板块类型无效');
      const types = type === 'all' ? ['industry', 'concept'] : [type];
      const groups = [];
      for (const current of types) groups.push(await cached(`boards:${current}`, 15000, () => fallback([
        ...eastCandidates('qt/clist/get', {
          pn: 1, pz: 100, po: 1, np: 1, fltt: 2, fid: 'f12', fs: `m:90 t:${current === 'industry' ? 2 : 3} f:!50`, fields: BOARD_FIELDS,
        }),
        { id: `sina:${current}-assignment`, kind: 'assignment-script', charset: 'gbk',
          variable: current === 'industry' ? 'S_Finance_bankuai_sinaindustry' : 'S_Finance_bankuai_class',
          url: current === 'industry' ? 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php' : 'https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=class' },
      ], async (raw, candidate, at) => {
        if (candidate.id.startsWith('sina:')) return { rows: parseSinaBoards(raw, current, { source: candidate.id, fetchedAt: at }), type: current,
          namespace: 'sina', partial: true, missingFields: ['marketCap', 'up', 'down', 'sourceDate', 'sourceTime'],
          scope: '新浪板块分类，未与东财全部目录一一映射；未知字段留空' };
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
      return { ok: true, rows: groups.flatMap(group => group.rows), groups, partial: groups.some(group => group.partial === true),
        missingFields: [...new Set(groups.flatMap(group => group.missingFields ?? []))],
        ...metadata(groups.map(group => group.source), fetched()) };
    });
  }
  /** D6 单个东财 BK 板块日 K，不自动遍历所有板块。 */
  async function getBoardDaily({ code, count = 80 } = {}) {
    return safe(() => { assert(/^BK\d{4,6}$/.test(code ?? ''), '请提供有效 BK 板块代码'); return daily(code, `90.${code}`, count); });
  }
  /** D7 四类池；日期必须显式传入，不用请求日期冒充响应日期。 */
  async function getLimitPools({ date, kinds = null } = {}) {
    return safe(async () => {
      const requestedDate = dateISO(date);
      assert(requestedDate <= chinaClock(now()).date, '不能请求未来涨跌停池');
      const defaultRotation = kinds === null, cursor = poolCursors.get(requestedDate) ?? 0;
      const selectedKinds = defaultRotation ? [...EXPECTED_POOLS.slice(cursor), ...EXPECTED_POOLS.slice(0, cursor)] : kinds;
      assert(Array.isArray(selectedKinds) && selectedKinds.length > 0 && new Set(selectedKinds).size === selectedKinds.length && selectedKinds.every(kind => EXPECTED_POOLS.includes(kind)), '涨跌停池列表无效');
      const pools = {};
      let firstDeferred = null;
      for (const kind of selectedKinds) {
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
        if (!pool.ok && pool.attempts?.some(attempt => attempt.deferred) && firstDeferred === null) firstDeferred = kind;
      }
      if (defaultRotation && firstDeferred) poolCursors.set(requestedDate, EXPECTED_POOLS.indexOf(firstDeferred));
      const failed = Object.entries(pools).filter(([, value]) => !value.ok);
      const actualSources = [...new Set(Object.values(pools).map(value => value.source).filter(Boolean))];
      const source = actualSources.length === 1 ? actualSources[0] : actualSources;
      if (failed.length) return failure(failed.map(([kind, value]) => `${kind}：${value.reason}`).join('；'), source, fetched(), { pools, requestedDate, partial: failed.length < selectedKinds.length, deferredKinds: failed.filter(([, value]) => value.attempts?.some(attempt => attempt.deferred)).map(([kind]) => kind), nextDefaultStart: firstDeferred });
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
      const variable = `__ashare_sina_top_${Date.now()}_${++callbackSerial}_${Math.random().toString(36).slice(2)}`;
      candidates.push({ id: 'sina:hs-a-turnover', kind: 'assignment-script', variable, charset: 'gbk', url: url(`https://vip.stock.finance.sina.com.cn/quotes_service/api/jsonp.php/var%20${variable}=/Market_Center.getHQNodeData`, {
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
  /** N4按定稿使用东财板块/腾讯两指数常用总额，标注近似；未知源日期不补今天。 */
  async function getBoardTurnoverShare({ board, market, maxSkewMs = 120000 } = {}) {
    return safe(async () => {
      assert(market?.ok === true && (market.scopeCode === 'SH000001_PLUS_SZ399001_SOFTWARE_CONVENTION' || market.scope === '上证指数+深证成指成交额（看盘软件常用口径）'), 'D3定稿口径的两市成交额数据缺失，不能计算板块占比');
      assert(board && board.ok !== false && board.source && market.source, '板块或两市成交额来源缺失');
      assert(typeof board.source === 'string' && board.source.startsWith('eastmoney:') && /^BK\d{4,6}$/.test(board.code ?? ''), '定稿分子要求东财板块成交额，新浪或其他分类不能静默替代');
      const date = dateISO(market.sourceDate);
      assert(board.sourceDate === date, '板块与两市成交额交易日不一致或缺失');
      assert(Number.isFinite(maxSkewMs) && maxSkewMs >= 0 && maxSkewMs <= 300000, '允许的源时间差应为0–300000毫秒');
      for (const item of [board, market]) if (item.sourceTime !== null && item.sourceTime !== undefined) assert(Number.isFinite(Date.parse(item.sourceTime)) && chinaClock(new Date(item.sourceTime)).date === date && Date.parse(item.sourceTime) <= now().getTime() + 60000, '源时间与交易日不符或位于未来');
      const skewMs = board.sourceTime && market.sourceTime ? Math.abs(Date.parse(board.sourceTime) - Date.parse(market.sourceTime)) : null;
      assert(skewMs === null || skewMs <= maxSkewMs, '板块与两市成交额源时点相差过大');
      const numerator = numeric(board.amount, '板块成交额', { nonnegative: true }), denominator = numeric(market.amount, '两市成交额', { nonnegative: true });
      assert(denominator > 0 && numerator <= denominator, '两市成交额须大于0且板块额不能超过同口径市场总额');
      const isFinal = market.isFinal === true && board.isFinal === true;
      return { ok: true, code: board.code ?? null, boardAmount: numerator, marketAmount: denominator, ratio: numerator / denominator, sharePct: numerator / denominator * 100,
        scope: market.scope, approximate: true, sourceSkewMs: skewMs, sourceTimeComparable: skewMs !== null, isFinal, provisional: !isFinal, phase: isFinal ? 'final' : 'intraday-or-unconfirmed-final',
        warning: '近似占比：分子为东财板块，分母为上证+深成常用成交额；重叠概念占比不可相加，源时间缺失时仅确认同交易日。此工具不判定45%阈值或行情阶段。',
        ...metadata([board.source, market.source], fetched(), { sourceDate: date, sourceTime: market.sourceTime ?? null, sourceTimeTrust: skewMs === null ? 'same-source-date-times-incomplete' : 'derived-from-two-comparable-source-times' }) };
    });
  }
  async function publicData(name) {
    return cached(`static:${name}`, 86400000, async () => {
      const value = await request({ id: `static:${name}`, kind: 'static-json', url: new URL(`../data/${name}`, import.meta.url).href });
      assert(value && typeof value === 'object', '公开静态数据结构缺失'); return { ok: true, value };
    });
  }
  function sinaNodeSpec(node, { page = 1, num = 100, sort = 'amount' } = {}) {
    assert(/^[\w]+$/.test(node), '新浪节点无效');
    const variable = `__ashare_sina_node_${Date.now()}_${++callbackSerial}_${Math.random().toString(36).slice(2)}`;
    return { id: `sina:node:${node}`, kind: 'assignment-script', variable, charset: 'gbk',
      url: url(`https://vip.stock.finance.sina.com.cn/quotes_service/api/jsonp.php/var%20${variable}=/Market_Center.getHQNodeData`, { page, num, sort, asc: 0, node, symbol: '', _s_r_a: 'page' }) };
  }
  function previousTradeDate(date) {
    assert(calendar?.holidays && date >= calendar.start && date <= calendar.end, '日期超出已核交易日历');
    const closed = new Set(calendar.holidays);
    for (let offset = 1; offset <= 40; offset++) {
      const day = new Date(Date.parse(`${date}T00:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);
      assert(day >= calendar.start, '前一交易日超出日历');
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      if (weekday > 0 && weekday < 6 && !closed.has(day)) return day;
    }
    throw new Error('无法确定前一交易日');
  }

  /** 实际累计额与统计模型预估分字段，曲线缺失/口径不符时绝不猜比例。 */
  async function getProjectedTurnover() {
    return safe(() => cached(`projected:${chinaClock(now()).date}`, 15000, async () => {
      const market = await getMarketTurnover(); assert(market.ok, market.reason);
      const clocks = market.components.map(row => Date.parse(row.sourceTime));
      const sourceTime = clocks.every(Number.isFinite) ? new Date(Math.min(...clocks)).toISOString() : null;
      const base = { cumulativeAmount: market.amount, scope: market.scope, source: market.source, fetchedAt: market.fetchedAt, sourceDate: market.sourceDate, sourceTime, sourceTimeTrust: 'two-index-source-clock', isFinal: null };
      if (!clocks.every(Number.isFinite) || Math.max(...clocks) - Math.min(...clocks) > 60000) return { ok: false, ...base, projectedFullDay: null, reason: '两市来源时钟缺失或相差超过60秒，保留已取得累计额但不估计' };
      const at = chinaClock(new Date(sourceTime)), device = chinaClock(now());
      if (Math.max(...clocks) > now().getTime()) return { ok: false, ...base, projectedFullDay: null, estimated: false, reason: '来源时钟位于未来，不用于盘中估计' };
      if (at.time >= '15:00:00' || at.date !== chinaClock(now()).date) return { ok: true, ...base, projectedFullDay: null, estimated: false, phase: 'reported-observation-only', reason: '该时点只展示来源已报告累计额；不将15时后数据当作确认终值' };
      const ageMs = now().getTime() - Math.min(...clocks);
      if (device.time >= '11:30:00' && device.time < '13:00:00') return { ok: true, ...base, projectedFullDay: null, estimated: false, phase: 'lunch-break', lastCurveMinute: at.time.slice(0, 5), observationAgeMs: ageMs, reason: '午休保留最后实际累计额，未将午休前报价伪装成实时预测' };
      if (!(at.time >= '09:30:00' && ageMs <= 180000)) return { ok: false, ...base, projectedFullDay: null, estimated: false, observationAgeMs: ageMs, reason: '未开盘或来源报价已超过3分钟，保留累计额但不作盘中预估' };
      try {
      const curve = volumeCurve ?? (await publicData('intraday_volume_curve.json')).value;
      if (!(curve?.usable === true && curve.sampleCount >= (curve.minSamples ?? 20) && curve.sampleCount >= 20)) return { ok: false, ...base, projectedFullDay: null, reason: '量能曲线未具备至少20个已核样本，预估缺失', curveVersion: curve?.version ?? null, sampleCount: curve?.sampleCount ?? 0, curveStatus: curve?.status ?? 'missing' };
      assert(curve.scope === market.scope && Array.isArray(curve.sampleDates) && curve.sampleDates.length === curve.sampleCount && new Set(curve.sampleDates).size === curve.sampleCount && curve.sampleDates.every(day => dateISO(day) < at.date), '曲线口径不符或训练日期包含预测日，不能预估');
      const minute = at.time.slice(0, 5), point = curve.points?.find(row => row.minute === minute);
      assert(point && point.sampleCount >= 20, '该来源分钟缺少足够曲线样本');
      const median = numeric(point.median, '累计占比中位数'), q10 = numeric(point.q10, '累计占比q10'), q90 = numeric(point.q90, '累计占比q90');
      assert(q10 > 0 && q10 <= median && median <= q90 && q90 <= 1, '累计占比分位数无效');
      return { ok: true, ...base, estimated: true, projectedFullDay: market.amount / median,
        interval: { low: market.amount / q90, high: market.amount / q10, kind: 'empirical-q10-q90-inverse-not-guarantee' },
        curveVersion: curve.version, curveMinute: minute, curveMethod: point.method, sampleCount: point.sampleCount, sampleDates: curve.sampleDates,
        afterHours: curve.afterHours ?? null, backtest: curve.backtest ?? null, warning: '模型估计与实际累计额分列；区间来自历史占比分位数，不是保证区间' };
      } catch (error) { return { ok: false, ...base, projectedFullDay: null, estimated: false, reason: String(error.message ?? error) }; }
    }));
  }

  async function boardHistory(native, count, currentDate) {
    const completedDate = previousTradeDate(currentDate);
    return cached(`completed-board:${native}:${count}:${completedDate}`, 3 * 86400000, async () => {
      let rawHistory;
      if (native.startsWith('eastmoney:')) rawHistory = await getBoardDaily({ code: native.slice(10), count: Math.max(80, count + 1) });
      else {
        const code = native.slice(4), year = Number(currentDate.slice(0, 4)); assert(/^88\d{4}$/.test(code), '同花顺板块代码无效');
        const yearly = async selectedYear => {
          const callbackName = `quotebridge_v4_line_bk_${code}_01_${selectedYear}`;
          return fallback([{ id: `ths:board:${code}`, kind: 'fixed-callback-script', callbackName, url: `https://d.10jqka.com.cn/v4/line/bk_${code}/01/${selectedYear}.js` }], (raw, spec, at) => parseTHSBoardDaily(raw, code, { fetchedAt: at }));
        };
        rawHistory = await yearly(year);
        if (rawHistory.ok && rawHistory.rows.filter(row => row.date < currentDate).length < count) {
          const previous = await yearly(year - 1); assert(previous.ok, previous.reason);
          rawHistory = { ...rawHistory, rows: [...previous.rows, ...rawHistory.rows] };
        }
      }
      assert(rawHistory.ok, rawHistory.reason);
      const completed = rawHistory.rows.filter(row => row.date < currentDate).slice(-count);
      assert(completed.length === count && completed.at(-1).date === completedDate, '板块已完成日K不足或尚未更新到前一交易日');
      return { ok: true, rows: completed, nativeHistoryBoard: native, source: rawHistory.source, fetchedAt: rawHistory.fetchedAt,
        sourceDate: completed.at(-1).date, sourceTime: null, sourceTimeTrust: 'source-daily-date',
        currentDayIncluded: false, currentDayPolicy: '当日K不进入全天缓存，当前报价从板块实时接口单独获取', completedThrough: completed.at(-1).date };
    });
  }
  async function getBoardRecentDaily(codes, count = 20) {
    return safe(async () => {
      assert(Array.isArray(codes) && codes.length >= 1 && codes.length <= 6 && new Set(codes).size === codes.length, '每轮板块只接受1–6个唯一代码（当前涨跌各前三）');
      assert(Number.isSafeInteger(count) && count >= 1 && count <= 60, '板块近期日K数量须为1–60');
      const currentDate = chinaClock(now()).date, groups = [];
      for (const value of codes) {
        const requested = /^BK\d{4,6}$/.test(value) ? `eastmoney:${value}` : /^(new_|gn_)/.test(value) ? `sina:${value}` : value;
        const result = await safe(async () => {
          assert(/^(?:eastmoney:BK\d{4,6}|sina:(?:new_|gn_)\w+|ths:88\d{4})$/.test(requested), '板块需明确供应商代码');
          if (!requested.startsWith('sina:')) {
            const native = await safe(() => boardHistory(requested, count, currentDate));
            if (native.ok) return { ...native, requestedBoard: requested, sourceChanged: false, scopeDifference: null };
            if (requested.startsWith('ths:')) throw new Error(native.reason);
          }
          const mapping = boardSourceMap ?? (await publicData('board_source_map.json')).value;
          const match = mapping.mappings?.find(row => row.from === requested && ['exact_name', 'same_provider', 'explicit_alias'].includes(row.matchType));
          assert(match && /^ths:88\d{4}$/.test(match.to) && typeof match.scopeDifference === 'string' && match.scopeDifference.length > 0, '没有已核精确名称或明确别名映射；不以相近板块替换');
          const history = await boardHistory(match.to, count, currentDate);
          return { ...history, requestedBoard: requested, sourceChanged: requested !== match.to, scopeDifference: match.scopeDifference,
            mapping: { from: match.from, to: match.to, matchType: match.matchType, sameConstituentsVerified: match.sameConstituentsVerified === true } };
        });
        groups.push({ requestedBoard: requested, ...result });
      }
      const valid = groups.filter(row => row.ok);
      return { ok: valid.length > 0, partial: valid.length !== groups.length, groups, ...(valid.length ? {} : { reason: groups.map(row => row.reason).join('；') }), ...metadata([...new Set(valid.flatMap(row => row.source))], fetched()) };
    });
  }

  async function getBoardMembers(boardCode, n = 10) {
    return safe(() => {
      const code = String(boardCode ?? '').replace(/^sina:/, '');
      assert(/^(new_|gn_)\w+$/.test(code), '成员接口需新浪原生板块代码；不同供应商成分不自动互换');
      assert(Number.isSafeInteger(n) && n >= 1 && n <= 10, '领涨集团数量须为1–10');
      return cached(`members:${code}:${n}:${chinaClock(now()).date}`, 60000, async () => {
        const type = code.startsWith('new_') ? 'industry' : 'concept';
        const directory = await cached(`sina-directory:${type}`, 300000, () => fallback([{ id: `sina:${type}-assignment`, kind: 'assignment-script', charset: 'gbk', variable: type === 'industry' ? 'S_Finance_bankuai_sinaindustry' : 'S_Finance_bankuai_class', url: type === 'industry' ? 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php' : 'https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=class' }], (raw, spec, at) => ({ rows: parseSinaBoards(raw, type, { source: spec.id, fetchedAt: at }) })));
        assert(directory.ok, directory.reason); const board = directory.rows.find(row => row.code === code); assert(board?.members > 0, '新浪目录未确认该板块或成分数');
        const topEach = Math.max(1, Math.min(2 * n, Math.ceil(board.members / 2))), lists = [];
        for (const sort of ['amount', 'changepercent']) {
          const result = await fallback([sinaNodeSpec(code, { num: topEach, sort })], (raw, spec, at) => ({ rows: parseSinaStockRows(raw, { fetchedAt: at, sort, expectedCount: topEach }) }));
          assert(result.ok, result.reason); lists.push(result.rows);
        }
        const pctRanks = new Map(lists[1].map((row, index) => [row.symbol, index + 1]));
        const intersection = lists[0].filter(row => pctRanks.has(row.symbol));
        const rows = intersection.slice(0, n).map(row => ({ ...row, amountRank: row.rank, pctRank: pctRanks.get(row.symbol) }));
        return { ok: true, boardCode: code, rows, partial: rows.length < n, members: board.members, scope: '新浪原生板块成分',
          selection: { method: 'intersection-of-amount-and-pct-top-lists', topEach, topEachDefinition: 'max(1,min(2*n,ceil(members/2)))', ordering: 'amount-desc-then-source-order', intersectionCount: intersection.length, requested: n, returned: rows.length },
          sourceDate: null, sourceTime: null, sourceTimeTrust: 'time-of-day-only-no-trade-date', source: `sina:node:${code}`, fetchedAt: fetched(), warning: '双排名交集只表达两个维度靠前，未赋综合分；来源未提供交易日期' };
      });
    });
  }

  async function getWideRangeCandidates({ minAmount, n = 10 } = {}) {
    return safe(() => {
      assert(Number.isFinite(minAmount) && minAmount >= 0, 'minAmount须为大于等于0的金额元');
      assert(Number.isSafeInteger(n) && n >= 1 && n <= 10, '宽幅候选数量须为1–10');
      const currentDate = chinaClock(now()).date;
      return cached(`wide:${currentDate}:${minAmount}:${n}`, 300000, async () => {
        assert(roundMax - used >= 18, '宽幅扫描需独立批次预留18次请求；请先beginRefresh');
        const all = [];
        for (let page = 1; page <= 2; page++) {
          const result = await fallback([sinaNodeSpec('hs_a', { page, num: 100 })], (raw, spec, at) => ({ rows: parseSinaStockRows(raw, { fetchedAt: at, expectedCount: 100 }) }));
          assert(result.ok, result.reason); all.push(...result.rows);
        }
        assert(new Set(all.map(row => row.symbol)).size === 200 && all.every((row, index) => index === 0 || all[index - 1].amount >= row.amount), '前200分页重复或金额跨页顺序不符');
        assert(all.every(row => /^(sh(?:60|68)|sz(?:00|30))\d{4}$/.test(row.symbol)), '前200含非沪深A股/CDR或本接口尚不支持证券，不能缩小样本冒充完整200');
        const realtime = await fallback([{ id: 'tencent:qt', kind: 'tencent-script', symbols: all.map(row => row.symbol), url: `https://qt.gtimg.cn/q=${all.map(row => row.symbol).join(',')}` }], (raw, spec, at) => ({ rows: parseTencentQuotes(raw, spec.symbols, { source: spec.id, fetchedAt: at }) }));
        assert(realtime.ok && realtime.rows.every(row => row.sourceDate === currentDate), '候选报价缺失或非当前源日期，不能冒充今天');
        assert(realtime.rows.every(row => row.high > 0 && row.low > 0 && row.high >= row.low && row.previousClose > 0), '前200报价最高/最低/昨收不完整，不能确定振幅前15');
        const selected = realtime.rows.filter(row => row.amount >= minAmount).map(row => ({ ...row, currentAmplitudePct: (row.high - row.low) / row.previousClose * 100 }))
          .sort((a, b) => b.currentAmplitudePct - a.currentAmplitudePct || b.amount - a.amount).slice(0, 15);
        assert(selected.length > 0, '成交额门槛内没有有效振幅候选');
        const rows = [], missing = [];
        for (const candidate of selected) {
          const symbol = candidate.symbol;
          const history = await cached(`wide-daily:${symbol}:${currentDate}`, 300000, () => fallback([{ id: 'tencent:newfqkline', kind: 'cors-json', url: url('https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get', { param: `${symbol},day,,,80,` }) }], (raw, spec, at) => parseTencentDaily(raw, symbol, { source: spec.id, fetchedAt: at, minBars: 25, count: 80 })));
          const result = await safe(async () => {
            assert(history.ok, history.reason); const completed = history.rows.filter(row => row.date < currentDate);
            assert(completed.at(-1)?.date === previousTradeDate(currentDate), '候选日K尚未到前一交易日');
            const metrics = calculateWideRangeMetrics(completed);
            const quote = realtime.rows.find(row => row.symbol === symbol);
            assert(quote.high > 0 && quote.low > 0 && quote.high >= quote.low && quote.previousClose > 0, '腾讯当前最高/最低/昨收缺失，不能把新浪无日期振幅当今天');
            return { ok: true, ...candidate, ...quote, currentAmplitudePct: (quote.high - quote.low) / quote.previousClose * 100, amplitudeSource: quote.source, amplitudeSourceDate: quote.sourceDate, rankingSourceDate: null, historySource: history.source, historyFetchedAt: history.fetchedAt, ...metrics };
          });
          if (result.ok) rows.push(result); else missing.push({ symbol, reason: result.reason });
        }
        const output = rows.sort((a, b) => b.currentAmplitudePct - a.currentAmplitudePct || b.amount - a.amount).slice(0, n);
        return { ok: output.length > 0, partial: missing.length > 0 || output.length < n, rows: output, missing,
          ...(output.length ? {} : { reason: '所有候选历史数据均不可用' }), scope: '新浪hs_a节点成交额前200，覆盖范围未扩称沪深京全A',
          selection: { universeRows: 200, inspectedDaily: selected.length, minAmount, ranking: 'tencent-current-amplitude-desc-within-sina-amount-top200', snapshotAtomic: false, rankingSourceDate: null, amplitudeRankingSourceDate: currentDate },
          warning: '新浪成交额前200无来源日期，保留未知；全部200只报价及振幅均由腾讯核当前源日期后筛前15。历史仅用此前完成日K，原始不复权价格跨除权日可能影响统计。',
          ...metadata(['sina:node:hs_a', 'tencent:qt', 'tencent:newfqkline'], fetched(), commonTime(realtime.rows)) };
      });
    });
  }

  /** 同花顺板块当日K轮询：每次最多10个原生代码，单板块缓存50秒；失败的板块单独列出，不用旧值冒充今天。 */
  async function getTHSBoardToday(codes) {
    return safe(async () => {
      assert(Array.isArray(codes) && codes.length >= 1 && codes.length <= 10 && new Set(codes).size === codes.length && codes.every(c => /^88\d{4}$/.test(c)), '每次1–10个唯一同花顺原生板块代码');
      const rows = [], failed = [];
      for (const code of codes) {
        const result = await cached(`ths-today:${code}`, 50000, () => fallback([{ id: `ths:today:${code}`, kind: 'fixed-callback-script', callbackName: `quotebridge_v4_line_bk_${code}_01_today`, url: `https://d.10jqka.com.cn/v4/line/bk_${code}/01/today.js` }],
          (raw, spec, at) => parseTHSBoardToday(raw, code, { fetchedAt: at })));
        if (result.ok) rows.push(result); else failed.push({ code, reason: result.reason });
        if (used >= roundMax) break;
      }
      return { ok: rows.length > 0, rows, failed, partial: failed.length > 0 || rows.length < codes.length, ...(rows.length ? {} : { reason: failed.map(f => `${f.code}：${f.reason}`).join('；') || '本轮预算不足' }), ...metadata('ths:today', fetched()) };
    });
  }

  /** 东财全市场板块排行（概念 508 / 行业约 500，按今日涨跌幅排序，每页 100）：每次只取一页，走东财每分钟 3 次限额。 */
  async function getBoardRanking({ type = 'concept', page = 1, order = 'desc' } = {}) {
    return safe(async () => {
      assert(['concept', 'industry'].includes(type) && Number.isSafeInteger(page) && page >= 1 && page <= 10 && ['desc', 'asc'].includes(order), '板块排行参数无效');
      return cached(`rank:${type}:${page}:${order}`, 50000, () => fallback(eastCandidates('qt/clist/get', {
        pn: page, pz: 100, po: order === 'desc' ? 1 : 0, np: 1, fltt: 2, invt: 2, fid: 'f3', fs: `m:90 t:${type === 'industry' ? 2 : 3} f:!50`, fields: 'f12,f14,f3,f109,f128',
      }), (raw, candidate, at) => parseBoardRanking(raw, type, { source: candidate.id, fetchedAt: at })));
    });
  }

  /** 东财板块批量报价（热门板块池刷新今日、5 日涨跌）：一次请求最多 60 个板块。 */
  async function getBoardQuotes(codes) {
    return safe(async () => {
      assert(Array.isArray(codes) && codes.length >= 1 && codes.length <= 60 && codes.every(c => /^BK\d{4}$/.test(c)), '每次 1–60 个东财板块代码');
      return cached(`boardq:${[...codes].sort().join(',')}`, 50000, () => fallback(eastCandidates('qt/ulist.np/get', {
        fltt: 2, invt: 2, secids: codes.map(c => `90.${c}`).join(','), fields: 'f12,f14,f3,f109,f128',
      }), (raw, candidate, at) => parseBoardRanking(raw, 'quote', { source: candidate.id, fetchedAt: at })));
    });
  }

  /** 个股前复权日 K（腾讯 newfqkline，qfqday 含当日盘中 K），用于情绪周期高标见顶判断；每次 1–6 只。 */
  async function getStockKline(codes, count = 80) {
    return safe(async () => {
      assert(Array.isArray(codes) && codes.length >= 1 && codes.length <= 6 && codes.every(c => /^\d{6}$/.test(c)), '每次 1–6 只 6 位个股代码');
      assert(Number.isSafeInteger(count) && count >= 10 && count <= 640, '日 K 根数须为 10–640');
      const rows = {}, failed = [];
      for (const code of codes) {
        const sym = (/^[69]/.test(code) ? 'sh' : /^[48]/.test(code) ? 'bj' : 'sz') + code;
        const r = await cached(`stock-k:${code}:${count}`, 60000, () => fallback([{ id: 'tencent:newfqkline-qfq', kind: 'cors-json', url: url('https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get', { param: `${sym},day,,,${count},qfq` }) }],
          (raw, spec, at) => parseStockKline(raw, sym, { fetchedAt: at })));
        if (r.ok) rows[code] = r.bars; else failed.push({ code, reason: r.reason });
        if (used >= roundMax) break;
      }
      return { ok: Object.keys(rows).length > 0, rows, failed, ...(Object.keys(rows).length ? {} : { reason: failed.map(f => `${f.code}：${f.reason}`).join('；') || '本轮预算不足' }), ...metadata('tencent:newfqkline-qfq', fetched()) };
    });
  }

  /** 同花顺涨停池题材（reason_type）：用于同题材涨停集中度与情绪龙头；每页 200，最多 3 页。 */
  async function getTHSLimitThemes(date) {
    return safe(async () => {
      const day = dateISO(date), rows = [];
      let total = null, counts = null;
      for (let page = 1; page <= 3 && (total === null || rows.length < total); page++) {
        const r = await cached(`ths-themes:${day}:${page}`, 60000, () => fallback([{ id: 'ths:limit-up-pool', kind: 'cors-json', url: url('https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool', {
          page, limit: 200, date: day.replaceAll('-', ''), field: '199112,10,9001,330329,133971,1968584', order_field: 330329, order_type: 0, filter: 'HS,GEM2STAR' }) }],
          (raw, spec, at) => parseTHSLimitThemes(raw, day, { fetchedAt: at })));
        if (!r.ok) { if (!rows.length) return r; break; }
        total = r.total; rows.push(...r.rows); if (page === 1) counts = r.counts;
        if (!r.rows.length) break;
      }
      return { ok: true, date: day, rows, count: rows.length, total, counts, partial: total !== null && rows.length < total, ...metadata('ths:limit-up-pool', fetched(), { sourceDate: day, sourceTimeTrust: 'source-pool-date' }) };
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
        isMarketOpen: afterHoursActive ? null : isContinuousTrading || isAuction, phase,
        marketOpenScope: '常规竞价时段由日历判断；盘后为候选时间窗，具体证券交易资格尚未核验',
        regularSession: { open: isContinuousTrading || isAuction, continuous: ['09:30–11:30', '13:00–14:57'], auction: ['09:15–09:25', '14:57–15:00'] },
        afterHours: { windowActive: afterHoursActive, open: afterHoursActive ? null : false, eligibilityVerified: false, start: '15:05', end: '15:30', scope: '仅适用已实施盘后固定价格交易且当日符合条件的证券；本接口未核验逐证券资格，不推定全部A股或ETF可交易', source: calendar.sessionSource ?? null, additionalSource: 'https://docs.static.szse.cn/www/lawrules/rule/trade/current/W020260424690713155663.pdf' },
        refreshRecommended: isTradingDay && minute >= '09:15' && minute <= '15:35',
        dailyDataFinal: null, finalityReason: '年度日历及本机时钟不能证明当日量额已最终完成；应核对行情来源时钟及盘后更新',
        unscheduledClosuresVerified: calendar.unscheduledClosuresVerified === true,
        coverage: { start, end }, verifiedOn: calendar.verifiedOn ?? null,
        ...metadata(calendar.source, fetched(), { sourceTimeTrust: 'official-calendar-rule-plus-device-clock-not-market-observation' }) };
    });
  }
  function beginRefresh({ maxRequests: limit = maxRequests } = {}) {
    assert(pending.size === 0 && activeOperations === 0, '仍有请求进行中，不能重置预算');
    assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 20, '请求预算须为1–20');
    used = 0;
    roundMax = limit;
    return getRequestStats();
  }
  /** 外围科技指数日 K：一个指数一次请求（东财优先，失败或冷却时按配置改用腾讯）；已完成日由调用方按日缓存。 */
  async function getOverseasDaily(key, count = 30) {
    return safe(() => {
      const item = OVERSEAS.find(row => row.key === key);
      assert(item, '未知外围指数');
      assert(Number.isSafeInteger(count) && count >= 5 && count <= 120, '外围日 K 根数须为5–120');
      const tencent = (sym, id) => ({ id, kind: 'cors-json', sym, url: url('https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get', { param: `${sym},day,,,${count},qfq` }) });
      const candidates = [];
      if (item.secid) candidates.push(...eastCandidates('qt/stock/kline/get', { secid: item.secid, klt: 101, fqt: 0, beg: 0, end: 20500101, lmt: count, fields1: 'f1,f2,f3', fields2: 'f51,f52,f53,f54,f55' }, true));
      if (item.tencent) candidates.push(tencent(item.tencent, 'tencent:newfqkline'));
      if (item.proxy) candidates.push(tencent(item.proxy, 'tencent:newfqkline-etf'));
      return cached(`overseas:${key}:${count}`, 600000, () => fallback(candidates, (raw, candidate, at) => {
        if (candidate.id.startsWith('eastmoney')) {
          assert(raw && Number(raw.rc ?? 0) === 0 && Array.isArray(raw.data?.klines), `${key} 东财日 K 结构或业务状态无效`);
          const rows = raw.data.klines.map(line => { const f = String(line).split(','); return [f[0], f[1], f[3], f[4], f[2]]; });
          return { ...parseOverseasDaily(rows, key, { source: candidate.id, fetchedAt: at }), viaEtf: null };
        }
        const d = raw?.data?.[candidate.sym], rows = d?.day ?? d?.qfqday;
        assert(Number(raw?.code) === 0 && Array.isArray(rows), `${key} 腾讯日 K 结构无效`);
        return { ...parseOverseasDaily(rows.map(f => [f[0], f[1], f[3], f[4], f[2]]), key, { source: candidate.id, fetchedAt: at }),
          viaEtf: candidate.id.endsWith('-etf') ? candidate.sym.replace(/^us|\.\w+$/g, '') : null };
      }));
    });
  }
  /** 日韩指数盘中涨跌（腾讯一次批量，不占东财额度）。 */
  async function getOverseasQuotes() {
    const symbols = OVERSEAS.filter(row => row.quote).map(row => row.quote);
    return safe(() => cached('overseasQuotes', 60000, () => fallback([{ id: 'tencent:qt', kind: 'tencent-script', url: `https://qt.gtimg.cn/q=${symbols.join(',')}`, symbols }],
      (raw, candidate, at) => ({ rows: parseOverseasQuotes(raw, symbols, { source: candidate.id, fetchedAt: at }) }))));
  }
  function getRequestStats() { return { requests: used, maxRequests: roundMax, remaining: Math.max(0, roundMax - used), pending: pending.size, cachedEntries: cache.size }; }
  async function getSourceCooldown() { return cooldown.snapshot(); }
  return { getIndexQuotes, getIndexDaily, getMarketTurnover, getMarketBreadth, getBoards, getBoardDaily, getLimitPools, getLimitStockSectors, getEtfData, getTradingCalendar, getTopTurnover, getYesterdayTopTurnover, getBoardTurnoverShare, getProjectedTurnover, getBoardRecentDaily, getBoardMembers, getWideRangeCandidates, getTHSBoardToday, getTHSLimitThemes, getStockKline, getBoardRanking, getBoardQuotes, getOverseasDaily, getOverseasQuotes, beginRefresh, getRequestStats, getSourceCooldown };
}

const defaultDataSource = createDataSource();
export const { getIndexQuotes, getIndexDaily, getMarketTurnover, getMarketBreadth, getBoards, getBoardDaily, getLimitPools, getLimitStockSectors, getEtfData, getTradingCalendar, getTopTurnover, getYesterdayTopTurnover, getBoardTurnoverShare, getProjectedTurnover, getBoardRecentDaily, getBoardMembers, getWideRangeCandidates, getTHSBoardToday, getTHSLimitThemes, getStockKline, getBoardRanking, getBoardQuotes, getOverseasDaily, getOverseasQuotes, beginRefresh, getRequestStats, getSourceCooldown } = defaultDataSource;
export default defaultDataSource;
