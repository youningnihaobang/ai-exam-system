/**
 * 复习排期核心（FSRS 风格近似实现）
 *
 * 纯函数、无外部依赖，便于单独验证：
 * - 评分归一化（四档 + 旧三档兼容）
 * - 可提取性 / 目标保留率 → 下次间隔
 * - 学习步与卡片状态机（分钟级）
 * - 掌握度、惰性字段补齐
 */

/* ------------------------------ 常量 ------------------------------ */

/** 四档评分 */
export const RATINGS = ['again', 'hard', 'good', 'easy'];

/** 旧三档评分 → 新四档（兼容既有客户端） */
export const LEGACY_RATINGS = { forgot: 'again', fuzzy: 'hard', known: 'good' };

export const RATING_LABELS = { again: '忘了', hard: '模糊', good: '记得', easy: '很轻松' };

/** 卡片状态 */
export const CARD_STATES = ['new', 'learning', 'review', 'relearning'];

/** 单张卡片的最大复习间隔（天） */
export const REVIEW_MAX_INTERVAL = 180;

const MAX_STABILITY = REVIEW_MAX_INTERVAL * 1.5;
const MIN_STABILITY = 0.4;

/** 学习步（分钟）：新卡 / 重学卡当天内的重复节奏 */
export const LEARNING_STEPS_MINUTES = [1, 10];

/** 复习日志上限 */
export const LOG_LIMIT = 50;

/** 顽固卡阈值：遗忘次数达到这个值，建议换一种记忆方式 */
export const LEECH_LAPSES = 4;

/** 目标保留率（默认 0.9）；取值范围 (0.7, 0.98) 开区间 */
export const DEFAULT_DESIRED_RETENTION = 0.9;
const RETENTION_MIN = 0.7;
const RETENTION_MAX = 0.98;

const DAY_MS = 86400000;
const MINUTE_MS = 60000;

/* ------------------------------ 日期工具（本地时区） ------------------------------ */

const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));

/** 本地时区的日期字符串 YYYY-MM-DD */
export function dayStr(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 在日期字符串上加减天数，返回日期字符串 */
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + Number(n || 0));
  return dayStr(d);
}

/** 某天 00:00（本地时区）对应的 ISO 时间戳 */
export function startOfDay(day) {
  return new Date(`${day}T00:00:00`).toISOString();
}

/* ------------------------------ 评分与保留率 ------------------------------ */

/** 归一化评分：非法值返回空字符串 */
export function normalizeRating(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (RATINGS.includes(v)) return v;
  return LEGACY_RATINGS[v] || '';
}

/** 目标保留率：非法 / 越界时回落默认值 */
export function resolveDesiredRetention(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= RETENTION_MIN || n >= RETENTION_MAX) return DEFAULT_DESIRED_RETENTION;
  return Number(n.toFixed(4));
}

/**
 * 可提取性：经过 elapsedDays 天、稳定度为 stability 时仍能想起的概率。
 * R(t, S) = (1 + t / 9S)^-1
 */
export function retentionAt(elapsedDays, stability) {
  const t = Math.max(0, Number(elapsedDays) || 0);
  const s = Math.max(0.1, Number(stability) || 1.2);
  return 1 / (1 + t / (9 * s));
}

/**
 * 目标保留率 r 下应安排的下次间隔（天）：由 R(t, S) = r 反解 t = 9S(1/r - 1)。
 * 默认 r = 0.9 时 t = S，与「间隔 ≈ 稳定度」的直觉一致。
 */
export function intervalFor(stability, desiredRetention = DEFAULT_DESIRED_RETENTION) {
  const s = clamp(stability, 0.1, MAX_STABILITY);
  const r = resolveDesiredRetention(desiredRetention);
  const days = 9 * s * (1 / r - 1);
  return Math.min(REVIEW_MAX_INTERVAL, Math.max(1, Math.round(days)));
}

