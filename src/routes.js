import express from 'express';
import multer from 'multer';
import { aiProgress, aiStatus, chatJSON, currentModel, listModels, setActiveModel } from './ai.js';
import {
  buildAnalyzePrompt,
  buildExplainPrompt,
  buildGeneratePrompt,
  buildGradePrompt,
  buildOutlinePrompt,
  buildRealExamPrompt,
  buildVariantPrompt,
  TYPE_LABELS,
} from './prompts.js';
import { formatAnswer, isBlankAnswer, judgeObjective, normalizeQuestions } from './normalize.js';
import { MAX_FILES, MAX_FILE_BYTES, MAX_OUTLINE_CHARS, extractText, isAccepted } from './parse.js';
import { describeRemoved, describeShortfalls, duplicateStats, renumber, sortByType, trimToSpecs } from './validate.js';
import { enqueue, findActiveJob, getJob, jobView, queueSnapshot } from './queue.js';
import * as store from './store.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (!isAccepted(file.originalname)) {
      const err = new Error(`不支持的文件「${file.originalname}」，请上传 PDF / Word(.docx) / TXT`);
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------ 基础信息 ------------------------------ */

router.get(
  '/config',
  wrap((req, res) => {
    res.json({ ...aiStatus(), typeLabels: TYPE_LABELS });
  })
);

/** 当前 AI 任务的执行进度（用于前端展示「正在生成…已输出 N 字」） */
router.get(
  '/ai/progress',
  wrap((req, res) => {
    res.json(aiProgress());
  })
);

/** 可用模型列表（来自 CodeBuddy CLI / 账号），?refresh=1 强制重新拉取 */
router.get(
  '/models',
  wrap(async (req, res) => {
    const refresh = ['1', 'true', 'yes'].includes(String(req.query?.refresh || '').toLowerCase());
    const data = await listModels({ refresh });
    res.json({ ...data, current: currentModel(), envModel: aiStatus().envModel });
  })
);

/** 切换当前使用的模型（传空字符串恢复默认） */
router.post(
  '/ai/model',
  wrap(async (req, res) => {
    const id = String(req.body?.model || '').trim();
    setActiveModel(id);
    store.setSetting('model', id);
    console.log(`[models] 切换模型 → ${id || '默认（跟随环境）'}`);
    res.json(aiStatus());
  })
);

/* ------------------------------ 历年真题考点 ------------------------------ */

/** 解析「真题占比」：默认 50，限制在 10~90 */
function parseRatio(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 50;
  return Math.min(90, Math.max(10, n));
}

/** 解析「新题占比」：默认 40，限制在 10~100 */
function parseNewRate(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 40;
  return Math.min(100, Math.max(10, n));
}

/**
 * 取同科目已生成的历史试卷，用于命题时避重。
 * 返回 { papers, questions, lines, stems }；没有历史试卷时返回 null。
 */
function collectHistory({ subject, limit }) {
  const name = String(subject || '').trim().toLowerCase();
  if (!name) return null;

  const maxPapers = Math.min(10, Math.max(1, Number(limit) || 5));
  // addPaper 是 unshift，数组头部即最新试卷
  const same = store
    .getPapers()
    .filter((p) => String(p.subject || '').trim().toLowerCase() === name)
    .slice(0, maxPapers);
  if (!same.length) return null;

  const MAX_STEM = 90; // 单条题干截断长度，避免 prompt 过长
  const MAX_CHARS = 6000; // 历史片段总长度上限
  const stems = [];
  const blocks = [];
  let used = 0;

  for (const p of same) {
    const lines = [];
    for (const q of p.questions || []) {
      const stem = String(q?.stem || '').trim();
      if (!stem) continue;
      stems.push(stem);
      if (used >= MAX_CHARS) continue;
      const label = TYPE_LABELS[q.type] || q.type || '题';
      const line = `- ${label}：${stem.length > MAX_STEM ? `${stem.slice(0, MAX_STEM)}…` : stem}`;
      used += line.length;
      lines.push(line);
    }
    if (lines.length) {
      blocks.push(`第 ${blocks.length + 1} 份《${p.title}》（${(p.createdAt || '').slice(0, 10)}）共 ${(p.questions || []).length} 题：\n${lines.join('\n')}`);
    }
  }

  if (!blocks.length) return null;

  return {
    papers: same.length,
    questions: stems.length,
    lines: blocks.join('\n\n'),
    stems,
  };
}

/**
 * 联网检索历年真题考点。
 * 检索失败 / 无结果时降级（返回 ok:false + warning），不阻断命题。
 */
async function collectRealExam({ subject, difficulty, years, ratio, scope = '' }) {
  try {
    const { system, user, temperature } = buildRealExamPrompt({ subject, difficulty, years, scope });
    const data = await chatJSON({ system, user, temperature, maxTokens: 4096, label: '真题检索', web: true });

    const keyPoints = (Array.isArray(data?.keyPoints) ? data.keyPoints : [])
      .map((p) => ({
        point: String(p?.point || '').trim(),
        frequency: ['高', '中', '低'].includes(String(p?.frequency || '').trim())
          ? String(p.frequency).trim()
          : '中',
        years: Array.isArray(p?.years) ? p.years.map((y) => String(y)).filter(Boolean).slice(0, 8) : [],
        evidence: String(p?.evidence || '').trim().slice(0, 120),
        ask: String(p?.ask || '').trim().slice(0, 120),
      }))
      .filter((p) => p.point)
      .slice(0, 20);

    // 提问方式 / 设问角度：只做长度与条数限制，内容交给提示词约束
    const sg = data?.styleGuide && typeof data.styleGuide === 'object' ? data.styleGuide : null;
    const pick = (arr, max, len, keys) =>
      (Array.isArray(arr) ? arr : [])
        .map((x) => {
          if (typeof x === 'string') return String(x).trim().slice(0, len);
          const o = {};
          for (const k of keys) o[k] = String(x?.[k] || '').trim().slice(0, len);
          return keys.some((k) => o[k]) ? o : null;
        })
        .filter(Boolean)
        .slice(0, max);

    const styleGuide = sg
      ? {
          typeHabits: pick(sg.typeHabits, 6, 120, ['type', 'usage', 'note']),
          angles: pick(sg.angles, 8, 160, ['angle', 'description', 'exampleStem']),
          wording: pick(sg.wording, 8, 60, []).map((w) => (typeof w === 'string' ? w : String(w))),
          traps: pick(sg.traps, 5, 120, []).map((t) => (typeof t === 'string' ? t : String(t))),
          answerDemands: pick(sg.answerDemands, 5, 120, []).map((d) => (typeof d === 'string' ? d : String(d))),
        }
      : null;

    const sources = (Array.isArray(data?.sources) ? data.sources : [])
      .map((s) => ({
        title: String(s?.title || '').trim(),
        url: String(s?.url || '').trim(),
        year: String(s?.year || '').trim(),
        note: String(s?.note || '').trim().slice(0, 120),
      }))
      .filter((s) => s.url)
      .slice(0, 8);

    const result = {
      examType: String(data?.examType || '').trim(),
      summary: String(data?.summary || '').trim(),
      sources,
      keyPoints,
      ...(styleGuide ? { styleGuide } : {}),
      ratio,
      years: String(years || '').trim(),
      updatedAt: new Date().toISOString(),
    };

    if (!keyPoints.length) {
      return {
        ok: false,
        realExam: result,
        warning: '未检索到可用的历年真题考点，本次全部按大纲 / 科目范围命题',
      };
    }

    const styleCount = styleGuide
      ? (styleGuide.angles?.length || 0) + (styleGuide.typeHabits?.length || 0) + (styleGuide.wording?.length || 0)
      : 0;
    console.log(
      `[real-exam] ${subject} · 考点 ${keyPoints.length} 个 · 提问方式 ${styleCount} 条 · 来源 ${sources.length} 条 · ${
        result.examType || '未标注考试类型'
      }`
    );
    return { ok: true, realExam: result };
  } catch (err) {
    return { ok: false, warning: `历年真题检索失败（${err.message}），本次按大纲 / 科目范围命题` };
  }
}

/** 只检索历年真题考点，不命题（供前端预览 / 校验检索效果） */
router.post(
  '/real-exam/analyze',
  wrap(async (req, res) => {
    const subject = String(req.body?.subject || '').trim();
    if (!subject) throw httpError(400, '请填写科目');

    const years = String(req.body?.years || '').trim() || '近 5 年';
    const difficulty = String(req.body?.difficulty || '中等').trim();
    const scope = String(req.body?.scope || '').trim();

    const { ok, realExam, warning } = await collectRealExam({
      subject,
      difficulty,
      years,
      ratio: parseRatio(req.body?.ratio),
      scope,
    });

    res.json({ ok, realExam: realExam || null, warning: warning || '' });
  })
);

/* ------------------------------ 生成试卷 ------------------------------ */

