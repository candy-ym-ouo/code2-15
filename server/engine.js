export const GAME_VERSION = 1;
export const HUB_ID = 'skyport';

export const HUB_ISLAND = {
  id: 'skyport',
  code: 'SKY',
  name: '天枢邮港',
  subtitle: '中央调度港',
  position: { x: 50, y: 52 },
  color: '#54d7e8',
  trait: '所有信使从这里起航，并按方案顺序访问投递岛。'
};

export const ISLANDS = [
  {
    id: 'sun',
    code: 'SUN',
    name: '曦光岛',
    subtitle: '晨钟与温室',
    position: { x: 20, y: 26 },
    color: '#f6b84b',
    trait: '清晨雾层会使 9 点前抵达的航线额外耗时 0.25 小时。'
  },
  {
    id: 'gale',
    code: 'GAL',
    name: '风翎岛',
    subtitle: '风车与瞭望塔',
    position: { x: 79, y: 20 },
    color: '#70d6c5',
    trait: '岛际乱流使抵达这里的末段航速降低 12%。'
  },
  {
    id: 'mist',
    code: 'MST',
    name: '雾礁岛',
    subtitle: '灯港与档案馆',
    position: { x: 82, y: 74 },
    color: '#91a9df',
    trait: '低云让每封邮件额外消耗 0.35 小时。'
  },
  {
    id: 'forge',
    code: 'FRG',
    name: '铸炉岛',
    subtitle: '熔炉与齿轮城',
    position: { x: 24, y: 78 },
    color: '#ee806f',
    trait: '重型货物多，通常需要更大载重的信使。'
  }
];

export const COURIERS = [
  {
    id: 'zephyr',
    name: '风信子号',
    callSign: 'Z-01',
    capacity: 11,
    maxLetters: 5,
    baseSpeed: 82,
    color: '#54d7e8',
    description: '速度与载量均衡，适合分散路线。'
  },
  {
    id: 'atlas',
    name: '重峦号',
    callSign: 'A-07',
    capacity: 20,
    maxLetters: 4,
    baseSpeed: 62,
    color: '#ffc65c',
    description: '载重最高，但逆风和满载时速度损失明显。'
  },
  {
    id: 'comet',
    name: '彗尾号',
    callSign: 'C-12',
    capacity: 7,
    maxLetters: 3,
    baseSpeed: 97,
    color: '#f58bb9',
    description: '最快的加急艇，只适合少量轻邮件。'
  }
];

const RECIPIENT_IDS = ISLANDS.map((island) => island.id);
const WIND_NAMES = ['北风', '东北风', '东风', '东南风', '南风', '西南风', '西风', '西北风'];
const SENDERS = [
  '气象议会',
  '港口管理局',
  '钟楼合作社',
  '测绘公会',
  '糕点师行会',
  '浮空舰维修站',
  '植物园',
  '灯塔守卫队'
];
const SUBJECTS = {
  1: ['季节问候', '展览邀请', '种子交换目录', '例行港口简报', '旅店预订回函'],
  2: ['贸易合约修订', '设备采购回函', '航线测绘报告', '医疗物资清单', '邮路安全通报'],
  3: ['风塔核心维修函', '紧急医疗配给', '断链航线警报', '失踪飞艇协查', '堤坝抢险调度']
};

