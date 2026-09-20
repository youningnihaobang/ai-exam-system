export const TYPE_LABELS = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  blank: '填空题',
  term: '名词解释题',
  short: '简答题',
  discriminate: '辨析题',
  material: '材料分析题',
  essay: '论述题',
  readcode: '程序阅读题',
  fillcode: '程序填空题',
  debug: '程序改错题',
  code: '编程题',
};

/** 需要 AI 评分的主观题 */
export const AI_TYPES = ['term', 'short', 'discriminate', 'material', 'essay', 'readcode', 'fillcode', 'debug', 'code'];

/** 编程类题型：题目带代码与语言，答案为代码或代码片段 */
export const CODE_TYPES = ['readcode', 'fillcode', 'debug', 'code'];

/** 题型说明，供命题与评卷 prompt 复用 */
export const TYPE_GUIDE = `single=单项选择题（只有一个正确选项）
multiple=多项选择题（至少两个正确选项）
judge=判断题（判断陈述对错）
blank=填空题（多空用 ____ 表示）
term=名词解释题（解释概念，答案写关键要点）
short=简答题（简明作答，答案含关键步骤/得分要点）
discriminate=辨析题（先判断说法正误，再说明理由）
material=材料分析题（提供一段材料，设问需结合材料分析；材料原文写在 material 字段）
essay=论述题（需展开论述，答案含论点、论据与结论要点）
readcode=程序阅读题（给出一段代码，写出运行结果或说明程序功能；代码写在 code 字段，language 标明语言）
fillcode=程序填空题（给出带空位的代码骨架，空位用 ____ 表示，考生补全代码；骨架写在 code 字段，answer 为按空顺序的数组）
debug=程序改错题（给出含错误的代码，指出错误并改正；代码写在 code 字段，answer 列出每处错误位置与改正写法）
code=编程题（按要求编写完整程序或函数；stem 写清输入输出要求，answer 为满足要求的参考代码，并附思路说明）`;

/** 题目 JSON 结构说明，多个 prompt 复用 */
export const QUESTION_SCHEMA = `{
  "type": "single | multiple | judge | blank | term | short | discriminate | material | essay | readcode | fillcode | debug | code",
  "stem": "题干文字（single/multiple 的题干不要包含选项；blank 用 ____ 表示空格；material 只写设问；编程类题型写清功能要求与输入输出约定）",
  "material": "材料原文，仅 material 题型需要；其他题型留空字符串",
  "language": "编程语言（如 c / cpp / java / python），仅 readcode / fillcode / debug / code 需要写；其他题型留空字符串",
  "code": "程序原文或代码骨架，仅编程类题型需要；fillcode 的空位用 ____ 表示；其他题型留空字符串",
  "options": ["选项内容1", "选项内容2"],  // 仅 single / multiple 需要，内容不要带 A. B. 之类的前缀
  "answer": "single 为单个大写字母如 B；multiple 为字母数组如 [\\"A\\",\\"C\\"]；judge 为 true(正确)/false(错误)；blank 为按空格顺序排列的答案数组如 [\\"6\\",\\"动能\\"]；fillcode 为按空顺序排列的补全代码数组如 [\\"int sum = 0;\\"]，数量与 ____ 个数一致；readcode 为程序运行结果（多行用 \\n 分隔）或功能说明；debug 为逐条列出「错误位置 + 原因 + 改正写法」；code 为满足要求的完整参考代码；term 为名词解释的关键要点；short 为参考答案（含关键步骤与得分要点）；discriminate 先写「正确」或「错误」再写理由；material 为结合材料的作答要点；essay 为论点、论据与结论要点",
  "analysis": "详细解析",
  "knowledge": "本题考查的知识点（不超过 12 字）",
  "points": 3
}`;

const ANALYZER_SYSTEM = `你是课程与考试设计专家，擅长从考试大纲中提炼科目、知识点与题型结构。
你只输出符合用户给定结构的合法 JSON，不要输出任何解释、注释或 Markdown 代码块。`;

const PROPOSER_SYSTEM = `你是一位经验丰富的命题专家，精通各学段各科目的课程标准与考试命题。
你只输出符合用户给定结构的合法 JSON，不要输出任何解释、注释或 Markdown 代码块。
所有题目必须表述严谨、答案唯一明确、解析充分。`;