router.post(
  '/papers',
  wrap(async (req, res) => {
    const { subject, difficulty, notes, specs } = req.body || {};
    if (!subject || !String(subject).trim()) throw httpError(400, '请填写科目');

    const cleanSpecs = cleanSpecList(specs);

    if (!cleanSpecs.length) throw httpError(400, '请至少选择一种题型并设置题量');

    const warnings = [];
    // 历年真题（用户提供原文）：命题时学习其提问方式
    const pastPaper = collectPastPaper(pastPaperArgs(req.body, String(subject).trim()));
    if (pastPaper) {
      console.log(
        `[past-paper] 参考历年真题 ${pastPaper.files.length} 份 · ${pastPaper.chars} 字 · 模式 ${
          pastPaper.mode === 'mix' ? '问法 + 考点' : '学习提问方式'
        }`
      );
      if (pastPaper.truncated) warnings.push(`历年真题原文过长，已截取前 ${MAX_PAST_CHARS} 字用于学习提问方式`);
    }

    // 先检索历年真题，再按「真题考点 : 大纲范围」的比例命题
    let realExam = null;
    if (req.body?.useRealExam) {
      const r = await collectRealExam({
        subject: String(subject).trim(),
        difficulty: difficulty || '中等',
        years: String(req.body?.realExamYears || '').trim() || '近 5 年',
        ratio: parseRatio(req.body?.realExamRatio),
      });
      if (r.ok) realExam = r.realExam;
      else warnings.push(r.warning);
    }

    // 参考同科目历史试卷：把已出过的题干交给 AI 做避重
    const historyNewRate = parseNewRate(req.body?.historyRatio);
    const history = req.body?.useHistory
      ? collectHistory({ subject: String(subject).trim(), limit: req.body?.historyLimit })
      : null;
    if (req.body?.useHistory && !history) warnings.push('该科目还没有历史试卷，本次未做避重比对');
    if (history) {
      console.log(`[history] 命题参考 ${history.papers} 份历史试卷 · ${history.questions} 道题 · 目标新题率 ${historyNewRate}%`);
    }

    // 出题交给 AI，这里只做格式校验：题型与题量必须与要求一致
    const { questions, data } = await generateWithSpecCheck({
      label: '命题',
      specs: cleanSpecs,
      build: (specList, extra) =>
        buildGeneratePrompt({
          subject: String(subject).trim(),
          difficulty: difficulty || '中等',
          specs: specList,
          notes: [notes ? String(notes).trim() : '', extra].filter(Boolean).join('；'),
          totalPoints: specList.reduce((sum, s) => sum + s.count * s.points, 0),
          realExam,
          pastPaper,
          history,
          historyNewRate,
        }),
    });
    if (!questions.length) throw httpError(500, 'AI 未返回有效题目，请调整要求后重试');

    const dup = history ? duplicateStats(questions, history.stems) : null;
    if (dup && dup.newRate < historyNewRate) {
      warnings.push(
        `新题率 ${dup.newRate}%（目标 ${historyNewRate}%）：约 ${dup.duplicated} 题与历史试卷高度相似，可再次生成或调高新题比例`
      );
    }

    const paper = {
      id: store.uid('paper'),
      title: data?.title || `${subject}模拟试卷`,
      subject: String(subject).trim(),
      difficulty: difficulty || '中等',
      duration: Number(data?.duration) || Math.max(30, questions.length * 3),
      questions,
      realExam: realExam
        ? {
            examType: realExam.examType,
            ratio: realExam.ratio,
            summary: realExam.summary,
            keyPoints: realExam.keyPoints,
            ...(realExam.styleGuide ? { styleGuide: realExam.styleGuide } : {}),
          }
        : null,
      history: dup
        ? { papers: history.papers, questions: history.questions, targetNewRate: historyNewRate, actualNewRate: dup.newRate }
        : null,
      pastPaper: pastPaperBrief(pastPaper),
      createdAt: new Date().toISOString(),
    };
    store.addPaper(paper);
    res.json({ paper: publicPaper(paper), realExam, pastPaper: pastPaperBrief(pastPaper), warnings, history: paper.history });
  })
);

/** 用 AI 分析大纲：识别科目、难度、题型与题量建议（只做格式校验，不改写内容） */
router.post(
  '/outline/analyze',
  upload.array('files', MAX_FILES),
  wrap(async (req, res) => {
    const manual = String(req.body?.outline || '').trim();
    const docs = [];
    const warnings = [];

    for (const f of req.files || []) {
      try {
        const text = await extractText(f);
        if (!text) {
          warnings.push(`「${f.originalname}」未能提取到文字，可能是扫描版 PDF，已跳过`);
          continue;
        }
        const saved = store.saveParsedDocument({ name: f.originalname, size: f.size, text, kind: 'outline' });
        docs.push({ name: f.originalname, size: f.size, text, docId: saved?.id || '' });
      } catch (err) {
        warnings.push(`「${f.originalname}」解析失败：${err.message}`);
      }
    }

    if (!docs.length && !manual) {
      throw httpError(400, warnings[0] || '请上传大纲文档，或在文本框中粘贴大纲内容');
    }

    const blocks = [];
    if (manual) blocks.push(`【粘贴的大纲 / 题型要求】\n${manual}`);
    for (const d of docs) blocks.push(`【文件：${d.name}】\n${d.text}`);

    let outlineText = blocks.join('\n\n');
    let truncated = false;
    if (outlineText.length > MAX_OUTLINE_CHARS) {
      outlineText = outlineText.slice(0, MAX_OUTLINE_CHARS);
      truncated = true;
      warnings.push(`大纲内容过长，已截取前 ${MAX_OUTLINE_CHARS} 字用于分析`);
    }

    const { system, user, temperature } = buildAnalyzePrompt({ outline: outlineText });
    const data = await chatJSON({ system, user, temperature, maxTokens: 2048, label: '大纲分析' });

    // 只保留合法题型与正整数题量，分值缺失时用默认分值
    const specs = cleanSpecList(data?.specs);
    if (!specs.length) throw httpError(500, 'AI 未能识别出题型结构，请手动设置题型或直接生成');

    const rawDifficulty = String(data?.difficulty || '').trim();
    const difficulty = ['简单', '中等', '较难', '竞赛'].includes(rawDifficulty) ? rawDifficulty : '中等';
    const totalPoints = specs.reduce((sum, s) => sum + s.count * s.points, 0);

    // 解析出的文档已在库里，这里补上 AI 识别到的科目，便于文档库按科目筛选
    const subjectName = String(data?.subject || '').trim();
    if (subjectName) for (const d of docs) if (d.docId) store.updateDocument(d.docId, { subject: subjectName });

    res.json({
      analysis: {
        subject: subjectName,
        difficulty,
        duration: Number(data?.duration) || 0,
        totalPoints,
        specs,
        coverage: Array.isArray(data?.coverage)
          ? data.coverage.map((c) => String(c)).filter(Boolean).slice(0, 20)
          : [],
        notes: String(data?.notes || '').trim(),
        truncated,
        chars: outlineText.length,
      },
      warnings,
    });
  })
);

/**
 * 上传文档后立即解析，返回字数与预览（不调用 AI）。
 * 解析出来的正文会存进「解析文档库」（documents 集合），返回 docId 供后续命题直接复用。
 * kind=past-paper 表示上传的是历年真题（默认 outline 大纲）。
 */
router.post(
  '/outline/preview',
  upload.array('files', MAX_FILES),
  wrap(async (req, res) => {
    const kind = req.body?.kind === 'past-paper' ? 'past-paper' : 'outline';
    const subject = String(req.body?.subject || '').trim();
    const files = [];
    for (const f of req.files || []) {
      try {
        const text = await extractText(f);
        const saved = text
          ? store.saveParsedDocument({ name: f.originalname, size: f.size, text, kind, subject })
          : null;
        files.push({
          name: f.originalname,
          size: f.size,
          chars: text.length,
          preview: text.slice(0, 300),
          ok: Boolean(text),
          docId: saved?.id || '',
          error: text ? '' : '未能提取到文字，可能是扫描版 PDF，请改用文本或 Word 文档',
        });
        if (saved) console.log(`[document] 已保存解析结果「${saved.name}」· ${saved.chars} 字 · ${kind}`);
      } catch (err) {
        files.push({ name: f.originalname, size: f.size, chars: 0, preview: '', ok: false, docId: '', error: err.message });
      }
    }
    res.json({ files });
  })
);