export class GameRuleError extends Error {
  constructor(message, issues = [], statusCode = 400) {
    super(message);
    this.name = 'GameRuleError';
    this.issues = issues;
    this.statusCode = statusCode;
  }
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRng(seed, day) {
  let value = hashString(`${seed}:${day}`);
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function round(value, precision = 1) {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function relationKey(firstId, secondId) {
  return [firstId, secondId].sort().join(':');
}

export function getIsland(state, islandId) {
  return state.islands.find((island) => island.id === islandId);
}

export function getCourier(state, courierId) {
  return state.couriers.find((courier) => courier.id === courierId);
}

export function getOpenLetters(state) {
  return state.letters.filter((letter) => letter.status === 'inbox' || letter.status === 'backlog');
}

export function generateWind(seed, day) {
  const rng = createRng(`${seed}:wind`, day);
  const directionIndex = Math.floor(rng() * WIND_NAMES.length);
  const strength = round(4 + rng() * 18, 1);
  return {
    directionIndex,
    direction: WIND_NAMES[directionIndex],
    angle: -90 + directionIndex * 45,
    strength,
    note: strength >= 17 ? '强风，顺风收益与逆风损失都很明显' : strength >= 11 ? '中强风，请考虑载重与航向' : '微风，重量对航速影响更明显'
  };
}

export function generateLettersForDay(seed, day) {
  const rng = createRng(`${seed}:letters`, day);
  const count = 5 + Math.floor(rng() * 3);
  const letters = [];
  const routeCandidates = RECIPIENT_IDS.flatMap((originId) => (
    RECIPIENT_IDS
      .filter((recipientId) => recipientId !== originId)
      .map((recipientId) => ({ originId, recipientId }))
  ));
  const routeOffset = Math.floor(rng() * routeCandidates.length);

  for (let index = 0; index < count; index += 1) {
    const route = routeCandidates[(routeOffset + index) % routeCandidates.length];
    const urgencyRoll = rng();
    const urgency = urgencyRoll < 0.23 ? 3 : urgencyRoll < 0.72 ? 2 : 1;
    const weight = round(0.5 + rng() * 5.7, 1);
    const deadlineHour = urgency === 3 ? 12 : urgency === 2 ? 18 : 22;
    const origin = ISLANDS.find((island) => island.id === route.originId);

    letters.push({
      id: `L${String(day).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`,
      day,
      originIslandId: route.originId,
      recipientIslandId: route.recipientId,
      sender: `${origin.name}${pick(rng, SENDERS)}`,
      subject: pick(rng, SUBJECTS[urgency]),
      weight,
      urgency,
      deadlineDay: day,
      deadlineHour,
      sealColor: urgency === 3 ? 'seal-red' : urgency === 2 ? 'seal-amber' : 'seal-blue',
      status: 'inbox',
      backlogSince: null,
      deliveredDay: null,
      deliveredTo: null,
      outcome: null
    });
  }

  return letters;
}

function buildInitialRelations() {
  const relations = {};
  const variation = {
    'gale:sun': 52,
    'mist:sun': 68,
    'forge:sun': 61,
    'gale:mist': 74,
    'forge:gale': 47,
    'forge:mist': 65
  };

  for (let firstIndex = 0; firstIndex < RECIPIENT_IDS.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < RECIPIENT_IDS.length; secondIndex += 1) {
      const key = relationKey(RECIPIENT_IDS[firstIndex], RECIPIENT_IDS[secondIndex]);
      relations[key] = variation[key] ?? 60;
    }
  }
  return relations;
}

export function createInitialState({ seed = Date.now(), days = 14 } = {}) {
  const normalizedSeed = String(seed);
  const normalizedDays = Number.isInteger(days) && days > 0 ? days : 14;
  const letters = generateLettersForDay(normalizedSeed, 1);
  const now = new Date().toISOString();

  return {
    version: GAME_VERSION,
    seed: normalizedSeed,
    day: 1,
    days: normalizedDays,
    phase: 'planning',
    reputation: 60,
    credits: 80,
    streak: 0,
    revision: 0,
    wind: generateWind(normalizedSeed, 1),
    islands: [structuredClone(HUB_ISLAND), ...structuredClone(ISLANDS)],
    couriers: structuredClone(COURIERS),
    relations: buildInitialRelations(),
    letters,
    priorityOverrides: [],
    history: [],
    lastReport: null,
    ending: null,
    createdAt: now,
    updatedAt: now
  };
}

export function normalizeAssignments(assignments = []) {
  if (!Array.isArray(assignments)) {
    throw new GameRuleError('调度方案必须是数组。');
  }

  return assignments.map((assignment, index) => {
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
      throw new GameRuleError(`第 ${index + 1} 项调度数据格式无效。`);
    }

    const rawOrder = assignment.order;
    const order = rawOrder === undefined || rawOrder === null ? index : Number(rawOrder);
    if (!Number.isFinite(order)) {
      throw new GameRuleError(`${assignment.letterId || `第 ${index + 1} 项`} 的航线顺序无效。`);
    }

    return {
      letterId: assignment.letterId,
      courierId: assignment.courierId,
      targetIslandId: assignment.targetIslandId,
      order
    };
  });
}

export function validateAssignmentPlan(state, rawAssignments = []) {
  const assignments = normalizeAssignments(rawAssignments);
  const issues = [];
  const seenLetters = new Set();
  const routes = new Map(state.couriers.map((courier) => [courier.id, []]));

  if (state.phase !== 'planning') {
    issues.push({ code: 'GAME_NOT_PLANNING', message: '本局已经结束，不能继续调度。' });
  }

  for (const assignment of assignments) {
    const letter = state.letters.find((item) => item.id === assignment.letterId);
    const courier = getCourier(state, assignment.courierId);
    const island = getIsland(state, assignment.targetIslandId);

    if (!letter) {
      issues.push({ code: 'LETTER_NOT_FOUND', message: `找不到邮件 ${assignment.letterId || '(空)'}。`, letterId: assignment.letterId });
      continue;
    }
    if (letter.status !== 'inbox' && letter.status !== 'backlog') {
      issues.push({ code: 'LETTER_NOT_OPEN', message: `${letter.id} 已不在待投递队列。`, letterId: letter.id });
    }
    if (seenLetters.has(letter.id)) {
      issues.push({ code: 'LETTER_DUPLICATE', message: `${letter.id} 被安排了多次。`, letterId: letter.id });
    }
    seenLetters.add(letter.id);

    if (!courier) {
      issues.push({ code: 'COURIER_NOT_FOUND', message: `找不到信使 ${assignment.courierId || '(空)'}。`, letterId: letter.id });
    }
    if (!island || island.id === HUB_ID) {
      issues.push({ code: 'TARGET_INVALID', message: `投递目标 ${assignment.targetIslandId || '(空)'} 无效。`, letterId: letter.id });
    }

    if (courier) {
      routes.get(courier.id).push({ ...assignment, letter });
    }
  }

  for (const courier of state.couriers) {
    const routeAssignments = routes.get(courier.id).sort((first, second) => first.order - second.order);
    const totalWeight = round(routeAssignments.reduce((sum, item) => sum + item.letter.weight, 0), 1);

    if (routeAssignments.length > courier.maxLetters) {
      issues.push({
        code: 'LETTER_LIMIT_EXCEEDED',
        message: `${courier.name} 最多携带 ${courier.maxLetters} 封，当前为 ${routeAssignments.length} 封。`,
        courierId: courier.id
      });
    }
    if (totalWeight > courier.capacity + 0.001) {
      issues.push({
        code: 'WEIGHT_LIMIT_EXCEEDED',
        message: `${courier.name} 载重上限 ${courier.capacity} kg，当前为 ${totalWeight} kg。`,
        courierId: courier.id
      });
    }
  }

  return { assignments, issues, routes };
}

function distanceBetween(first, second) {
  return Math.hypot(first.position.x - second.position.x, first.position.y - second.position.y) * 2.2;
}

// 单航段飞行模型：calculateRoute 与分拣优先级引擎共用，避免两套航速公式漂移。
export function computeLeg(state, courier, fromIsland, toIsland, totalWeight, departHour) {
  const loadRatio = totalWeight / courier.capacity;
  const legDistance = distanceBetween(fromIsland, toIsland);
  const bearing = Math.atan2(toIsland.position.y - fromIsland.position.y, toIsland.position.x - fromIsland.position.x) * 180 / Math.PI;
  const angleDifference = (bearing - state.wind.angle) * Math.PI / 180;
  const alignment = Math.cos(angleDifference);
  const windBoost = state.wind.strength * alignment * 0.78;
  let speed = courier.baseSpeed * (1 - 0.34 * loadRatio) + windBoost;
  if (toIsland.id === 'gale') speed *= 0.88;
  speed = clamp(speed, 24, 118);

  const weatherDelay = (toIsland.id === 'mist' ? 0.35 : 0) + (toIsland.id === 'sun' && departHour < 9 ? 0.25 : 0);
  const legHours = legDistance / speed + weatherDelay;

  return {
    arrivalHour: round(departHour + legHours, 2),
    legDistance,
    legHours,
    effectiveSpeed: speed,
    windAlignment: alignment,
    weatherDelay
  };
}

export function calculateRoute(state, courierId, routeAssignments = []) {
  const courier = getCourier(state, courierId);
  if (!courier) {
    throw new GameRuleError(`找不到信使 ${courierId}。`);
  }

  const sorted = [...routeAssignments].sort((first, second) => first.order - second.order);
  const totalWeight = round(sorted.reduce((sum, item) => sum + item.letter.weight, 0), 1);
  let current = getIsland(state, HUB_ID);
  let hour = 7;
  let distance = 0;

  const letters = sorted.map((assignment) => {
    const target = getIsland(state, assignment.targetIslandId);
    const leg = computeLeg(state, courier, current, target, totalWeight, hour);
    hour = leg.arrivalHour;
    distance = round(distance + leg.legDistance, 1);

    const late = state.day > assignment.letter.deadlineDay || hour > assignment.letter.deadlineHour;
    const wrong = assignment.targetIslandId !== assignment.letter.recipientIslandId;
    const outcome = wrong ? (late ? 'wrong-late' : 'wrong') : late ? 'late' : 'on-time';

    const result = {
      letterId: assignment.letter.id,
      targetIslandId: target.id,
      targetName: target.name,
      intendedIslandId: assignment.letter.recipientIslandId,
      intendedName: getIsland(state, assignment.letter.recipientIslandId).name,
      order: assignment.order,
      weight: assignment.letter.weight,
      urgency: assignment.letter.urgency,
      legDistance: round(leg.legDistance, 1),
      effectiveSpeed: round(leg.effectiveSpeed, 1),
      windAlignment: round(leg.windAlignment, 2),
      arrivalHour: hour,
      outcome,
      late,
      wrong,
      deadline: `第 ${assignment.letter.deadlineDay} 日 ${String(assignment.letter.deadlineHour).padStart(2, '0')}:00`
    };

    current = target;
    return result;
  });

  return {
    courierId: courier.id,
    courierName: courier.name,
    callSign: courier.callSign,
    color: courier.color,
    startHour: 7,
    endHour: letters.length ? letters.at(-1).arrivalHour : 7,
    totalWeight,
    capacity: courier.capacity,
    letterCount: letters.length,
    maxLetters: courier.maxLetters,
    totalDistance: distance,
    letters
  };
}

function emptyProjection() {
  return {
    reputationDelta: 0,
    creditsDelta: 0,
    onTime: 0,
    late: 0,
    wrong: 0,
    backlog: 0,
    relationChanges: []
  };
}

function collectPlanEffects(state, preparedRoutes, unassignedLetters) {
  const projection = emptyProjection();
  const relationMap = new Map();

  for (const route of preparedRoutes) {
    for (const result of route.letters) {
      const letter = state.letters.find((item) => item.id === result.letterId);
      const urgency = letter.urgency;
      const key = relationKey(letter.originIslandId, letter.recipientIslandId);
      const currentChange = relationMap.get(key) || {
        key,
        firstIslandId: key.split(':')[0],
        secondIslandId: key.split(':')[1],
        delta: 0,
        reasons: []
      };

      if (result.wrong) {
        projection.wrong += 1;
        projection.reputationDelta -= 2 + urgency;
        projection.creditsDelta -= urgency * 2;
        currentChange.delta -= 3 + urgency * 2;
        currentChange.reasons.push(`${letter.id} 误投至${result.targetName}`);
      } else if (result.late) {
        projection.late += 1;
        projection.reputationDelta -= 1;
        projection.creditsDelta += Math.max(1, 4 - urgency);
        currentChange.delta += 1;
        currentChange.reasons.push(`${letter.id} 逾时送达`);
      } else {
        projection.onTime += 1;
        projection.reputationDelta += urgency;
        projection.creditsDelta += urgency * 6;
        currentChange.delta += 1 + urgency;
        currentChange.reasons.push(`${letter.id} 准时送达`);
      }

      relationMap.set(key, currentChange);
    }
  }

  for (const letter of unassignedLetters) {
    if (letter.lastPenaltyDay === state.day) continue;
    projection.backlog += 1;
    projection.reputationDelta -= urgencyPenalty(letter.urgency);
    projection.creditsDelta -= letter.urgency;
  }

  projection.reputationDelta = round(
    clamp(state.reputation + projection.reputationDelta, 0, 100) - state.reputation,
    1
  );
  projection.creditsDelta = round(
    Math.max(0, state.credits + projection.creditsDelta) - state.credits,
    1
  );
  projection.relationChanges = [...relationMap.values()]
    .filter((change) => change.delta !== 0)
    .map((change) => {
      const requestedDelta = round(change.delta, 1);
      const currentValue = state.relations[change.key];
      const appliedDelta = round(clamp(currentValue + requestedDelta, -100, 100) - currentValue, 1);
      return {
        ...change,
        requestedDelta,
        delta: appliedDelta,
        firstIslandName: getIsland(state, change.firstIslandId).name,
        secondIslandName: getIsland(state, change.secondIslandId).name
      };
    });
  return projection;
}

function urgencyPenalty(urgency) {
  return urgency === 3 ? 2 : urgency === 2 ? 1.2 : 0.6;
}

export function previewPlan(state, rawAssignments = []) {
  const validation = validateAssignmentPlan(state, rawAssignments);
  const assignedIds = new Set(validation.assignments.map((assignment) => assignment.letterId));
  const unassignedLetters = getOpenLetters(state).filter((letter) => !assignedIds.has(letter.id));
  const preparedRoutes = validation.issues.length === 0
    ? state.couriers
        .map((courier) => calculateRoute(state, courier.id, validation.routes.get(courier.id)))
        .filter((route) => route.letterCount > 0)
    : [];
  const projection = preparedRoutes.length || !validation.issues.length
    ? collectPlanEffects(state, preparedRoutes, unassignedLetters)
    : emptyProjection();

  const warnings = [];
  if (unassignedLetters.length > 0) {
    warnings.push(`${unassignedLetters.length} 封邮件尚未安排，今日结算会记为积压并降低信誉。`);
  }
  for (const route of preparedRoutes) {
    const wrongCount = route.letters.filter((letter) => letter.wrong).length;
    const lateCount = route.letters.filter((letter) => letter.late).length;
    if (wrongCount) warnings.push(`${route.courierName} 有 ${wrongCount} 封误投，将损害岛屿关系。`);
    if (lateCount) warnings.push(`${route.courierName} 有 ${lateCount} 封预计逾时。`);
  }

  return {
    valid: validation.issues.length === 0,
    issues: validation.issues,
    warnings,
    routes: preparedRoutes,
    unassignedLetterIds: unassignedLetters.map((letter) => letter.id),
    projection
  };
}

export function advanceDay(state, rawAssignments = []) {
  const preview = previewPlan(state, rawAssignments);
  if (!preview.valid) {
    throw new GameRuleError('调度方案不合法，未进入结算。', preview.issues);
  }

  const beforeReputation = state.reputation;
  const beforeCredits = state.credits;
  const assignedIds = new Set(preview.routes.flatMap((route) => route.letters.map((letter) => letter.letterId)));
  const unassignedLetters = getOpenLetters(state).filter((letter) => !assignedIds.has(letter.id));
  const relationChanges = preview.projection.relationChanges;
  const generatedNextDay = state.day < state.days && state.reputation + preview.projection.reputationDelta > 0
    ? state.day + 1
    : null;

  for (const route of preview.routes) {
    for (const result of route.letters) {
      const letter = state.letters.find((item) => item.id === result.letterId);
      letter.status = 'delivered';
      letter.deliveredDay = state.day;
      letter.deliveredTo = result.targetIslandId;
      letter.outcome = result.outcome;
      letter.deliveryHour = result.arrivalHour;
    }
  }

  for (const letter of unassignedLetters) {
    if (letter.status === 'inbox') {
      letter.status = 'backlog';
      letter.backlogSince = state.day;
    }
    letter.lastPenaltyDay = state.day;
  }

  const appliedRelationChanges = relationChanges.map((change) => {
    const previousValue = state.relations[change.key];
    const nextValue = clamp(previousValue + change.delta, -100, 100);
    state.relations[change.key] = nextValue;
    return {
      ...change,
      requestedDelta: change.requestedDelta ?? change.delta,
      delta: round(nextValue - previousValue, 1)
    };
  });

  state.reputation = clamp(round(state.reputation + preview.projection.reputationDelta, 1), 0, 100);
  state.credits = Math.max(0, round(state.credits + preview.projection.creditsDelta, 1));

  const hadProblem = preview.projection.wrong > 0 || preview.projection.late > 0 || preview.projection.backlog > 0;
  state.streak = hadProblem ? 0 : state.streak + 1;

  const report = {
    day: state.day,
    reputationBefore: beforeReputation,
    reputationAfter: state.reputation,
    creditsBefore: beforeCredits,
    creditsAfter: state.credits,
    reputationDelta: round(state.reputation - beforeReputation, 1),
    creditsDelta: round(state.credits - beforeCredits, 1),
    routes: preview.routes,
    unassignedLetterIds: unassignedLetters.map((letter) => letter.id),
    relationChanges: appliedRelationChanges,
    generatedNextDay,
    streak: state.streak
  };

  state.history.push({
    day: state.day,
    reputationDelta: report.reputationDelta,
    creditsDelta: report.creditsDelta,
    delivered: assignedIds.size,
    onTime: preview.projection.onTime,
    late: preview.projection.late,
    wrong: preview.projection.wrong,
    backlog: unassignedLetters.length
  });

  state.lastReport = report;

  if (state.reputation <= 0) {
    state.phase = 'failed';
    state.ending = {
      type: 'failed',
      title: '邮路停摆',
      message: '岛屿对邮政署的信任已经耗尽，议会暂停了所有航权。',
      rank: 'D'
    };
  } else if (state.day >= state.days) {
    const rank = state.reputation >= 85 ? 'S' : state.reputation >= 70 ? 'A' : state.reputation >= 50 ? 'B' : 'C';
    state.phase = 'completed';
    state.ending = {
      type: 'completed',
      title: rank === 'S' ? '天空邮路传奇' : '十四日航线完成',
      message: `你完成了 ${state.days} 日调度，最终信誉 ${state.reputation}。`,
      rank
    };
  } else {
    state.day += 1;
    state.wind = generateWind(state.seed, state.day);
    state.letters.push(...generateLettersForDay(state.seed, state.day));
    report.generatedNextDay = state.day;
  }

  state.revision = Number.isInteger(state.revision) ? state.revision + 1 : 1;
  state.updatedAt = new Date().toISOString();
  return report;
}

export function publicGameState(state) {
  return {
    ...state,
    openLetterCount: getOpenLetters(state).length,
    averageRelation: Object.keys(state.relations).length
      ? round(Object.values(state.relations).reduce((sum, value) => sum + value, 0) / Object.keys(state.relations).length, 1)
      : 0
  };
}
