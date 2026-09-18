const VALID_TYPES = [
  'single',
  'multiple',
  'judge',
  'blank',
  'term',
  'short',
  'discriminate',
  'material',
  'essay',
  'readcode',
  'fillcode',
  'debug',
  'code',
];

/** AI 偶尔会用中文名或别名写 type，这里做一次归一，避免整道题被丢弃 */
const TYPE_ALIAS = {
  单选: 'single',
  单选题: 'single',
  single_choice: 'single',
  choice: 'single',
  radio: 'single',
  多选: 'multiple',
  多选题: 'multiple',
  multiple_choice: 'multiple',
  checkbox: 'multiple',
  判断: 'judge',
  判断题: 'judge',
  true_false: 'judge',
  boolean: 'judge',
  填空: 'blank',
  填空题: 'blank',
  fill: 'blank',
  fill_blank: 'blank',
  名词解释: 'term',
  名词解释题: 'term',
  简答: 'short',
  简答题: 'short',
  short_answer: 'short',
  辨析: 'discriminate',
  辨析题: 'discriminate',
  材料: 'material',
  材料分析: 'material',
  材料分析题: 'material',
  论述: 'essay',
  论述题: 'essay',
  // 编程类题型常见别名
  程序阅读: 'readcode',
  程序阅读题: 'readcode',
  读程序: 'readcode',
  阅读程序: 'readcode',
  读程序写结果: 'readcode',
  写出运行结果: 'readcode',
  程序运行结果: 'readcode',
  read_code: 'readcode',
  程序填空: 'fillcode',
  程序填空题: 'fillcode',
  fill_code: 'fillcode',
  程序改错: 'debug',
  程序改错题: 'debug',
  改错: 'debug',
  改错题: 'debug',
  代码改错: 'debug',
  debug题: 'debug',
  编程: 'code',
  编程题: 'code',
  程序设计: 'code',
  程序设计题: 'code',
  写程序: 'code',
  编码题: 'code',
  coding: 'code',
  programming: 'code',
};

/** 解析题型：无法识别时返回 null（由调用方丢弃，避免被当成单选题混入统计） */
function resolveType(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (VALID_TYPES.includes(key)) return key;
  return TYPE_ALIAS[key] || TYPE_ALIAS[String(value ?? '').trim()] || null;
}

/** 需要交给 AI 评分的题型（主观题 / 编程题） */
const AI_TYPES = ['term', 'short', 'discriminate', 'material', 'essay', 'readcode', 'fillcode', 'debug', 'code'];

/** 编程类题型：题目带 language / code 字段 */
const CODE_TYPES = ['readcode', 'fillcode', 'debug', 'code'];

const OPTION_PREFIX = /^\s*[\(（]?[A-Ha-h][\)）\.、．:：]\s*/;

const TRUE_WORDS = ['正确', '对', '是', '√', '✓', 't', 'true', 'a', 'yes', 'y', '1'];
const FALSE_WORDS = ['错误', '错', '否', '×', '✗', 'x', 'f', 'false', 'b', 'no', 'n', '0'];

export function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => String(o ?? '').replace(OPTION_PREFIX, '').trim())
    .filter((o) => o.length > 0);
}

/** 全角转半角 + 去标点空白 + 小写，用于文本答案模糊比较 */
export function normalizeText(value) {
  let s = String(value ?? '');
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
  s = s.replace(/\s+/g, '');
  s = s.replace(/[()（）\[\]【】{}<>《》,.。，、;；:：'"“”‘’?!？！_—\-·\/\\]/g, '');
  return s.toLowerCase();
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value) && value.length) return toBool(value[0]);
  const s = normalizeText(value);
  if (TRUE_WORDS.includes(s)) return true;
  if (FALSE_WORDS.includes(s)) return false;
  return null;
}

function toLetters(value) {
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of arr) {
    const matches = String(item ?? '').toUpperCase().match(/[A-H]/g);
    if (matches) out.push(...matches);
  }
  return [...new Set(out)].sort();
}

/** 把 AI 或学生提供的答案整理成统一结构，便于比较与展示 */
export function normalizeAnswer(type, answer) {
  switch (type) {
    case 'single':
      return toLetters(answer)[0] || '';
    case 'multiple':
      return toLetters(answer);
    case 'judge':
      return toBool(answer);
    case 'blank': {
      const arr = Array.isArray(answer) ? answer : String(answer ?? '').split(/\s*[,，;；|]\s*/);
      return arr.map((a) => String(a ?? '').trim()).filter((a) => a !== '');
    }
    case 'fillcode': {
      // 程序填空：按空顺序的数组；代码答案不按逗号拆分，只按已有的数组结构保留
      const arr = Array.isArray(answer) ? answer : [String(answer ?? '')];
      return arr.map((a) => String(a ?? '').trim()).filter((a) => a !== '');
    }
    default:
      return Array.isArray(answer) ? answer.join('\n') : String(answer ?? '');
  }
}

