import {
  GameRuleError,
  HUB_ID,
  computeLeg,
  getIsland,
  getOpenLetters
} from './engine.js';

// ---------------------------------------------------------------------------
// 常量与量级设计
//
// 软评分全部为整数分，三个分量互不混淆：
//   加急分      0..3000   每级 1000 分
//   截止窗分    0..2000   物理余量越紧分越高，余量 >= 15 小时记 0 分
//   目的地分    0..1000   运输时长(<=600) + 承运稀缺度(<=400)
//
// 人工覆盖只允许在 ±OVERRIDE_DELTA_CAP 内调整软分。上限 900 小于一个完整
// 加急级距(1000)，因此覆盖可以微调相邻顺序，却无法仅凭覆盖让低加急邮件
// 反超一个完整等级；硬规则（承运能力、状态、容量）则完全不在覆盖射程内。
// ---------------------------------------------------------------------------

export const GAME_DAY_START_HOUR = 7;
export const OVERRIDE_DELTA_CAP = 900;
export const URGENCY_POINTS = { 1: 1000, 2: 2000, 3: 3000 };
export const SLACK_HORIZON_CENTI_HOURS = 1500; // 截止余量超过 15 小时不再加分
export const MAX_DEADLINE_POINTS = 2000;
export const MAX_TRANSIT_POINTS = 600;
export const MAX_SCARCITY_POINTS = 400;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, precision = 1) {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

// 确定性的字符串比较（localeCompare 随运行环境语言而变，禁止用于排序键）。
function compareText(first, second) {
  return first < second ? -1 : first > second ? 1 : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// 硬规则：任何环节（包括人工覆盖）都不得绕过
// ---------------------------------------------------------------------------

// 硬规则一：载重。信使容量小于邮件重量即物理不可承运。
export function feasibleCouriers(state, letter) {
  return state.couriers.filter((courier) => letter.weight <= courier.capacity);
}

// 硬规则二：状态。只有待处理邮件可以进入分拣队列。
export function isSortable(letter) {
  return letter.status === 'inbox' || letter.status === 'backlog';
}

// 以"单件直航"估计最早可达时刻：这是该邮件今日送达的物理下界，
// 实际多站航线只会更晚，因此可以用它安全地判定截止窗是否物理可达。
export function estimateEarliestArrival(state, letter, couriers = feasibleCouriers(state, letter)) {
  if (couriers.length === 0) return null;
  const hub = getIsland(state, HUB_ID);
  const target = getIsland(state, letter.recipientIslandId);
  let best = null;

  for (const courier of couriers) {
    const leg = computeLeg(state, courier, hub, target, letter.weight, GAME_DAY_START_HOUR);
    if (!best || leg.arrivalHour < best.arrivalHour
      || (leg.arrivalHour === best.arrivalHour && compareText(courier.id, best.courierId) < 0)) {
      best = { arrivalHour: leg.arrivalHour, courierId: courier.id, leg };
    }
  }
  return best;
}

function isDeadlineFeasible(state, letter, earliestArrivalHour) {
  if (state.day > letter.deadlineDay) return false;
  if (state.day < letter.deadlineDay) return true;
  return earliestArrivalHour <= letter.deadlineHour;
}

// ---------------------------------------------------------------------------
// 软评分：纯函数、整数运算，同一输入必然得到同一分数
// ---------------------------------------------------------------------------

function scoreLetter(state, letter, earliest, feasibleCount) {
  const urgencyPoints = URGENCY_POINTS[letter.urgency] ?? 0;

  const slackHours = round(
    (letter.deadlineDay - state.day) * 24 + letter.deadlineHour - earliest.arrivalHour,
    2
  );
  const slackCentiHours = Math.round(slackHours * 100);
  const deadlinePoints = clamp(
    MAX_DEADLINE_POINTS - Math.round(slackCentiHours * MAX_DEADLINE_POINTS / SLACK_HORIZON_CENTI_HOURS),
    0,
    MAX_DEADLINE_POINTS
  );

  const transitCentiHours = Math.round((earliest.arrivalHour - GAME_DAY_START_HOUR) * 100);
  const transitPoints = clamp(transitCentiHours * 2, 0, MAX_TRANSIT_POINTS);
  const scarcityPoints = Math.round((1 - feasibleCount / state.couriers.length) * MAX_SCARCITY_POINTS);
  const destinationPoints = Math.min(1000, transitPoints + scarcityPoints);

  return {
    baseScore: urgencyPoints + deadlinePoints + destinationPoints,
    slackHours,
    breakdown: {
      urgencyPoints,
      deadlinePoints,
      destinationPoints,
      transitPoints,
      scarcityPoints
    }
  };
}

// ---------------------------------------------------------------------------
// 人工覆盖：事件溯源（append-only），当日有效，可撤销，全程留痕
// ---------------------------------------------------------------------------

export function getActiveOverrides(state) {
  const appliesByLetter = new Map();
  const revokedIds = new Set();

  for (const event of state.priorityOverrides ?? []) {
    if (event.day !== state.day) continue; // 覆盖仅当日有效，跨日自动失效
    if (event.action === 'apply') {
      appliesByLetter.set(event.letterId, event);
    } else if (event.action === 'revoke') {
      revokedIds.add(event.targetId);
    }
  }

  return [...appliesByLetter.values()]
    .filter((event) => !revokedIds.has(event.id))
    .sort((first, second) => compareText(first.letterId, second.letterId));
}

function nextOverrideEvent(state, fields) {
  const seq = (state.priorityOverrides?.length ?? 0) + 1;
  return {
    id: `ov-${state.day}-${seq}`,
    day: state.day,
    seq,
    ...fields
  };
}

export function applyPriorityOverride(state, payload, now = new Date().toISOString()) {
  const body = isPlainObject(payload) ? payload : {};
  const letterId = body.letterId;
  const delta = body.delta;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  const letter = state.letters.find((item) => item.id === letterId);
  if (!letter) {
    throw new GameRuleError('找不到要覆盖优先级的邮件。', [
      { code: 'LETTER_NOT_FOUND', message: `找不到邮件 ${letterId || '(空)'}。`, letterId }
    ]);
  }
  if (!isSortable(letter)) {
    throw new GameRuleError('只能调整待处理邮件的优先级。', [
      { code: 'LETTER_NOT_OPEN', message: `${letter.id} 已不在待投递队列，覆盖不生效。`, letterId: letter.id }
    ]);
  }
  // 硬规则不可覆盖：没有任何信使能承运的邮件，拒绝施加覆盖。
  if (feasibleCouriers(state, letter).length === 0) {
    throw new GameRuleError('该邮件超出所有信使的承运能力，人工覆盖不能绕过硬规则。', [
      { code: 'NO_FEASIBLE_COURIER', message: `${letter.id} 重量 ${letter.weight} kg 超出所有信使载重。`, letterId: letter.id }
    ]);
  }
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > OVERRIDE_DELTA_CAP) {
    throw new GameRuleError(`覆盖幅度必须是 ±${OVERRIDE_DELTA_CAP} 以内的非零整数。`, [
      { code: 'OVERRIDE_DELTA_INVALID', message: `delta 需在 ±${OVERRIDE_DELTA_CAP} 内且不为 0。`, letterId: letter.id }
    ]);
  }
  if (!reason) {
    throw new GameRuleError('人工覆盖必须填写原因以便审计。', [
      { code: 'OVERRIDE_REASON_REQUIRED', message: 'reason 不能为空。', letterId: letter.id }
    ]);
  }

  if (!Array.isArray(state.priorityOverrides)) state.priorityOverrides = [];

  // 同一封邮件同时只保留一条有效覆盖：新覆盖会先撤销旧覆盖（留痕）。
  for (const active of getActiveOverrides(state)) {
    if (active.letterId !== letter.id) continue;
    state.priorityOverrides.push(nextOverrideEvent(state, {
      action: 'revoke',
      letterId: letter.id,
      targetId: active.id,
      reason: '被新的人工覆盖取代',
      createdAt: now
    }));
  }

  const event = nextOverrideEvent(state, {
    action: 'apply',
    letterId: letter.id,
    delta,
    reason,
    createdAt: now
  });
  state.priorityOverrides.push(event);
  return structuredClone(event);
}

export function revokePriorityOverride(state, payload, now = new Date().toISOString()) {
  const overrideId = isPlainObject(payload) ? payload.overrideId : undefined;
  const events = state.priorityOverrides ?? [];
  const target = events.find((event) => event.id === overrideId && event.action === 'apply');

  if (!target || target.day !== state.day) {
    throw new GameRuleError('找不到仍然有效的覆盖记录。', [
      { code: 'OVERRIDE_NOT_FOUND', message: `覆盖 ${overrideId || '(空)'} 不存在或已随当日结算过期。` }
    ]);
  }
  const alreadyRevoked = events.some((event) => event.action === 'revoke' && event.targetId === target.id);
  if (alreadyRevoked) {
    throw new GameRuleError('该覆盖已被撤销，不能重复撤销。', [
      { code: 'OVERRIDE_ALREADY_REVOKED', message: `覆盖 ${target.id} 已被撤销。`, letterId: target.letterId }
    ]);
  }

  const event = nextOverrideEvent(state, {
    action: 'revoke',
    letterId: target.letterId,
    targetId: target.id,
    reason: '调度员手动撤销',
    createdAt: now
  });
  state.priorityOverrides.push(event);
  return structuredClone(event);
}

// ---------------------------------------------------------------------------
// 建议装载：按优先级贪心装入信使，容量与件数上限是硬约束，覆盖无法突破
// ---------------------------------------------------------------------------

function buildSuggestion(state, queue, letterById) {
  const lanes = new Map(state.couriers.map((courier) => [courier.id, { count: 0, weight: 0 }]));
  const arrivalCache = new Map();
  const assignments = [];
  const skipped = [];

  const directArrival = (courierId, letter) => {
    const key = `${courierId}:${letter.id}`;
    if (!arrivalCache.has(key)) {
      const courier = state.couriers.find((item) => item.id === courierId);
      const leg = computeLeg(state, courier, getIsland(state, HUB_ID), getIsland(state, letter.recipientIslandId), letter.weight, GAME_DAY_START_HOUR);
      arrivalCache.set(key, leg.arrivalHour);
    }
    return arrivalCache.get(key);
  };

  for (const entry of queue) {
    const letter = letterById.get(entry.letterId);
    const candidates = entry.feasibleCourierIds.filter((courierId) => {
      const courier = state.couriers.find((item) => item.id === courierId);
      const lane = lanes.get(courierId);
      return lane.count < courier.maxLetters && round(lane.weight + letter.weight, 1) <= courier.capacity + 0.001;
    });

    if (candidates.length === 0) {
      skipped.push({
        letterId: letter.id,
        code: 'CAPACITY_EXHAUSTED',
        message: '可承运信使的载重或件数已满，今日无法装载。'
      });
      continue;
    }

    const chosen = candidates
      .map((courierId) => ({ courierId, arrival: directArrival(courierId, letter) }))
      .sort((first, second) => first.arrival - second.arrival || compareText(first.courierId, second.courierId))[0].courierId;
    const lane = lanes.get(chosen);
    assignments.push({
      letterId: letter.id,
      courierId: chosen,
      targetIslandId: letter.recipientIslandId,
      order: lane.count
    });
    lane.count += 1;
    lane.weight = round(lane.weight + letter.weight, 1);
  }

  return { assignments, skipped };
}

// ---------------------------------------------------------------------------
// 分拣队列：同一输入必然得到同一输出
//   - 不读取系统时钟、不使用随机数，一切由 state 决定
//   - 先按邮件 id 预排序，消除输入顺序影响
//   - 排序键为全序（分数 → 截止日 → 截止时 → 加急级 → id），不存在并列
// ---------------------------------------------------------------------------

export function computePriorityQueue(state) {
  const openLetters = getOpenLetters(state)
    .slice()
    .sort((first, second) => compareText(first.id, second.id));

  const activeOverrides = new Map(getActiveOverrides(state).map((event) => [event.letterId, event]));
  const queue = [];
  const exceptions = [];

  for (const letter of openLetters) {
    const couriers = feasibleCouriers(state, letter);
    const earliest = couriers.length ? estimateEarliestArrival(state, letter, couriers) : null;

    // 硬规则裁决先于一切覆盖：不可承运的邮件直接进入异常队列，
    // 即使存在覆盖事件也在这里被忽略（读取时的第二道防线）。
    if (!earliest) {
      exceptions.push({
        letterId: letter.id,
        code: 'NO_FEASIBLE_COURIER',
        message: `${letter.id} 重量 ${letter.weight} kg 超出所有信使载重，今日无法承运。`
      });
      continue;
    }

    const { baseScore, slackHours, breakdown } = scoreLetter(state, letter, earliest, couriers.length);
    const override = activeOverrides.get(letter.id) ?? null;
    const overrideDelta = override ? override.delta : 0;

    queue.push({
      letterId: letter.id,
      score: baseScore + overrideDelta,
      baseScore,
      overrideDelta,
      overridden: override !== null,
      overrideId: override?.id ?? null,
      deadlineFeasible: isDeadlineFeasible(state, letter, earliest.arrivalHour),
      slackHours,
      earliestArrivalHour: earliest.arrivalHour,
      bestCourierId: earliest.courierId,
      feasibleCourierIds: couriers.map((courier) => courier.id),
      breakdown
    });
  }

  const letterById = new Map(openLetters.map((letter) => [letter.id, letter]));

  // 全序平局裁决：截止日 → 截止时 → 加急级 → 邮件 id（唯一，保证总序）。
  const tieBreak = (firstLetterId, secondLetterId) => {
    const first = letterById.get(firstLetterId);
    const second = letterById.get(secondLetterId);
    return (
      first.deadlineDay - second.deadlineDay ||
      first.deadlineHour - second.deadlineHour ||
      second.urgency - first.urgency ||
      compareText(first.id, second.id)
    );
  };

  queue.sort((first, second) => (
    second.score - first.score ||
    tieBreak(first.letterId, second.letterId)
  ));

  queue.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  return {
    day: state.day,
    seed: state.seed,
    queue,
    exceptions,
    overrides: {
      active: getActiveOverrides(state),
      log: (state.priorityOverrides ?? []).map((event) => ({ ...event }))
    },
    suggestion: buildSuggestion(state, queue, letterById)
  };
}
