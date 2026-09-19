import { GameRuleError } from './engine.js';
import {
  ACTIONS,
  applyOverride,
  buildDefaultWindows,
  buildSortPlan,
  revokeOverride,
  sanitizeLedger
} from './priority.js';

// 状态流转层：priority.js 保持纯函数，这里负责在游戏状态上挂载/更新人工覆盖台账。
// 台账只追加，与主状态一起做乐观锁（revision），保证人工覆盖可审计、可撤销。

export function ensurePriorityLedger(state) {
  if (!Array.isArray(state.priorityLedger)) {
    state.priorityLedger = [];
  }
  return state.priorityLedger;
}

export function normalizePriorityLedger(state) {
  state.priorityLedger = sanitizeLedger(state.priorityLedger);
  return state.priorityLedger;
}

export function getPrioritySnapshot(state, options = {}) {
  const ledger = ensurePriorityLedger(state);
  const windows = options.windows ?? buildDefaultWindows(state, options.config);
  const plan = buildSortPlan(state, { windows, ledger, config: options.config });
  return {
    plan,
    ledger: ledger.map((event) => ({ ...event })),
    // 可直接提交给 /api/game/plan/preview 或 /api/game/day/advance 的 assignments
    assignments: plan.assignments.map((item) => ({
      letterId: item.letterId,
      courierId: item.courierId,
      targetIslandId: item.targetIslandId,
      order: item.order
    }))
  };
}

function validateOverridePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GameRuleError('请求体必须是 JSON 对象。');
  }
  const { letterId, action, courierId, points, reason, note } = body;
  if (typeof letterId !== 'string' || letterId.length === 0) {
    throw new GameRuleError('必须指定要覆盖的信件 ID。');
  }
  if (!Object.values(ACTIONS).includes(action)) {
    throw new GameRuleError(`覆盖动作无效，仅支持：${Object.values(ACTIONS).join('、')}。`);
  }
  return {
    letterId,
    action,
    courierId: courierId ?? null,
    points: points ?? null,
    reason: reason ?? null,
    note: note ?? null
  };
}

export function applyOverrideToState(state, body) {
  const payload = validateOverridePayload(body);
  const ledger = ensurePriorityLedger(state);

  // 软校验：信件必须存在且仍开放。台账写入阶段就拦截指向不存在信件的覆盖，
  // 但窗口/载重等硬规则仍由 buildSortPlan 在每次分拣时评估。
  const letter = state.letters.find((item) => item.id === payload.letterId);
  if (!letter) {
    throw new GameRuleError(`找不到信件 ${payload.letterId}。`);
  }
  if (letter.status !== 'inbox' && letter.status !== 'backlog') {
    throw new GameRuleError(`信件 ${payload.letterId} 已不在待分拣队列，不能再施加人工覆盖。`);
  }
  if (payload.action === ACTIONS.PIN) {
    if (!state.couriers.some((courier) => courier.id === payload.courierId)) {
      throw new GameRuleError(`置顶目标信使 ${payload.courierId || '(空)'} 不存在。`);
    }
  }

  const event = applyOverride(ledger, payload);
  return { event: { ...event }, ledger: ledger.map((item) => ({ ...item })) };
}

export function revokeOverrideInState(state, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GameRuleError('请求体必须是 JSON 对象。');
  }
  const { eventId, reason, note } = body;
  if (typeof eventId !== 'string' || eventId.length === 0) {
    throw new GameRuleError('必须指定要撤销的覆盖事件 ID。');
  }
  const ledger = ensurePriorityLedger(state);
  const event = revokeOverride(ledger, eventId, { reason: reason ?? null, note: note ?? null });
  return { event: { ...event }, ledger: ledger.map((item) => ({ ...item })) };
}
