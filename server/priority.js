import {
  GameRuleError,
  calculateRoute,
  getCourier,
  getIsland,
  getOpenLetters,
  HUB_ID
} from './engine.js';

function round(value, precision = 1) {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

// 分拣优先级引擎（与主引擎同风格的纯函数模块）
//
// 设计要点：
// 1. 硬规则（窗口关闭、载重、邮件数、目的地必须等于收件岛）是准入闸门，
//    任何人工覆盖（置顶/加权/暂缓）都只能在闸门通过后生效，无法绕行。
// 2. 评分只做确定性整数运算，所有并列用固定字典序打破，同一输入永远同一输出。
// 3. 人工覆盖保存在只追加（append-only）台账里；撤销通过追加 revoke 事件完成，
//    同信件同动作被新事件自然取代，撤销是可继续叠加、可再撤销的分层语义。

export const PRIORITY_ENGINE_VERSION = 1;

export const DEFAULT_PRIORITY_CONFIG = Object.freeze({
  // 加急基础分
  urgencyPoints: Object.freeze({ 1: 10, 2: 26, 3: 45 }),
  // 距截止窗剩余时间（小时）分档
  slackBands: Object.freeze([
    { maxSlackHours: 0, points: 30 },
    { maxSlackHours: 2, points: 22 },
    { maxSlackHours: 5, points: 12 },
    { maxSlackHours: 10, points: 5 },
    { maxSlackHours: Infinity, points: 0 }
  ]),
  // 积压每多等一天的加分与上限
  agingPointsPerDay: 8,
  agingPointsCap: 24,
  // 目的岛关系约束：关系值映射到 [0, 12]
  relationZeroPoint: 0,
  relationFullPoint: 100,
  relationPointsCap: 12,
  // 人工加权可给出的最高加分（封顶本身也是硬规则）
  maxBoostPoints: 15,
  // 规划时刻（小时）：默认 6 点，信使 7 点起航
  currentHour: 6,
  // 默认截止窗关闭时间（起航前 1 小时停止排程）
  defaultWindowClosesAtHour: 7
});

export const ACTIONS = Object.freeze({
  PIN: 'pin', // 置顶：指定信使
  BOOST: 'boost', // 加权：在自动排序基础上加分
  HOLD: 'hold' // 暂缓：今日不安排
});

// 硬闸门原因码（人工覆盖同样无法绕过）
export const GATES = Object.freeze({
  WINDOW_CLOSED: 'WINDOW_CLOSED', // 该信使的截止窗已关闭
  WINDOW_NOT_OPEN: 'WINDOW_NOT_OPEN', // 该岛/信使今日无开放窗口
  WEIGHT_LIMIT: 'WEIGHT_LIMIT', // 超出信使载重
  LETTER_LIMIT: 'LETTER_LIMIT', // 超出信使可携带邮件数
  TARGET_FORBIDDEN: 'TARGET_FORBIDDEN', // 目标岛不是该信的合法目的地
  LETTER_NOT_OPEN: 'LETTER_NOT_OPEN' // 信件已不在待分拣队列
});

// 覆盖被拒绝的原因码（在硬闸门之外，针对覆盖本身的校验）
export const OVERRIDE_REJECTIONS = Object.freeze({
  ACTION_CONFLICT: 'OVERRIDE_ACTION_CONFLICT',
  COURIER_NOT_FOUND: 'OVERRIDE_COURIER_NOT_FOUND',
  BOOST_OUT_OF_RANGE: 'OVERRIDE_BOOST_OUT_OF_RANGE'
});

function mergeConfig(config = {}) {
  const base = DEFAULT_PRIORITY_CONFIG;
  return {
    ...base,
    ...config,
    urgencyPoints: { ...base.urgencyPoints, ...(config.urgencyPoints || {}) },
    slackBands: config.slackBands ? config.slackBands.map((band) => ({ ...band })) : base.slackBands
  };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function ensureInteger(value, message) {
  if (!Number.isInteger(value)) {
    throw new GameRuleError(message);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 截止窗
// ---------------------------------------------------------------------------

// 为每个信使生成默认窗口：今日 7:00 起航，currentHour 之后视为关闭。
export function buildDefaultWindows(state, config = {}) {
  const merged = mergeConfig(config);
  return state.couriers.map((courier) => ({
    courierId: courier.id,
    closesAtHour: merged.defaultWindowClosesAtHour,
    open: true
  }));
}

function indexWindows(windows) {
  const map = new Map();
  for (const window of windows) {
    if (!window || typeof window.courierId !== 'string') {
      throw new GameRuleError('截止窗数据格式无效：缺少 courierId。');
    }
    if (!isFiniteNumber(window.closesAtHour)) {
      throw new GameRuleError(`信使 ${window.courierId} 的截止窗关闭时间无效。`);
    }
    if (map.has(window.courierId)) {
      throw new GameRuleError(`信使 ${window.courierId} 存在多个截止窗。`);
    }
    map.set(window.courierId, {
      courierId: window.courierId,
      closesAtHour: window.closesAtHour,
      open: window.open !== false
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// 人工覆盖台账（只追加；撤销 = 追加 revoke 事件）
// ---------------------------------------------------------------------------

function normalizeAction(action) {
  const valid = Object.values(ACTIONS);
  if (!valid.includes(action)) {
    throw new GameRuleError(`人工覆盖动作无效，仅支持：${valid.join('、')}。`);
  }
  return action;
}

function normalizeNote(note) {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string') {
    throw new GameRuleError('人工覆盖备注必须是字符串。');
  }
  return note;
}

// 追加一条覆盖。不校验信件/信使是否存在——台账允许先记录，
// 真正的硬规则校验发生在 buildSortPlan，拒绝结果会出现在 refusedOverrides 中。
export function applyOverride(ledger, { letterId, action, courierId = null, points = null, reason = null, note = null, createdAtHour = null }) {
  if (!Array.isArray(ledger)) {
    throw new GameRuleError('人工覆盖台账必须是数组。');
  }
  if (typeof letterId !== 'string' || letterId.length === 0) {
    throw new GameRuleError('人工覆盖必须指定信件 ID。');
  }
  const normalizedAction = normalizeAction(action);

  if (normalizedAction === ACTIONS.PIN) {
    if (typeof courierId !== 'string' || courierId.length === 0) {
      throw new GameRuleError('置顶覆盖必须指定信使。');
    }
    if (points !== null) {
      throw new GameRuleError('置顶覆盖不接受加分参数。');
    }
  }
  if (normalizedAction === ACTIONS.BOOST) {
    if (!Number.isInteger(points) || points <= 0) {
      throw new GameRuleError('加权覆盖必须给出正整数加分。');
    }
    if (courierId !== null) {
      throw new GameRuleError('加权覆盖不接受指定信使。');
    }
  }
  if (normalizedAction === ACTIONS.HOLD && (courierId !== null || points !== null)) {
    throw new GameRuleError('暂缓覆盖不接受信使或加分参数。');
  }

  const event = {
    id: `OV-${String(ledger.length + 1).padStart(4, '0')}`,
    seq: ledger.length,
    kind: 'apply',
    letterId,
    action: normalizedAction,
    courierId: normalizedAction === ACTIONS.PIN ? courierId : null,
    points: normalizedAction === ACTIONS.BOOST ? points : null,
    reason: normalizeNote(reason),
    note: normalizeNote(note),
    createdAtHour: createdAtHour === null ? null : ensureInteger(createdAtHour, '覆盖创建时刻必须是整数小时。'),
    revoked: false,
    revokedByEventId: null
  };
  ledger.push(event);
  return event;
}

// 撤销某条 apply 事件：不是删除，而是追加一条 revoke 事件并打标记。
export function revokeOverride(ledger, eventId, { reason = null, note = null } = {}) {
  if (!Array.isArray(ledger)) {
    throw new GameRuleError('人工覆盖台账必须是数组。');
  }
  const target = ledger.find((event) => event.id === eventId && event.kind === 'apply');
  if (!target) {
    throw new GameRuleError(`找不到人工覆盖 ${eventId || '(空)'}。`);
  }
  if (target.revoked) {
    throw new GameRuleError(`人工覆盖 ${eventId} 已经被撤销。`);
  }
  target.revoked = true;
  target.revokedByEventId = `OV-${String(ledger.length + 1).padStart(4, '0')}`;
  const event = {
    id: target.revokedByEventId,
    seq: ledger.length,
    kind: 'revoke',
    targetEventId: target.id,
    letterId: target.letterId,
    action: target.action,
    reason: normalizeNote(reason),
    note: normalizeNote(note)
  };
  ledger.push(event);
  return event;
}

// 重放台账，得到每封信当前生效的覆盖。
// 同一封信允许叠加不同动作（如 boost + hold），同动作后者取代前者；
// 撤销最新一条后，上一条未撤销记录自动重新生效（分层撤销）。
export function activeOverrides(ledger) {
  if (!Array.isArray(ledger)) {
    throw new GameRuleError('人工覆盖台账必须是数组。');
  }
  const revokedIds = new Set();
  for (const event of ledger) {
    if (event && event.kind === 'revoke' && typeof event.targetEventId === 'string') {
      revokedIds.add(event.targetEventId);
    }
  }
  // 对直接带 revoked 标记的持久化台账同样兼容。
  const isRevoked = (event) => revokedIds.has(event.id) || event.revoked === true;

  // key = letterId|action，值为按 seq 排序的未撤销 apply 栈
  const stacks = new Map();
  for (const event of ledger) {
    if (!event || event.kind !== 'apply') continue;
    if (typeof event.letterId !== 'string' || typeof event.action !== 'string') continue;
    if (isRevoked(event)) continue;
    const key = `${event.letterId}|${event.action}`;
    if (!stacks.has(key)) stacks.set(key, []);
    stacks.get(key).push(event);
  }

  const result = new Map();
  for (const stack of stacks.values()) {
    const sorted = [...stack].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
    const top = sorted[sorted.length - 1];
    const existing = result.get(top.letterId);
    const view = {
      ...top,
      supersededEventIds: sorted.slice(0, -1).map((event) => event.id)
    };
    if (existing) {
      result.set(top.letterId, { ...existing, [view.action]: view });
    } else {
      result.set(top.letterId, { [view.action]: view });
    }
  }
  return result;
}

// 供持久化层使用：把未知来源的台账数据校验/规范化为事件数组。
export function sanitizeLedger(rawLedger) {
  if (rawLedger === undefined || rawLedger === null) return [];
  if (!Array.isArray(rawLedger)) return [];
  return rawLedger.filter((event) => (
    event &&
    typeof event.id === 'string' &&
    (event.kind === 'apply' || event.kind === 'revoke') &&
    typeof event.letterId === 'string' &&
    typeof event.action === 'string'
  ));
}

// ---------------------------------------------------------------------------
// 评分
// ---------------------------------------------------------------------------

function deadlineHours(letter) {
  return (letter.deadlineDay - 1) * 24 + letter.deadlineHour;
}

function slackBandPoints(slackHours, config) {
  for (const band of config.slackBands) {
    if (slackHours <= band.maxSlackHours) return band.points;
  }
  return 0;
}

export function scoreLetter(letter, state, config = {}) {
  const merged = mergeConfig(config);
  const urgentPoints = merged.urgencyPoints[letter.urgency] ?? 0;
  const slackHours = deadlineHours(letter) - merged.currentHour;
  const slackPoints = slackBandPoints(slackHours, merged);

  const ageDays = letter.backlogSince === null
    ? 0
    : Math.max(0, state.day - letter.backlogSince);
  const agingPoints = Math.min(
    merged.agingPointsCap,
    ageDays * merged.agingPointsPerDay
  );

  const relationKey = [letter.originIslandId, letter.recipientIslandId].sort().join(':');
  const relation = state.relations[relationKey] ?? merged.relationZeroPoint;
  const ratio = Math.min(1, Math.max(0, relation / merged.relationFullPoint));
  const relationPoints = Math.round(ratio * merged.relationPointsCap);

  const breakdown = {
    urgencyPoints: urgentPoints,
    slackHours,
    slackPoints,
    ageDays,
    agingPoints,
    relationPoints
  };
  const basePoints = urgentPoints + slackPoints + agingPoints + relationPoints;
  return { basePoints, breakdown };
}

// ---------------------------------------------------------------------------
// 硬闸门：窗口 / 载重 / 数量 / 目的地
// ---------------------------------------------------------------------------

function windowGate(courier, window, config) {
  if (!window || window.open === false) {
    return { pass: false, code: GATES.WINDOW_NOT_OPEN, message: `${courier.name} 今日没有开放的截止窗。` };
  }
  if (config.currentHour >= window.closesAtHour) {
    return { pass: false, code: GATES.WINDOW_CLOSED, message: `${courier.name} 的截止窗已于 ${window.closesAtHour}:00 关闭。` };
  }
  return { pass: true };
}

function destinationGate(letter, state) {
  const target = getIsland(state, letter.recipientIslandId);
  if (!target || target.id === HUB_ID) {
    return { pass: false, code: GATES.TARGET_FORBIDDEN, message: `${letter.id} 的收件目的地不可达。` };
  }
  return { pass: true };
}

// 在「该信使当前已装邮件 + 本封」的假设下，检查载重、数量与航时可行性。
// feasibility 用主引擎同款航段模拟，保证分拣引擎给出的建议与实际结算一致。
function evaluatePlacement(state, courier, window, routeAssignments, letter, config) {
  const windowResult = windowGate(courier, window, config);
  if (!windowResult.pass) return windowResult;

  const destinationResult = destinationGate(letter, state);
  if (!destinationResult.pass) return destinationResult;

  const nextAssignments = [...routeAssignments, {
    letterId: letter.id,
    courierId: courier.id,
    targetIslandId: letter.recipientIslandId,
    order: routeAssignments.length,
    letter
  }];
  if (nextAssignments.length > courier.maxLetters) {
    return { pass: false, code: GATES.LETTER_LIMIT, message: `${courier.name} 最多携带 ${courier.maxLetters} 封。` };
  }
  const totalWeight = round(nextAssignments.reduce((sum, item) => sum + item.letter.weight, 0), 1);
  if (totalWeight > courier.capacity + 0.001) {
    return { pass: false, code: GATES.WEIGHT_LIMIT, message: `${courier.name} 载重上限 ${courier.capacity} kg，装入后为 ${totalWeight} kg。` };
  }

  const route = calculateRoute(state, courier.id, nextAssignments);
  const result = route.letters[route.letters.length - 1];
  return {
    pass: true,
    totalWeight,
    arrivalHour: result.arrivalHour,
    late: result.late
  };
}

// ---------------------------------------------------------------------------
// 分拣主流程
// ---------------------------------------------------------------------------

function rankKey(entry) {
  const letter = entry.letter;
  return [
    -entry.effectivePoints,
    -letter.urgency,
    deadlineHours(letter),
    -(entry.scoring.ageDays),
    letter.id
  ];
}

function compareRankKeys(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function buildSortPlan(state, { windows, ledger = [], config = {} } = {}) {
  if (!state || typeof state !== 'object') {
    throw new GameRuleError('缺少游戏状态。');
  }
  if (!Array.isArray(windows)) {
    throw new GameRuleError('必须显式提供截止窗数组（可用 buildDefaultWindows 生成）。');
  }
  const merged = mergeConfig(config);
  const windowByCourier = indexWindows(windows);
  const overrides = activeOverrides(ledger);
  const openLetters = getOpenLetters(state);

  const plannedMap = new Map(); // courierId -> { assignments: [], placementByLetter: Map }
  for (const courier of state.couriers) {
    plannedMap.set(courier.id, { assignments: [], placementByLetter: new Map() });
  }

  const held = [];
  const unassigned = [];
  const refusedOverrides = [];

  // 第一遍：建立每封开放信件的评分与覆盖视图；暂缓信直接落 held。
  // 一封信可同时持有不同动作的覆盖（如 boost + pin），但 hold 优先级最高。
  const candidates = [];
  for (const letter of openLetters) {
    const scoring = scoreLetter(letter, state, merged);
    const overrideSet = overrides.get(letter.id) || {};
    const hold = overrideSet[ACTIONS.HOLD] || null;
    const pin = overrideSet[ACTIONS.PIN] || null;
    const boostEvent = overrideSet[ACTIONS.BOOST] || null;

    if (hold) {
      held.push({
        letterId: letter.id,
        reason: hold.reason,
        overrideId: hold.id,
        audit: {
          basePoints: scoring.basePoints,
          breakdown: scoring.breakdown,
          override: 'hold',
          suppressedOverrides: [pin, boostEvent].filter(Boolean).map((event) => event.id)
        }
      });
      continue;
    }

    let boostPoints = 0;
    let boostRefused = null;
    if (boostEvent && boostEvent.points > merged.maxBoostPoints) {
      // 加权上限是硬规则：不静默截断，直接拒绝整条覆盖，按自动排序处理。
      boostRefused = {
        overrideId: boostEvent.id,
        letterId: letter.id,
        action: ACTIONS.BOOST,
        code: OVERRIDE_REJECTIONS.BOOST_OUT_OF_RANGE,
        message: `加权 ${boostEvent.points} 分超过上限 ${merged.maxBoostPoints} 分，该覆盖未生效。`
      };
    } else if (boostEvent) {
      boostPoints = boostEvent.points;
    }

    candidates.push({
      letter,
      scoring,
      pin,
      boostEvent: boostRefused ? null : boostEvent,
      boostRefused,
      boostPoints,
      effectivePoints: scoring.basePoints + boostPoints
    });
    if (boostRefused) refusedOverrides.push(boostRefused);
  }

  // 第二遍：确定性排序。置顶覆盖不改变排序位置，只在可行时锁定信使；
  // 排序完全由分数与固定并列键决定，避免「同一输入不同结果」。
  const ranked = [...candidates].sort((left, right) => compareRankKeys(rankKey(left), rankKey(right)));

  // 第三遍：按排名顺序贪心装入。置顶先尝试目标信使，失败则记为拒绝（不自动改派）。
  ranked.forEach((entry, rankIndex) => {
    const { letter, pin } = entry;

    if (pin) {
      const courier = getCourier(state, pin.courierId);
      if (!courier) {
        refusedOverrides.push({
          overrideId: pin.id,
          letterId: letter.id,
          action: ACTIONS.PIN,
          code: OVERRIDE_REJECTIONS.COURRIER_NOT_FOUND,
          message: `置顶目标信使 ${pin.courierId || '(空)'} 不存在。`
        });
        // 信使不存在属于数据问题，回落为自动分配，避免一封可投递的信仅因错填 ID 而滞留。
      } else {
        const bucket = plannedMap.get(courier.id);
        const window = windowByCourier.get(courier.id);
        const feasibility = evaluatePlacement(state, courier, window, bucket.assignments, letter, merged);
        if (feasibility.pass) {
          placeEntry({ courier, window, bucket, letter, entry, feasibility, rankIndex, overrideLabel: 'pin' });
          return;
        }
        refusedOverrides.push({
          overrideId: pin.id,
          letterId: letter.id,
          action: ACTIONS.PIN,
          code: feasibility.code,
          message: `置顶被硬规则拦截：${feasibility.message}`
        });
        // 置顶撞上硬规则（窗口已关/超载/数量满）时不自动改派：
        // 自动改派会让「置顶」在硬规则面前悄悄变形，调度员须显式撤销置顶后再回到自动分配。
        unassigned.push(buildUnassigned(letter, entry, {
          code: feasibility.code,
          message: feasibility.message,
          overrideRefused: true
        }));
        return;
      }
    }

    // 自动分配：在所有窗口开放且装得下的信使中，选预计到达最早的；
    // 并列时按信使 ID，保证确定性。
    const options = [];
    for (const courier of state.couriers) {
      const bucket = plannedMap.get(courier.id);
      const window = windowByCourier.get(courier.id);
      const feasibility = evaluatePlacement(state, courier, window, bucket.assignments, letter, merged);
      if (feasibility.pass) {
        options.push({ courier, window, feasibility });
      }
    }
    options.sort((left, right) => (
      left.feasibility.arrivalHour - right.feasibility.arrivalHour ||
      left.courier.id.localeCompare(right.courier.id)
    ));

    if (options.length === 0) {
      unassigned.push(buildUnassigned(letter, entry, inferNoCapacityReason(state, plannedMap, windowByCourier, letter, merged)));
      return;
    }
    const best = options[0];
    placeEntry({
      courier: best.courier,
      window: best.window,
      bucket: plannedMap.get(best.courier.id),
      letter,
      entry,
      feasibility: best.feasibility,
      rankIndex,
      overrideLabel: entry.boostPoints > 0 ? 'boost' : null
    });
  });

  const planned = [];
  for (const courier of state.couriers) {
    const bucket = plannedMap.get(courier.id);
    bucket.assignments.forEach((assignment, order) => {
      const placement = bucket.placementByLetter.get(assignment.letterId);
      planned.push({
        letterId: assignment.letterId,
        courierId: courier.id,
        targetIslandId: assignment.letter.recipientIslandId,
        order,
        rank: placement.rank,
        points: placement.effectivePoints,
        basePoints: placement.basePoints,
        boostPoints: placement.boostPoints,
        breakdown: placement.breakdown,
        arrivalHour: placement.arrivalHour,
        late: placement.late,
        windowClosesAtHour: placement.closesAtHour,
        override: placement.overrideLabel
      });
    });
  }
  planned.sort((left, right) => (
    left.courierId.localeCompare(right.courierId) ||
    left.order - right.order ||
    left.letterId.localeCompare(right.letterId)
  ));

  held.sort((left, right) => left.letterId.localeCompare(right.letterId));
  unassigned.sort((left, right) => (
    right.points - left.points || left.letterId.localeCompare(right.letterId)
  ));
  refusedOverrides.sort((left, right) => (
    left.letterId.localeCompare(right.letterId) ||
    left.overrideId.localeCompare(right.overrideId)
  ));

  return {
    engineVersion: PRIORITY_ENGINE_VERSION,
    currentHour: merged.currentHour,
    windows: windows.map((window) => ({ ...window })),
    configFingerprint: fingerprintConfig(merged),
    assignments: planned,
    held,
    unassigned,
    refusedOverrides
  };
}

function placeEntry({ courier, window, bucket, letter, entry, feasibility, rankIndex, overrideLabel }) {
  const assignment = {
    letterId: letter.id,
    courierId: courier.id,
    targetIslandId: letter.recipientIslandId,
    order: bucket.assignments.length,
    letter
  };
  bucket.assignments.push(assignment);
  bucket.placementByLetter.set(letter.id, {
    rank: rankIndex,
    effectivePoints: entry.effectivePoints,
    basePoints: entry.scoring.basePoints,
    boostPoints: entry.boostPoints,
    breakdown: entry.scoring.breakdown,
    arrivalHour: feasibility.arrivalHour,
    late: feasibility.late,
    overrideLabel: overrideLabel || null,
    closesAtHour: window.closesAtHour
  });
}

function buildUnassigned(letter, entry, reason) {
  return {
    letterId: letter.id,
    points: entry.effectivePoints,
    basePoints: entry.scoring.basePoints,
    breakdown: entry.scoring.breakdown,
    code: reason.code,
    message: reason.message,
    overrideRefused: Boolean(reason.overrideRefused)
  };
}

function inferNoCapacityReason(state, plannedMap, windowByCourier, letter, config) {
  // 给出确定性的首要原因：先看窗口是否全部关闭，再看数量，再看载重。
  const closedCouriers = [];
  const fullCouriers = [];
  for (const courier of state.couriers) {
    const window = windowByCourier.get(courier.id);
    const windowResult = windowGate(courier, window, config);
    if (!windowResult.pass) {
      closedCouriers.push({ courier, code: windowResult.code, message: windowResult.message });
      continue;
    }
    const bucket = plannedMap.get(courier.id);
    if (bucket.assignments.length >= courier.maxLetters) {
      fullCouriers.push({ courier, code: GATES.LETTER_LIMIT, message: `${courier.name} 携带数量已满。` });
      continue;
    }
    const totalWeight = round(bucket.assignments.reduce((sum, item) => sum + item.letter.weight, 0) + letter.weight, 1);
    if (totalWeight > courier.capacity + 0.001) {
      fullCouriers.push({ courier, code: GATES.WEIGHT_LIMIT, message: `${courier.name} 剩余载重不足。` });
    }
  }
  if (closedCouriers.length === state.couriers.length) {
    const first = closedCouriers[0];
    return { code: first.code, message: `所有截止窗均不可用：${first.message}` };
  }
  if (fullCouriers.length > 0) {
    fullCouriers.sort((left, right) => left.courier.id.localeCompare(right.courier.id));
    const first = fullCouriers[0];
    return { code: first.code, message: `没有可容纳该信的信使：${first.message}` };
  }
  const target = getIsland(state, letter.recipientIslandId);
  if (!target || target.id === HUB_ID) {
    return { code: GATES.TARGET_FORBIDDEN, message: `${letter.id} 的收件目的地不可达。` };
  }
  return { code: GATES.WINDOW_NOT_OPEN, message: `${letter.id} 今日没有可排入的窗口。` };
}

function fingerprintConfig(config) {
  // 稳定指纹：相同配置同指纹，便于在输出里核对「同一输入」是否真的同参数。
  const payload = {
    u: config.urgencyPoints,
    b: config.slackBands.map((band) => [band.maxSlackHours === Infinity ? 'inf' : band.maxSlackHours, band.points]),
    a: [config.agingPointsPerDay, config.agingPointsCap],
    r: [config.relationZeroPoint, config.relationFullPoint, config.relationPointsCap],
    m: config.maxBoostPoints,
    h: config.currentHour
  };
  const text = JSON.stringify(payload);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `cf-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