const REAL_EXAM_SYSTEM = `你是考试研究专家，擅长检索并归纳历年真题的考点分布与命题风格（提问方式、设问角度、措辞习惯）。
你可以使用 WebSearch / WebFetch 工具联网检索真实的历年真题与考点分析资料。
你只输出符合用户给定结构的合法 JSON，不要输出任何解释、注释或 Markdown 代码块。
检索不到可靠资料时如实说明，绝不编造真题来源与年份。`;

/**
 * 生成「历年真题考点」提示词（需要联网，由 chatJSON 的 web 选项放开 WebSearch/WebFetch）
 */
export function buildRealExamPrompt({ subject, difficulty, years = '近 5 年', scope = '' }) {
  const user = `请联网检索并归纳「${subject}」的历年真题考点。
- 科目：${subject}
- 难度参考：${difficulty || '中等'}
- 年份范围：${years || '近 5 年'}
${scope ? `- 范围限定（大纲 / 章节 / 教材）：\n${String(scope).slice(0, 2000)}` : ''}

执行步骤：
1. 用 WebSearch 检索，例如「${subject} ${years || '近 5 年'} 真题 及答案」「${subject} 真题 考点分布 高频」（按科目实际情况选择考试类型：高考 / 中考 / 期末统考 / 考研 / 自学考试 / 计算机等级考试 / 期末测验等；编程类科目可加语言名，如「Python 程序设计 期末真题 编程题」）。
2. 用 WebFetch 打开其中 3~6 个最相关的页面，确认页面里确实有真题或考点分析后再采纳。
3. 归纳考点：按出现频次排序，标出考点出现的年份 / 套卷，并写清真题里的常见考法。
4. 归纳提问方式与设问角度（这是重点）：真题是怎么问的，而不只是考什么。要提炼出：
   - 题型搭配：哪些考点习惯用什么题型考（单选 / 多选 / 判断 / 填空 / 名词解释 / 简答 / 辨析 / 材料分析 / 论述）；
   - 设问角度：如「概念辨识」「原理应用」「计算求解」「比较异同」「因果分析」「材料解读」「评价影响」「方案设计」等，并给出真题里的代表性问法；
   - 措辞习惯：真题题干的常用开头与指令词（如「下列说法正确的是」「结合材料说明」「简述并举例论证」「分析……的原因」）；
   - 干扰 / 陷阱设置：选择题常见错项套路、判断题常见偷换概念方式；
   - 作答要求：答案的组织方式与详略程度（如「要点式」「需列公式与步骤」「需联系实际」）。

输出 JSON：
{
  "examType": "如：高考全国甲卷 / 期末统考 / 考研",
  "sources": [{ "title": "页面标题", "url": "https://...", "year": "2023", "note": "页面包含什么真题或分析" }],
  "keyPoints": [
    { "point": "考点名称（不超过 12 字）", "frequency": "高 | 中 | 低", "years": ["2023", "2021"], "evidence": "真题中的典型考法（一句话）", "ask": "该考点在真题里的典型提问方式 / 设问角度（一句话，尽量贴近原题干措辞）" }
  ],
  "styleGuide": {
    "typeHabits": [{ "type": "single / multiple / judge / blank / term / short / discriminate / material / essay", "usage": "该题型通常考什么、占多大比重", "note": "真题里该题型的特点" }],
    "angles": [{ "angle": "设问角度名称（不超过 8 字）", "description": "这种角度怎么问、考什么能力", "exampleStem": "真题中的代表性问法（原样摘录或高度贴近原表述，不超过 60 字）" }],
    "wording": ["题干常用开头 / 指令词，如「下列说法正确的是」"],
    "traps": ["选择题干扰项套路或常见陷阱，如「把必要条件说成充分条件」"],
    "answerDemands": ["答案组织要求，如「分点作答、每点需配实例」"]
  },
  "summary": "历年真题考点分布概述（150 字以内；若未检索到，写清原因）"
}

要求：
1. 必须联网检索；sources 为真实可访问的 URL，3~8 条，检索不到就返回空数组，绝对不要编造 URL。
2. keyPoints 8~20 个，按频次「高 → 中 → 低」排序；检索结果与该科目无关或明显不可靠时返回空数组。
3. styleGuide 必须尽量填满：angles 4~8 条、typeHabits 3~6 条、wording 3~8 条、traps 2~5 条、answerDemands 2~5 条；只能来自检索到的真题，不得凭空编造，没把握就少写。
4. 只输出上述 JSON。`;

  return { system: REAL_EXAM_SYSTEM, user, temperature: 0.3 };
}

/**
 * 把「历年真题考点」渲染成命题 prompt 片段，并按比例划分重点。
 * realExam: { summary, sources[], keyPoints[], ratio（真题占比，默认 50） }
 */