/** 规范化整卷：补 id / 补齐字段 / 统一答案格式 */
export function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  const out = [];
  questions.forEach((q, index) => {
    if (!q || typeof q !== 'object') return;
    const type = resolveType(q.type);
    if (!type) return; // 题型无法识别：丢弃，避免污染题型与题量统计
    const stem = String(q.stem ?? '').trim();
    if (!stem) return;
    const code = CODE_TYPES.includes(type) ? String(q.code ?? '').trim() : '';
    out.push({
      id: `q${index + 1}`,
      type,
      stem,
      material: String(q.material ?? '').trim(),
      language: CODE_TYPES.includes(type) ? String(q.language ?? '').trim().toLowerCase() : '',
      code,
      // 程序填空的空数：优先取 answer 长度，其次数 code / stem 里的 ____
      ...(type === 'fillcode'
        ? {
            blankCount: Math.max(
              Array.isArray(q.answer) ? q.answer.filter((a) => String(a ?? '').trim()).length : 0,
              (String(code + ' ' + stem).match(/____/g) || []).length,
              1
            ),
          }
        : {}),
      options: type === 'single' || type === 'multiple' ? normalizeOptions(q.options) : [],
      answer: normalizeAnswer(type, q.answer),
      analysis: String(q.analysis ?? '').trim(),
      knowledge: String(q.knowledge ?? '').trim(),
      points: Number.isFinite(Number(q.points)) && Number(q.points) > 0 ? Number(q.points) : defaultPoints(type),
    });
  });
  // 保证 id 唯一
  const seen = new Set();
  return out.map((q, i) => {
    let id = q.id;
    while (seen.has(id)) id = `${id}_${i}`;
    seen.add(id);
    return { ...q, id };
  });
}

export function defaultPoints(type) {
  return {
    single: 3,
    multiple: 4,
    judge: 2,
    blank: 3,
    term: 4,
    short: 8,
    discriminate: 6,
    material: 12,
    essay: 15,
    readcode: 8,
    fillcode: 8,
    debug: 8,
    code: 15,
  }[type] || 3;
}

export function isBlankAnswer(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0 || value.every((v) => String(v ?? '').trim() === '');
  return String(value).trim() === '';
}

/**
 * 客观题本地判定。
 * 返回 null 表示需要交给 AI 评分（主观题）。
 */
export function judgeObjective(question, studentAnswer) {
  const { type, answer, points } = question;
  if (AI_TYPES.includes(type)) return null;

  if (isBlankAnswer(studentAnswer)) {
    return { correct: false, score: 0, reason: '未作答' };
  }

  const stu = normalizeAnswer(type, studentAnswer);

  if (type === 'single' || type === 'multiple') {
    const a = Array.isArray(answer) ? [...answer].sort() : String(answer || '');
    const b = Array.isArray(stu) ? [...stu].sort() : String(stu || '');
    const same = Array.isArray(a)
      ? a.length === b.length && a.every((x, i) => x === b[i])
      : normalizeText(a) === normalizeText(b);
    return { correct: same, score: same ? points : 0, reason: same ? '' : `正确答案为 ${formatAnswer(question)}` };
  }

  if (type === 'judge') {
    const same = stu !== null && stu === answer;
    return { correct: same, score: same ? points : 0, reason: same ? '' : `正确答案为 ${formatAnswer(question)}` };
  }

  // blank：逐空比较，允许同义/格式差异（忽略空白、大小写与标点）
  const expected = Array.isArray(answer) ? answer : [];
  const given = Array.isArray(stu) ? stu : [];
  let hit = 0;
  expected.forEach((ans, i) => {
    if (normalizeText(given[i]) === normalizeText(ans)) hit += 1;
  });
  const correct = expected.length > 0 && hit === expected.length;
  const score = expected.length ? Number(((points * hit) / expected.length).toFixed(2)) : 0;
  return {
    correct,
    score,
    reason: correct ? '' : `正确答案：${expected.join('；')}`,
  };
}

export function formatAnswer(question) {
  const { type, answer } = question;
  if (type === 'judge') return answer === true ? '正确' : '错误';
  if (Array.isArray(answer)) return answer.join('、');
  return String(answer ?? '');
}