/** 间隔下限保护：good / easy 不允许倒退（至少比上次略长），hard 允许持平 */
function boundedInterval(days, prevInterval, rating) {
  let n = Math.max(1, Math.round(Number(days) || 1));
  if (rating === 'good' || rating === 'easy') n = Math.max(n, Math.ceil((Number(prevInterval) || 0) * 1.05), 1);
  return Math.min(REVIEW_MAX_INTERVAL, n);
}

/* ------------------------------ 掌握度 ------------------------------ */

/**
 * 掌握度 0~100：连续记得 + 间隔长度 + 客观作答正确率，减去遗忘惩罚。
 * 没有任何客观作答记录时，客观分量记 0（不白送），使新卡从 0 起算。
 */
export function masteryOf(card) {
  const streak = card.streak || 0;
  const interval = card.interval || 0;
  const lapses = card.lapses || 0;
  const obj = card.objective || { checks: 0, correct: 0 };
  const checks = Number(obj.checks) || 0;
  const objRate = checks ? (Number(obj.correct) || 0) / checks : null;

  const base = Math.min(40, streak * 6);
  const span = Math.min(30, (Math.log2(Math.max(1, interval)) / Math.log2(REVIEW_MAX_INTERVAL)) * 30);
  const objective = objRate == null ? 0 : objRate * 30;
  const penalty = Math.min(25, lapses * 4);

  return Math.round(clamp(base + span + objective - penalty, 0, 100));
}

/* ------------------------------ 惰性字段补齐 ------------------------------ */

/** 卡片是否缺少新字段（用于判断是否需要落盘，避免每次读取都写文件） */
export function needsCardShape(card) {
  if (!card) return false;
  return (
    !CARD_STATES.includes(card.state) ||
    !Number.isFinite(Number(card.step)) ||
    !card.dueAt ||
    !Array.isArray(card.logs) ||
    !Number.isFinite(Number(card.lastElapsedDays))
  );
}

/**
 * 为历史卡片补齐新字段（原地修改），且不改动既有排期进度：
 * stability / difficulty / interval / streak / lapses / reviews 一律保留。
 */
export function ensureCardShape(card, now = new Date()) {
  if (!card) return card;
  if (!CARD_STATES.includes(card.state)) {
    card.state = (Number(card.reviews) || 0) > 0 ? 'review' : 'new';
  }
  if (!Number.isFinite(Number(card.step))) card.step = 0;
  if (!card.dueAt) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(card.due || '')) ? String(card.due) : dayStr(now);
    card.dueAt = startOfDay(day);
  }
  if (!Array.isArray(card.logs)) card.logs = [];
  if (!Number.isFinite(Number(card.lastElapsedDays))) card.lastElapsedDays = 0;
  return card;
}

/* ------------------------------ 排期 ------------------------------ */

/**
 * 计算一次复习后的排期结果（返回要写回的字段，不改动入参）。
 *
 * 关键点：先用「距上次复习的实际经过天数」估算当前保留率 R，
 * 再据此放大 / 收缩稳定度增长——逾期后仍能正确回忆说明记忆更牢，
 * 增长更快（间隔重复的 spacing effect）；提前复习则增长收缩。
 */