export function buildRealExamSection(realExam, totalQuestions) {
  const points = (realExam?.keyPoints || []).filter((p) => String(p?.point || '').trim());
  if (!points.length) return '';

  const ratio = Math.min(90, Math.max(10, Number(realExam.ratio) || 50));
  const total = Number(totalQuestions) || 0;
  const pastCount = total ? Math.max(1, Math.round((total * ratio) / 100)) : 0;
  const otherCount = total ? Math.max(1, total - pastCount) : 0;

  const sources = (realExam.sources || [])
    .slice(0, 8)
    .map((s) => `- ${s.title || '未命名来源'}（${s.year || '年份未知'}）${s.url || ''}`)
    .join('\n');

  const pointLines = points
    .slice(0, 20)
    .map((p, i) => {
      const years = (p.years || []).filter(Boolean).join('/');
      return `${i + 1}. ${p.point}【频次 ${p.frequency || '未标注'}】${years ? `出现于 ${years}` : ''}${
        p.evidence ? ` · ${p.evidence}` : ''
      }${p.ask ? `\n   真题问法：${p.ask}` : ''}`;
    })
    .join('\n');

  return `
【历年真题考点（已联网检索）】
考试类型：${realExam.examType || '未标注'}
概述：${realExam.summary || '无'}
${sources ? `参考来源：\n${sources}` : '参考来源：未获取到可访问来源'}
高频考点：
${pointLines}
${buildStyleSection(realExam?.styleGuide)}

【重点分配要求（必须遵守）】
1. 全卷约 ${ratio}% 的题目${
    pastCount ? `（约 ${pastCount} 题）` : ''
  }必须考查上面「高频考点」中出现过的考点，并尽量贴近真题的考法、题型与难度。
2. 其余约 ${100 - ratio}% 的题目${
    otherCount ? `（约 ${otherCount} 题）` : ''
  }考查本学科 / 大纲要求范围内、真题中未出现或低频的知识点，保证覆盖面完整。
3. 真题考点若超出本学科 / 大纲要求范围，一律舍弃，不得为了贴合真题而超纲。
4. 每道题的 knowledge 字段要写明所考知识点，便于核对重点分配。`;
}

/** 把「真题提问方式与设问角度」渲染成命题 prompt 片段 */
function buildStyleSection(style) {
  if (!style || typeof style !== 'object') return '';

  const list = (arr, max, render) =>
    (Array.isArray(arr) ? arr : [])
      .map((x) => render(x))
      .filter(Boolean)
      .slice(0, max)
      .join('\n');

  const typeHabits = list(
    style.typeHabits,
    6,
    (t) => (t?.type ? `- ${t.type}：${[t.usage, t.note].filter(Boolean).join('；')}` : '')
  );
  const angles = list(
    style.angles,
    8,
    (a) =>
      a?.angle
        ? `- ${a.angle}：${a.description || ''}${a.exampleStem ? `\n   真题问法示例：${a.exampleStem}` : ''}`
        : ''
  );
  const wording = list(style.wording, 8, (w) => (w ? `- ${w}` : ''));
  const traps = list(style.traps, 5, (t) => (t ? `- ${t}` : ''));
  const demands = list(style.answerDemands, 5, (d) => (d ? `- ${d}` : ''));

  if (!typeHabits && !angles && !wording && !traps && !demands) return '';

  return `
【历年真题的提问方式与设问角度（必须模仿）】
${angles ? `常见设问角度与真题问法：\n${angles}` : ''}
${typeHabits ? `题型搭配习惯：\n${typeHabits}` : ''}
${wording ? `题干常用措辞 / 指令词（写 stem 时优先使用这些表达方式）：\n${wording}` : ''}
${traps ? `干扰项与陷阱设置（选择题、判断题按这些套路设置错项）：\n${traps}` : ''}
${demands ? `答案组织要求：\n${demands}` : ''}

【提问方式要求】
1. 题干的措辞、指令词、设问角度要向上面归纳的真题风格靠拢，让读者觉得「这就是这类考试的题」，而不只是知识点相同。
2. 同一考点尽量采用真题里出现过的那几种设问角度，不要整卷都是同一种问法（如全是「下列说法正确的是」）。
3. 可以借鉴真题问法与角度，但不得照抄原题题干与数据；数据、情境、材料要重新设计。`;
}

/**
 * 把用户上传的「历年真题原文」渲染成命题 prompt 片段（重点是学习提问方式）。
 * pastPaper: { text, files: [{ name, chars }], truncated, mode: 'style' | 'mix' }
 */