/** 依据大纲 / 文档生成试卷 */
router.post(
  '/papers/from-outline',
  upload.array('files', MAX_FILES),
  wrap(async (req, res) => {
    const { subject, difficulty, notes, outline } = req.body || {};
    if (!subject || !String(subject).trim()) throw httpError(400, '请填写科目');

    const manual = String(outline || '').trim();
    const docs = [];
    const warnings = [];

    for (const f of req.files || []) {
      try {
        const text = await extractText(f);
        if (!text) {
          warnings.push(`「${f.originalname}」未能提取到文字，可能是扫描版 PDF，已跳过`);
          continue;
        }
        // 解析结果落库，之后可复用 / 查看，不必重复上传
        const saved = store.saveParsedDocument({
          name: f.originalname,
          size: f.size,
          text,
          kind: 'outline',
          subject: String(subject).trim(),
        });
        docs.push({ name: f.originalname, size: f.size, text, docId: saved?.id || '' });
      } catch (err) {
        warnings.push(`「${f.originalname}」解析失败：${err.message}`);
      }
    }

    if (!docs.length && !manual) {
      throw httpError(400, warnings[0] || '请上传大纲文档，或在文本框中粘贴大纲内容');
    }

    // 历年真题：粘贴原文 + 已保存的真题解析文档，用于学习真题的提问方式
    const pastPaper = collectPastPaper(pastPaperArgs(req.body, String(subject).trim()));
    if (pastPaper) {
      console.log(
        `[past-paper] 参考历年真题 ${pastPaper.files.length} 份 · ${pastPaper.chars} 字${
          pastPaper.truncated ? `（原文 ${pastPaper.rawChars} 字，已截断）` : ''
        } · 模式 ${pastPaper.mode === 'mix' ? '问法 + 考点' : '学习提问方式'}`
      );
      if (pastPaper.truncated) warnings.push(`历年真题原文过长，已截取前 ${MAX_PAST_CHARS} 字用于学习提问方式`);
    }

    const blocks = [];
    if (manual) blocks.push(`【粘贴的大纲 / 题型要求】\n${manual}`);
    for (const d of docs) blocks.push(`【文件：${d.name}】\n${d.text}`);

    let outlineText = blocks.join('\n\n');
    let truncated = false;
    if (outlineText.length > MAX_OUTLINE_CHARS) {
      outlineText = outlineText.slice(0, MAX_OUTLINE_CHARS);
      truncated = true;
      warnings.push(`大纲内容过长，已截取前 ${MAX_OUTLINE_CHARS} 字用于命题`);
    }

    const specs = cleanSpecList(parseSpecsField(req.body?.specs));

    console.log(
      `[outline] 命题开始 · 科目 ${String(subject).trim()} · 大纲 ${outlineText.length} 字（文件 ${docs.length} 个）· 题型 ${
        specs.length ? specs.map((s) => `${TYPE_LABELS[s.type]}×${s.count}`).join('、') : '由 AI 设计'
      }`
    );

    // 先检索历年真题，再按「真题考点 : 大纲范围」的比例命题
    let realExam = null;
    if (req.body?.useRealExam) {
      const r = await collectRealExam({
        subject: String(subject).trim(),
        difficulty: difficulty || '中等',
        years: String(req.body?.realExamYears || '').trim() || '近 5 年',
        ratio: parseRatio(req.body?.realExamRatio),
        scope: outlineText.slice(0, 2000), // 让检索聚焦本大纲涉及的章节
      });
      if (r.ok) realExam = r.realExam;
      else warnings.push(r.warning);
    }

    const historyNewRate = parseNewRate(req.body?.historyRatio);
    const history = req.body?.useHistory
      ? collectHistory({ subject: String(subject).trim(), limit: req.body?.historyLimit })
      : null;
    if (req.body?.useHistory && !history) warnings.push('该科目还没有历史试卷，本次未做避重比对');
    if (history) {
      console.log(`[history] 大纲命题参考 ${history.papers} 份历史试卷 · ${history.questions} 道题 · 目标新题率 ${historyNewRate}%`);
    }

    // 出题交给 AI，这里只做格式校验：题型与题量必须与要求一致
    const { questions, data } = await generateWithSpecCheck({
      label: '大纲命题',
      specs,
      build: (specList, extra) =>
        buildOutlinePrompt({
          subject: String(subject).trim(),
          difficulty: difficulty || '中等',
          outline: outlineText,
          notes: [notes ? String(notes).trim() : '', extra].filter(Boolean).join('；'),
          specs: specList,
          totalPoints: specList.length ? specList.reduce((sum, s) => sum + s.count * s.points, 0) : 100,
          realExam,
          pastPaper,
          history,
          historyNewRate,
        }),
    });
    console.log(`[outline] 命题完成 · 得到 ${questions.length} 题 · 覆盖 ${(data?.coverage || []).length} 个知识点`);
    if (!questions.length) throw httpError(500, 'AI 未返回有效题目，请补充或精简大纲后重试');

    const dup = history ? duplicateStats(questions, history.stems) : null;
    if (dup && dup.newRate < historyNewRate) {
      warnings.push(
        `新题率 ${dup.newRate}%（目标 ${historyNewRate}%）：约 ${dup.duplicated} 题与历史试卷高度相似，可再次生成或调高新题比例`
      );
    }

    const paper = {
      id: store.uid('paper'),
      title: data?.title || `${String(subject).trim()}（大纲）模拟试卷`,
      subject: String(subject).trim(),
      difficulty: difficulty || '中等',
      duration: Number(data?.duration) || Math.max(30, questions.length * 3),
      questions,
      source: 'outline',
      outline: {
        files: docs.map((d) => ({ name: d.name, size: d.size, chars: d.text.length })),
        manualChars: manual.length,
        chars: outlineText.length,
        truncated,
        coverage: Array.isArray(data?.coverage)
          ? data.coverage.map((c) => String(c)).filter(Boolean).slice(0, 30)
          : [],
      },
      realExam: realExam
        ? {
            examType: realExam.examType,
            ratio: realExam.ratio,
            summary: realExam.summary,
            keyPoints: realExam.keyPoints,
            ...(realExam.styleGuide ? { styleGuide: realExam.styleGuide } : {}),
          }
        : null,
      history: dup
        ? { papers: history.papers, questions: history.questions, targetNewRate: historyNewRate, actualNewRate: dup.newRate }
        : null,
      pastPaper: pastPaperBrief(pastPaper),
      createdAt: new Date().toISOString(),
    };
    store.addPaper(paper);

    // 归档科目：本次解析的大纲、题型结构与真题考点一并入库，以后直接复用，不必重复解析
    const profile = archiveSubject({
      name: String(subject).trim(),
      difficulty: difficulty || '中等',
      notes: notes ? String(notes).trim() : '',
      outline: {
        text: outlineText,
        files: docs.map((d) => ({ name: d.name, size: d.size, chars: d.text.length })),
        manualChars: manual.length,
        chars: outlineText.length,
        truncated,
        coverage: paper.outline.coverage,
      },
      ...(specs.length
        ? {
            analysis: {
              specs,
              duration: paper.duration,
              totalPoints: specs.reduce((sum, s) => sum + s.count * s.points, 0),
            },
          }
        : {}),
      ...(realExam ? { realExam } : {}),
      // 历年真题原文一并归档，下次直接从科目库复用其提问方式
      ...(pastPaper
        ? {
            pastPaper: {
              text: pastPaper.fullText,
              files: pastPaper.files,
              chars: pastPaper.chars,
              rawChars: pastPaper.rawChars,
              mode: pastPaper.mode,
              docIds: pastPaper.docIds,
              updatedAt: new Date().toISOString(),
            },
          }
        : {}),
    });
    console.log(
      `[subject] 已归档「${profile.name}」· 大纲 ${outlineText.length} 字 · 真题考点 ${
        (realExam?.keyPoints || []).length
      } 个 · 历年真题 ${pastPaper?.chars || 0} 字`
    );

    res.json({
      paper: publicPaper(paper),
      realExam,
      subject: subjectSummary(profile),
      pastPaper: pastPaperBrief(pastPaper),
      meta: { truncated, coverage: paper.outline.coverage, files: paper.outline.files, warnings },
    });
  })
);

/* ------------------------------ 解析文档库 ------------------------------ */

/** 上传文档解析出来的正文（大纲 / 历年真题）都存在这里，可查看、复用与删除 */
router.get(
  '/documents',
  wrap((req, res) => {
    const kind = String(req.query?.kind || '').trim();
    const subject = String(req.query?.subject || '').trim().toLowerCase();
    const limit = req.query?.limit ? clampInt(req.query.limit, 1, 200) : 50;

    let list = store.getDocuments();
    if (kind) list = list.filter((d) => d.kind === kind);
    if (subject) list = list.filter((d) => String(d.subject || '').trim().toLowerCase() === subject);

    res.json({
      documents: list.slice(0, limit).map(store.documentSummary),
      total: list.length,
      chars: list.reduce((sum, d) => sum + (d.chars || 0), 0),
    });
  })
);

router.get(
  '/documents/:id',
  wrap((req, res) => {
    const doc = store.findDocument(req.params.id);
    if (!doc) throw httpError(404, '文档不存在或已删除');
    res.json({ document: { ...store.documentSummary(doc), text: doc.text } });
  })
);

router.delete(
  '/documents/:id',
  wrap((req, res) => {
    if (!store.findDocument(req.params.id)) throw httpError(404, '文档不存在或已删除');
    store.removeDocument(req.params.id);
    res.json({ ok: true });
  })
);

/* ------------------------------ 科目库 ------------------------------ */

/** 列表用的简要信息（不含大纲原文，避免列表请求过大） */
function subjectSummary(s) {
  return {
    id: s.id,
    name: s.name,
    difficulty: s.difficulty || '中等',
    notes: s.notes || '',
    outlineChars: s.outline?.text?.length || 0,
    outlineFiles: (s.outline?.files || []).length,
    coverage: (s.outline?.coverage || s.analysis?.coverage || []).slice(0, 30),
    specs: s.analysis?.specs || [],
    hasRealExam: Boolean((s.realExam?.keyPoints || []).length),
    pastPaperChars: s.pastPaper?.text?.length || 0,
    pastPaperFiles: (s.pastPaper?.files || []).length,
    pastPaperMode: s.pastPaper?.mode || 'style',
    examType: s.realExam?.examType || '',
    realExamRatio: s.realExam?.ratio || 50,
    realExamPoints: (s.realExam?.keyPoints || []).length,
    realExamYears: s.realExam?.years || '',
    useCount: s.useCount || 0,
    lastUsedAt: s.lastUsedAt || null,
    updatedAt: s.updatedAt,
    createdAt: s.createdAt,
  };
}

/** 写入 / 更新科目档案，只覆盖传入的字段 */
function archiveSubject(payload) {
  return store.upsertSubject({
    name: payload.name,
    ...(payload.difficulty ? { difficulty: payload.difficulty } : {}),
    ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
    ...(payload.outline ? { outline: payload.outline } : {}),
    ...(payload.analysis !== undefined ? { analysis: payload.analysis } : {}),
    ...(payload.realExam !== undefined ? { realExam: payload.realExam } : {}),
    ...(payload.pastPaper !== undefined ? { pastPaper: payload.pastPaper } : {}),
  });
}