export function scheduleReview(card, ratingInput, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const rating = normalizeRating(ratingInput);
  if (!rating) throw new Error(`无效评分：${ratingInput}`);

  const desiredRetention = resolveDesiredRetention(options.desiredRetention);
  const c = ensureCardShape({ ...card }, now);

  const prevState = c.state;
  const inLearning = prevState === 'new' || prevState === 'learning' || prevState === 'relearning';
  const prevInterval = Number(c.interval) || 0;
  let step = Number(c.step) || 0;
  let stability = Number(c.stability) || Math.max(0.6, prevInterval || 1.2);
  let difficulty = Number(c.difficulty) || clamp(5 + (c.lapses || 0) * 0.6, 1, 10);
  let lapses = Number(c.lapses) || 0;

  const lastAt = c.lastReviewedAt ? new Date(c.lastReviewedAt) : null;
  const hasHistory = Boolean(lastAt && Number.isFinite(lastAt.getTime()));
  const elapsedDays = hasHistory ? Math.max(0, (now.getTime() - lastAt.getTime()) / DAY_MS) : 0;

  // 逾期校核：R 越低（越晚才复习）而仍然记得 → 增长越大；提前复习则收缩
  const retention = retentionAt(elapsedDays, stability);
  const growth = hasHistory && !inLearning ? clamp((1 - retention) / (1 - desiredRetention), 0.5, 2) : 1;

  if (rating === 'again') {
    difficulty += 0.8;
    stability *= 0.28;
  } else if (rating === 'hard') {
    difficulty += 0.15;
    stability *= 1 + 0.55 * (1 - difficulty / 10) * growth;
  } else if (rating === 'good') {
    difficulty -= 0.15;
    stability *= 1 + 1.8 * (1 - difficulty / 10) * growth;
  } else {
    difficulty -= 0.4;
    stability *= 1 + 3.0 * (1 - difficulty / 10) * growth;
  }
  difficulty = clamp(difficulty, 1, 10);
  stability = Number(clamp(stability, MIN_STABILITY, MAX_STABILITY).toFixed(2));

  let state;
  let interval;
  let dueAt;

  if (rating === 'again') {
    // 学习 / 重学中继续重来；已毕业的卡片回到重学
    state = prevState === 'new' || prevState === 'learning' ? 'learning' : 'relearning';
    step = 0;
    interval = 0;
    dueAt = new Date(now.getTime() + LEARNING_STEPS_MINUTES[0] * MINUTE_MS).toISOString();
    if (prevState === 'review' || prevState === 'relearning') lapses += 1;
  } else if (inLearning) {
    step += 1;
    if (step >= LEARNING_STEPS_MINUTES.length) {
      // 学习步走完 → 毕业，拿到以天为单位的间隔
      state = 'review';
      interval = boundedInterval(intervalFor(stability, desiredRetention), prevInterval, rating);
      dueAt = startOfDay(addDays(dayStr(now), interval));
    } else {
      state = prevState === 'relearning' ? 'relearning' : 'learning';
      interval = 0;
      dueAt = new Date(now.getTime() + LEARNING_STEPS_MINUTES[step] * MINUTE_MS).toISOString();
    }
  } else {
    state = 'review';
    interval = boundedInterval(intervalFor(stability, desiredRetention), prevInterval, rating);
    dueAt = startOfDay(addDays(dayStr(now), interval));
  }

  const at = now.toISOString();
  const next = {
    state,
    step,
    stability,
    difficulty,
    interval,
    dueAt,
    due: dayStr(new Date(dueAt)),
    ease: Number((2.6 - (difficulty - 5) * 0.15).toFixed(2)), // 兼容旧前端展示
    streak: rating === 'again' ? 0 : (c.streak || 0) + 1,
    lapses,
    reviews: (c.reviews || 0) + 1,
    lastResult: rating,
    lastReviewedAt: at,
    lastElapsedDays: Number(elapsedDays.toFixed(3)),
  };
  next.leech = next.lapses >= LEECH_LAPSES;
  next.logs = [
    ...(c.logs || []),
    {
      at,
      result: rating,
      elapsedDays: Number(elapsedDays.toFixed(2)),
      interval,
      stability,
      difficulty,
      state,
    },
  ].slice(-LOG_LIMIT);
  next.mastery = masteryOf({ ...c, ...next });
  return next;
}

/** 复习日志的保留率统计（无日志时 rate 为 null） */
export function retentionStats(cards) {
  let reviews = 0;
  let again = 0;
  let sampled = 0;
  for (const c of cards) {
    const logs = Array.isArray(c.logs) ? c.logs : [];
    if (!logs.length) continue;
    sampled += 1;
    reviews += logs.length;
    again += logs.filter((l) => l.result === 'again' || l.result === 'forgot').length;
  }
  return { reviews, again, sampled, rate: reviews ? Number((1 - again / reviews).toFixed(3)) : null };
}

/** 学习 / 重学中的卡片数 */
export const countLearning = (cards) => cards.filter((c) => c.state === 'learning' || c.state === 'relearning').length;