export function buildPastPaperSection(pastPaper, totalQuestions) {
  const text = String(pastPaper?.text || '').trim();
  if (!text) return '';

  const files = (pastPaper.files || []).filter((f) => f?.name);
  const total = Number(totalQuestions) || 0;
  const mix = pastPaper.mode === 'mix';
  const pastCount = mix && total ? Math.max(1, Math.round(total * 0.6)) : 0;

  return `
【历年真题原文（用户上传，用于学习提问方式）】
${files.length ? `真题来源：${files.map((f) => `${f.name}${f.chars ? `（${f.chars} 字）` : ''}`).join('、')}\n` : ''}真题原文共 ${text.length} 字${pastPaper.truncated ? '（内容过长，已截断）' : ''}

---- 历年真题原文开始 ----
${text}
---- 历年真题原文结束 ----

【真题学习要求（重点：学习提问方式）】
1. 先通读上面的真题，逐题分析它们的**提问方式**：题干怎么开头、用什么指令词、从哪个角度设问、选项如何设置、答案要求写到什么程度、各题型的分值配比如何。
2. 命题时模仿真题的提问方式与措辞习惯，让生成的题目「像这份真题」——像的不只是考点，而是问法：选择题的设问角度、填空题的表述方式、简答 / 论述题的作答要求都要向真题靠拢；同一考点不要反复使用同一种问法。
3. 严禁照抄真题的题干、选项、材料与数据：人名、数值、情境、材料必须重新设计；可以借鉴问法与角度，不得复制原题。
4. 真题中出现过的知识点优先考查${
    mix ? `，约 ${pastCount || '六成'} 道题围绕真题考过的考点展开` : ''
  }；若某道真题的考点超出本次大纲 / 科目范围，只借鉴它的问法，不考这些超纲内容。
5. 每道题的 knowledge 字段写明所考知识点，便于核对与真题的对应关系。`;
}

/**
 * 把「同科目历史试卷」渲染成避重 prompt 片段。
 * history: { papers, questions, lines }；newRate：要求的新题（不重复）占比，默认 40。
 */
export function buildHistorySection(history, totalQuestions, newRate = 40) {
  const lines = String(history?.lines || '').trim();
  if (!lines) return '';

  const rate = Math.min(100, Math.max(10, Number(newRate) || 40));
  const total = Number(totalQuestions) || 0;
  const newCount = total ? Math.max(1, Math.round((total * rate) / 100)) : 0;
  const reuseCount = total ? total - newCount : 0;

  return `
【历史试卷（同一科目已生成过的试卷，仅用于避重参考）】
${lines}

【避重要求（必须遵守）】
1. 全卷至少 ${rate}% 的题目${newCount ? `（约 ${newCount} 题）` : ''}必须是上面历史试卷中从未出现过的「新题」：知识点可以重复，但情境、数据、设问方式都要不同，不得换汤不换药。
2. 其余题目${reuseCount ? `（约 ${reuseCount} 题）` : ''}允许考查历史中出现过的知识点（保证重点覆盖），但必须更换数据、情境或问法，严禁与题干高度雷同或直接照抄。
3. 生成前先逐条比对上面的题干；只要与题干表达高度接近（含只改数字、只换选项顺序）就算重复，必须重写。`;
}