router.get(
  '/subjects',
  wrap((req, res) => {
    res.json({ subjects: store.getSubjects().map(subjectSummary) });
  })
);

router.get(
  '/subjects/:id',
  wrap((req, res) => {
    const s = store.findSubject(req.params.id);
    if (!s) throw httpError(404, '科目档案不存在');
    res.json({
      subject: {
        ...subjectSummary(s),
        outline: s.outline?.text || '',
        realExam: s.realExam || null,
        pastPaper: s.pastPaper || null,
      },
    });
  })
);

/** 新建或更新科目档案（按科目名去重） */
router.post(
  '/subjects',
  wrap((req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) throw httpError(400, '请填写科目名称');

    const raw = req.body?.outline;
    const outline =
      raw === undefined
        ? undefined
        : {
            text: String(raw?.text || '').slice(0, MAX_OUTLINE_CHARS),
            files: Array.isArray(raw?.files)
              ? raw.files.slice(0, 8).map((f) => ({ name: String(f?.name || ''), size: Number(f?.size) || 0, chars: Number(f?.chars) || 0 }))
              : [],
            coverage: Array.isArray(raw?.coverage) ? raw.coverage.map(String).filter(Boolean).slice(0, 30) : [],
          };

    // 历年真题原文（可选）：随档案一起保存，之后可直接复用其提问方式
    const ppRaw = req.body?.pastPaper;
    const pastPaperText = String(ppRaw?.text || '').trim();
    const pastPaper = pastPaperText
      ? {
          text: pastPaperText.slice(0, MAX_OUTLINE_CHARS),
          files: Array.isArray(ppRaw?.files)
            ? ppRaw.files.slice(0, 8).map((f) => ({
                name: String(f?.name || ''),
                chars: Number(f?.chars) || 0,
                docId: String(f?.docId || ''),
              }))
            : [],
          mode: ppRaw?.mode === 'mix' ? 'mix' : 'style',
          updatedAt: new Date().toISOString(),
        }
      : undefined;

    const saved = archiveSubject({
      name,
      difficulty: String(req.body?.difficulty || '中等').trim(),
      notes: String(req.body?.notes || '').trim(),
      ...(outline ? { outline } : {}),
      ...(req.body?.analysis ? { analysis: req.body.analysis } : {}),
      ...(req.body?.realExam ? { realExam: req.body.realExam } : {}),
      ...(pastPaper ? { pastPaper } : {}),
    });

    res.json({ subject: subjectSummary(saved) });
  })
);

router.delete(
  '/subjects/:id',
  wrap((req, res) => {
    if (!store.findSubject(req.params.id)) throw httpError(404, '科目档案不存在');
    store.removeSubject(req.params.id);
    res.json({ ok: true });
  })
);

/**
 * 用科目档案命题：直接取库里的大纲与真题考点，不再上传 / 解析文档。
 * refreshRealExam=1 时重新联网检索真题，否则复用档案里已存考点。
 */
