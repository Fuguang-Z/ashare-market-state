/**
 * 仓位建议（2026-10-28 用户定）：指数线档位 + 情绪线档位相加，总仓位不超过 100%。
 * 指数线：大主升 80%（重仓）、大主升-减仓 50%（半仓）、震荡 10%（小仓）、筑底 0%、主跌 0%；主线为偏好不参与的板块时记 0%。
 * 情绪线：情绪主升且龙头未首次见顶 +50%（半仓）；补涨、退潮、试探、见顶后观望均 +0%；龙头属偏好不参与的板块时 +0%。
 * 实际仓位不超过建议 + 5 个百分点为 √，否则为 ×（低于建议也算 √，控制风险优先）。
 * 本模块同时供本站首卡与天枢「年度计划」逐日表使用（天枢跨站 import），改档位只改这里。只给档位比例，不构成投资建议。
 */
import { PREFERENCE_EXCLUDED } from './engine.js?v=20261028c';
import { labelBoard } from './cycle.js?v=20261028c';

export const INDEX_PCT = Object.freeze({ '大主升': 80, '大主升-减仓': 50, '震荡': 10, '筑底': 0, '主跌': 0 });
export const EMO_PCT = 50;
export const TOLERANCE = 5;
export const RULE_TEXT = '指数线：大主升 80%、减仓 50%、震荡 10%、筑底与主跌 0%；情绪主升（龙头见顶前）另加 50%；合计不超过 100%。实际仓位超出建议 5 个百分点以上记 ×。';

const emoPref = board => labelBoard(board ?? '').startsWith('资源');

/** 合成建议仓位（%）。indexState 为指数线状态；indexPref 主线偏好不参与；emoOn 情绪主升半仓有效；返回 { pct, index, emo } */
export function suggestPosition(indexState, { indexPref = false, emoOn = false } = {}) {
  const index = indexPref ? 0 : (INDEX_PCT[indexState] ?? null);
  if (index === null) return { pct: null, index: null, emo: null };
  const emo = emoOn ? EMO_PCT : 0;
  return { pct: Math.min(100, index + emo), index, emo };
}

/** 判定：actualPct 与建议（均为百分数）→ true √ / false × / null 无法判定 */
export function positionOk(actualPct, suggestPct) {
  const ok = v => typeof v === 'number' && Number.isFinite(v);
  return ok(actualPct) && ok(suggestPct) ? actualPct <= suggestPct + TOLERANCE : null;
}

/** 情绪主升半仓区间：周期起点 → 首轮补涨前一天，且早于龙头首次见顶日（见顶当日收盘即观望）；作废的试探周期不算 */
function emoOnAt(cycles, date) {
  for (const c of cycles ?? []) {
    if (c.voided || date < c.start || (c.end && date > c.end)) continue;
    const firstRound = c.main?.rounds?.[0]?.start;
    if (firstRound && date >= firstRound) return { on: false, cycle: c };
    if (c.leaderTop?.date && date >= c.leaderTop.date) return { on: false, cycle: c };
    return { on: !emoPref(c.leader?.board), cycle: c };
  }
  return { on: false, cycle: null };
}

/** 用收盘时间线（data/regime_timeline.json）求某个历史交易日收盘时的建议仓位；超出时间线范围返回 null */
export function suggestOn(timeline, date) {
  if (!timeline || date < timeline.from || date > timeline.through) return null;
  const seg = (timeline.index ?? []).find(s => s.start <= date && date <= s.end);
  if (!seg) return null;
  const indexPref = seg.state.startsWith('大主升') && PREFERENCE_EXCLUDED.includes(seg.family);
  const e = emoOnAt(timeline.cycles, date);
  return { ...suggestPosition(seg.state, { indexPref, emoOn: e.on }), state: seg.state, emoLeader: e.cycle?.leader?.name ?? null };
}