export function buildGeneratePrompt({ subject, difficulty, specs, notes, totalPoints, realExam, pastPaper, history, historyNewRate }) {
  const specLines = specs
    .map((s) => `- ${TYPE_LABELS[s.type] || s.type} ${s.count} 道，每题 ${s.points} 分`)
    .join('\n');
  const totalQuestions = specs.reduce((n, s) => n + (Number(s.count) || 0), 0);

  const user = `请生成一份试卷。
- 科目：${subject}
- 难度：${difficulty}
- 题型与题量（必须严格遵守题量）：
${specLines}
- 全卷总分目标：约 ${totalPoints} 分
- 附加要求：${notes || '无'}
${buildRealExamSection(realExam, totalQuestions)}
${buildPastPaperSection(pastPaper, totalQuestions)}
${buildHistorySection(history, totalQuestions, historyNewRate)}
输出 JSON 结构（严格遵守，questions 数组顺序为：单选 → 多选 → 判断 → 填空 → 名词解释 → 简答 → 辨析 → 材料分析 → 论述）：
{
  "title": "试卷标题（含科目与学段）",
  "duration": 建议考试用时（分钟，整数）,
  "coverage": ["已覆盖的知识点1", "已覆盖的知识点2"],
  "questions": [ ${QUESTION_SCHEMA} ]
}

题型定义：
${TYPE_GUIDE}

命题要求：
1. 题目内容必须符合该学段的知识范围与难度，不得超纲。
2. 每道题的 stem 必须完整、可独立作答；答案无歧义。
3. single 只有一个正确选项，multiple 至少两个正确选项，干扰项要有区分度。
4. judge 题的陈述必须明确为真或为假。
5. blank 题的空格数量与 answer 数组长度一致。
6. term 题选取该科目核心概念，answer 要列出解释时必须写到的关键要点。
7. short 题的 answer 要包含关键步骤和给分要点。
8. discriminate 题先给出一个似是而非的说法，answer 必须先明确判定「正确」或「错误」，再给出理由。
9. material 题的 material 字段写材料原文（150-300 字），stem 只写设问，answer 要列出结合材料分析的要点。
10. essay 题考查综合运用能力，answer 要给出论点、论据方向与结论要点，并按分值展开。
11. 编程类题目（readcode / fillcode / debug / code）：代码必须语法正确、逻辑自洽；同一份试卷使用同一种语言（以科目与大纲为准，如 C 语言、C++、Java、Python）；code 题的 stem 要写清函数签名或输入输出约定；readcode 的程序运行结果必须唯一确定；debug 题的错误数量与错误类型要明确（一般 2~4 处）。
12. analysis 要讲清楚思路，帮助考生订正。`;

  return { system: PROPOSER_SYSTEM, user, temperature: 0.4 };
}

export function buildOutlinePrompt({ subject, difficulty, outline, notes, specs, totalPoints, realExam, pastPaper, history, historyNewRate }) {
  const specLines = (specs || [])
    .map((s) => `- ${TYPE_LABELS[s.type] || s.type} ${s.count} 道，每题 ${s.points} 分`)
    .join('\n');
  const totalQuestions = (specs || []).reduce((n, s) => n + (Number(s.count) || 0), 0);

  const user = `请依据下面提供的【大纲 / 知识点 / 题型要求】原文，生成一份试卷。
- 科目：${subject}
- 难度：${difficulty}
${
  specLines
    ? `- 用户指定的题型与题量（优先满足；若与大纲明确要求冲突，以大纲为准）：
${specLines}
- 参考总分：约 ${totalPoints} 分`
    : '- 用户未指定题型题量：请你根据大纲篇幅与学段自行设计合理的题型结构与题量，建议 12~30 题、总分 100 分左右。'
}
- 附加要求：${notes || '无'}

【大纲 / 题型要求原文开始】
${outline}
【大纲 / 题型要求原文结束】
${buildRealExamSection(realExam, totalQuestions)}
${buildPastPaperSection(pastPaper, totalQuestions)}
${buildHistorySection(history, totalQuestions, historyNewRate)}
输出 JSON 结构（严格遵守）：
{
  "title": "试卷标题（含科目与学段）",
  "duration": 建议考试用时（分钟，整数）,
  "coverage": ["已覆盖的知识点/章节1", "已覆盖的知识点/章节2"],
  "questions": [ ${QUESTION_SCHEMA} ]
}

题型定义：
${TYPE_GUIDE}

命题要求：
1. 严格命题范围：只能考大纲原文中出现或可由其直接推导的知识点，严禁超纲；大纲未涉及的内容不要考。
2. 覆盖度优先：尽量覆盖大纲中列出的主要章节与知识点，重要知识点（大纲中反复出现、标注为重点/掌握/熟练的）优先命题，coverage 中列出本次实际覆盖到的知识点。
3. 若原文给出了题型、题量、分值、考试时长等要求，必须严格遵守；原文未给出时按第 2 条与学段常识自行设计。
4. 每道题 stem 必须完整可独立作答，答案唯一明确；解析要讲清思路，便于考后订正。
5. single 只有一个正确选项，multiple 至少两个正确选项，干扰项要有区分度。
6. judge 陈述必须明确为真或为假；blank 的空格数与 answer 数组长度一致。
7. term 选取科目核心概念，answer 列出必须写到的关键要点。
8. short 的 answer 含关键步骤与给分要点；discriminate 的 answer 先判「正确/错误」再给理由。
9. material 的 material 字段写材料原文（150-300 字），stem 只写设问；essay 的 answer 给出论点、论据方向与结论要点。
10. 编程类题目（readcode / fillcode / debug / code）：同一份试卷使用同一种语言（以大纲为准）；代码写在 code 字段并填 language；代码必须语法正确、逻辑自洽、结果唯一确定；fillcode 的 ____ 个数与 answer 数组长度一致；code 题的 stem 写清函数签名或输入输出约定。
11. 若大纲原文内容过少、不足以支撑命题，请基于科目与学段常识适当补充，但不得偏离大纲主题。`;

  return { system: PROPOSER_SYSTEM, user, temperature: 0.4 };
}