router.post(
  '/papers/from-subject',
  wrap(async (req, res) => {
    const profile = store.findSubject(req.body?.subjectId || req.body?.subject);
    if (!profile) throw httpError(404, '未找到该科目档案，请先解析大纲或保存科目');

    const name = String(req.body?.subject || profile.name).trim();
    const difficulty = String(req.body?.difficulty || profile.difficulty || '中等').trim();
    const outlineText = String(profile.outline?.text || '').trim();
    const specs = cleanSpecList(req.body?.specs);
    const focus = Array.isArray(req.body?.focusPoints)
      ? req.body.focusPoints.map((p) => String(p).trim()).filter(Boolean).slice(0, 30)
      : [];
    const warnings = [];

    if (!outlineText && !specs.length) {
      throw httpError(400, '该科目档案没有大纲内容，请指定题型与题量后再生成');
    }

    console.log(
      `[subject] 用档案命题 · ${name} · 大纲 ${outlineText.length} 字 · 真题考点 ${(profile.realExam?.keyPoints || []).length} 个 · 题型 ${
        specs.length ? specs.map((s) => `${TYPE_LABELS[s.type]}×${s.count}`).join('、') : '由 AI 设计'
      }`
    );

    // 真题考点：默认复用档案中已检索的（省一次联网）；显式要求时再检索
    const wantRefresh = Boolean(req.body?.refreshRealExam);
    const wantReal = Boolean(req.body?.useRealExam || wantRefresh);
    let realExam = wantReal && (profile.realExam?.keyPoints || []).length ? profile.realExam : null;
    if (wantReal && (wantRefresh || !realExam)) {
      const r = await collectRealExam({
        subject: name,
        difficulty,
        years: String(req.body?.realExamYears || '').trim() || '近 5 年',
        ratio: parseRatio(req.body?.realExamRatio ?? profile.realExam?.ratio),
        scope: outlineText.slice(0, 2000),
      });
      if (r.ok) realExam = r.realExam;
      else warnings.push(r.warning);
    }
    if (realExam && !wantRefresh && (profile.realExam?.keyPoints || []).length) {
      warnings.push('本次复用档案中已保存的历年真题考点，未重新联网检索');
    }

    const userNotes = String(req.body?.notes || '').trim();
    const notesText = [
      userNotes,
      focus.length ? `本次必须优先考查这些知识点：${focus.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('；');

    // 参考同科目历史试卷：把已出过的题干交给 AI 做避重
    const historyNewRate = parseNewRate(req.body?.historyRatio ?? profile.history?.targetNewRate);
    const history = req.body?.useHistory ? collectHistory({ subject: name, limit: req.body?.historyLimit }) : null;
    if (req.body?.useHistory && !history) warnings.push('该科目还没有历史试卷，本次未做避重比对');
    if (history) {
      console.log(`[history] 档案命题参考 ${history.papers} 份历史试卷 · ${history.questions} 道题 · 目标新题率 ${historyNewRate}%`);
    }

    // 历年真题：优先用本次上传 / 粘贴的；否则按开关复用档案里保存的真题原文
    const fromRequest = pastPaperArgs(req.body, name);
    let pastPaper = collectPastPaper(fromRequest);
    if (!pastPaper && req.body?.usePastPaper && profile.pastPaper?.text) {
      pastPaper = collectPastPaper({
        text: profile.pastPaper.text,
        mode: req.body?.pastPaperMode || profile.pastPaper.mode,
        name: '科目档案中的历年真题',
        subject: name,
      });
      if (pastPaper) warnings.push('本次复用科目档案中已保存的历年真题原文');
    }
    if (req.body?.usePastPaper && !pastPaper) {
      warnings.push('科目档案里还没有历年真题原文，可在「按大纲 / 文档」模式上传真题后保存');
    }
    if (pastPaper) {
      console.log(
        `[past-paper] 档案命题参考历年真题 ${pastPaper.files.length} 份 · ${pastPaper.chars} 字 · 模式 ${
          pastPaper.mode === 'mix' ? '问法 + 考点' : '学习提问方式'
        }`
      );
    }

    const build = (specList, extra) => {
      const mergedNotes = [notesText, extra].filter(Boolean).join('；');
      return outlineText
        ? buildOutlinePrompt({
            subject: name,
            difficulty,
            outline: outlineText,
            notes: mergedNotes,
            specs: specList,
            totalPoints: specList.length ? specList.reduce((sum, s) => sum + s.count * s.points, 0) : 100,
            realExam,
            pastPaper,
            history,
            historyNewRate,
          })
        : buildGeneratePrompt({
            subject: name,
            difficulty,
            specs: specList,
            notes: mergedNotes,
            totalPoints: specList.reduce((sum, s) => sum + s.count * s.points, 0),
            realExam,
            pastPaper,
            history,
            historyNewRate,
          });
    };

    const { questions, data } = await generateWithSpecCheck({
      label: '档案命题',
      specs,
      build,
    });
    console.log(`[subject] 命题完成 · 得到 ${questions.length} 题 · 覆盖 ${(data?.coverage || []).length} 个知识点`);
    if (!questions.length) throw httpError(500, 'AI 未返回有效题目，请调整要求后重试');

    const dup = history ? duplicateStats(questions, history.stems) : null;
    if (dup && dup.newRate < historyNewRate) {
      warnings.push(
        `新题率 ${dup.newRate}%（目标 ${historyNewRate}%）：约 ${dup.duplicated} 题与历史试卷高度相似，可再次生成或调高新题比例`
      );
    }

    const coverage = Array.isArray(data?.coverage) ? data.coverage.map((c) => String(c)).filter(Boolean).slice(0, 30) : [];
    const paper = {
      id: store.uid('paper'),
      title: data?.title || `${name}模拟试卷`,
      subject: name,
      difficulty,
      duration: Number(data?.duration) || Math.max(30, questions.length * 3),
      questions,
      source: 'subject',
      subjectId: profile.id,
      outline: outlineText
        ? {
            files: profile.outline?.files || [],
            chars: outlineText.length,
            coverage,
          }
        : { coverage },
      realExam: realExam
        ? {
            examType: realExam.examType,
            ratio: realExam.ratio,
            summary: realExam.summary,
            keyPoints: realExam.keyPoints,
            ...(realExam.styleGuide ? { styleGuide: realExam.styleGuide } : {}),
          }
        : null,
      history: dup
        ? { papers: history.papers, questions: history.questions, targetNewRate: historyNewRate, actualNewRate: dup.newRate }
        : null,
      pastPaper: pastPaperBrief(pastPaper),
      createdAt: new Date().toISOString(),
    };
    store.addPaper(paper);

    // 回写档案：更新使用次数、本次覆盖的知识点，必要时保存新检索的真题考点与本次上传的历年真题
    store.touchSubject(profile.id);
    const updated = archiveSubject({
      name: profile.name,
      ...(realExam ? { realExam } : {}),
      ...(coverage.length && profile.outline ? { outline: { ...profile.outline, coverage } } : {}),
      ...(pastPaper && fromRequest
        ? {
            pastPaper: {
              text: pastPaper.fullText,
              files: pastPaper.files,
              chars: pastPaper.chars,
              rawChars: pastPaper.rawChars,
              mode: pastPaper.mode,
              docIds: pastPaper.docIds,
              updatedAt: new Date().toISOString(),
            },
          }
        : {}),
    });

    res.json({
      paper: publicPaper(paper),
      realExam,
      subject: subjectSummary(updated || profile),
      pastPaper: pastPaperBrief(pastPaper),
      meta: { warnings, coverage, from: 'subject' },
    });
  })
);

router.get(
  '/papers',
  wrap((req, res) => {
    res.json({ papers: store.getPapers().map(summary) });
  })
);

router.get(
  '/papers/:id',
  wrap((req, res) => {
    const paper = store.findPaper(req.params.id);
    if (!paper) throw httpError(404, '试卷不存在');
    // mode=exam：隐藏答案与解析，用于答题
    const hide = req.query.mode === 'exam';
    res.json({ paper: hide ? examPaper(paper) : publicPaper(paper) });
  })
);

router.delete(
  '/papers/:id',
  wrap((req, res) => {
    if (!store.findPaper(req.params.id)) throw httpError(404, '试卷不存在');
    store.removePaper(req.params.id);
    res.json({ ok: true });
  })
);

/* ------------------------------ 评卷：后台排队，串行执行 ------------------------------ */

/**
 * 执行一次评卷：客观题本地判定，主观题 / 编程题交 AI，产出答卷并归档错题。
 * 只由队列调用（同一时刻只有一个评卷在跑），不直接响应请求。
 */
async function gradeSubmission({ paperId, answers, onProgress }) {
  const paper = store.findPaper(paperId);
  if (!paper) throw httpError(404, '试卷不存在');

    const details = [];
    const toAI = [];
    const objectiveBrief = [];

    for (const q of paper.questions) {
      const studentAnswer = answers[q.id];
      const local = judgeObjective(q, studentAnswer);
      if (local === null) {
        // 主观题 / 编程题：交给 AI
        toAI.push({
          id: q.id,
          type: q.type,
          stem: q.stem,
          material: q.material,
          language: q.language,
          code: q.code,
          options: q.options,
          answer: q.answer,
          studentAnswer: isBlankAnswer(studentAnswer) ? '' : studentAnswer,
          points: q.points,
        });
        continue;
      }
      // 填空题本地判错时，交给 AI 复核（避免同义答案被误判）；复核完成后再生成评卷明细
      if (q.type === 'blank' && !local.correct) {
        toAI.push({
          id: q.id,
          type: q.type,
          stem: q.stem,
          material: q.material,
          options: q.options,
          answer: q.answer,
          studentAnswer,
          points: q.points,
          localScore: local.score,
        });
        continue;
      }
      objectiveBrief.push(`- ${q.id}（${TYPE_LABELS[q.type]}，${q.points}分）：${local.correct ? '正确' : '错误'}`);
      details.push(makeDetail(q, studentAnswer, local));
    }

    let summary = '';
    let weakPoints = [];
    let advice = '';

    const { system, user, temperature } = buildGradePrompt({
      subject: paper.subject,
      objectiveBrief: objectiveBrief.join('\n') || '（无）',
      subjectiveList: toAI.map(({ localScore, ...rest }) => rest),
    });
    const graded = await chatJSON({ system, user, temperature, maxTokens: 4096, label: '评卷', onProgress });

    const aiMap = new Map();
    for (const item of Array.isArray(graded?.subjective) ? graded.subjective : []) {
      if (item && item.id) aiMap.set(String(item.id), item);
    }

    for (const q of toAI) {
      const ai = aiMap.get(q.id);
      const points = q.points;
      let score = 0;
      let comment = 'AI 未给出评分，按 0 分计';
      if (ai) {
        score = Math.max(0, Math.min(points, Number(ai.score) || 0));
        if (q.localScore != null) score = Math.max(score, Number(q.localScore) || 0);
        comment = String(ai.comment || '').trim() || comment;
      } else if (q.localScore != null) {
        score = Math.max(0, Math.min(points, Number(q.localScore) || 0));
        comment = 'AI 复核未返回结果，按系统判定计分';
      }
      const correct = score >= points;
      const full = paper.questions.find((x) => x.id === q.id);
      details.push({
        questionId: full.id,
        type: full.type,
        stem: full.stem,
        material: full.material,
        language: full.language,
        code: full.code,
        options: full.options,
        points,
        studentAnswer: q.studentAnswer ?? '',
        correctAnswer: full.answer,
        correctAnswerText: formatAnswer(full),
        isCorrect: correct,
        score,
        comment,
        analysis: full.analysis,
        knowledge: full.knowledge,
        byAI: true,
      });
    }

    // 保持题目原有顺序
    const order = new Map(paper.questions.map((q, i) => [q.id, i]));
    details.sort((a, b) => (order.get(a.questionId) ?? 0) - (order.get(b.questionId) ?? 0));

    summary = String(graded?.summary || '').trim();
    advice = String(graded?.advice || '').trim();
    weakPoints = Array.isArray(graded?.weakPoints) ? graded.weakPoints.map((w) => String(w)).filter(Boolean) : [];

    const totalScore = details.reduce((s, d) => s + d.points, 0);
    const earnedScore = Number(details.reduce((s, d) => s + d.score, 0).toFixed(2));
    const correctCount = details.filter((d) => d.isCorrect).length;

    const submission = {
      id: store.uid('sub'),
      paperId: paper.id,
      paperTitle: paper.title,
      subject: paper.subject,
      createdAt: new Date().toISOString(),
      totalScore,
      earnedScore,
      correctCount,
      questionCount: details.length,
      accuracy: details.length ? Number(((correctCount / details.length) * 100).toFixed(1)) : 0,
      summary,
      advice,
      weakPoints,
      details,
    };
    store.addSubmission(submission);

    // 错题本处理分两步：先处理做错的（入本 / 累计），再处理做对的（同题 + 同知识点标记为已掌握）
    const allMistakes = store.getMistakes();
    const newMistakes = [];
    const wrongIds = new Set(); // 本轮做错的题目，避免被「同知识点做对」连带掌握

    // 1) 做错的：入本 / 累计错误次数
    for (const d of details) {
      if (d.isCorrect) continue;
      wrongIds.add(d.questionId);
      const question = paper.questions.find((q) => q.id === d.questionId);
      const exist = allMistakes.find((m) => m.paperId === paper.id && m.questionId === d.questionId);
      if (exist) {
        exist.mastered = false; // 又做错了：即便之前已掌握，也要重新回到错题本
        exist.masteredAt = null;
        exist.masteredByKnowledge = null;
        exist.studentAnswer = d.studentAnswer;
        exist.lastWrongAt = submission.createdAt;
        exist.wrongTimes = (exist.wrongTimes || 1) + 1;
        store.save();
        continue;
      }
      newMistakes.push(
        store.addMistake({
          id: store.uid('mis'),
          paperId: paper.id,
          paperTitle: paper.title,
          submissionId: submission.id,
          questionId: d.questionId,
          subject: paper.subject,
          knowledge: d.knowledge || question?.knowledge || '', // 用于错题本按知识点分组
          question,
          studentAnswer: d.studentAnswer,
          comment: d.comment,
          explanation: null,
          variants: null,
          mastered: false,
          wrongTimes: 1,
          createdAt: submission.createdAt,
          lastWrongAt: submission.createdAt,
        })
      );
    }

    // 2) 做对的：同题错题 + 错题本里同知识点（且本轮没做错）的错题一并标记为已掌握
    const masteredMistakes = [];
    const masteredIds = new Set();
    for (const d of details) {
      if (!d.isCorrect) continue;
      const own = allMistakes.find(
        (m) => m.paperId === paper.id && m.questionId === d.questionId && !m.mastered
      );
      const hit = [];
      if (own) hit.push(own);
      if (d.knowledge) {
        for (const m of allMistakes) {
          if (m.mastered || m === own || masteredIds.has(m.id)) continue;
          // 本卷里这道题这次做错了，就不能因为同知识点别的题做对而算它掌握
          if (m.paperId === paper.id && wrongIds.has(m.questionId)) continue;
          if (sameKnowledge(m, d.knowledge)) hit.push(m);
        }
      }
      for (const m of hit) {
        if (masteredIds.has(m.id)) continue;
        masteredIds.add(m.id);
        m.mastered = true;
        m.masteredAt = submission.createdAt;
        m.masteredBySubmissionId = submission.id;
        if (m === own) m.studentAnswer = d.studentAnswer; // 记录这次做对的答案
        else m.masteredByKnowledge = d.knowledge; // 因同知识点的题做对而连带掌握
        masteredMistakes.push(m);
      }
      if (hit.length) {
        store.save();
        d.mistakeMastered = true; // 结果页据此提示「已消灭错题」
        d.knowledgeMastered = hit.length; // 本次因该知识点消灭的错题数
      }
    }

    if (masteredMistakes.length) {
      submission.masteredCount = masteredMistakes.length; // 本次消灭的错题数
      store.save();
    }

    return { submission, mistakes: newMistakes.length, mastered: masteredMistakes.length };
}

/**
 * 提交答卷：立即返回后台任务，评卷在服务端排队执行。
 * 同一份试卷已有未完成的评卷任务时直接复用，不会重复排队。
 */
router.post(
  '/papers/:id/grade',
  wrap((req, res) => {
    const paper = store.findPaper(req.params.id);
    if (!paper) throw httpError(404, '试卷不存在');
    const answers = (req.body && req.body.answers) || {};

    const active = findActiveJob({ type: 'grade', paperId: paper.id });
    if (active) return res.json({ job: jobView(active), duplicated: true });

    const job = enqueue({
      type: 'grade',
      label: `评卷：${paper.title}`,
      meta: { paperId: paper.id, paperTitle: paper.title, subject: paper.subject },
      run: (report) => gradeSubmission({ paperId: paper.id, answers, onProgress: report }),
    });
    console.log(`[grade] 已入队 · ${job.id} · ${paper.title}`);
    res.json({ job: jobView(job) });
  })
);

/** 查询后台任务进度；评卷完成后一并返回答卷 */
router.get(
  '/jobs/:id',
  wrap((req, res) => {
    const job = getJob(req.params.id);
    if (!job) throw httpError(404, '任务不存在或已过期');
    const view = jobView(job);
    if (job.status === 'done' && job.result) {
      const { submission, mistakes, mastered } = job.result;
      return res.json({ job: view, submission, mistakes, mastered });
    }
    res.json({ job: view });
  })
);

/** 队列概况：正在执行的任务与排队中的任务 */
router.get(
  '/jobs',
  wrap((req, res) => {
    res.json(queueSnapshot());
  })
);

router.get(
  '/submissions',
  wrap((req, res) => {
    let list = store.getSubmissions();
    if (req.query.paperId) list = list.filter((s) => s.paperId === req.query.paperId);
    res.json({ submissions: list.map((s) => ({ ...s, details: undefined })) });
  })
);

router.get(
  '/submissions/:id',
  wrap((req, res) => {
    const sub = store.findSubmission(req.params.id);
    if (!sub) throw httpError(404, '答卷不存在');
    res.json({ submission: sub });
  })
);

/* ------------------------------ 做题历史 ------------------------------ */

/** 做题历史总览：累计次数 / 最近做题时间与成绩 / 按科目与按试卷的统计 / 逐次记录 */
router.get(
  '/history',
  wrap((req, res) => {
    const subs = [...store.getSubmissions()].sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );

    const records = subs.slice(0, 500).map((s) => ({
      id: s.id,
      paperId: s.paperId,
      paperTitle: s.paperTitle,
      subject: s.subject,
      createdAt: s.createdAt,
      earnedScore: s.earnedScore,
      totalScore: s.totalScore,
      accuracy: s.accuracy,
      correctCount: s.correctCount,
      questionCount: s.questionCount,
    }));

    // 按科目汇总
    const subjectBuckets = new Map();
    for (const s of subs) {
      const key = String(s.subject || '').trim() || '未分类';
      let b = subjectBuckets.get(key);
      if (!b) {
        b = { subject: key, subs: [], paperIds: new Set() };
        subjectBuckets.set(key, b);
      }
      b.subs.push(s);
      if (s.paperId) b.paperIds.add(s.paperId);
    }
    const bySubject = [...subjectBuckets.values()]
      .map((b) => summarizeAttempts(b.subs, { subject: b.subject, papers: b.paperIds.size }))
      .sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));

    // 按试卷汇总
    const paperBuckets = new Map();
    for (const s of subs) {
      if (!s.paperId) continue;
      let b = paperBuckets.get(s.paperId);
      if (!b) {
        b = { subs: [], info: { paperId: s.paperId, title: s.paperTitle, subject: s.subject } };
        paperBuckets.set(s.paperId, b);
      }
      b.subs.push(s);
    }
    const byPaper = [...paperBuckets.values()]
      .map((b) => summarizeAttempts(b.subs, b.info))
      .sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));

    const last = subs[0] || null;
    const overview = {
      attempts: subs.length,
      papers: byPaper.length,
      subjects: bySubject.length,
      avgAccuracy: subs.length
        ? Number((subs.reduce((sum, s) => sum + (Number(s.accuracy) || 0), 0) / subs.length).toFixed(1))
        : 0,
      lastAt: last?.createdAt || null,
      lastScore: last ? last.earnedScore : null,
      lastTotalScore: last ? last.totalScore : null,
      lastAccuracy: last ? last.accuracy : null,
      lastPaperTitle: last?.paperTitle || '',
    };

    res.json({ overview, bySubject, byPaper, records });
  })
);

/* ------------------------------ 错题本 / 改错 ------------------------------ */

router.get(
  '/mistakes',
  wrap((req, res) => {
    let list = store.getMistakes();
    if (req.query.mastered === 'true') list = list.filter((m) => m.mastered);
    if (req.query.mastered === 'false') list = list.filter((m) => !m.mastered);
    // 老错题没有顶层 knowledge，从题目里补出来，供前端按知识点分组
    res.json({
      mistakes: list.map((m) => ({ ...m, knowledge: m.knowledge || m.question?.knowledge || '' })),
    });
  })
);

router.post(
  '/mistakes/:id/explain',
  wrap(async (req, res) => {
    const m = store.findMistake(req.params.id);
    if (!m) throw httpError(404, '错题不存在');
    if (m.explanation) return res.json({ mistake: m });

    const { system, user, temperature } = buildExplainPrompt({
      subject: m.subject,
      question: m.question,
      studentAnswer: m.studentAnswer,
    });
    const data = await chatJSON({ system, user, temperature, maxTokens: 2048, label: '错题讲解' });
    const similar = normalizeQuestions([data?.similar])[0] || null;
    m.explanation = {
      idea: String(data?.idea || '').trim(),
      trap: String(data?.trap || '').trim(),
      remember: String(data?.remember || '').trim(),
      similar,
    };
    store.save();
    res.json({ mistake: m });
  })
);

router.post(
  '/mistakes/:id/variants',
  wrap(async (req, res) => {
    const m = store.findMistake(req.params.id);
    if (!m) throw httpError(404, '错题不存在');
    const count = clampInt(req.body?.count, 1, 5) || 3;

    const { system, user, temperature } = buildVariantPrompt({
      subject: m.subject,
      question: m.question,
      count,
    });
    const data = await chatJSON({ system, user, temperature, maxTokens: 4096, label: '变式题' });
    // 变式题必须与原错题同题型，这里只做格式过滤
    const questions = normalizeQuestions(data?.questions)
      .filter((q) => !m.question?.type || q.type === m.question.type)
      .slice(0, count);
    if (!questions.length) throw httpError(500, 'AI 未生成变式题，请重试');

    m.variants = { questions, createdAt: new Date().toISOString(), result: null };
    store.save();
    res.json({ mistake: m });
  })
);

/** 批改变式题：与试卷评卷共用一条队列，避免并发调用模型 */
async function gradeVariants({ mistakeId, answers }) {
  const m = store.findMistake(mistakeId);
  if (!m) throw httpError(404, '错题不存在');
  if (!m.variants) throw httpError(400, '请先生成变式题');

    const toAI = [];
    const result = [];
    for (const q of m.variants.questions) {
      const local = judgeObjective(q, answers[q.id]);
      if (local === null || (q.type === 'blank' && local && !local.correct)) {
        toAI.push({
          id: q.id,
          type: q.type,
          stem: q.stem,
          material: q.material,
          language: q.language,
          code: q.code,
          options: q.options,
          answer: q.answer,
          studentAnswer: isBlankAnswer(answers[q.id]) ? '' : answers[q.id],
          points: q.points,
          localScore: local?.score,
        });
        continue;
      }
      result.push({
        questionId: q.id,
        type: q.type,
        stem: q.stem,
        material: q.material,
        language: q.language,
        code: q.code,
        options: q.options,
        points: q.points,
        studentAnswer: answers[q.id] ?? '',
        correctAnswer: q.answer,
        correctAnswerText: formatAnswer(q),
        isCorrect: local.correct,
        score: local.score,
        comment: local.reason || '',
        analysis: q.analysis,
        knowledge: q.knowledge,
      });
    }

    if (toAI.length) {
      const { system, user, temperature } = buildGradePrompt({
        subject: m.subject,
        objectiveBrief: '（无）',
        subjectiveList: toAI.map(({ localScore, ...rest }) => rest),
      });
      const graded = await chatJSON({ system, user, temperature, maxTokens: 2048, label: '变式题批改' });
      const aiMap = new Map(
        (Array.isArray(graded?.subjective) ? graded.subjective : []).map((x) => [String(x.id), x])
      );
      for (const q of toAI) {
        const ai = aiMap.get(q.id);
        let score = Math.max(0, Math.min(q.points, Number(ai?.score) || 0));
        if (q.localScore != null) score = Math.max(score, Number(q.localScore) || 0);
        const full = m.variants.questions.find((x) => x.id === q.id);
        result.push({
          questionId: q.id,
          type: full.type,
          stem: full.stem,
          material: full.material,
          options: full.options,
          points: full.points,
          studentAnswer: q.studentAnswer ?? '',
          correctAnswer: full.answer,
          correctAnswerText: formatAnswer(full),
          isCorrect: score >= full.points,
          score,
          comment: String(ai?.comment || '').trim(),
          analysis: full.analysis,
          knowledge: full.knowledge,
        });
      }
    }

    const order = new Map(m.variants.questions.map((q, i) => [q.id, i]));
    result.sort((a, b) => (order.get(a.questionId) ?? 0) - (order.get(b.questionId) ?? 0));

    const allCorrect = result.length > 0 && result.every((r) => r.isCorrect);
    m.variants.result = {
      items: result,
      createdAt: new Date().toISOString(),
      passed: allCorrect,
    };
    if (allCorrect) m.variants.passedOnce = true;
    store.save();
    return { mistake: m, passed: allCorrect };
}

router.post(
  '/mistakes/:id/variants/grade',
  wrap(async (req, res) => {
    const m = store.findMistake(req.params.id);
    if (!m) throw httpError(404, '错题不存在');
    const answers = (req.body && req.body.answers) || {};

    // 入队执行：请求会等到排队结束，但同一时刻只会有一个评卷 / 批改在跑
    const job = enqueue({
      type: 'variant-grade',
      label: '变式题批改',
      meta: { mistakeId: m.id },
      run: () => gradeVariants({ mistakeId: m.id, answers }),
    });
    await job.promise;
    if (job.status === 'error') throw httpError(500, job.error || '批改失败');
    res.json(job.result);
  })
);

router.patch(
  '/mistakes/:id',
  wrap((req, res) => {
    const m = store.findMistake(req.params.id);
    if (!m) throw httpError(404, '错题不存在');
    if (typeof req.body?.mastered === 'boolean') m.mastered = req.body.mastered;
    if (req.body?.clearVariants) m.variants = null;
    store.save();
    res.json({ mistake: m });
  })
);

router.delete(
  '/mistakes/:id',
  wrap((req, res) => {
    const idx = store.getMistakes().findIndex((m) => m.id === req.params.id);
    if (idx === -1) throw httpError(404, '错题不存在');
    store.getMistakes().splice(idx, 1);
    store.save();
    res.json({ ok: true });
  })
);

/* ------------------------------ 复习 / 闪卡（间隔重复） ------------------------------ */

const REVIEW_RESULTS = ['forgot', 'fuzzy', 'known'];
/** 单张卡片的最大复习间隔（天） */
const REVIEW_MAX_INTERVAL = 180;

/** 本地时区的日期字符串 YYYY-MM-DD */
function dayStr(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + Number(n || 0));
  return dayStr(d);
}

/** 简化版 SM-2：三档评分（忘了 / 模糊 / 记得）→ 下次到期日与间隔 */
function scheduleReview(card, result) {
  const today = dayStr();
  let { ease = 2.5, interval = 0, streak = 0, lapses = 0, reviews = 0 } = card;

  if (result === 'forgot') {
    ease = Math.max(1.3, Number((ease - 0.2).toFixed(2)));
    interval = 0; // 当天再来一遍
    streak = 0;
    lapses += 1;
  } else if (result === 'fuzzy') {
    ease = Math.max(1.3, Number((ease - 0.05).toFixed(2)));
    interval = interval < 1 ? 1 : Math.min(REVIEW_MAX_INTERVAL, Math.max(1, Math.round(interval * 1.2)));
    streak += 1;
  } else {
    streak += 1;
    if (interval < 1) interval = 1;
    else if (interval < 3) interval = 3;
    else interval = Math.min(REVIEW_MAX_INTERVAL, Math.round(interval * ease));
  }

  return {
    ease,
    interval,
    streak,
    lapses,
    reviews: reviews + 1,
    due: addDays(today, interval),
    lastResult: result,
    lastReviewedAt: new Date().toISOString(),
  };
}

/** 由错题生成闪卡正面（题干 + 选项）与背面（答案要点 + 记忆点） */
function cardFacesFrom(mistake) {
  const q = mistake.question || {};
  const knowledge = String(mistake.knowledge || q.knowledge || '').trim();
  const options = (q.options || []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`);
  const front = [String(q.stem || '').trim() || knowledge, ...options].filter(Boolean).join('\n');
  const remember = mistake.explanation?.remember ? `\n必须记住：${mistake.explanation.remember}` : '';
  return {
    front,
    back: `参考答案：${formatAnswer(q)}${remember}`,
    knowledge,
    type: q.type || '',
    detail: {
      options: q.options || [],
      material: q.material || '',
      language: q.language || '',
      code: q.code || '',
      points: q.points || 0,
      analysis: q.analysis || '',
      correctAnswer: q.answer,
      explanation: mistake.explanation || null,
    },
  };
}

/**
 * 复习卡片列表：?due=1 只返回今天该复习的（含逾期），?subject= 按科目过滤。
 * 同时给出统计，供前端显示「今日待复习 N 张」与科目分布。
 */
router.get(
  '/reviews',
  wrap((req, res) => {
    const subject = String(req.query?.subject || '').trim();
    const dueOnly = ['1', 'true', 'yes'].includes(String(req.query?.due || '').toLowerCase());
    const today = dayStr();

    const all = store
      .getReviews()
      .filter((c) => !subject || String(c.subject || '').trim() === subject);

    const stats = {
      total: all.length,
      due: all.filter((c) => String(c.due || today) <= today).length,
      learned: all.filter((c) => (c.streak || 0) >= 2).length,
      lapses: all.reduce((sum, c) => sum + (c.lapses || 0), 0),
      reviews: all.reduce((sum, c) => sum + (c.reviews || 0), 0),
      bySubject: [
        ...all
          .reduce((map, c) => {
            const name = String(c.subject || '').trim() || '未分类';
            const item = map.get(name) || { subject: name, count: 0, due: 0 };
            item.count += 1;
            if (String(c.due || today) <= today) item.due += 1;
            map.set(name, item);
            return map;
          }, new Map())
          .values(),
      ].sort((a, b) => b.due - a.due || b.count - a.count),
    };

    const cards = (dueOnly ? all.filter((c) => String(c.due || today) <= today) : all).sort((a, b) =>
      dueOnly
        ? String(a.due || '').localeCompare(String(b.due || '')) || (b.lapses || 0) - (a.lapses || 0)
        : String(a.due || '').localeCompare(String(b.due || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    );

    res.json({ cards: cards.slice(0, 500), stats });
  })
);

/** 把错题本里的错题同步成闪卡（同一道错题只保留一张卡片，排期不因同步重置） */
router.post(
  '/reviews/sync',
  wrap((req, res) => {
    const subject = String(req.body?.subject || '').trim();
    const today = dayStr();
    const now = new Date().toISOString();
    const list = store.getMistakes().filter((m) => !subject || String(m.subject || '').trim() === subject);

    let added = 0;
    let updated = 0;
    for (const m of list) {
      const faces = cardFacesFrom(m);
      if (!faces.front) continue;

      const exist = store.findReviewByMistake(m.id);
      if (exist) {
        if (exist.front !== faces.front || exist.back !== faces.back) {
          store.upsertReview(exist.id, { ...faces, subject: String(m.subject || '').trim(), updatedAt: now });
          updated += 1;
        }
        continue;
      }

      store.addReview({
        id: store.uid('rev'),
        source: 'mistake',
        mistakeId: m.id,
        paperId: m.paperId || '',
        paperTitle: m.paperTitle || '',
        questionId: m.questionId || '',
        subject: String(m.subject || '').trim(),
        ...faces,
        ease: 2.5,
        interval: 0,
        streak: 0,
        lapses: 0,
        reviews: 0,
        due: today,
        lastResult: '',
        lastReviewedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      added += 1;
    }

    store.save();
    console.log(`[review] 同步错题 → 新增 ${added} 张 · 更新 ${updated} 张 · 共 ${store.getReviews().length} 张`);
    res.json({ added, updated, total: store.getReviews().length });
  })
);

/** 提交一张卡片的复习结果（forgot / fuzzy / known），返回更新后的排期 */
router.post(
  '/reviews/:id/answer',
  wrap((req, res) => {
    const card = store.findReview(req.params.id);
    if (!card) throw httpError(404, '复习卡片不存在');

    const result = String(req.body?.result || '').trim();
    if (!REVIEW_RESULTS.includes(result)) throw httpError(400, '评分只能是 forgot / fuzzy / known');

    store.upsertReview(card.id, { ...scheduleReview(card, result), updatedAt: new Date().toISOString() });
    store.save();
    res.json({ card: { ...card } });
  })
);

router.delete(
  '/reviews/:id',
  wrap((req, res) => {
    if (!store.findReview(req.params.id)) throw httpError(404, '复习卡片不存在');
    store.removeReview(req.params.id);
    res.json({ ok: true });
  })
);

/* ------------------------------ 工具函数 ------------------------------ */

/** 拼进 prompt 的历年真题原文上限（字符），超出截断 */
const MAX_PAST_CHARS = 12000;

/** 表单 / JSON 里的 id 数组（可能是 JSON 字符串或逗号分隔） */
function parseIdsField(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim()).filter(Boolean);
  } catch {
    /* 退化为逗号分隔 */
  }
  return text.split(',').map((x) => x.trim()).filter(Boolean);
}

/** 把上传解析出的文档正文存进「解析文档库」，返回文档记录 */
function saveParsedDocs(docs, { kind = 'outline', subject = '' } = {}) {
  return (docs || [])
    .map((d) => store.saveParsedDocument({ name: d.name, size: d.size, text: d.text, kind, subject }))
    .filter(Boolean);
}

/**
 * 汇总本次使用的历年真题原文：粘贴的文本 + 已保存的解析文档（上传真题的解析结果）。
 * 返回 null 表示没有可用真题；prompt 用 text（可能截断），归档用 fullText。
 */
function collectPastPaper({ text, docIds, subject, mode, name } = {}) {
  const pasted = String(text || '').trim();
  const docs = parseIdsField(docIds)
    .map((id) => store.findDocument(id))
    .filter((d) => d && String(d.text || '').trim());

  const blocks = [];
  const files = [];
  if (pasted) {
    blocks.push(`【粘贴的历年真题】\n${pasted}`);
    files.push({ name: String(name || '').trim() || '粘贴的真题文本', chars: pasted.length, docId: '' });
  }
  for (const d of docs) {
    blocks.push(`【真题文件：${d.name}】\n${String(d.text).trim()}`);
    files.push({ name: d.name, chars: d.chars || String(d.text).length, docId: d.id });
    const nextSubject = subject ? String(subject).trim() : '';
    if (d.kind !== 'past-paper' || (nextSubject && d.subject !== nextSubject)) {
      store.updateDocument(d.id, { kind: 'past-paper', ...(nextSubject ? { subject: nextSubject } : {}) });
    }
  }
  if (!blocks.length) return null;

  const fullText = blocks.join('\n\n');
  const truncated = fullText.length > MAX_PAST_CHARS;
  return {
    text: truncated ? fullText.slice(0, MAX_PAST_CHARS) : fullText,
    fullText,
    files,
    chars: Math.min(fullText.length, MAX_PAST_CHARS),
    rawChars: fullText.length,
    truncated,
    mode: mode === 'mix' ? 'mix' : 'style',
    docIds: docs.map((d) => d.id),
  };
}

/** 写进试卷 / 科目档案的真题摘要（不含原文） */
function pastPaperBrief(pastPaper) {
  if (!pastPaper) return null;
  return {
    files: pastPaper.files,
    chars: pastPaper.chars,
    rawChars: pastPaper.rawChars,
    truncated: pastPaper.truncated,
    mode: pastPaper.mode,
    docIds: pastPaper.docIds,
  };
}

/** 把 form / json 里的真题参数解析成 collectPastPaper 入参 */
function pastPaperArgs(body, subject) {
  const use = Boolean(body?.usePastPaper ?? body?.pastPaperText ?? body?.pastDocIds);
  if (!use) return null;
  return {
    text: body?.pastPaperText,
    docIds: body?.pastDocIds ?? body?.pastPaperDocs,
    mode: body?.pastPaperMode,
    subject,
  };
}

function makeDetail(q, studentAnswer, local) {
  return {
    questionId: q.id,
    type: q.type,
    stem: q.stem,
    material: q.material,
    language: q.language,
    code: q.code,
    options: q.options,
    points: q.points,
    studentAnswer: studentAnswer ?? '',
    correctAnswer: q.answer,
    correctAnswerText: formatAnswer(q),
    isCorrect: local.correct,
    score: local.score,
    comment: local.reason || '',
    analysis: q.analysis,
    knowledge: q.knowledge,
    byAI: false,
  };
}

/** FormData 里的 specs 是 JSON 字符串，这里做容错解析 */
function parseSpecsField(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 生成题目并对「题型 + 题量」做格式校验（题目内容仍完全由 AI 生成）：
 * 1. 未要求的题型直接丢弃，超量部分截断 —— 本地确定性处理，不改写题面
 * 2. 数量不足时，让 AI 只补缺失的题型与题量，重试一次
 * 3. 仍不满足则抛出明确错误，绝不把题型/题量不符的卷子存下来
 *
 * build(specList, extraNote) 需返回 { system, user, temperature }
 */
async function generateWithSpecCheck({ build, specs, label }) {
  const call = async (specList, extraNote) => {
    const { system, user, temperature } = build(specList, extraNote);
    const data = await chatJSON({ system, user, temperature, maxTokens: 8192, label });
    return { data, questions: normalizeQuestions(data?.questions) };
  };

  const first = await call(specs, '');
  let result = trimToSpecs(first.questions, specs);

  // 未指定题型题量（由 AI 自行设计）时不做数量校验
  if (!specs.length) return { questions: renumber(sortByType(result.questions)), data: first.data };

  let hint = '';
  if (result.removed.length) {
    hint = `上次结果中 ${describeRemoved(result.removed)} 不符合题型/题量要求，已被丢弃，本次不要重复生成这些题目。`;
    console.log(`[spec] ${label} 丢弃不符合要求的题目：${describeRemoved(result.removed)}`);
  }

  if (result.shortfalls.length) {
    const patchSpecs = result.shortfalls.map((s) => ({ type: s.type, count: s.need, points: s.points }));
    console.log(`[spec] ${label} 题量不足，补题：${describeShortfalls(result.shortfalls)}`);
    const patch = await call(
      patchSpecs,
      `${hint}本次只生成下列题型，数量必须准确：${patchSpecs
        .map((s) => `${TYPE_LABELS[s.type]} ${s.count} 道`)
        .join('、')}。`
    );
    result = trimToSpecs([...result.questions, ...patch.questions], specs);
  }

  if (result.shortfalls.length) {
    throw httpError(500, `AI 生成的题目与要求不符，请重试：${describeShortfalls(result.shortfalls)}`);
  }

  return { questions: renumber(sortByType(result.questions)), data: first.data };
}

function cleanSpecList(specs) {
  return (Array.isArray(specs) ? specs : [])
    .map((s) => {
      const hasPoints =
        s.points !== undefined && s.points !== null && s.points !== '' && Number.isFinite(Number(s.points));
      return {
        type: s.type,
        count: clampInt(s.count, 0, 30),
        points: hasPoints ? clampInt(s.points, 1, 50) : undefined,
      };
    })
    .filter((s) => s.count > 0 && TYPE_LABELS[s.type])
    .map((s) => ({ ...s, points: s.points || defaultPts(s.type) }));
}

function defaultPts(type) {
  return { single: 3, multiple: 4, judge: 2, blank: 3, term: 4, short: 8, discriminate: 6, material: 12, essay: 15 }[
    type
  ] || 3;
}

/** 知识点归一化：去空白 + 忽略大小写，用于比较两份知识点是否相同 */
function normalizeKnowledge(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * 判断错题是否属于某个知识点：完全相同，或一个知识点包含另一个（较短者至少 3 字），
 * 与错题本前端的分组口径保持一致，例如「中国式现代化」覆盖「中国式现代化中国特色」。
 */
function sameKnowledge(mistake, knowledge) {
  const a = normalizeKnowledge(mistake?.knowledge || mistake?.question?.knowledge);
  const b = normalizeKnowledge(knowledge);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.includes(short);
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function examPaper(paper) {
  return {
    ...paper,
    questions: paper.questions.map((q) => ({
      id: q.id,
      type: q.type,
      stem: q.stem,
      material: q.material,
      options: q.options,
      points: q.points,
      knowledge: q.knowledge,
      blankCount: Array.isArray(q.answer) ? q.answer.length : 0,
    })),
  };
}

function publicPaper(paper) {
  return paper;
}

function summary(paper) {
  return {
    id: paper.id,
    title: paper.title,
    subject: paper.subject,
    difficulty: paper.difficulty,
    duration: paper.duration,
    createdAt: paper.createdAt,
    questionCount: paper.questions.length,
    totalPoints: paper.questions.reduce((s, q) => s + q.points, 0),
    types: [...new Set(paper.questions.map((q) => q.type))],
    stats: paperStats(paper.id),
  };
}

/**
 * 某份试卷的做题统计：次数 / 最近一次（时间与成绩）/ 最好一次 / 平均正确率。
 * submissions 是 unshift 入库，但仍按时间倒序排一遍，避免历史数据顺序不一致。
 */
function paperStats(paperId) {
  if (!paperId) return null;
  const subs = store
    .getSubmissions()
    .filter((s) => s.paperId === paperId)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  if (!subs.length) return null;

  const last = subs[0];
  const best = subs.reduce((m, s) => (Number(s.earnedScore) > Number(m.earnedScore) ? s : m), subs[0]);
  const avg = subs.reduce((sum, s) => sum + (Number(s.accuracy) || 0), 0) / subs.length;

  return {
    attempts: subs.length,
    lastAt: last.createdAt,
    lastScore: last.earnedScore,
    lastTotalScore: last.totalScore,
    lastAccuracy: last.accuracy,
    lastCorrectCount: last.correctCount,
    lastQuestionCount: last.questionCount,
    bestScore: best.earnedScore,
    bestAccuracy: best.accuracy,
    avgAccuracy: Number(avg.toFixed(1)),
  };
}

/** 把一批答卷汇总成「次数 / 最近时间 / 最近成绩 / 平均正确率」 */
function summarizeAttempts(subs, extra) {
  const list = [...subs].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  if (!list.length) return null;
  const last = list[0];
  const best = list.reduce((m, s) => (Number(s.earnedScore) > Number(m.earnedScore) ? s : m), list[0]);
  const avg = list.reduce((sum, s) => sum + (Number(s.accuracy) || 0), 0) / list.length;
  return {
    ...extra,
    attempts: list.length,
    lastAt: last.createdAt,
    lastScore: last.earnedScore,
    lastTotalScore: last.totalScore,
    lastAccuracy: last.accuracy,
    bestScore: best.earnedScore,
    avgAccuracy: Number(avg.toFixed(1)),
  };
}

export default router;
