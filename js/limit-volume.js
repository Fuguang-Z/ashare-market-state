/**
 * 极限量池（个股层，2026-11-10 新增）：读取 data/limit_volume.json，给机会判定提供一个「量能是否放到历史极值」的观察项。
 *
 * 口径来自淘股吧帖内公式（zarili 2026-11-10 第 4934 楼）：
 *   非次新:=BARSCOUNT(C)>最小上市日;
 *   三日极限量:=MA(V,3)>三日放量倍数*MA(V,BARSCOUNT(CLOSE));
 *   三日日均成交额:=MA(AMOUNT,3)>最小成交额千万*10000000;
 *   输出:非次新 AND 三日日均成交额 AND 三日极限量 AND C>MA(C,5);
 * 由同花顺条件选股跑出结果，经 tools/limit_volume.py 转成本文件的格式；页面只读结果，不自行计算个股历史均量。
 *
 * 本模块是纯函数，不发起网络请求；数据缺失返回 missing，不把缺失当成「没量」。
 */

export const LV_RULE = Object.freeze({
  minListDays: 100,     // 最小上市日（交易日）
  volMult: 5,           // 三日放量倍数
  minAmtWan: 30,        // 最小成交额（千万元）→ 30 = 3 亿元 3 日均额
  mainMin: 3,           // 主线族内至少几只，才算「集中在主线」
});

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** 归一化一只票：只保留页面要显示的字段 */
function stock(s) {
  return {
    code: String(s.code ?? ''),
    name: String(s.name ?? ''),
    fam: s.fam ? String(s.fam) : '未归类',
    board: s.board ? String(s.board) : '',
    p1: isNum(s.p1) ? s.p1 : null,
    amt3d: isNum(s.amt3dWan) ? s.amt3dWan : null,      // 3 日均额（万元）
    volRatio: isNum(s.volRatio) ? s.volRatio : null,   // 3 日均量 ÷ 上市以来均量
    limitUp: s.limitUp === true,
  };
}

/**
 * @param {object|null} raw data/limit_volume.json 内容
 * @param {string|null} today 当前交易日（用于判断文件是否过期）
 * @returns {{status:'missing'|'empty'|'ok'|'stale', count:number, mainCount:number, mainFamily:string|null,
 *            families:Array<{name:string,count:number}>, stocks:Array, asOf:string|null,
 *            params:object, read:string, hit:boolean|null}}
 */
export function readLimitVolume(raw, today = null) {
  const params = { ...LV_RULE, ...(raw?.params ?? {}) };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.stocks) || raw.imported === false) {
    return {
      status: 'missing', count: 0, mainCount: 0, mainFamily: null, families: [], stocks: [],
      asOf: null, params, hit: null,
      read: '未导入当日选股结果（按 docs/极限量选股_同花顺公式.md 导出后运行 tools/limit_volume.py）',
    };
  }
  const stocks = raw.stocks.map(stock).filter(s => s.name);
  const count = isNum(raw.count) ? raw.count : stocks.length;
  const tally = new Map();
  for (const s of stocks) tally.set(s.fam, (tally.get(s.fam) ?? 0) + 1);
  const families = [...tally.entries()].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count);
  const main = families.find(f => f.name !== '未归类') ?? null;
  const mainCount = main?.count ?? 0;
  const asOf = typeof raw.asOf === 'string' ? raw.asOf : null;
  const stale = !!(today && asOf && asOf !== today);
  const status = count <= 0 ? 'empty' : stale ? 'stale' : 'ok';
  const p = `参数 ${params.minListDays} 天 / ${params.volMult} 倍 / ${params.minAmtWan} 千万`;
  const read = status === 'empty'
    ? `本日池内无票（${asOf ?? '日期未填'}；${p}）`
    : `池内 ${count} 只，最多集中在「${main?.name ?? '未归类'}」${mainCount} 只（${asOf ?? '日期未填'}${stale ? '，非当日' : ''}；${p}）`;
  return {
    status, count, mainCount, mainFamily: main?.name ?? null, families, stocks, asOf, params,
    read,
    hit: status === 'ok' || status === 'stale' ? count > 0 : null,
  };
}

/** 是否「量能集中在主线」：主线族内至少 mainMin 只，且占池子 mainShare 以上 */
export function lvConcentrated(lv) {
  if (!lv || lv.status === 'missing' || lv.status === 'empty') return null;
  const share = lv.count ? lv.mainCount / lv.count : 0;
  return lv.mainCount >= (lv.params?.mainMin ?? LV_RULE.mainMin) && share >= 0.4;
}

/** 机会行用的一句话（不含买卖含义，只报读数） */
export function lvChip(lv) {
  if (!lv || lv.status === 'missing') return { text: '极限量 未导入', cls: 'flat' };
  if (lv.status === 'empty') return { text: '极限量池 0 只', cls: 'flat' };
  const tail = lv.status === 'stale' ? '（非当日）' : '';
  return { text: `极限量 ${lv.count} 只 · 主线 ${lv.mainCount} 只${tail}`, cls: lvConcentrated(lv) ? 'up' : 'flat' };
}