export function buildGradePrompt({ subject, objectiveBrief, subjectiveList }) {
  const user = `你是严格的阅卷老师。请为一份「${subject}」试卷的作答进行评卷。

【客观题已由系统自动判定】
${objectiveBrief || '（无）'}

【需要你评分的题目】
${
  subjectiveList.length
    ? subjectiveList
        .map(
          (q, i) => `第 ${i + 1} 题
- id: ${q.id}
- 题型: ${TYPE_LABELS[q.type] || q.type}
${q.material ? `- 材料: ${q.material}` : ''}
${q.language ? `- 编程语言: ${q.language}` : ''}
${q.code ? `- 题目代码:\n${q.code}` : ''}
- 题干: ${q.stem}
${(q.options || []).length ? `- 选项: ${q.options.map((o, j) => `${String.fromCharCode(65 + j)}. ${o}`).join('  ')}` : ''}
- 参考答案: ${JSON.stringify(q.answer)}
- 学生作答: ${q.studentAnswer === '' || q.studentAnswer == null ? '（未作答）' : JSON.stringify(q.studentAnswer)}
- 满分: ${q.points} 分`
        )
        .join('\n\n')
    : '（无）'
}

评分原则：按步骤/要点给分，可以给出 0.5 分粒度的小数分；完全未作答记 0 分。
各类题型细则：
- term（名词解释）：写到核心定义与关键要点即给分，缺要点扣分。
- short（简答）：按关键步骤/要点给分。
- discriminate（辨析）：先判断「正误」是否正确（占该小题约 1/3 分），再按理由的充分性给分；判断错误但理由中有正确成分可酌情给部分分。
- material（材料分析）：既要结合材料，又要答出对应知识点要点，只答理论不结合材料最多给一半分。
- essay（论述）：按论点完整性、论据充分性、逻辑结构给分，允许考生有合理的个人表述。
- readcode（程序阅读）：结果与标准答案一致（忽略空白差异）给满分；只答对部分输出/要点按比例给分。
- fillcode（程序填空）：逐空评判，写法等价、语义正确即给分（不要求与参考答案逐字相同）；每空分值平均分配。
- debug（程序改错）：按找出的错误处数给分；指出错误但未改正给一半，改正正确再给另一半。
- code（编程）：按「程序能否正确实现功能」给分：逻辑正确与输出符合要求为主（约 60%），语法正确性约 20%，边界/特殊情况处理与代码规范约 20%；变量名不同、写法等价不扣分；局部小错误（如某处边界错误）按比例扣分，不要一错全扣。

输出 JSON 结构：
{
  "subjective": [
    { "id": "题目 id", "score": 3.5, "correct": false, "comment": "得分点与失分点说明，并给出正确解法" }
  ],
  "summary": "本次作答的整体评价（120 字以内）",
  "weakPoints": ["薄弱知识点1", "薄弱知识点2"],
  "advice": "针对薄弱点的复习建议（120 字以内）"
}`;

  return { system: '你是严格的阅卷老师，只输出合法 JSON。', user, temperature: 0.2 };
}

export function buildExplainPrompt({ subject, question, studentAnswer }) {
  const user = `请讲解下面这道「${subject}」错题，帮助学生彻底弄懂并避免再错。

- 题型：${TYPE_LABELS[question.type] || question.type}
${question.material ? `- 材料：${question.material}` : ''}
- 题干：${question.stem}
${(question.options || []).length ? `- 选项：${question.options.map((o, j) => `${String.fromCharCode(65 + j)}. ${o}`).join('  ')}` : ''}
- 正确答案：${JSON.stringify(question.answer)}
- 学生作答：${studentAnswer === '' || studentAnswer == null ? '（未作答）' : JSON.stringify(studentAnswer)}
- 原解析：${question.analysis || '无'}

输出 JSON 结构：
{
  "idea": "解题思路，分步骤说明（每步一行）",
  "trap": "本题的易错点与学生错误原因",
  "remember": "必须记住的结论 / 公式 / 方法",
  "similar": ${QUESTION_SCHEMA}
}
其中 similar 是与原题考查同一知识点、但更换了数据或情境的巩固练习题。`;

  return { system: PROPOSER_SYSTEM, user, temperature: 0.4 };
}

