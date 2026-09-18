import { TYPE_LABELS } from './prompts.js';

/** 题型展示顺序：单选 → 多选 → 判断 → 填空 → 名词解释 → 简答 → 辨析 → 材料分析 → 论述 */
export const TYPE_ORDER = Object.keys(TYPE_LABELS);

/**
 * 按用户要求的题型与题量校验 / 裁剪 AI 生成的题目：
 * - 丢弃未要求的题型
 * - 超出要求的题量截断
 * - 数量不足的记为 shortfalls，交由调用方让 AI 补题后再次校验
 *
 * specs 为空（由 AI 自行设计题型）时不做数量校验，只原样返回。
 */
export function trimToSpecs(questions, specs) {
  const list = Array.isArray(questions) ? questions : [];
  if (!Array.isArray(specs) || !specs.length) {
    return { questions: list, shortfalls: [], removed: [] };
  }

  const want = new Map(specs.map((s) => [s.type, s.count]));
  const kept = [];
  const gotCount = new Map();
  const removedCount = new Map();

  for (const q of list) {
    const limit = want.get(q.type) || 0;
    const got = gotCount.get(q.type) || 0;
    if (got < limit) {
      kept.push(q);
      gotCount.set(q.type, got + 1);
    } else {
      removedCount.set(q.type, (removedCount.get(q.type) || 0) + 1);
    }
  }

  const shortfalls = [];
  for (const s of specs) {
    const got = gotCount.get(s.type) || 0;
    if (got < s.count) {
      shortfalls.push({ type: s.type, want: s.count, got, need: s.count - got, points: s.points });
    }
  }

  return {
    questions: kept,
    shortfalls,
    removed: [...removedCount.entries()].map(([type, count]) => ({ type, count })),
  };
}

/** 按固定题型顺序排列题目 */
export function sortByType(questions) {
  return [...questions].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
}

/** 排序后重新编号，保证 id 与试卷顺序一致 */
export function renumber(questions) {
  return questions.map((q, i) => ({ ...q, id: `q${i + 1}` }));
}

export function describeShortfalls(shortfalls) {
  return shortfalls.map((s) => `${TYPE_LABELS[s.type] || s.type} 需要 ${s.want} 道，实得 ${s.got} 道`).join('；');
}

export function describeRemoved(removed) {
  return removed.map((r) => `${TYPE_LABELS[r.type] || r.type} ${r.count} 道`).join('、');
}

/* ------------------------------ 与历史试卷的重复度 ------------------------------ */

/** 题干归一化：去掉空白与标点后再比较，避免格式差异影响判断 */
function normalizeStem(text) {
  return String(text || '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/** 3-gram 集合，用于估算两段文字的重合度 */
function grams(text) {
  const set = new Set();
  const s = normalizeStem(text);
  for (let i = 0; i + 3 <= s.length; i += 1) set.add(s.slice(i, i + 3));
  return set;
}

/** 两道题干的相似度（0~1）：完全相同或一方包含另一方时取高值 */
export function stemSimilarity(a, b) {
  const A = normalizeStem(a);
  const B = normalizeStem(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.includes(B) || B.includes(A)) return 0.9;

  const ga = grams(A);
  const gb = grams(B);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

/**
 * 统计新卷相对历史试卷的「不重复率」。
 * historyStems：历史题干数组；threshold：相似度达到多少算重复（默认 0.62）。
 */
export function duplicateStats(questions, historyStems, threshold = 0.62) {
  const list = Array.isArray(questions) ? questions : [];
  const hist = Array.isArray(historyStems) ? historyStems.filter(Boolean) : [];
  if (!list.length) return { total: 0, duplicated: 0, newRate: 100, hits: [] };
  if (!hist.length) return { total: list.length, duplicated: 0, newRate: 100, hits: [] };

  const histGrams = hist.map((h) => ({ raw: normalizeStem(h), set: grams(h) }));
  const hits = [];

  for (const q of list) {
    const stem = String(q?.stem || '').trim();
    if (!stem) continue;
    const stemGrams = grams(stem);
    const stemNorm = normalizeStem(stem);
    let best = 0;
    let bestHit = '';
    for (const h of histGrams) {
      if (!h.raw) continue;
      let score;
      if (stemNorm === h.raw) score = 1;
      else if (stemNorm.includes(h.raw) || h.raw.includes(stemNorm)) score = 0.9;
      else {
        let inter = 0;
        for (const g of stemGrams) if (h.set.has(g)) inter += 1;
        score = stemGrams.size + h.set.size - inter ? inter / (stemGrams.size + h.set.size - inter) : 0;
      }
      if (score > best) {
        best = score;
        bestHit = h.raw;
      }
    }
    if (best >= threshold) hits.push({ stem: stem.slice(0, 80), similarity: Number(best.toFixed(2)), hit: bestHit.slice(0, 80) });
  }

  const duplicated = hits.length;
  return {
    total: list.length,
    duplicated,
    newRate: Math.round(((list.length - duplicated) / list.length) * 100),
    hits: hits.slice(0, 10),
  };
}
