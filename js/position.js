/**
 * 仓位建议（2026-11-10 用户定）：主跌 0%、筑底 10%、反弹 20%、主升 100%。
 * 情绪线仓位和板块偏好单列于机会提示。
 * 实际仓位不超过建议 + 5 个百分点为 √，否则为 ×（低于建议也算 √，控制风险优先）。
 * 本模块同时供本站首卡与天枢「年度计划」逐日表使用（天枢跨站 import），改档位只改这里。只给档位比例，不构成投资建议。
 */
export const INDEX_PCT = Object.freeze({ '主跌': 0, '筑底': 10, '反弹': 20, '主升': 100 });
export const TOLERANCE = 5;
export const RULE_TEXT = '指数线主跌 0%、筑底 10%、反弹 20%、主升 100%。实际仓位超出建议 5 个百分点以上记 ×。';

/** 兼容旧版收盘时间线；旧「震荡」没有反弹门槛记录。 */
export function indexStage(state) {
  if (state === '震荡') return '筑底';
  if (state === '大主升' || state === '大主升-减仓' || state === '大主升-半仓') return '主升';
  return state;
}

/** 指数线建议仓位（%），未知状态返回 null。 */
export function suggestPosition(indexState) {
  const state = indexStage(indexState);
  const index = Object.hasOwn(INDEX_PCT, state) ? INDEX_PCT[state] : null;
  return { pct: index, index, emo: index === null ? null : 0 };
}

export function positionOf(state) {
  const { pct } = suggestPosition(state);
  return pct === null ? undefined : `${pct}%`;
}

/** 判定：actualPct 与建议（均为百分数）→ true √ / false × / null 无法判定 */
export function positionOk(actualPct, suggestPct) {
  const ok = v => typeof v === 'number' && Number.isFinite(v);
  return ok(actualPct) && ok(suggestPct) ? actualPct <= suggestPct + TOLERANCE : null;
}

/** 用收盘时间线（data/regime_timeline.json）求某个历史交易日收盘时的建议仓位；超出时间线范围返回 null */
export function suggestOn(timeline, date) {
  if (!timeline || date < timeline.from || date > timeline.through) return null;
  const seg = (timeline.index ?? []).find(s => s.start <= date && date <= s.end);
  if (!seg) return null;
  const state = indexStage(seg.state);
  return { ...suggestPosition(state), state };
}