/** 大纲分析：只识别「科目 + 题型题量结构」，不命题 */
export function buildAnalyzePrompt({ outline }) {
  const user = `请分析下面这份【考试大纲 / 知识点 / 题型要求】原文，判断它属于哪个科目，并给出合理的题型与题量建议。

【原文开始】
${outline}
【原文结束】

输出 JSON 结构（严格遵守，只输出 JSON）：
{
  "subject": "科目名称，如：高中数学、大学语文、计算机网络",
  "difficulty": "简单 | 中等 | 较难 | 竞赛",
  "duration": 建议考试用时（分钟，整数）,
  "totalPoints": 建议总分（整数，通常 100）,
  "specs": [
    { "type": "single", "count": 10, "points": 3 }
  ],
  "coverage": ["主要章节 / 知识点1", "主要章节 / 知识点2"],
  "notes": "原文中明确提出、但无法用题型题量表达的要求（如考试时长、开闭卷、重点章节、命题范围等）；没有则留空字符串"
}

题型只能取以下取值：
${TYPE_GUIDE}

要求：
1. subject 只写科目名称，不要包含学段、年级、学期等无关信息。
2. 若原文已明确给出题型、题量、分值，必须严格照填；未给出时按科目特点与大纲篇幅自行设计，建议 12~30 题、总分 100 分左右。
3. count 与 points 必须是正整数；各题型的 count × points 之和应接近 totalPoints。
4. coverage 列出大纲中的主要章节 / 知识点，不超过 20 个。
5. notes 只摘录原文里的硬性要求，不要自行发挥。`;

  return { system: ANALYZER_SYSTEM, user, temperature: 0.2 };
}

export function buildVariantPrompt({ subject, question, count }) {
  const user = `请基于原错题，生成 ${count} 道同类变式题，用于针对性强化训练。
- 科目：${subject}
${question.material ? `- 原材料：${question.material}` : ''}
${question.language ? `- 编程语言：${question.language}（变式题必须沿用同一语言）` : ''}
${question.code ? `- 原代码：\n${String(question.code).slice(0, 1500)}` : ''}
- 原错题：${question.stem}
- 原答案：${JSON.stringify(question.answer)}
- 知识点：${question.knowledge || '未标注'}

要求：与原错题考查同一知识点与同一题型（${TYPE_LABELS[question.type] || question.type}），更换数据或情境（编程类题型要重新设计代码，但功能复杂度与考点保持相当），难度相当或略高。

输出 JSON 结构：
{
  "questions": [ ${QUESTION_SCHEMA} ]
}`;

  return { system: PROPOSER_SYSTEM, user, temperature: 0.6 };
}

/* ------------------------------ 记忆效率相关 prompt ------------------------------ */

/** 简要题面（多个 prompt 复用） */
function questionBrief(question, subject) {
  const q = question || {};
  return `- 科目：${subject || '未标注'}
- 题型：${TYPE_LABELS[q.type] || q.type || '未标注'}
${q.material ? `- 材料：${String(q.material).slice(0, 300)}` : ''}
- 题干：${String(q.stem || '').slice(0, 400)}
- 参考答案：${JSON.stringify(q.answer ?? '')}${q.analysis ? `\n- 解析：${String(q.analysis).slice(0, 400)}` : ''}`;
}

/** 挖空回忆：把答案拆成「提示词 → 要点」若干组，用于主动回忆 */
export function buildClozePrompt({ subject, question }) {
  const user = `请把下面这道题的答案拆成 2~5 个记忆要点，用于「挖空回忆」式复习（只看提示词，自己补全要点）。
${questionBrief(question, subject)}

输出 JSON：
{
  "points": [
    { "hint": "提示词（不超过 8 字，能引导回忆但不要泄露答案）", "answer": "该要点必须写出的内容（不超过 40 字）" }
  ]
}

要求：
1. 要点覆盖得分关键，按重要性排序；数量不超过 5 个。
2. 提示词之间要有区分度，不能互相提示同一内容。
3. 不要复述题干，不要额外解释，只输出 JSON。`;
  return { system: PROPOSER_SYSTEM, user, temperature: 0.3 };
}

/** AI 助记：口诀 / 首字缩写 / 类比 */
export function buildMnemonicPrompt({ subject, question }) {
  const user = `请为下面这道题设计助记方案，帮助快速记住答案要点。
${questionBrief(question, subject)}

输出 JSON：
{
  "mnemonic": "一句话助记（口诀 / 顺口溜 / 首字缩写，尽量押韵、好念、好记）",
  "association": "生活化类比或联想场景，用一句话说明怎么把要点串起来",
  "keywords": ["必须记住的关键词1", "关键词2"]
}

要求：
1. 助记必须真的能对应答案要点，不要空洞口号。
2. keywords 2~5 个，每个不超过 8 字。
3. 不要复述题干与解析，只输出 JSON。`;
  return { system: PROPOSER_SYSTEM, user, temperature: 0.6 };
}

/** 费曼复述评分：让用户用自己的话讲一遍，按要点给分并指出遗漏 */
export function buildFeynmanPrompt({ subject, question, text }) {
  const user = `学生正在用自己的话复述下面这道题的答案（费曼学习法）。请按参考答案要点评分。
${questionBrief(question, subject)}
- 学生的复述：${String(text || '').slice(0, 1500)}

输出 JSON：
{
  "score": 0 到 100 的整数（覆盖参考答案要点的程度；表述不同但意思一致算对）,
  "hit": ["复述中答对的要点"],
  "missing": ["漏掉或说错的要点"],
  "comment": "一句话点评 + 补漏建议（60 字以内）"
}

要求：宁可严格也不要虚高；完全没有覆盖要点时 score 给 0~20。只输出 JSON。`;
  return { system: '你是严格的阅卷老师，只输出合法 JSON。', user, temperature: 0.2 };
}

/** 复习作答的快速判定（先判对错，不展开逐点评分） */
export function buildReviewCheckPrompt({ subject, question, studentAnswer }) {
  const user = `请判断学生的作答是否正确（用于复习卡片的客观校准）。
${questionBrief(question, subject)}
- 学生作答：${studentAnswer === '' || studentAnswer == null ? '（未作答）' : JSON.stringify(studentAnswer)}

输出 JSON：
{
  "correct": true 或 false,
  "score": 得分（数字，满分按题目分值，未给分值就按 0~1 的比例）,
  "comment": "一句话说明漏了什么 / 错在哪（40 字以内）"
}

要求：只判「是否达到得分要点」，不要求与参考答案逐字一致；同义表述算对。只输出 JSON。`;
  return { system: '你是严格的阅卷老师，只输出合法 JSON。', user, temperature: 0.2 };
}

/** 易混对比卡：从知识点清单里挑最容易混淆的组合，生成专项区分卡 */
export function buildConfusionPrompt({ subject, points }) {
  const list = (points || [])
    .slice(0, 40)
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n');

  const user = `以下是「${subject || '本次复习范围'}」的知识点清单，请找出其中最容易被混淆的 3~5 组，生成「易混对比卡」用于专项区分训练。

【知识点清单】
${list}

输出 JSON：
{
  "pairs": [
    {
      "a": "概念 A（必须是清单里的知识点）",
      "b": "概念 B（必须是清单里的知识点）",
      "front": "一句话设问，要求区分两者（如：A 与 B 的区别是什么？）",
      "back": "分条写出两者在 2~4 个维度上的区别，并各给一个典型例子",
      "tip": "一句话记忆提示，说明怎么一眼区分"
    }
  ]
}

要求：
1. 只挑真的容易混的（名称相近、含义相邻、常被当成同一件事），不要凑数；不足 3 组就有几组写几组。
2. a、b 必须来自上面的清单，不得新造知识点。
3. 只输出 JSON。`;
  return { system: PROPOSER_SYSTEM, user, temperature: 0.5 };
}

/** 错因归纳：把学生自述的错因归类，并给出针对性建议 */
export function buildWhyPrompt({ subject, question, text }) {
  const user = `学生在复习时记录了自己出错的原因，请归类并给出一条针对性建议。
${questionBrief(question, subject)}
- 学生自述：${String(text || '').slice(0, 500)}

错因类型只能取以下之一，必须原样使用（不要改写、不要新增类型）：
概念混淆 / 记忆不牢 / 审题遗漏 / 计算或推导失误 / 方法不熟 / 表达不到位 / 粗心

只输出一行合法 JSON，不要解释、不要 Markdown 代码块，字符串一律使用英文双引号：
{"type":"上面的类型之一","advice":"针对这个错因的一条具体复习建议（40 字以内）"}`;
  return { system: ANALYZER_SYSTEM, user, temperature: 0.2 };
}
