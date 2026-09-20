const TYPE_LABELS = {
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

// 主观题（论述/材料）作答框更高
const BIG_BOX_TYPES = ['essay', 'material'];
/** 编程类题型：答题框用等宽字体，题干代码用 pre 展示 */
const CODE_TYPES = ['readcode', 'fillcode', 'debug', 'code'];

const DEFAULT_SPECS = [
  { type: 'single', count: 5, points: 3 },
  { type: 'multiple', count: 3, points: 4 },
  { type: 'judge', count: 5, points: 2 },
  { type: 'blank', count: 3, points: 3 },
  { type: 'term', count: 0, points: 4 },
  { type: 'short', count: 2, points: 8 },
  { type: 'discriminate', count: 0, points: 6 },
  { type: 'material', count: 0, points: 12 },
  { type: 'essay', count: 0, points: 15 },
  { type: 'readcode', count: 0, points: 8 },
  { type: 'fillcode', count: 0, points: 8 },
  { type: 'debug', count: 0, points: 8 },
  { type: 'code', count: 0, points: 15 },
];

const MAX_FILES = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_EXT_RE = /\.(pdf|docx|txt|md|markdown)$/i;

/** 大纲模式默认不指定题型，交由 AI 依据大纲决定 */
const OUTLINE_SPECS = DEFAULT_SPECS.map((s) => ({ ...s, enabled: false }));

const state = {
  view: 'generate',
  mode: 'spec',
  outlineFiles: [],
  pastFiles: [], // 本次用于命题的历年真题文档（解析后带 docId）
  pastPick: [], // 从「解析文档库」中选中的真题文档 id
  pastDocs: [], // 解析文档库列表（摘要）
  docTexts: {}, // 文档库：查看全文时按需拉取并缓存
  expandedDocs: {}, // 文档库展开状态
  outlineMeta: null,
  outlineAnalysis: null,
  realExam: null,
  subjects: [],
  activeSubject: null,
  focusPoints: [],
  config: null,
  models: [],
  specs: DEFAULT_SPECS.map((s) => ({ ...s, enabled: s.count > 0 })),
  papers: [],
  generated: null,
  paper: null, // 当前答题试卷（exam 模式）
  examIndex: 0, // 单题作答模式：当前第几题
  // 单选 / 判断题作答后是否自动进入下一题（可在答题页切换，记忆在本地）
  autoNext: (() => {
    try {
      return localStorage.getItem('exam.autoNext') !== '0';
    } catch (_) {
      return true;
    }
  })(),
  answers: {},
  result: null,
  grading: null, // 后台评卷任务：{ jobId, paperId, status, position, waiting, progress, startedAt, fails }
  viewingHistory: false, // 当前结果页是否来自「做题历史」
  paperSubmissions: [], // 当前试卷的历史答卷
  history: null, // 做题历史（总览 / 按科目 / 按试卷 / 逐次记录）
  historySubject: '', // 做题历史左栏选中的科目（'' = 全部科目）
  mistakes: [],
  mistakeFilter: 'all',
  mistakeRetry: {}, // 错题重做状态：{ [mistakeId]: { answer, result } }
  // 复习 / 闪卡
  reviewCards: [], // 全部卡片（含排期）
  reviewStats: null,
  reviewMode: 'today', // today | all
  reviewSubject: '', // 左栏选中的科目
  reviewSession: null, // { queue: [id], pos, done, known, fuzzy, forgot, correct }
  reviewById: new Map(),
  reviewRevealed: false,
  reviewDue: [], // 今日到期队列（服务端已按知识点交错）
  reviewPanel: '', // 卡片交互面板：answer | cloze | mnemonic | feynman | why
  reviewShowOptions: false, // 选择题选项是否已揭示（默认先隐藏，逼自己回忆）
  reviewDraft: {}, // 复习作答草稿 { [cardId]: string | string[] }
  reviewFeedback: null, // 作答判定结果
  reviewFeynmanText: '',
  reviewWhyText: '',
  variantAnswers: {},
  expanded: {},
  collapsedSubjects: {}, // 试卷列表「按科目」分组的折叠状态：{ [科目名]: true }
  collapsedMistakeSubjects: {}, // 错题本「科目」分组的折叠状态：{ [科目名]: true }
  collapsedMistakeKnowledges: {}, // 错题本「科目 → 知识点」的折叠状态：{ [科目::知识点]: true }
  paperSubject: '', // 左栏选中的科目（'' = 全部科目）
  mistakeSubject: '', // 错题本左栏选中的科目（'' = 全部科目）
};

const UNKNOWN_KNOWLEDGE = '未标注知识点';

/** 答题卡签名（已答状态）；没变化就不重绘答题卡 */
let qNavSig = '';
/** 「答完自动下一题」的待执行定时器：radio 会同时触发 input 与 change，必须去重，否则会连跳两题 */
let autoNextTimer = null;

/** 取条目所属科目名，空则归为「未分类」 */
function subjectOf(item) {
  return String(item.subject || '').trim() || '未分类';
}

/** 渲染左栏导航；entries 为 [{ name, count }]，allLabel 为「全部」项的文案 */
function renderSubjectNav(el, entries, activeName, onPick, allLabel = '全部科目') {
  const rows = [{ name: '', label: allLabel, count: entries.reduce((s, e) => s + e.count, 0) }].concat(
    entries.map((e) => ({ ...e, label: e.name }))
  );
  el.innerHTML = rows
    .map(
      (r) => `
      <div class="subj-item ${activeName === r.name ? 'active' : ''}" data-subject="${esc(r.name)}" title="${esc(
        r.label
      )}">
        <span class="sn">${esc(r.label)}</span><span class="sc">${r.count}</span>
      </div>`
    )
    .join('');
  $$('.subj-item', el).forEach((item) =>
    item.addEventListener('click', () => onPick(item.dataset.subject))
  );
}

/* ------------------------------ 工具 ------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const res = await fetch('/api' + path, {
    ...options,
    // FormData 交给浏览器自动设置 multipart boundary
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

let busyTimer = null;
function busy(text) {
  const base = text || 'AI 处理中…';
  const startedAt = Date.now();
  const el = $('#overlayText');
  el.textContent = base;
  $('#overlay').classList.remove('hidden');
  clearInterval(busyTimer);
  let lastTick = 0;
  // 每秒刷新：已等待时长 + 服务端 AI 的真实进度（阶段 / 已输出字数）
  busyTimer = setInterval(async () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    let detail = `已等待 ${seconds} 秒`;
    if (seconds - lastTick >= 2) {
      lastTick = seconds;
      try {
        const res = await fetch('/api/ai/progress');
        const p = await res.json();
        if (p.running) {
          detail += ` · ${p.phase} · 已输出 ${p.chars} 字`;
        }
      } catch (_) {
        /* 进度查询失败不影响主流程 */
      }
    }
    el.textContent = `${base}（${detail}）`;
  }, 1000);
}
function idle() {
  clearInterval(busyTimer);
  busyTimer = null;
  $('#overlay').classList.add('hidden');
}

function answerText(type, ans) {
  if (ans === '' || ans == null) return '未作答';
  // 程序填空的逐空代码答案换行展示，其余数组用顿号
  if (Array.isArray(ans)) return ans.length ? ans.join(type === 'fillcode' ? '\n' : '、') : '未作答';
  if (type === 'judge') return String(ans) === 'true' || ans === true ? '正确' : '错误';
  return String(ans);
}

function letter(i) {
  return String.fromCharCode(65 + i);
}

/** 时间简写：09-18 14:05；跨年时带上年份 */
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = sameYear
    ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function materialHTML(q) {
  return q && q.material ? `<div class="material-box"><b>材料：</b>${esc(q.material)}</div>` : '';
}

/** 编程题的代码块：pre 保留缩进与换行 */
function codeHTML(q, label = '代码') {
  if (!q || !q.code) return '';
  const lang = q.language ? `（${esc(q.language)}）` : '';
  return `<div class="code-wrap"><div class="code-label">${label}${lang}：</div><pre class="code-block">${esc(
    q.code
  )}</pre></div>`;
}

function answerPlaceholder(type) {
  return (
    {
      term: '请写出该概念的定义与关键要点',
      discriminate: '请先判断正误，再说明理由',
      material: '请结合材料，分点作答',
      essay: '请展开论述（论点 + 论据 + 结论）',
      readcode: '请写出程序运行结果（多行代码/输出直接换行书写）',
      fillcode: '说明：下方逐空作答，每空填写补全的代码',
      debug: '请逐条指出错误位置、原因，并给出改正后的代码',
      code: '在此编写代码（纯文本即可，注意缩进）',
    }[type] || '请写出你的解答（含关键步骤）'
  );
}

function answerBox(q, saved, nameAttr, extra = '') {
  const isCode = CODE_TYPES.includes(q.type);
  const rows = isCode ? 12 : BIG_BOX_TYPES.includes(q.type) ? 10 : 5;
  const cls = `answer-box${isCode ? ' code-input' : ''}`;
  return `<textarea class="${cls}" rows="${rows}" name="${nameAttr}" ${extra} placeholder="${answerPlaceholder(
    q.type
  )}" spellcheck="false">${esc(saved || '')}</textarea>`;
}

/* ------------------------------ 初始化 ------------------------------ */

/* ------------------------------ 模型设置 ------------------------------ */

function renderStatus() {
  const cfg = state.config;
  const st = $('#status');
  if (!cfg) return;
  if (cfg.configured) {
    st.className = 'status ok';
    st.textContent = `AI 就绪 · ${cfg.model} · ${cfg.auth}`;
  } else {
    st.className = 'status bad';
    st.textContent = 'AI 服务不可用';
  }
}

/** 拉取可用模型（来自 CodeBuddy CLI / 账号）；refresh=true 强制重新拉取 */
async function loadModels(refresh = false) {
  const sel = $('#modelPick');
  try {
    const data = await api('/models' + (refresh ? '?refresh=1' : ''));
    state.models = data.models || [];
    const current = data.current || '';

    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = data.envModel ? `默认模型（${data.envModel}）` : '默认模型';
    sel.appendChild(def);

    state.models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name && m.name !== m.id ? `${m.name} · ${m.id}` : m.id;
      if (m.description) opt.title = m.description;
      sel.appendChild(opt);
    });

    sel.value = state.models.some((m) => m.id === current) ? current : '';
    sel.disabled = !state.models.length;
    if (data.error) toast(data.error, true);
  } catch (e) {
    sel.disabled = true;
    toast(`可用模型获取失败：${e.message}`, true);
  }
}

async function changeModel(id) {
  try {
    const cfg = await api('/ai/model', { method: 'POST', body: JSON.stringify({ model: id }) });
    state.config = { ...(state.config || {}), ...cfg };
    renderStatus();
    toast(id ? `已切换到 ${id}` : '已恢复默认模型');
  } catch (e) {
    toast(e.message, true);
    loadModels();
  }
}

async function init() {
  bindGlobal();
  setMode('spec');
  try {
    state.config = await api('/config');
    renderStatus();
  } catch (e) {
    $('#status').textContent = '无法连接后端';
  }
  loadPapers();
  loadMistakes();
  loadSubjects();
  loadModels();
  loadHistory();
  loadDocuments();
  loadReviews();
}

function bindGlobal() {
  $$('.tab').forEach((btn) =>
    btn.addEventListener('click', () => switchView(btn.dataset.view))
  );

  $$('.mode-btn').forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

  $('#btnGenerate').addEventListener('click', generatePaper);
  $('#btnAnalyzeOutline').addEventListener('click', analyzeOutline);
  $('#btnRealExam').addEventListener('click', analyzeRealExam);
  $('#useRealExam').addEventListener('change', (e) => {
    $('#realExamOpts').classList.toggle('hidden', !e.target.checked);
  });
  $('#useHistory').addEventListener('change', (e) => {
    $('#historyOpts').classList.toggle('hidden', !e.target.checked);
  });
  $('#subjectPick').addEventListener('change', (e) => pickSubject(e.target.value));
  $('#btnSaveSubject').addEventListener('click', saveSubject);
  $('#btnDeleteSubject').addEventListener('click', deleteSubject);
  $('#subjectInfo').addEventListener('click', onSubjectInfoClick);
  $('#specRows').addEventListener('input', onSpecInput);
  $('#btnRefreshPapers').addEventListener('click', loadPapers);
  $('#btnRefreshMistakes').addEventListener('click', loadMistakes);
  $('#btnRefreshHistory').addEventListener('click', loadHistory);
  $('#historyPane').addEventListener('click', onHistoryClick);
  $('#examPane').addEventListener('click', onHistoryClick);
  initSideToggles();
  $('#modelPick').addEventListener('change', (e) => changeModel(e.target.value));
  $('#btnRefreshModels').addEventListener('click', () => loadModels(true));

  bindFilePicker('#dropzone', '#outlineFiles', 'outline');
  bindFilePicker('#pastDropzone', '#pastFiles', 'past-paper');
  // 拖到页面其它位置时不要让浏览器直接打开文件
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  $('#fileList').addEventListener('click', onFileAction);
  $('#pastFileList').addEventListener('click', onFileAction);

  $('#usePastPaper').addEventListener('change', (e) => {
    $('#pastPaperOpts').classList.toggle('hidden', !e.target.checked);
  });
  $('#btnRefreshDocs').addEventListener('click', loadDocuments);
  $('#docList').addEventListener('click', onDocAction);

  $('#examPane').addEventListener('input', onAnswerInput);
  $('#examPane').addEventListener('change', onAnswerInput);
  $('#examPane').addEventListener('click', onExamClick); // 单题作答：上一题 / 下一题 / 题号跳转

  // 单题作答：方向键左右切题（输入框内不拦截）
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'exam' || state.result || !state.paper) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      gotoQuestion(state.examIndex - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      gotoQuestion(state.examIndex + 1);
    }
  });

  $$('#view-mistakes .filters .chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      $$('#view-mistakes .filters .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.mistakeFilter = chip.dataset.filter;
      renderMistakes();
    })
  );

  $('#mistakeList').addEventListener('input', onVariantInput);
  $('#mistakeList').addEventListener('change', onVariantInput);
  $('#mistakeList').addEventListener('click', onMistakeAction);

  // 复习 / 闪卡
  $('#btnRefreshReviews').addEventListener('click', loadReviews);
  $('#btnSyncReviews').addEventListener('click', syncReviews);
  $('#btnConfusion').addEventListener('click', genConfusions);
  $('#reviewPane').addEventListener('click', onReviewAction);
  $('#reviewPane').addEventListener('input', onReviewInput);
  $('#reviewPane').addEventListener('change', onReviewInput);
  $$('#view-review .filters .chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      $$('#view-review .filters .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.reviewMode = chip.dataset.rmode;
      state.reviewSession = null;
      resetCardUI();
      renderReviews();
    })
  );
}

/** 侧边栏收起 / 展开：状态按视图分别记在 localStorage */
function initSideToggles() {
  const KEY = 'ui.sideCollapsed';
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch (e) {
    saved = {};
  }

  $$('.side-toggle').forEach((btn) => {
    const key = btn.dataset.side;
    const layout = btn.closest('.layout');
    if (!layout) return;

    const apply = (collapsed) => {
      layout.classList.toggle('collapsed', collapsed);
      btn.textContent = collapsed ? '»' : '«';
      btn.title = collapsed ? '展开侧边栏' : '收起侧边栏';
      saved[key] = collapsed;
      try {
        localStorage.setItem(KEY, JSON.stringify(saved));
      } catch (e) {
        /* 忽略存储失败 */
      }
    };

    apply(Boolean(saved[key]));
    btn.addEventListener('click', () => apply(!layout.classList.contains('collapsed')));
  });
}

function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  ['generate', 'exam', 'history', 'mistakes', 'review'].forEach((v) => {
    $('#view-' + v).classList.toggle('hidden', v !== view);
  });
  if (view === 'exam') {
    loadPapers();
    renderExam(); // 后台评卷结束时可能已出结果，切回来要同步展示
  }
  if (view === 'history') loadHistory();
  if (view === 'mistakes') loadMistakes();
  if (view === 'review') loadReviews();
}

/* ------------------------------ 生成试卷 ------------------------------ */

function setMode(mode) {
  state.mode = mode;
  state.outlineMeta = null;
  state.outlineAnalysis = null;
  renderAnalysis();
  $$('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#panel-outline').classList.toggle('hidden', mode !== 'outline');
  $('#specsHint').textContent =
    mode === 'outline'
      ? '可选：如需指定题型与题量请勾选；留空则由 AI 依据大纲自行设计。'
      : '勾选需要的题型，设置题量与每题分值。';
  $('#btnGenerate').textContent = mode === 'outline' ? '按大纲生成试卷' : '生成试卷';
  const preset = mode === 'outline' ? OUTLINE_SPECS : DEFAULT_SPECS;
  state.specs = preset.map((s) => ({ ...s, enabled: s.count > 0 }));
  renderSpecRows();
}

function activeSpecs() {
  return state.specs
    .filter((s) => s.enabled && s.count > 0)
    .map((s) => ({ type: s.type, count: s.count, points: s.points }));
}

function renderSpecRows() {
  $('#specRows').innerHTML = state.specs
    .map(
      (s, i) => `
      <div class="spec-row" data-index="${i}">
        <label class="name">
          <input type="checkbox" data-field="enabled" ${s.enabled ? 'checked' : ''} />
          ${TYPE_LABELS[s.type]}
        </label>
        <input type="number" min="1" max="30" data-field="count" value="${s.count}" ${s.enabled ? '' : 'disabled'} />
        <input type="number" min="1" max="50" data-field="points" value="${s.points}" ${s.enabled ? '' : 'disabled'} />
      </div>`
    )
    .join('');
  updateTotal();
}

function onSpecInput(e) {
  const row = e.target.closest('.spec-row');
  if (!row) return;
  const i = Number(row.dataset.index);
  const field = e.target.dataset.field;
  if (field === 'enabled') {
    state.specs[i].enabled = e.target.checked;
    $$('input[data-field]', row).forEach((inp) => {
      if (inp.dataset.field !== 'enabled') inp.disabled = !e.target.checked;
    });
  } else {
    const n = Math.max(1, Number(e.target.value) || 1);
    state.specs[i][field] = field === 'count' ? Math.min(30, n) : Math.min(50, n);
  }
  updateTotal();
}

function updateTotal() {
  const active = state.specs.filter((s) => s.enabled && s.count > 0);
  if (!active.length) {
    $('#totalInfo').textContent =
      state.mode === 'outline' ? '未指定题型，由 AI 依据大纲决定' : '请至少选择一种题型';
    return;
  }
  const count = active.reduce((a, s) => a + s.count, 0);
  const points = active.reduce((a, s) => a + s.count * s.points, 0);
  $('#totalInfo').textContent = `共 ${count} 题，约 ${points} 分`;
}

/* ------------------------------ 上传文件（大纲 / 历年真题） ------------------------------ */

/** 文件选择区（点击 / 拖拽）绑定；kind 区分大纲文档与历年真题文档 */
function bindFilePicker(dropId, inputId, kind) {
  const dz = $(dropId);
  const fileInput = $(inputId);
  dz.addEventListener('click', () => fileInput.click());
  // 避免程序化 click 冒泡回 dropzone 造成递归
  fileInput.addEventListener('click', (e) => e.stopPropagation());
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files, kind);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('over')));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    addFiles(e.dataTransfer && e.dataTransfer.files, kind);
  });
}

const isPastKind = (kind) => kind === 'past-paper';
const bucketOf = (kind) => (isPastKind(kind) ? state.pastFiles : state.outlineFiles);
const fileListElOf = (kind) => $(isPastKind(kind) ? '#pastFileList' : '#fileList');

function addFiles(fileList, kind = 'outline') {
  const bucket = bucketOf(kind);
  const incoming = [...(fileList || [])];
  if (!incoming.length) return;
  const rejected = [];

  for (const f of incoming) {
    if (!FILE_EXT_RE.test(f.name)) {
      rejected.push(`${f.name}：不支持的格式`);
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      rejected.push(`${f.name}：超过 10MB`);
      continue;
    }
    if (bucket.length >= MAX_FILES) {
      rejected.push(`${f.name}：最多上传 8 个文件`);
      continue;
    }
    if (bucket.some((x) => x.name === f.name && x.size === f.size)) {
      rejected.push(`${f.name}：已添加`);
      continue;
    }
    bucket.push({ file: f, name: f.name, size: f.size, chars: null, ok: null, error: '', docId: '' });
  }

  if (rejected.length) toast(rejected.join('；'), true);
  renderFileList(kind);
  previewFiles(kind);
}

/** 解析上传文档（解析结果同时保存进「解析文档库」），回填字数与 docId */
async function previewFiles(kind = 'outline') {
  const bucket = bucketOf(kind);
  const pending = bucket.filter((f) => f.chars === null);
  if (!pending.length) return;

  const fd = new FormData();
  pending.forEach((f) => fd.append('files', f.file, f.name));
  fd.append('kind', kind);
  const subject = $('#subject').value.trim();
  if (subject) fd.append('subject', subject);
  try {
    const { files } = await api('/outline/preview', { method: 'POST', body: fd });
    files.forEach((r, i) => {
      const target = pending[i];
      if (!target) return;
      target.chars = r.chars;
      target.ok = r.ok;
      target.error = r.error || '';
      target.docId = r.docId || '';
    });
    loadDocuments(); // 解析结果已入库，刷新文档库
  } catch (e) {
    pending.forEach((p) => {
      p.chars = 0;
      p.ok = false;
      p.error = e.message;
    });
  }
  renderFileList(kind);
}

/* ------------------------------ 解析文档库 ------------------------------ */

const docKindLabel = (kind) => (kind === 'past-paper' ? '历年真题' : '大纲 / 文档');

async function loadDocuments() {
  try {
    const { documents } = await api('/documents?limit=20');
    state.pastDocs = documents;
    renderDocList();
  } catch (e) {
    /* 忽略 */
  }
}

function renderDocList() {
  const el = $('#docList');
  if (!state.pastDocs.length) {
    el.innerHTML =
      '<div class="doc-empty">还没有解析文档：上传大纲或历年真题文档后，解析出的正文会自动保存在这里。</div>';
    return;
  }
  el.innerHTML = state.pastDocs
    .map((d) => {
      const picked = state.pastPick.includes(d.id);
      const open = Boolean(state.expandedDocs[d.id]);
      const text = state.docTexts[d.id];
      const time = esc(String(d.updatedAt || '').slice(0, 16).replace('T', ' '));
      return `
    <div class="doc-item ${picked ? 'picked' : ''}" data-id="${esc(d.id)}">
      <div class="n">
        <b title="${esc(d.name)}">${esc(d.name)}</b>
        <span class="s">${docKindLabel(d.kind)}${d.subject ? ` · ${esc(d.subject)}` : ''} · ${d.chars} 字 · ${time}</span>
        ${open ? `<pre>${esc(text || d.preview || '（加载中…）')}</pre>` : ''}
      </div>
      <div class="ops">
        <button class="ghost small" data-act="view">${open ? '收起' : '查看'}</button>
        <button class="ghost small" data-act="pick" title="把这份文档的原文用于本次命题">${
          picked ? '已选用于命题' : '用于命题'
        }</button>
        <button class="ghost small danger" data-act="del">删除</button>
      </div>
    </div>`;
    })
    .join('');
}

async function onDocAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const item = btn.closest('.doc-item');
  const id = item && item.dataset.id;
  if (!id) return;

  if (btn.dataset.act === 'view') {
    const open = !state.expandedDocs[id];
    state.expandedDocs[id] = open;
    if (open && !state.docTexts[id]) {
      try {
        const { document } = await api(`/documents/${encodeURIComponent(id)}`);
        state.docTexts[id] = document.text;
      } catch (err) {
        toast(err.message, true);
      }
    }
    renderDocList();
    return;
  }

  if (btn.dataset.act === 'pick') {
    const picked = state.pastPick.includes(id);
    state.pastPick = picked ? state.pastPick.filter((x) => x !== id) : [...state.pastPick, id];
    if (!picked) {
      // 选中即打开真题开关
      $('#usePastPaper').checked = true;
      $('#pastPaperOpts').classList.remove('hidden');
    }
    renderDocList();
    return;
  }

  if (btn.dataset.act === 'del') {
    if (!confirm('删除这份解析文档？已生成的试卷不受影响。')) return;
    try {
      await api(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.pastPick = state.pastPick.filter((x) => x !== id);
      delete state.docTexts[id];
      delete state.expandedDocs[id];
      await loadDocuments();
      toast('解析文档已删除');
    } catch (err) {
      toast(err.message, true);
    }
  }
}

/** 本次命题要用的历年真题参数（粘贴原文 + 上传解析文档 + 文档库选项） */
function pastPaperPayload() {
  const use = $('#usePastPaper').checked;
  const docIds = [...state.pastFiles.map((f) => f.docId), ...state.pastPick].filter(Boolean);
  return {
    usePastPaper: use,
    pastPaperText: use ? $('#pastPaperText').value.trim() : '',
    pastDocIds: use ? docIds : [],
    pastPaperMode: $('#pastPaperMode').value,
  };
}

/* --------------------------- 大纲 AI 分析 --------------------------- */

async function analyzeOutline() {
  const outline = $('#outlineText').value.trim();
  if (!outline && !state.outlineFiles.length) {
    return toast('请先粘贴大纲，或上传大纲文档', true);
  }

  const fd = new FormData();
  fd.append('outline', outline);
  state.outlineFiles.forEach((f) => fd.append('files', f.file, f.name));

  busy('AI 正在分析大纲…');
  try {
    const { analysis, warnings } = await api('/outline/analyze', { method: 'POST', body: fd });
    applyAnalysis(analysis);
    toast(
      warnings.length
        ? `分析完成：${warnings.join('；')}`
        : `分析完成：${analysis.subject || '已填充题型与题量'}`,
      warnings.length > 0
    );
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

/** 把 AI 分析结果回填到表单（科目 / 难度 / 题型题量），用户仍可手动修改 */
function applyAnalysis(a) {
  if (!a) return;
  if (a.subject) $('#subject').value = a.subject;
  if (a.difficulty) $('#difficulty').value = a.difficulty;
  if (a.notes && !$('#notes').value.trim()) $('#notes').value = a.notes;

  const map = new Map((a.specs || []).map((s) => [s.type, s]));
  state.specs = state.specs.map((s) => {
    const hit = map.get(s.type);
    return hit ? { ...s, enabled: true, count: hit.count, points: hit.points } : { ...s, enabled: false };
  });
  renderSpecRows();

  state.outlineAnalysis = a;
  renderAnalysis();
}

function renderAnalysis() {
  const el = $('#analysisResult');
  const a = state.outlineAnalysis;
  if (!a) {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }
  const specs = (a.specs || [])
    .map((s) => `${TYPE_LABELS[s.type] || s.type} ${s.count} 题 × ${s.points} 分`)
    .join('、');
  const cov = (a.coverage || []).map((c) => `<span class="chip-item">${esc(c)}</span>`).join('');
  el.innerHTML = `
    <b>AI 分析结果：</b>${esc(a.subject || '未识别科目')} · ${esc(a.difficulty)} · 共 ${a.totalPoints} 分${
    a.duration ? ` · 建议用时 ${a.duration} 分钟` : ''
  }${a.truncated ? '（大纲过长，已截断分析）' : ''}
    ${specs ? `<div>${esc(specs)}</div>` : ''}
    ${cov ? `<div class="chips">${cov}</div>` : ''}`;
  el.classList.remove('hidden');
}

/** 生成试卷时随请求带上的真题参数 */
function realExamPayload() {
  return {
    useRealExam: $('#useRealExam').checked,
    realExamYears: $('#realExamYears').value.trim() || '近 5 年',
    realExamRatio: Number($('#realExamRatio').value) || 50,
  };
}

/** 生成试卷时随请求带上的「历史试卷避重」参数 */
function historyPayload() {
  return {
    useHistory: $('#useHistory').checked,
    historyRatio: Number($('#historyRatio').value) || 40,
    historyLimit: Number($('#historyLimit').value) || 5,
  };
}

/** 只检索历年真题考点，便于先确认检索效果 */
async function analyzeRealExam() {
  const subject = $('#subject').value.trim();
  if (!subject) return toast('请先填写科目', true);

  $('#useRealExam').checked = true;
  $('#realExamOpts').classList.remove('hidden');

  busy('AI 正在联网检索历年真题…');
  try {
    const data = await api('/real-exam/analyze', {
      method: 'POST',
      body: JSON.stringify({
        subject,
        difficulty: $('#difficulty').value,
        years: $('#realExamYears').value.trim() || '近 5 年',
        ratio: Number($('#realExamRatio').value) || 50,
      }),
    });
    state.realExam = data.realExam || null;
    renderRealExam();
    const n = (data.realExam && data.realExam.keyPoints) || [];
    toast(data.ok ? `检索到 ${n.length} 个真题考点` : data.warning || '未检索到真题考点', !data.ok);
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

function renderRealExam() {
  const el = $('#realExamResult');
  const r = state.realExam;
  if (!r) {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }
  const points = (r.keyPoints || [])
    .map(
      (p) =>
        `<span class="chip-item">${esc(p.point)}${p.frequency ? ` · ${esc(p.frequency)}` : ''}${
          (p.years || []).length ? ` · ${esc(p.years.join('/'))}` : ''
        }</span>`
    )
    .join('');
  const srcs = (r.sources || [])
    .filter((s) => /^https?:\/\//i.test(s.url || ''))
    .slice(0, 8)
    .map(
      (s) =>
        `<div>· <a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.title || s.url)}</a>${
          s.year ? `（${esc(s.year)}）` : ''
        }</div>`
    )
    .join('');

  // 每个考点在真题里的典型问法
  const asks = (r.keyPoints || [])
    .filter((p) => p.ask)
    .slice(0, 20)
    .map((p) => `<div>· ${esc(p.point)}：${esc(p.ask)}</div>`)
    .join('');

  // 提问方式与设问角度
  const sg = r.styleGuide || null;
  const styleLines = sg
    ? [
        (sg.angles || []).length
          ? `<div><b>设问角度：</b>${(sg.angles || [])
              .slice(0, 8)
              .map((a) => `<span class="chip-item" title="${esc(a.exampleStem || '')}">${esc(a.angle)}</span>`)
              .join('')}</div>`
          : '',
        (sg.wording || []).length
          ? `<div><b>常用措辞：</b>${(sg.wording || []).slice(0, 8).map((w) => esc(w)).join(' / ')}</div>`
          : '',
        (sg.typeHabits || []).length
          ? `<div><b>题型搭配：</b>${(sg.typeHabits || [])
              .slice(0, 6)
              .map((t) => `${esc(TYPE_LABELS[t.type] || t.type)}（${esc(t.usage || '—')}）`)
              .join('；')}</div>`
          : '',
        (sg.traps || []).length
          ? `<div><b>常见陷阱：</b>${(sg.traps || []).slice(0, 5).map((t) => esc(t)).join(' / ')}</div>`
          : '',
        (sg.answerDemands || []).length
          ? `<div><b>作答要求：</b>${(sg.answerDemands || []).slice(0, 5).map((d) => esc(d)).join(' / ')}</div>`
          : '',
      ].join('')
    : '';

  el.innerHTML = `
    <b>历年真题考点：</b>${esc(r.examType || '未标注考试类型')} · 真题占比 ${r.ratio || 50}%
    ${r.summary ? `<div>${esc(r.summary)}</div>` : ''}
    ${points ? `<div class="chips">${points}</div>` : ''}
    ${asks ? `<div class="real-src"><b>真题问法：</b>${asks}</div>` : ''}
    ${styleLines ? `<div class="real-src">${styleLines}</div>` : ''}
    ${srcs ? `<div class="real-src">参考来源：${srcs}</div>` : ''}`;
  el.classList.remove('hidden');
}

/* ------------------------------ 科目库 ------------------------------ */

async function loadSubjects(preferredId) {
  try {
    const { subjects } = await api('/subjects');
    state.subjects = subjects || [];
  } catch (_) {
    state.subjects = [];
  }
  const sel = $('#subjectPick');
  const current = preferredId || (state.activeSubject && state.activeSubject.id) || '';
  sel.innerHTML =
    `<option value="">从科目库选择…</option>` +
    state.subjects
      .map(
        (s) =>
          `<option value="${esc(s.id)}" ${s.id === current ? 'selected' : ''}>${esc(s.name)}${
            s.outlineChars ? ` · 大纲 ${s.outlineChars} 字` : ''
          } · 真题考点 ${s.realExamPoints} 个</option>`
      )
      .join('');
}

/** 选中档案：回填科目 / 难度 / 大纲 / 题型 / 真题考点，之后可直接生成 */
async function pickSubject(id) {
  // 换档案时清空上一份资料里挑的真题文档，避免跨科目误用
  state.pastPick = [];
  renderDocList();

  if (!id) {
    state.activeSubject = null;
    state.focusPoints = [];
    renderSubjectInfo();
    return;
  }
  try {
    const { subject } = await api(`/subjects/${encodeURIComponent(id)}`);
    state.activeSubject = subject;
    state.focusPoints = [];

    if (subject.name) $('#subject').value = subject.name;
    if (subject.difficulty) $('#difficulty').value = subject.difficulty;
    if (subject.notes && !$('#notes').value.trim()) $('#notes').value = subject.notes;
    if (subject.outline) {
      $('#outlineText').value = subject.outline;
      setMode('outline'); // 有大纲就切到大纲模式；注意这会重置题型，故放在回填题型之前
    }
    if ((subject.specs || []).length) {
      const map = new Map(subject.specs.map((x) => [x.type, x]));
      state.specs = state.specs.map((x) => {
        const hit = map.get(x.type);
        return hit ? { ...x, enabled: true, count: hit.count, points: hit.points } : { ...x, enabled: false };
      });
      renderSpecRows();
    }
    if (((subject.realExam && subject.realExam.keyPoints) || []).length) {
      state.realExam = subject.realExam;
      $('#useRealExam').checked = true;
      $('#refreshRealExam').checked = false;
      $('#realExamOpts').classList.remove('hidden');
      if (subject.realExam.years) $('#realExamYears').value = subject.realExam.years;
      if (subject.realExam.ratio) $('#realExamRatio').value = subject.realExam.ratio;
      renderRealExam();
    }
    // 档案里保存过历年真题原文：自动打开真题开关，生成时直接复用其提问方式
    if (subject.pastPaperChars) {
      $('#usePastPaper').checked = true;
      $('#pastPaperOpts').classList.remove('hidden');
      if (subject.pastPaperMode) $('#pastPaperMode').value = subject.pastPaperMode;
    }
    renderSubjectInfo();
    toast(`已载入科目「${subject.name}」，可直接生成`);
  } catch (e) {
    toast(e.message, true);
  }
}

function renderSubjectInfo() {
  const el = $('#subjectInfo');
  const s = state.activeSubject;
  if (!s) {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }
  const points = [
    ...(s.coverage || []),
    ...(((s.realExam && s.realExam.keyPoints) || []).map((p) => p.point) || []),
  ].filter(Boolean);
  const uniq = [...new Set(points)];
  const chips = uniq
    .map(
      (p) =>
        `<span class="chip-item point-chip ${state.focusPoints.includes(p) ? 'on' : ''}" data-act="focus" data-point="${esc(
          p
        )}">${esc(p)}</span>`
    )
    .join('');

  el.innerHTML = `
    <b>已选档案：</b>${esc(s.name)} · ${esc(s.difficulty)} · 大纲 ${s.outlineChars || 0} 字${
    s.outlineFiles ? `（${s.outlineFiles} 个文件）` : ''
  } · 真题考点 ${s.realExamPoints || 0} 个${
    s.realExam && s.realExam.updatedAt ? `（${esc(String(s.realExam.updatedAt).slice(0, 10))} 检索）` : ''
  } · 历年真题 ${s.pastPaperChars || 0} 字
    <div class="hint">点击知识点可设为「本次重点」（可多选）；不选则按档案整体范围命题。生成时无需再上传 / 解析大纲。</div>
    ${chips ? `<div class="chips">${chips}</div>` : ''}`;
  el.classList.remove('hidden');
}

function onSubjectInfoClick(e) {
  const chip = e.target.closest('[data-act="focus"]');
  if (!chip) return;
  const p = chip.dataset.point;
  state.focusPoints = state.focusPoints.includes(p)
    ? state.focusPoints.filter((x) => x !== p)
    : [...state.focusPoints, p];
  renderSubjectInfo();
}

/** 把当前表单（科目 / 大纲 / 题型 / 真题考点）保存进科目库，按科目名去重 */
async function saveSubject() {
  const name = $('#subject').value.trim();
  if (!name) return toast('请填写科目名称', true);

  const outline = $('#outlineText').value.trim();
  const files = state.outlineFiles.map((f) => ({ name: f.name, size: f.size, chars: f.chars || 0 }));
  const pastText = $('#pastPaperText').value.trim();
  const pastFiles = state.pastFiles.map((f) => ({ name: f.name, chars: f.chars || 0, docId: f.docId || '' }));
  if (!outline && !files.length && !pastText && !pastFiles.length && !state.activeSubject) {
    return toast('请先粘贴大纲或上传大纲 / 真题文档，再保存到科目库', true);
  }

  try {
    const { subject } = await api('/subjects', {
      method: 'POST',
      body: JSON.stringify({
        name,
        difficulty: $('#difficulty').value,
        notes: $('#notes').value.trim(),
        outline: { text: outline, files, coverage: (state.outlineMeta && state.outlineMeta.coverage) || [] },
        analysis: { specs: activeSpecs() },
        realExam: state.realExam || undefined,
        // 历年真题原文：粘贴的内容直接归档；仅上传文件时由档案里的原文继续保留
        pastPaper: pastText ? { text: pastText, files: pastFiles, mode: $('#pastPaperMode').value } : undefined,
      }),
    });
    await loadSubjects(subject.id);
    await pickSubject(subject.id);
    toast(`科目「${name}」已保存到科目库`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteSubject() {
  const s = state.activeSubject;
  if (!s) return toast('请先在科目库中选择要删除的科目', true);
  if (!confirm(`删除科目档案「${s.name}」？已生成的试卷不会受影响。`)) return;
  try {
    await api(`/subjects/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    state.activeSubject = null;
    state.focusPoints = [];
    renderSubjectInfo();
    await loadSubjects('');
    $('#subjectPick').value = '';
    toast('科目档案已删除');
  } catch (e) {
    toast(e.message, true);
  }
}

/** 用科目档案命题：不上传文件、不解析文档、可复用已存真题考点 */
async function generateFromSubject(subject) {
  const s = state.activeSubject;
  if (!s) return generatePaper();
  if (state.mode !== 'outline' && !activeSpecs().length) {
    return toast('请至少选择一种题型并设置题量', true);
  }

  const refresh = $('#refreshRealExam').checked;
  busy(refresh ? 'AI 正在重新检索历年真题并命题…' : 'AI 正在按科目档案命题…');
  try {
    const data = await api('/papers/from-subject', {
      method: 'POST',
      body: JSON.stringify({
        subjectId: s.id,
        subject,
        difficulty: $('#difficulty').value,
        notes: $('#notes').value.trim(),
        specs: activeSpecs(),
        focusPoints: state.focusPoints,
        useRealExam: $('#useRealExam').checked,
        refreshRealExam: refresh,
        realExamYears: $('#realExamYears').value.trim() || '近 5 年',
        realExamRatio: Number($('#realExamRatio').value) || 50,
        ...historyPayload(),
        ...pastPaperPayload(),
      }),
    });
    state.generated = data.paper;
    state.outlineMeta = data.meta || null;
    if (data.realExam) {
      state.realExam = data.realExam;
      renderRealExam();
    }
    if (data.subject) {
      state.activeSubject = { ...state.activeSubject, ...data.subject };
      renderSubjectInfo();
      await loadSubjects(data.subject.id);
    }
    renderGenerated();
    loadPapers();
    const warnings = (data.meta && data.meta.warnings) || [];
    toast(
      warnings.length ? `试卷生成成功：${warnings.join('；')}` : '试卷生成成功',
      Boolean(warnings.length)
    );
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

function onFileAction(e) {
  const btn = e.target.closest('button[data-act="remove"]');
  if (!btn) return;
  const item = btn.closest('.file-item');
  if (!item) return;
  const kind = item.dataset.kind === 'past-paper' ? 'past-paper' : 'outline';
  bucketOf(kind).splice(Number(item.dataset.index), 1);
  renderFileList(kind);
}

function renderFileList(kind = 'outline') {
  const el = fileListElOf(kind);
  const bucket = bucketOf(kind);
  if (!bucket.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = bucket
    .map(
      (f, i) => `
    <div class="file-item ${f.ok === false ? 'bad' : ''}" data-index="${i}" data-kind="${kind}">
      <span class="n" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="s">${humanSize(f.size)}${
        f.chars === null ? ' · 解析中…' : ` · ${f.chars} 字${f.docId ? ' · 已入库' : ''}`
      }</span>
      ${f.error ? `<span class="s err">${esc(f.error)}</span>` : ''}
      <button class="ghost small" data-act="remove">移除</button>
    </div>`
    )
    .join('');
}

async function generatePaper() {
  const subject = $('#subject').value.trim();
  if (!subject) return toast('请填写科目', true);

  // 已选科目档案：直接用库里的大纲与真题考点命题，跳过上传 / 解析
  if (state.activeSubject) return generateFromSubject(subject);

  if (state.mode === 'outline') return generateFromOutline(subject);

  const specs = activeSpecs();
  if (!specs.length) return toast('请至少选择一种题型并设置题量', true);

  const useRealExam = $('#useRealExam').checked;
  const pp = pastPaperPayload();
  const pastTip = pp.pastPaperText || pp.pastDocIds.length ? '（学习历年真题的提问方式）' : '';
  busy(useRealExam ? `AI 正在检索历年真题并命题${pastTip}…` : `AI 正在命题${pastTip}，请稍候…`);
  try {
    const { paper, realExam, warnings } = await api('/papers', {
      method: 'POST',
      body: JSON.stringify({
        subject,
        difficulty: $('#difficulty').value,
        notes: $('#notes').value.trim(),
        specs,
        ...realExamPayload(),
        ...historyPayload(),
        ...pp,
      }),
    });
    state.generated = paper;
    if (realExam) {
      state.realExam = realExam;
      renderRealExam();
    }
    renderGenerated();
    loadPapers();
    toast(warnings && warnings.length ? `试卷生成成功：${warnings.join('；')}` : '试卷生成成功', Boolean(warnings && warnings.length));
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

async function generateFromOutline(subject) {
  if (state.activeSubject) return generateFromSubject(subject);

  const outline = $('#outlineText').value.trim();
  if (!outline && !state.outlineFiles.length) {
    return toast('请上传大纲文档，或在文本框中粘贴大纲内容', true);
  }

  const fd = new FormData();
  fd.append('subject', subject);
  fd.append('difficulty', $('#difficulty').value);
  fd.append('notes', $('#notes').value.trim());
  fd.append('outline', outline);
  fd.append('specs', JSON.stringify(activeSpecs()));

  const p = realExamPayload();
  if (p.useRealExam) {
    fd.append('useRealExam', '1');
    fd.append('realExamYears', p.realExamYears);
    fd.append('realExamRatio', String(p.realExamRatio));
  }

  const h = historyPayload();
  if (h.useHistory) {
    fd.append('useHistory', '1');
    fd.append('historyRatio', String(h.historyRatio));
    fd.append('historyLimit', String(h.historyLimit));
  }

  // 历年真题：粘贴原文 + 已解析入库的真题文档（docId 复用，无需重复上传）
  const pp = pastPaperPayload();
  if (pp.usePastPaper || pp.pastPaperText) fd.append('usePastPaper', '1');
  if (pp.pastPaperText) fd.append('pastPaperText', pp.pastPaperText);
  if (pp.pastDocIds.length) fd.append('pastDocIds', JSON.stringify(pp.pastDocIds));
  fd.append('pastPaperMode', pp.pastPaperMode);

  state.outlineFiles.forEach((f) => fd.append('files', f.file, f.name));

  const pastTip = pp.pastPaperText || pp.pastDocIds.length ? '（学习历年真题的提问方式）' : '';
  busy(p.useRealExam ? `AI 正在检索历年真题并依据大纲命题${pastTip}…` : `AI 正在阅读大纲并命题${pastTip}…`);
  try {
    const data = await api('/papers/from-outline', { method: 'POST', body: fd });
    state.generated = data.paper;
    state.outlineMeta = data.meta || null;
    if (data.realExam) {
      state.realExam = data.realExam;
      renderRealExam();
    }
    if (data.subject) {
      // 本次解析的大纲已自动归档，之后可直接从科目库复用
      state.activeSubject = { ...(state.activeSubject || {}), ...data.subject };
      renderSubjectInfo();
      await loadSubjects(data.subject.id);
    }
    renderGenerated();
    loadPapers();
    const warnings = (data.meta && data.meta.warnings) || [];
    toast(warnings.length ? `试卷生成成功：${warnings.join('；')}` : '试卷生成成功', warnings.length > 0);
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

function outlineMetaHTML() {
  const m = state.outlineMeta;
  const pp = state.generated && state.generated.pastPaper;
  const past = pp
    ? `<div class="analysis"><b>历年真题参考：</b>${(pp.files || [])
        .map((f) => `${esc(f.name)}（${f.chars} 字）`)
        .join('、')} · ${pp.mode === 'mix' ? '提问方式 + 真题考点并重' : '重点学习提问方式'}${
        pp.truncated ? '（原文过长已截取）' : ''
      }</div>`
    : '';
  if (!m) return past;
  const files = (m.files || []).map((f) => `${esc(f.name)}（${f.chars} 字）`).join('、');
  const cov = (m.coverage || []).map((c) => `<span class="chip-item">${esc(c)}</span>`).join('');
  return `${past}
    ${files ? `<div class="analysis"><b>大纲来源：</b>${files}${m.truncated ? '（内容过长，已截断）' : ''}</div>` : ''}
    ${(m.warnings || []).length ? `<div class="comment"><b>提示：</b>${esc(m.warnings.join('；'))}</div>` : ''}
    ${cov ? `<div class="side-head"><h2>已覆盖知识点</h2></div><div class="chips">${cov}</div>` : ''}`;
}

function renderGenerated() {
  const p = state.generated;
  if (!p) return;
  const total = p.questions.reduce((s, q) => s + q.points, 0);
  $('#generatedPane').innerHTML = `
    <div class="card">
      <div class="side-head">
        <div>
          <h2>${esc(p.title)}</h2>
          <div class="hint">${esc(p.subject)} · ${esc(p.difficulty)} · ${p.questions.length} 题 · ${total} 分 · 建议用时 ${p.duration} 分钟${
            p.history ? ` · 新题率 ${p.history.actualNewRate}%（比对 ${p.history.papers} 份历史试卷 / ${p.history.questions} 道题）` : ''
          }</div>
        </div>
        <button class="primary" id="btnStartExam">开始答题</button>
      </div>
      ${outlineMetaHTML()}
      ${p.questions.map((q, i) => questionPreviewHTML(q, i)).join('')}
    </div>`;
  $('#btnStartExam').addEventListener('click', () => {
    switchView('exam');
    openPaper(p.id);
  });
}

function questionPreviewHTML(q, i) {
  return `
    <div class="q-block">
      <div class="q-head">
        <span class="q-index">第 ${i + 1} 题</span>
        <span class="q-type">${TYPE_LABELS[q.type] || q.type}</span>
        <span class="q-points">${q.points} 分</span>
        ${q.knowledge ? `<span class="tag">${esc(q.knowledge)}</span>` : ''}
      </div>
      <div class="q-stem">${esc(q.stem)}</div>
      ${materialHTML(q)}
      ${codeHTML(q)}
      ${(q.options || []).length ? `<div class="options">${q.options.map((o, j) => `<div class="opt ${isRightOption(q, letter(j)) ? 'correct' : ''}"><span class="letter">${letter(j)}.</span><span>${esc(o)}</span></div>`).join('')}</div>` : ''}
      <div class="analysis"><b>答案：</b>${esc(answerText(q.type, q.answer))}${q.analysis ? `\n<b>解析：</b>${esc(q.analysis)}` : ''}</div>
    </div>`;
}

function isRightOption(q, L) {
  const a = q.answer;
  if (Array.isArray(a)) return a.includes(L);
  return String(a) === L;
}

/* ------------------------------ 试卷列表与答题 ------------------------------ */

async function loadPapers() {
  try {
    const { papers } = await api('/papers');
    state.papers = papers;
    renderPaperList();
  } catch (e) {
    /* 忽略 */
  }
}

/** 左侧试卷列表：受左栏科目导航过滤，按科目分组，组内按时间倒序 */
function renderPaperList() {
  const el = $('#paperList');

  // 科目导航（不受当前选中科目影响，始终列出全部科目）
  const counts = new Map();
  for (const p of state.papers) {
    const k = subjectOf(p);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const navEntries = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  if (state.paperSubject && !counts.has(state.paperSubject)) state.paperSubject = '';
  renderSubjectNav($('#paperSubjectNav'), navEntries, state.paperSubject, (name) => {
    state.paperSubject = name;
    renderPaperList();
  });

  const papers = state.paperSubject
    ? state.papers.filter((p) => subjectOf(p) === state.paperSubject)
    : state.papers;

  if (!papers.length) {
    el.innerHTML = state.papers.length
      ? `<div class="empty">该科目下暂无试卷</div>`
      : `<div class="empty">还没有试卷，先去「生成试卷」吧</div>`;
    return;
  }

  const groups = new Map();
  for (const p of papers) {
    const key = subjectOf(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const ordered = [...groups.entries()]
    .map(([subject, list]) => {
      const sorted = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return { subject, list: sorted, latest: new Date(sorted[0].createdAt).getTime() || 0 };
    })
    .sort((a, b) => b.latest - a.latest);

  const activeId = state.paper && state.paper.id;
  // 当前选中试卷所在分组始终展开
  const activeSubject = state.paper ? String(state.paper.subject || '').trim() || '未分类' : '';

  el.innerHTML = ordered
    .map(({ subject, list }) => {
      const collapsed = subject === activeSubject ? false : Boolean(state.collapsedSubjects[subject]);
      return `
      <div class="paper-group${collapsed ? ' collapsed' : ''}">
        <div class="group-head" data-subject="${esc(subject)}" title="点击展开 / 收起">
          <span class="arrow">▾</span>
          <span class="gname">${esc(subject)}</span>
          <span class="gcount">${list.length} 份</span>
        </div>
        <div class="group-body">
          ${list
            .map(
              (p) => `
          <div class="list-item ${activeId === p.id ? 'active' : ''}" data-paper="${p.id}">
            <div class="t">${esc(p.title)}</div>
            <div class="m">${p.questionCount} 题 · ${p.totalPoints} 分 · ${esc(p.difficulty)}</div>
            <div class="m ${p.stats ? 'done' : ''}">${attemptLine(p.stats)}</div>
          </div>`
            )
            .join('')}
        </div>
      </div>`;
    })
    .join('');

  $$('#paperList .group-head').forEach((head) =>
    head.addEventListener('click', () => {
      const key = head.dataset.subject;
      state.collapsedSubjects[key] = !state.collapsedSubjects[key];
      renderPaperList();
    })
  );
  $$('#paperList .list-item').forEach((item) =>
    item.addEventListener('click', () => openPaper(item.dataset.paper))
  );
}

async function openPaper(id) {
  try {
    const [paperRes, subRes] = await Promise.all([
      api(`/papers/${id}?mode=exam`),
      api(`/submissions?paperId=${encodeURIComponent(id)}`).catch(() => ({ submissions: [] })),
    ]);
    state.paper = paperRes.paper;
    state.paperSubmissions = subRes.submissions || [];
    state.answers = {};
    state.examIndex = 0;
    state.result = null;
    state.viewingHistory = false;
    renderPaperList();
    renderExam();
  } catch (e) {
    toast(e.message, true);
  }
}

/** 试卷的做题情况：已做 N 次 · 最近 X 分（时间）· 最好 Y 分 */
function attemptLine(stats) {
  if (!stats || !stats.attempts) return '未作答';
  return `已做 ${stats.attempts} 次 · 最近 ${stats.lastScore}/${stats.lastTotalScore} 分 · ${fmtTime(stats.lastAt)}`;
}

/** 后台评卷完成后，刷新当前试卷的历次答卷 */
async function refreshPaperSubmissions(paperId) {
  try {
    const { submissions } = await api(`/submissions?paperId=${encodeURIComponent(paperId)}`);
    state.paperSubmissions = submissions || [];
  } catch (_) {
    /* 刷新失败不影响结果展示 */
  }
}

/** 当前试卷的历史记录（最近 10 条） */
function currentPaperStats() {
  return (state.papers.find((p) => p.id === (state.paper && state.paper.id)) || {}).stats || null;
}

/**
 * 答题页：一次只显示一道题（单题作答），配合题号答题卡与上一题 / 下一题，
 * 做题过程不需要整卷下滑；切换题目时会自动回到顶部。
 */
function renderExam() {
  const p = state.paper;
  const pane = $('#examPane');
  if (!p) {
    pane.innerHTML = `<div class="card"><div class="empty">从左侧选择一份试卷开始答题</div></div>`;
    return;
  }
  if (state.result) {
    renderResult();
    return;
  }
  const total = p.questions.reduce((s, q) => s + q.points, 0);
  const stats = currentPaperStats();
  const grading = Boolean(state.grading && state.grading.paperId === p.id);
  state.examIndex = Math.max(0, Math.min(p.questions.length - 1, state.examIndex || 0));
  qNavSig = ''; // 整页重绘，答题卡签名失效
  clearTimeout(autoNextTimer);
  autoNextTimer = null;

  pane.innerHTML = `
    ${grading ? `<div class="card" id="gradingBar">${gradingBarHTML()}</div>` : ''}
    <div class="card">
      <div class="side-head">
        <div>
          <h2>${esc(p.title)}</h2>
          <div class="hint">共 ${p.questions.length} 题 · ${total} 分 · 建议用时 ${p.duration} 分钟${
            stats ? ` · ${attemptLine(stats)}` : ''
          }</div>
        </div>
        <div class="exam-tools">
          <label class="check-line" title="单选题 / 判断题选择后自动进入下一题">
            <input type="checkbox" id="autoNextToggle" ${state.autoNext ? 'checked' : ''} />
            <span>答完自动下一题</span>
          </label>
          <button class="primary" id="btnSubmitExam" ${grading ? 'disabled' : ''}>
            ${grading ? '后台评卷中…' : '提交并评卷'}
          </button>
        </div>
      </div>
      ${qNavHTML()}
      <div id="qPane">${questionPaneHTML()}</div>
      ${examFooterHTML()}
    </div>
    ${paperAttemptsHTML()}`;
  $('#btnSubmitExam').addEventListener('click', submitExam);
  const autoNext = $('#autoNextToggle');
  if (autoNext) {
    autoNext.addEventListener('change', (e) => {
      state.autoNext = e.target.checked;
      try {
        localStorage.setItem('exam.autoNext', state.autoNext ? '1' : '0');
      } catch (_) {
        /* 忽略存储失败 */
      }
    });
  }
}

/** 某题是否已作答 */
function isAnswered(q) {
  const a = state.answers[q.id];
  if (a == null || a === '') return false;
  if (Array.isArray(a)) return a.some((x) => String(x).trim() !== '');
  return String(a).trim() !== '';
}

/** 题号答题卡：已作答 / 当前题高亮，点击跳转 */
function qNavHTML() {
  const p = state.paper;
  const idx = state.examIndex;
  const answered = p.questions.filter(isAnswered).length;
  return `
    <div class="q-nav-wrap">
      <div class="q-nav" id="qNav">
        ${p.questions
          .map(
            (q, i) =>
              `<button class="q-dot ${isAnswered(q) ? 'done' : ''} ${i === idx ? 'cur' : ''}" data-act="goto" data-i="${i}" title="第 ${
                i + 1
              } 题 · ${isAnswered(q) ? '已作答' : '未作答'}">${i + 1}</button>`
          )
          .join('')}
      </div>
      <div class="q-nav-meta">已答 <b>${answered}</b> / ${p.questions.length} 题</div>
    </div>`;
}

/** 当前题的内容 */
function questionPaneHTML() {
  const p = state.paper;
  const i = state.examIndex;
  return `<div class="single-q">${questionExamHTML(p.questions[i], i)}</div>`;
}

/** 底部导航：上一题 / 下一题（最后一题变成交卷） */
function examFooterHTML() {
  const p = state.paper;
  const i = state.examIndex;
  const isFirst = i === 0;
  const isLast = i >= p.questions.length - 1;
  const grading = Boolean(state.grading && state.grading.paperId === p.id);
  return `
    <div class="exam-footer" id="examFooter">
      <button class="ghost" data-act="prev" ${isFirst ? 'disabled' : ''}>上一题</button>
      <span class="hint">第 ${i + 1} / ${p.questions.length} 题</span>
      ${
        isLast
          ? `<button class="primary" data-act="submit" ${grading ? 'disabled' : ''}>提交并评卷</button>`
          : `<button class="primary" data-act="next">下一题</button>`
      }
    </div>`;
}

/** 切到第 i 题：只重绘题目区、答题卡与底部导航，不整页重绘 */
function gotoQuestion(i) {
  const p = state.paper;
  if (!p || state.result) return;
  clearTimeout(autoNextTimer); // 手动切题时取消待执行的自动跳转
  autoNextTimer = null;
  const next = Math.max(0, Math.min(p.questions.length - 1, Number(i) || 0));
  const qPane = $('#qPane');
  if (!qPane) return renderExam();

  state.examIndex = next;
  qPane.innerHTML = questionPaneHTML();
  const wrap = $('.q-nav-wrap');
  if (wrap) wrap.outerHTML = qNavHTML();
  const foot = $('#examFooter');
  if (foot) foot.outerHTML = examFooterHTML();
  scrollExamTop();
}

function scrollExamTop() {
  const pane = $('#examPane');
  const col = pane && pane.closest('.main-col');
  if (col) col.scrollTo({ top: 0, behavior: 'smooth' });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 答题页的按钮事件（题号跳转 / 上一题 / 下一题 / 交卷） */
function onExamClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (!['goto', 'prev', 'next', 'submit'].includes(act)) return;
  if (state.result) return;

  if (act === 'goto') return gotoQuestion(Number(btn.dataset.i));
  if (act === 'prev') return gotoQuestion(state.examIndex - 1);
  if (act === 'next') return gotoQuestion(state.examIndex + 1);
  if (act === 'submit') return submitExam();
}

/* ------------------------------ 后台评卷 ------------------------------ */

/** 提交后由服务端后台排队评卷：这里只负责展示进度，不再阻塞页面 */
function gradingBarHTML() {
  const g = state.grading;
  if (!g) return '';
  const seconds = Math.round((Date.now() - (g.startedAt || Date.now())) / 1000);
  const where = g.status === 'queued' ? `队列中第 ${g.position} 位（前面还有 ${g.waiting - 1} 个任务）` : 'AI 正在评卷';
  const prog = g.progress ? ` · ${g.progress.phase} · 已输出 ${g.progress.chars} 字` : '';
  return `
    <div class="grading-bar">
      <div class="spinner small"></div>
      <div class="g-text">
        <div class="g-title">已提交，服务端后台评卷中（同一时刻只评一份，其余排队）</div>
        <div class="g-meta">${esc(where)} · 已等待 ${seconds} 秒${esc(prog)}</div>
      </div>
    </div>`;
}

/** 只刷新进度条本身，避免重绘整页打断作答 */
function renderGradingBar() {
  const el = $('#gradingBar');
  if (el) el.innerHTML = gradingBarHTML();
  updateQueueTag();
}

/** 顶栏提示：切到其他页也能看到还有评卷在跑 */
function updateQueueTag() {
  const tag = $('#queueTag');
  if (!tag) return;
  const g = state.grading;
  tag.classList.toggle('hidden', !g);
  tag.textContent = !g ? '' : g.status === 'running' ? '后台评卷中…' : `评卷排队中（第 ${g.position} 位）`;
}

function questionExamHTML(q, i) {
  const saved = state.answers[q.id];
  let body = '';
  if (q.type === 'single' || q.type === 'multiple') {
    const type = q.type === 'single' ? 'radio' : 'checkbox';
    body = `<div class="options">${(q.options || [])
      .map((o, j) => {
        const L = letter(j);
        const checked = q.type === 'single' ? saved === L : Array.isArray(saved) && saved.includes(L);
        return `<label class="opt"><input type="${type}" name="${q.id}" value="${L}" ${checked ? 'checked' : ''} /><span class="letter">${L}.</span><span>${esc(o)}</span></label>`;
      })
      .join('')}</div>`;
  } else if (q.type === 'judge') {
    body = `<div class="options">
      <label class="opt"><input type="radio" name="${q.id}" value="true" ${saved === 'true' ? 'checked' : ''} /><span>正确</span></label>
      <label class="opt"><input type="radio" name="${q.id}" value="false" ${saved === 'false' ? 'checked' : ''} /><span>错误</span></label>
    </div>`;
  } else if (q.type === 'blank' || q.type === 'fillcode') {
    const n = Math.max(1, q.blankCount || (Array.isArray(q.answer) ? q.answer.length : 1) || 1);
    const arr = Array.isArray(saved) ? saved : [];
    body = `<div class="blank-inputs">${Array.from({ length: n })
      .map(
        (_, j) =>
          `<input class="${q.type === 'fillcode' ? 'code-input' : ''}" name="${q.id}" placeholder="第 ${
            j + 1
          } 空（补全代码）" value="${esc(arr[j] || '')}" spellcheck="false" />`
      )
      .join('')}</div>`;
  } else {
    body = answerBox(q, saved, q.id);
  }

  return `
    <div class="q-block">
      <div class="q-head">
        <span class="q-index">第 ${i + 1} 题</span>
        <span class="q-type">${TYPE_LABELS[q.type] || q.type}</span>
        <span class="q-points">${q.points} 分</span>
      </div>
      <div class="q-stem">${esc(q.stem)}</div>
      ${materialHTML(q)}
      ${codeHTML(q)}
      ${body}
    </div>`;
}

function onAnswerInput(e) {
  const qid = e.target.name;
  if (!qid || !state.paper) return;
  const q = state.paper.questions.find((x) => x.id === qid);
  if (!q) return;

  if (q.type === 'multiple') {
    state.answers[qid] = $$(`input[name="${qid}"]:checked`, $('#examPane')).map((el) => el.value);
  } else if (q.type === 'blank' || q.type === 'fillcode') {
    state.answers[qid] = $$(`input[name="${qid}"]`, $('#examPane')).map((el) => el.value);
  } else if (e.target.type === 'radio' || e.target.type === 'checkbox') {
    state.answers[qid] = e.target.checked ? e.target.value : '';
  } else {
    state.answers[qid] = e.target.value;
  }

  refreshQNav(); // 答题卡同步「已答」

  // 单选 / 判断题选完后自动进入下一题（可在答题页关掉）
  // 注意：radio 会同时触发 input 与 change，这里必须去重，否则会连跳两题
  const choiceDone = (q.type === 'single' || q.type === 'judge') && e.target.type === 'radio' && e.target.checked;
  if (choiceDone && state.autoNext && state.examIndex < state.paper.questions.length - 1) {
    const from = state.examIndex;
    clearTimeout(autoNextTimer);
    autoNextTimer = setTimeout(() => {
      autoNextTimer = null;
      // 期间若用户已手动切题，就不要再跳
      if (state.examIndex === from && !state.result) gotoQuestion(from + 1);
    }, 260);
  }
}

/** 只刷新答题卡（已答状态 / 已答计数），不重绘题目，避免打断作答 */
function refreshQNav() {
  if (!state.paper) return;
  const sig = state.paper.questions.map((q) => (isAnswered(q) ? '1' : '0')).join('');
  if (sig === qNavSig) return; // 已答状态没变就不用重绘
  qNavSig = sig;
  const wrap = $('.q-nav-wrap');
  if (wrap) wrap.outerHTML = qNavHTML();
}

/** 提交答卷：服务端立即入队返回任务 id，评卷在后台串行执行，页面不再等待 */
async function submitExam() {
  const p = state.paper;
  if (!p) return;
  if (state.grading && state.grading.paperId === p.id) return toast('该答卷已在后台评卷，请稍候', true);

  const unanswered = p.questions.filter((q) => !isAnswered(q));
  if (unanswered.length && !confirm(`还有 ${unanswered.length} 道题未作答，确定提交吗？`)) return;

  try {
    const data = await api(`/papers/${p.id}/grade`, {
      method: 'POST',
      body: JSON.stringify({ answers: state.answers }),
    });
    const job = data.job || {};
    state.grading = {
      jobId: job.id,
      paperId: p.id,
      status: job.status || 'queued',
      position: job.position || 1,
      waiting: job.waiting || 1,
      progress: job.progress || null,
      startedAt: Date.now(),
      fails: 0,
    };
    renderExam();
    startGradingPoll();
    toast(data.duplicated ? '该试卷有评卷任务在进行中，已接入原任务' : '已提交，服务端后台排队评卷');
  } catch (e) {
    toast(e.message, true);
  }
}

let gradingTimer = null;
let gradingBusy = false;
/** 连续查询失败这么多次后放弃（避免服务不可用时无限轮询） */
const GRADING_MAX_FAILS = 20;

function startGradingPoll() {
  stopGradingPoll();
  gradingTimer = setInterval(pollGrading, 2000);
  updateQueueTag();
  pollGrading();
}

function stopGradingPoll() {
  clearInterval(gradingTimer);
  gradingTimer = null;
}

/** 轮询后台评卷任务；完成后直接把结果渲染到答题页 */
async function pollGrading() {
  if (!state.grading) return stopGradingPoll();
  if (gradingBusy) return;
  gradingBusy = true;
  try {
    const data = await api(`/jobs/${state.grading.jobId}`);
    const job = data.job;
    const g = state.grading;
    if (!job) {
      state.grading = null;
      stopGradingPoll();
      updateQueueTag();
      if (state.view === 'exam') renderExam();
      return;
    }

    g.status = job.status;
    g.position = job.position;
    g.waiting = job.waiting;
    g.progress = job.progress || null;

    if (job.status === 'done') {
      state.grading = null;
      stopGradingPoll();
      const submission = data.submission || null;
      // 只有仍停留在同一份试卷时才切到结果页，否则只刷新列表与提示
      const mine = Boolean(submission && state.paper && state.paper.id === submission.paperId);
      if (mine) {
        state.result = submission;
        state.viewingHistory = false;
      }
      loadPapers();
      loadMistakes();
      loadHistory();
      if (mine) refreshPaperSubmissions(submission.paperId);
      if (state.view === 'exam') renderExam();
      updateQueueTag();
      const masteredCount = data.mastered || 0;
      const masteredTip = masteredCount ? `，消灭错题 ${masteredCount} 道` : '';
      toast(mine ? `评卷完成${masteredTip}` : `评卷完成${masteredTip}，可在「做题历史」查看结果`);
      return;
    }

    if (job.status === 'error') {
      state.grading = null;
      stopGradingPoll();
      if (state.view === 'exam') renderExam();
      updateQueueTag();
      toast(job.error || '评卷失败', true);
      return;
    }

    renderGradingBar();
  } catch (e) {
    if (!state.grading) return;
    state.grading.fails = (state.grading.fails || 0) + 1;
    if (state.grading.fails >= GRADING_MAX_FAILS) {
      state.grading = null;
      stopGradingPoll();
      if (state.view === 'exam') renderExam();
      updateQueueTag();
      toast('评卷进度查询失败，请稍后到「做题历史」查看结果', true);
    }
  } finally {
    gradingBusy = false;
  }
}

function renderResult() {
  const r = state.result;
  const chips = (r.weakPoints || []).map((w) => `<span class="chip-item">${esc(w)}</span>`).join('');
  $('#examPane').innerHTML = `
    <div class="card">
      <div class="score-card">
        <div>
          <div class="score-num">${r.earnedScore}</div>
          <div class="score-meta">/ ${r.totalScore} 分</div>
        </div>
        <div class="score-text">
          <div><b>正确率 ${r.accuracy}%</b> · 答对 ${r.correctCount} / ${r.questionCount} 题</div>
          <div class="hint">${r.createdAt ? `${fmtTime(r.createdAt)} · ` : ''}${esc(r.summary || '')}</div>
        </div>
      </div>
      ${chips ? `<div class="side-head"><h2>薄弱知识点</h2></div><div class="chips">${chips}</div>` : ''}
      ${r.advice ? `<div class="analysis"><b>复习建议：</b>${esc(r.advice)}</div>` : ''}
      <div class="actions" style="margin:16px 0">
        <button class="ghost" id="btnRetry">重新作答</button>
        ${state.viewingHistory ? `<button class="ghost" id="btnBackHistory">返回做题历史</button>` : ''}
        <span class="total">错题已自动收入错题本，可在「错题本」中改错${
          r.masteredCount ? `；本次做对并消灭错题 ${r.masteredCount} 道（含同知识点的错题）` : ''
        }</span>
      </div>
    </div>
    <div class="card">
      <h2>逐题解析</h2>
      ${r.details.map((d, i) => resultItemHTML(d, i)).join('')}
    </div>`;
  $('#btnRetry').addEventListener('click', () => {
    state.result = null;
    state.viewingHistory = false;
    state.answers = {};
    state.examIndex = 0;
    renderExam();
  });
  const back = $('#btnBackHistory');
  if (back) back.addEventListener('click', () => switchView('history'));
}

function resultItemHTML(d, i) {
  let body = '';
  if (d.type === 'single' || d.type === 'multiple') {
    const mine = Array.isArray(d.studentAnswer) ? d.studentAnswer : [d.studentAnswer].filter(Boolean);
    const right = Array.isArray(d.correctAnswer) ? d.correctAnswer : [d.correctAnswer];
    body = `<div class="options">${(d.options || [])
      .map((o, j) => {
        const L = letter(j);
        const cls = right.includes(L) ? 'correct' : mine.includes(L) ? 'wrong' : '';
        return `<div class="opt ${cls}"><span class="letter">${L}.</span><span>${esc(o)}</span></div>`;
      })
      .join('')}</div>`;
  }

  return `
    <div class="result-item ${d.isCorrect ? 'right' : 'wrong'}">
      <div class="q-head">
        <span class="q-index">第 ${i + 1} 题</span>
        <span class="q-type">${TYPE_LABELS[d.type] || d.type}</span>
        <span class="tag ${d.isCorrect ? 'ok' : 'no'}">${d.score} / ${d.points} 分</span>
        ${d.byAI ? `<span class="tag">AI 评分</span>` : ''}
        ${
          d.knowledgeMastered > 1
            ? `<span class="tag ok" title="做对本题后，错题本中同知识点的错题已标记为已掌握">知识点已掌握 · 消灭 ${d.knowledgeMastered} 道错题</span>`
            : d.mistakeMastered
            ? `<span class="tag ok" title="这道题已在错题本中标记为已掌握">错题已掌握</span>`
            : ''
        }
        ${d.knowledge ? `<span class="tag">${esc(d.knowledge)}</span>` : ''}
      </div>
      <div class="q-stem">${esc(d.stem)}</div>
      ${materialHTML(d)}
      ${codeHTML(d)}
      ${body}
      <div class="answer-row">
        <span class="${d.isCorrect ? '' : 'mine'}"><b>你的答案：</b>${esc(answerText(d.type, d.studentAnswer))}</span>
        <span class="std"><b>正确答案：</b>${esc(d.correctAnswerText)}</span>
      </div>
      ${d.comment ? `<div class="comment"><b>点评：</b>${esc(d.comment)}</div>` : ''}
      ${d.analysis ? `<div class="analysis"><b>解析：</b>${esc(d.analysis)}</div>` : ''}
    </div>`;
}

/* ------------------------------ 做题历史 ------------------------------ */

async function loadHistory() {
  try {
    state.history = await api('/history');
    if (state.view === 'history') renderHistory();
  } catch (_) {
    /* 忽略 */
  }
}

/** 一次做题记录：得分 / 正确率 / 做题时间 / 查看 */
function historyRowHTML(s, withSubject = true) {
  const title = s.paperTitle || '试卷';
  return `
    <div class="history-row">
      <div class="h-main">
        <div class="h-title" title="${esc(title)}">${esc(title)}</div>
        <div class="h-meta">${withSubject ? `${esc(subjectOf(s))} · ` : ''}答对 ${s.correctCount ?? 0} / ${
    s.questionCount ?? 0
  } 题 · 正确率 ${s.accuracy ?? 0}%</div>
      </div>
      <div class="h-col">
        <div class="h-k">得分</div>
        <div class="h-score">${s.earnedScore}<span class="h-total"> / ${s.totalScore}</span></div>
      </div>
      <div class="h-col">
        <div class="h-k">做题时间</div>
        <div class="h-time">${fmtTime(s.createdAt)}</div>
      </div>
      <button class="ghost small" data-act="view" data-sub="${s.id}" data-paper="${s.paperId || ''}">查看</button>
    </div>`;
}

/** 科目维度：做题次数 / 最近做题时间 / 最近成绩 */
function subjectRowHTML(s) {
  return `
    <div class="history-row">
      <div class="h-main">
        <div class="h-title">${esc(s.subject)}</div>
        <div class="h-meta">做题 ${s.attempts} 次 · ${s.papers} 份试卷 · 平均正确率 ${s.avgAccuracy}% · 最好 ${
    s.bestScore
  } 分</div>
      </div>
      <div class="h-col">
        <div class="h-k">最近成绩</div>
        <div class="h-score">${s.lastScore}<span class="h-total"> / ${s.lastTotalScore}</span></div>
      </div>
      <div class="h-col">
        <div class="h-k">最近做题</div>
        <div class="h-time">${fmtTime(s.lastAt)}</div>
      </div>
    </div>`;
}

/** 当前试卷的历史做题记录（答题页底部） */
function paperAttemptsHTML() {
  const list = state.paperSubmissions || [];
  if (!list.length) return '';
  const sorted = [...list].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return `
    <div class="card">
      <div class="side-head">
        <h2>本卷做题记录</h2>
        <span class="hint">共 ${sorted.length} 次</span>
      </div>
      ${sorted.map((s) => historyRowHTML(s, false)).join('')}
    </div>`;
}

function renderHistory() {
  const el = $('#historyPane');
  const h = state.history;
  if (!h) return;
  const { overview, bySubject, records } = h;

  if (!records.length) {
    $('#historySubjectNav').innerHTML = '';
    el.innerHTML = `<div class="card"><div class="empty">还没有做题记录，先去「答题评卷」做一份试卷吧</div></div>`;
    return;
  }

  // 左栏科目导航：按做题次数排序，点击只看该科目
  if (state.historySubject && !bySubject.some((s) => s.subject === state.historySubject)) {
    state.historySubject = '';
  }
  renderSubjectNav(
    $('#historySubjectNav'),
    bySubject.map((s) => ({ name: s.subject, count: s.attempts })),
    state.historySubject,
    (name) => {
      state.historySubject = name;
      renderHistory();
    }
  );

  const subjectRows = state.historySubject ? bySubject.filter((s) => s.subject === state.historySubject) : bySubject;
  const rows = state.historySubject ? records.filter((r) => subjectOf(r) === state.historySubject) : records;

  el.innerHTML = `
    <div class="card">
      <div class="side-head">
        <h2>做题总览</h2>
        <span class="hint">累计 ${overview.attempts} 次</span>
      </div>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="k">做题次数</div>
          <div class="v">${overview.attempts}</div>
          <div class="s">${overview.papers} 份试卷 · ${overview.subjects} 个科目</div>
        </div>
        <div class="stat-box">
          <div class="k">最近成绩</div>
          <div class="v">${overview.lastScore ?? '—'}<span class="v-sub"> / ${overview.lastTotalScore ?? '—'}</span></div>
          <div class="s">正确率 ${overview.lastAccuracy ?? '—'}%</div>
        </div>
        <div class="stat-box">
          <div class="k">最近做题时间</div>
          <div class="v v-sm">${fmtTime(overview.lastAt) || '—'}</div>
          <div class="s" title="${esc(overview.lastPaperTitle || '')}">${esc(overview.lastPaperTitle || '')}</div>
        </div>
        <div class="stat-box">
          <div class="k">平均正确率</div>
          <div class="v">${overview.avgAccuracy}%</div>
          <div class="s">全部记录平均</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="side-head">
        <h2>按科目统计</h2>
        <span class="hint">做题次数 · 最近做题时间 · 最近成绩</span>
      </div>
      ${subjectRows.map((s) => subjectRowHTML(s)).join('')}
    </div>

    <div class="card">
      <div class="side-head">
        <h2>做题记录</h2>
        <span class="hint">共 ${rows.length} 条${state.historySubject ? `（${esc(state.historySubject)}）` : ''}</span>
      </div>
      ${rows.map((r) => historyRowHTML(r)).join('')}
    </div>`;
}

/** 打开某次历史答卷：载入该次结果与对应试卷，在答题页展示 */
async function openSubmission(subId, paperId) {
  if (!subId) return;
  try {
    const [subRes, paperRes] = await Promise.all([
      api(`/submissions/${subId}`),
      paperId ? api(`/papers/${paperId}`).catch(() => ({ paper: null })) : Promise.resolve({ paper: null }),
    ]);
    if (paperRes.paper) state.paper = paperRes.paper;
    state.result = subRes.submission;
    state.viewingHistory = true;
    switchView('exam');
    renderExam();
  } catch (e) {
    toast(e.message, true);
  }
}

function onHistoryClick(e) {
  const btn = e.target.closest('button[data-act="view"]');
  if (!btn) return;
  openSubmission(btn.dataset.sub, btn.dataset.paper);
}

/* ------------------------------ 复习 / 闪卡（间隔重复） ------------------------------ */

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function loadReviews() {
  const base = state.reviewSubject ? `?subject=${encodeURIComponent(state.reviewSubject)}` : '';
  const dueUrl = `/reviews${base ? `${base}&due=1` : '?due=1'}`;
  try {
    // 两次请求：全量用于卡片库与统计；due=1 由服务端按知识点交错好，用作复习队列
    const [all, due] = await Promise.all([api('/reviews' + base), api(dueUrl)]);
    state.reviewCards = all.cards;
    state.reviewStats = all.stats;
    state.reviewDue = due.cards;
    state.reviewById = new Map([...all.cards, ...due.cards].map((c) => [c.id, c]));
    $('#reviewBadge').textContent = all.stats.due ? String(all.stats.due) : '';
    if (state.view === 'review') renderReviews();
  } catch (e) {
    /* 忽略 */
  }
}

/** 今天的复习队列（服务端已交错；兜底在前端过滤） */
function reviewDueCards() {
  if (state.reviewDue && state.reviewDue.length) return state.reviewDue;
  const today = todayStr();
  return state.reviewCards
    .filter((c) => String(c.due || today) <= today)
    .sort((a, b) => String(a.due || '').localeCompare(String(b.due || '')) || (b.lapses || 0) - (a.lapses || 0));
}

/** 重置当前卡片的所有交互态（面板 / 草稿 / 判定结果 / 揭晓） */
function resetCardUI() {
  state.reviewRevealed = false;
  state.reviewPanel = '';
  state.reviewShowOptions = false;
  state.reviewFeynmanText = '';
  state.reviewDraft = {};
  state.reviewFeedback = null;
  state.reviewWhyOpen = false;
}

function startReviewSession(cards) {
  const list = (cards || []).slice(0, 30);
  if (!list.length) return toast('今天没有需要复习的卡片', true);
  state.reviewSession = { queue: list.map((c) => c.id), pos: 0, done: 0, known: 0, fuzzy: 0, forgot: 0, correct: 0 };
  resetCardUI();
  renderReviews();
}

function renderReviewStats() {
  const st = state.reviewStats;
  const el = $('#reviewStats');
  if (!st) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <span class="rs"><b>${st.due}</b> 今日待复习</span>
    <span class="rs"><b>${st.total}</b> 卡片总数</span>
    <span class="rs"><b>${st.mastery}%</b> 平均掌握度</span>
    <span class="rs"><b>${st.learned}</b> 已进入长间隔</span>
    <span class="rs"><b>${st.leeches}</b> 顽固卡</span>
    <span class="rs"><b>${st.reviews}</b> 累计复习次数</span>
    <span class="rs"><b>${st.lapses}</b> 累计遗忘</span>`;
}

/** 记忆看板：未来 7 天到期预测 + 遗忘风险榜 + 错因分布 */
function renderReviewBoard() {
  const el = $('#reviewBoard');
  const st = state.reviewStats;
  if (!el) return;
  if (!st || !st.total) {
    el.innerHTML = '';
    return;
  }

  const max = Math.max(1, ...st.forecast.map((f) => f.count));
  const bars = st.forecast
    .map(
      (f) => `
      <div class="fx-bar" title="${f.date} · ${f.count} 张">
        <div class="fx-col"><i style="height:${Math.round((f.count / max) * 100)}%"></i></div>
        <span class="fx-n">${f.count}</span>
        <span class="fx-d">${f.date.slice(5)}</span>
      </div>`
    )
    .join('');

  const risky = (st.risky || [])
    .slice(0, 6)
    .map(
      (r) =>
        `<div class="risk-row"><span class="rk">${esc(r.knowledge)}</span><span class="rd">逾期 ${r.due} · 遗忘 ${r.lapses} · 间隔 ${r.avgInterval} 天 · 掌握 ${r.avgMastery}%</span></div>`
    )
    .join('');

  const errs = (st.errorTypes || [])
    .slice(0, 8)
    .map((e) => `<span class="chip-item">${esc(e.type)} ${e.count}</span>`)
    .join('');

  el.innerHTML = `
    <div class="board">
      <div class="board-box">
        <div class="board-title">未来 7 天到期预测</div>
        <div class="fx">${bars}</div>
      </div>
      <div class="board-box">
        <div class="board-title">遗忘风险榜（优先复习）</div>
        ${risky || '<div class="doc-empty">暂无数据</div>'}
      </div>
      ${errs ? `<div class="board-box"><div class="board-title">错因分布</div><div class="chips">${errs}</div></div>` : ''}
    </div>`;
}

function renderReviewNav() {
  const entries = ((state.reviewStats && state.reviewStats.bySubject) || []).map((b) => ({
    name: b.subject,
    count: b.count,
  }));
  renderSubjectNav($('#reviewSubjectNav'), entries, state.reviewSubject, (name) => {
    state.reviewSubject = name;
    state.reviewSession = null;
    state.reviewRevealed = false;
    loadReviews();
  });
}

function renderReviews() {
  renderReviewStats();
  renderReviewNav();
  renderReviewBoard();

  const el = $('#reviewPane');
  if (state.reviewMode === 'all' || state.reviewMode === 'leech') {
    el.innerHTML = allCardsHTML();
    return;
  }

  const s = state.reviewSession;
  if (!s || !s.queue.length) {
    const due = reviewDueCards();
    el.innerHTML = due.length
      ? `<div class="review-start">
           <p class="hint">今天有 <b>${due.length}</b> 张卡片需要复习（共 ${state.reviewCards.length} 张卡片）。</p>
           <button class="primary" data-act="start">开始复习</button>
         </div>`
      : `<div class="empty">${
          state.reviewCards.length
            ? '今天的复习已完成，休息一下。'
            : '还没有复习卡片：点上方「同步错题本」，把错题变成闪卡。'
        }</div>`;
    return;
  }

  if (s.pos >= s.queue.length) {
    el.innerHTML = `<div class="empty">本轮复习完成：复习 ${s.done} 次 · 记得 ${s.known} · 模糊 ${s.fuzzy} · 忘了 ${s.forgot}
      <div class="flash-actions"><button class="ghost" data-act="restart">再复习一遍</button></div></div>`;
    return;
  }

  const card = state.reviewById.get(s.queue[s.pos]);
  if (!card) {
    s.pos += 1;
    renderReviews();
    return;
  }
  el.innerHTML = flashCardHTML(card, s);
}

/* ---------- 卡片各面板 ---------- */

/** 选择题选项：默认隐藏，逼自己先回忆（生成效应） */
function flashOptionsHTML(card) {
  const options = (card.detail || {}).options || [];
  if (!options.length) return '';
  if (state.reviewPanel === 'answer') return '';
  if (!state.reviewShowOptions && !state.reviewRevealed) {
    return `<div class="opt-hidden"><button class="ghost small" data-act="show-options">先自己想，点这里看选项（${options.length} 个）</button></div>`;
  }
  return `<div class="options">${options
    .map((o, j) => `<div class="opt static"><span class="letter">${letter(j)}.</span><span>${esc(o)}</span></div>`)
    .join('')}</div>`;
}

/** 通用作答控件（复习作答 / 错题重做共用）；attr 决定事件用哪个 data 属性定位 */
function answerControlsHTML(q, key, draft, attr = 'data-rc') {
  const A = `${attr}="${key}"`;
  if (q.type === 'single' || q.type === 'multiple') {
    const type = q.type === 'single' ? 'radio' : 'checkbox';
    return `<div class="options">${(q.options || [])
      .map((o, j) => {
        const L = letter(j);
        const checked = q.type === 'single' ? draft === L : Array.isArray(draft) && draft.includes(L);
        return `<label class="opt"><input type="${type}" name="${key}" value="${L}" ${A} ${
          checked ? 'checked' : ''
        } /><span class="letter">${L}.</span><span>${esc(o)}</span></label>`;
      })
      .join('')}</div>`;
  }
  if (q.type === 'judge') {
    return `<div class="options">
      <label class="opt"><input type="radio" name="${key}" value="true" ${A} ${
      draft === 'true' ? 'checked' : ''
    } /><span>正确</span></label>
      <label class="opt"><input type="radio" name="${key}" value="false" ${A} ${
      draft === 'false' ? 'checked' : ''
    } /><span>错误</span></label>
    </div>`;
  }
  if (q.type === 'blank' || q.type === 'fillcode') {
    const n = Math.max(1, Array.isArray(q.answer) ? q.answer.length : 1);
    const arr = Array.isArray(draft) ? draft : [];
    return `<div class="blank-inputs">${Array.from({ length: n })
      .map((_, j) => `<input ${A} data-idx="${j}" value="${esc(arr[j] || '')}" placeholder="第 ${j + 1} 空" />`)
      .join('')}</div>`;
  }
  return `<textarea class="answer-input" rows="5" ${A} placeholder="写下你的答案（AI 会判定是否达到得分要点）">${esc(
    typeof draft === 'string' ? draft : ''
  )}</textarea>`;
}

/** 「我自己答一遍」的作答控件（客观校准） */
function cardAnswerAreaHTML(card) {
  const d = card.detail || {};
  return answerControlsHTML(
    { type: card.type, options: d.options, answer: d.correctAnswer },
    card.id,
    state.reviewDraft[card.id]
  );
}

/** 挖空回忆：只给提示词，自己补全要点 */
function clozePanelHTML(card) {
  const points = (card.cloze && card.cloze.points) || [];
  if (!points.length) return '<div class="doc-empty">正在生成挖空要点…</div>';
  const arr = Array.isArray(state.reviewDraft[card.id]) ? state.reviewDraft[card.id] : [];
  return `
    <div class="hint">只看提示词，把对应的要点写出来（意思对即可）。</div>
    <div class="cloze-list">
      ${points
        .map(
          (p, i) => `
        <div class="cloze-row">
          <span class="cz-hint">${esc(p.hint)}</span>
          ${
            state.reviewRevealed
              ? `<span class="cz-answer ${clozeHit(arr[i], p.answer) ? 'ok' : 'bad'}">${esc(p.answer)}</span>`
              : `<input data-rc="${card.id}" data-cz="${i}" value="${esc(arr[i] || '')}" placeholder="写出这个要点" />`
          }
        </div>`
        )
        .join('')}
    </div>
    ${
      state.reviewRevealed
        ? `<div class="flash-actions"><button class="primary" data-act="panel" data-panel="">收起</button></div>`
        : `<div class="flash-actions"><button class="primary" data-act="cloze-submit">对答案</button>
             <button class="ghost" data-act="panel" data-panel="">收起</button></div>`
    }`;
}

/** 挖空作答的宽松判定：意思命中即算对 */
function clozeHit(userText, answerText) {
  const norm = (s) =>
    String(s || '')
      .replace(/[\s，。、；：（）()【】「」“”"'’,.;:!?！？—-]/g, '')
      .toLowerCase();
  const u = norm(userText);
  const a = norm(answerText);
  if (!u || !a) return false;
  if (u.includes(a) || a.includes(u)) return true;
  const grams = a.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  return grams.some((g) => g.length >= 2 && u.includes(g));
}

function mnemonicHTML(card, inline = false) {
  const m = card.mnemonic;
  if (!m) {
    return inline
      ? ''
      : `<div class="doc-empty">还没有助记内容。</div>
         <div class="flash-actions"><button class="primary" data-act="gen-mnemonic">生成 AI 助记</button>
           <button class="ghost" data-act="panel" data-panel="">收起</button></div>`;
  }
  return `<div class="mnemonic-box">
      <div><b>助记：</b>${esc(m.mnemonic)}</div>
      ${m.association ? `<div><b>联想：</b>${esc(m.association)}</div>` : ''}
      ${
        (m.keywords || []).length
          ? `<div class="chips">${m.keywords.map((k) => `<span class="chip-item">${esc(k)}</span>`).join('')}</div>`
          : ''
      }
    </div>
    ${
      inline
        ? ''
        : `<div class="flash-actions"><button class="ghost small" data-act="gen-mnemonic" data-refresh="1">换个说法</button>
             <button class="ghost small" data-act="panel" data-panel="">收起</button></div>`
    }`;
}

function feynmanPanelHTML(card) {
  const prev = card.feynman;
  return `<div class="flash-panel">
      <div class="hint">用自己的话把答案讲一遍（不用背原文，讲清要点即可），AI 会按要点评分并指出遗漏。</div>
      <textarea class="answer-input" rows="6" data-rcf="${card.id}" placeholder="例如：这道题考的是……，关键在于……">${esc(
    state.reviewFeynmanText || ''
  )}</textarea>
      ${prev ? `<div class="comment">上次复述：${prev.score} 分 · ${esc(prev.comment || '')}</div>` : ''}
      <div class="flash-actions">
        <button class="primary" data-act="gen-feynman">提交复述并评分</button>
        <button class="ghost" data-act="panel" data-panel="">收起</button>
      </div>
    </div>`;
}

function whyPanelHTML(card) {
  const logs = card.whyLogs || [];
  return `<div class="flash-panel">
      <div class="hint">写下这次为什么没记牢，AI 会归类到固定错因（用于统计与针对性建议）。</div>
      <textarea class="answer-input" rows="3" data-rcw="${card.id}" placeholder="例如：把根本原因和主要原因记混了"></textarea>
      ${
        logs.length
          ? `<div class="hint">历史错因：${logs
              .slice(-3)
              .map((w) => esc(`${w.type}（${w.text}）`))
              .join('；')}</div>`
          : ''
      }
      <div class="flash-actions">
        <button class="primary" data-act="gen-why">提交错因</button>
        <button class="ghost" data-act="panel" data-panel="">收起</button>
      </div>
    </div>`;
}

function flashCardHTML(card, s) {
  const d = card.detail || {};
  const mastery = card.mastery == null ? 0 : card.mastery;
  const isSubjective = ['term', 'short', 'discriminate', 'material', 'essay'].includes(card.type);
  const panel = state.reviewPanel;
  const fb = state.reviewFeedback;

  const feedback = fb
    ? `<div class="flash-feedback ${fb.bad ? 'bad' : 'ok'}">
         <b>${esc(fb.title)}</b>
         ${fb.comment ? `<div>${esc(fb.comment)}</div>` : ''}
         ${fb.correctAnswerText ? `<div class="hint">参考答案：${esc(fb.correctAnswerText)}</div>` : ''}
         <div class="flash-actions"><button class="primary" data-act="next-card">继续下一张</button></div>
       </div>`
    : '';

  let panelHTML = '';
  if (panel === 'answer') {
    panelHTML = `<div class="flash-panel">${cardAnswerAreaHTML(card)}
      <div class="flash-actions">
        <button class="primary" data-act="check">提交作答（按客观结果排期）</button>
        <button class="ghost" data-act="panel" data-panel="">收起</button>
      </div></div>`;
  } else if (panel === 'cloze') {
    panelHTML = `<div class="flash-panel">${clozePanelHTML(card)}</div>`;
  } else if (panel === 'mnemonic') {
    panelHTML = `<div class="flash-panel">${mnemonicHTML(card)}</div>`;
  } else if (panel === 'feynman') {
    panelHTML = `<div class="flash-panel">${feynmanPanelHTML(card)}</div>`;
  } else if (panel === 'why') {
    panelHTML = `<div class="flash-panel">${whyPanelHTML(card)}</div>`;
  }

  const actions =
    panel || fb
      ? ''
      : state.reviewRevealed
        ? `<div class="flash-answer">
             <div class="analysis"><b>答案：</b>${esc(card.back)}</div>
             ${d.analysis ? `<div class="analysis"><b>解析：</b>${esc(d.analysis)}</div>` : ''}
             ${
               d.explanation && d.explanation.idea
                 ? `<div class="comment"><b>讲解：</b>${esc(d.explanation.idea)}</div>`
                 : ''
             }
             ${card.mnemonic ? mnemonicHTML(card, true) : ''}
             ${
               card.feynman
                 ? `<div class="comment"><b>上次费曼复述：</b>${card.feynman.score} 分${
                     card.feynman.comment ? ` · ${esc(card.feynman.comment)}` : ''
                   }</div>`
                 : ''
             }
           </div>
           <div class="flash-actions">
             <button class="ghost danger" data-act="grade" data-result="forgot">忘了</button>
             <button class="ghost" data-act="grade" data-result="fuzzy">模糊</button>
             <button class="primary" data-act="grade" data-result="known">记得</button>
           </div>
           <div class="flash-actions">
             <button class="ghost small" data-act="panel" data-panel="mnemonic">AI 助记</button>
             <button class="ghost small" data-act="panel" data-panel="feynman">费曼复述</button>
             <button class="ghost small" data-act="panel" data-panel="why">记下错因</button>
           </div>`
        : `<div class="flash-actions">
             <button class="primary" data-act="reveal">显示答案（先自己回忆）</button>
             <button class="ghost" data-act="panel" data-panel="answer">我自己答一遍</button>
             ${isSubjective ? `<button class="ghost" data-act="panel" data-panel="cloze">挖空回忆</button>` : ''}
             <button class="ghost" data-act="panel" data-panel="mnemonic">AI 助记</button>
             <button class="ghost" data-act="panel" data-panel="feynman">费曼复述</button>
           </div>`;

  return `
    <div class="flash-card">
      <div class="flash-progress">第 ${s.pos + 1} / ${s.queue.length} 张 · 本轮 记得 ${s.known} · 模糊 ${s.fuzzy} · 忘了 ${
        s.forgot
      } · 作答正确 ${s.correct || 0}</div>
      <div class="q-head">
        <span class="q-type">${card.mode === 'confusion' ? '易混对比' : TYPE_LABELS[card.type] || card.type || '卡片'}</span>
        ${card.knowledge ? `<span class="tag">${esc(card.knowledge)}</span>` : ''}
        ${card.leech ? '<span class="tag no" title="遗忘次数较多，建议换一种记忆方式">顽固卡 · 换种方式记</span>' : ''}
        ${card.paperTitle ? `<span class="q-points">${esc(card.paperTitle)}</span>` : ''}
        <span class="q-points">间隔 ${card.interval || 0} 天 · 复习 ${card.reviews || 0} 次 · 掌握度 ${mastery}%</span>
      </div>
      <div class="q-stem">${esc(card.front)}</div>
      ${d.material ? `<div class="material-box"><b>材料：</b>${esc(d.material)}</div>` : ''}
      ${d.code ? codeHTML(d) : ''}
      ${panel === 'answer' ? '' : flashOptionsHTML(card)}
      ${feedback}
      ${panelHTML}
      ${actions}
    </div>`;
}

function allCardsHTML() {
  const list = state.reviewMode === 'leech' ? state.reviewCards.filter((c) => (c.lapses || 0) >= 4) : state.reviewCards;
  if (!list.length) {
    return state.reviewMode === 'leech'
      ? '<div class="empty">还没有顽固卡（遗忘 4 次以上才会出现在这里）。</div>'
      : '<div class="empty">还没有复习卡片：点上方「同步错题本」，把错题变成闪卡。</div>';
  }
  const today = todayStr();
  return `<div class="list wide">${list
    .map((c) => {
      const due = String(c.due || '');
      return `
    <div class="review-row ${due && due <= today ? 'due' : ''}" data-id="${esc(c.id)}">
      <div class="rr-main">
        <div class="rr-title">${esc(String(c.front || '').split('\n')[0].slice(0, 90))}</div>
        <div class="m">${TYPE_LABELS[c.type] || c.type || '卡片'}${c.knowledge ? ` · ${esc(c.knowledge)}` : ''} · ${esc(
        c.subject || '未分类'
      )} · 到期 ${esc(due || '-')} · 间隔 ${c.interval || 0} 天 · 掌握度 ${c.mastery || 0}% · 记得 ${
        c.streak || 0
      } 次 / 忘 ${c.lapses || 0} 次${c.leech ? ' · <b>顽固卡</b>' : ''}</div>
      </div>
      <div class="ops">
        <button class="ghost small" data-act="review-one">复习</button>
        <button class="ghost small danger" data-act="del-card">删除</button>
      </div>
    </div>`;
    })
    .join('')}</div>`;
}

async function onReviewAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;

  const act = btn.dataset.act;
  const row = btn.closest('.review-row');
  const s = state.reviewSession;
  const id = row ? row.dataset.id : s && s.queue[s.pos];
  const card = id ? state.reviewById.get(id) : null;

  if (act === 'start' || act === 'restart') return startReviewSession(reviewDueCards());

  if (act === 'reveal') {
    state.reviewRevealed = true;
    state.reviewPanel = '';
    return renderReviews();
  }

  if (act === 'show-options') {
    state.reviewShowOptions = true;
    return renderReviews();
  }

  if (act === 'panel') {
    const target = btn.dataset.panel || '';
    state.reviewPanel = state.reviewPanel === target ? '' : target;
    if (target === 'cloze' && card && !((card.cloze || {}).points || []).length) return genCloze(card.id);
    if (target === 'mnemonic' && card && !card.mnemonic) return genMnemonic(card.id);
    return renderReviews();
  }

  if (act === 'cloze-submit') {
    state.reviewRevealed = true;
    return renderReviews();
  }

  if (act === 'check') return submitReviewAnswer(id);
  if (act === 'next-card') return nextCard();
  if (act === 'gen-cloze') return genCloze(id);
  if (act === 'gen-mnemonic') return genMnemonic(id, btn.dataset.refresh === '1');
  if (act === 'gen-feynman') return submitFeynman(id);
  if (act === 'gen-why') return submitWhy(id);

  if (act === 'review-one') {
    const one = state.reviewCards.find((c) => c.id === id);
    if (one) startReviewSession([one]);
    return;
  }

  if (act === 'del-card') {
    if (!confirm('删除这张复习卡片？错题本不受影响。')) return;
    try {
      await api(`/reviews/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.reviewSession = null;
      await loadReviews();
      toast('卡片已删除');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  if (act !== 'grade') return;
  if (!s || !card) return;

  const result = btn.dataset.result;
  try {
    const { card: updated } = await api(`/reviews/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ result }),
    });
    Object.assign(card, updated);
    s[result] = (s[result] || 0) + 1;
    s.done += 1;
    if (result === 'forgot') s.queue.push(id); // 忘了：今天再现一次
    s.pos += 1;
    resetCardUI();
    renderReviews();
    loadReviews(); // 后台刷新统计与角标
  } catch (err) {
    toast(err.message, true);
  }
}

/** 复习页的作答输入（客观校准 / 挖空 / 费曼 / 错因） */
function onReviewInput(e) {
  const el = e.target;
  if (el.dataset.rcf !== undefined) {
    state.reviewFeynmanText = el.value;
    return;
  }
  if (el.dataset.rcw !== undefined) {
    state.reviewWhyText = el.value;
    return;
  }

  const id = el.dataset.rc;
  if (!id) return;
  const card = state.reviewById.get(id);
  if (!card) return;

  // 挖空回忆：每个要点一个输入框
  if (el.dataset.cz !== undefined) {
    const arr = Array.isArray(state.reviewDraft[id]) ? [...state.reviewDraft[id]] : [];
    arr[Number(el.dataset.cz)] = el.value;
    state.reviewDraft[id] = arr;
    return;
  }

  if (card.type === 'multiple') {
    state.reviewDraft[id] = $$(`input[data-rc="${id}"]:checked`, $('#reviewPane')).map((x) => x.value);
  } else if (card.type === 'blank' || card.type === 'fillcode') {
    state.reviewDraft[id] = $$(`input[data-rc="${id}"]`, $('#reviewPane')).map((x) => x.value);
  } else {
    state.reviewDraft[id] = el.value;
  }
}

/** 推进到下一张卡片 */
function nextCard() {
  const s = state.reviewSession;
  if (!s) return;
  s.pos += 1;
  resetCardUI();
  renderReviews();
  loadReviews();
}

/** 「我自己答一遍」：交服务端判定，结果直接决定排期（客观校准自评偏差） */
async function submitReviewAnswer(id) {
  const card = state.reviewById.get(id);
  if (!card) return;
  const answer = state.reviewDraft[id];
  const empty =
    answer == null || answer === '' || (Array.isArray(answer) && answer.every((x) => !String(x || '').trim()));
  if (empty) return toast('先作答再提交', true);

  busy('正在判定…');
  try {
    const r = await api(`/reviews/${encodeURIComponent(id)}/check`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    });
    if (r.card) Object.assign(card, r.card);
    state.reviewFeedback = {
      title: r.correct ? '作答正确，排期已推进' : '作答错误，已回到今天',
      bad: !r.correct,
      comment: r.comment || '',
      correctAnswerText: r.correctAnswerText || '',
    };
    const s = state.reviewSession;
    if (s) {
      s.done += 1;
      if (r.correct) {
        s.correct += 1;
        s.known += 1;
      } else {
        s.forgot += 1;
        s.queue.push(id);
      }
    }
    renderReviews();
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

/** 挖空回忆：让 AI 把答案拆成可提示的要点 */
async function genCloze(id) {
  busy('AI 正在拆解记忆要点…');
  try {
    const { card: updated } = await api(`/reviews/${encodeURIComponent(id)}/cloze`, { method: 'POST' });
    const card = state.reviewById.get(id);
    if (card && updated) Object.assign(card, updated);
    state.reviewPanel = 'cloze';
    state.reviewDraft[id] = [];
    renderReviews();
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

/** AI 助记：口诀 / 首字缩写 / 类比 */
async function genMnemonic(id, refresh = false) {
  busy('AI 正在想助记办法…');
  try {
    const { card: updated } = await api(`/reviews/${encodeURIComponent(id)}/mnemonic`, {
      method: 'POST',
      body: JSON.stringify({ refresh }),
    });
    const card = state.reviewById.get(id);
    if (card && updated) Object.assign(card, updated);
    state.reviewPanel = 'mnemonic';
    renderReviews();
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

/** 费曼复述：讲一遍，AI 按要点评分并据此排期 */
async function submitFeynman(id) {
  const text = String(state.reviewFeynmanText || '').trim();
  if (!text) return toast('先用你自己的话写一遍', true);

  busy('AI 正在按要点评分…');
  try {
    const r = await api(`/reviews/${encodeURIComponent(id)}/feynman`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    const card = state.reviewById.get(id);
    if (card && r.card) Object.assign(card, r.card);
    state.reviewFeedback = {
      title: `费曼复述 ${r.score} 分${r.score >= 80 ? '，讲清楚了' : r.score >= 60 ? '，还有遗漏' : '，需要重来'}`,
      bad: r.score < 60,
      comment: [r.comment, (r.missing || []).length ? `漏掉：${r.missing.join('；')}` : ''].filter(Boolean).join(' · '),
      correctAnswerText: (card && card.back) || '',
    };
    const s = state.reviewSession;
    if (s) {
      s.done += 1;
      if (r.result === 'known') {
        s.known += 1;
        s.correct += 1;
      } else if (r.result === 'fuzzy') s.fuzzy += 1;
      else {
        s.forgot += 1;
        s.queue.push(id);
      }
    }
    renderReviews();
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

/** 错因记录：AI 归类到固定类型，用于统计与建议 */
async function submitWhy(id) {
  const text = String(state.reviewWhyText || '').trim();
  if (!text) return toast('先写下错因', true);

  busy('AI 正在归类错因…');
  try {
    const r = await api(`/reviews/${encodeURIComponent(id)}/why`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    const card = state.reviewById.get(id);
    if (card && r.card) Object.assign(card, r.card);
    state.reviewWhyText = '';
    toast(`已记录：${r.entry.type}${r.entry.advice ? ` · ${r.entry.advice}` : ''}`);
    renderReviews();
    loadReviews();
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

/** 易混对比卡：AI 找出最容易混的知识点组合，生成专项区分卡 */
async function genConfusions() {
  busy('AI 正在找出易混概念…');
  try {
    const r = await api('/reviews/confusions', {
      method: 'POST',
      body: JSON.stringify({ subject: state.reviewSubject }),
    });
    await loadReviews();
    toast(`已生成易混对比卡：新增 ${r.added} 张${r.skipped ? ` · 跳过 ${r.skipped} 张（已存在）` : ''}`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

async function syncReviews() {
  const subject = state.reviewSubject;
  busy('正在把错题同步成闪卡…');
  try {
    const r = await api('/reviews/sync', { method: 'POST', body: JSON.stringify({ subject }) });
    state.reviewSession = null;
    resetCardUI();
    await loadReviews();
    toast(`同步完成：新增 ${r.added} 张${r.updated ? ` · 更新 ${r.updated} 张` : ''}，共 ${r.total} 张`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
  }
}

/* ------------------------------ 错题本 ------------------------------ */

async function loadMistakes() {
  try {
    const { mistakes } = await api('/mistakes');
    state.mistakes = mistakes;
    const unmastered = mistakes.filter((m) => !m.mastered).length;
    $('#mistakeBadge').textContent = unmastered ? String(unmastered) : '';
    if (state.view === 'mistakes') renderMistakes();
  } catch (e) {
    /* 忽略 */
  }
}

function visibleMistakes() {
  if (state.mistakeFilter === 'mastered') return state.mistakes.filter((m) => m.mastered);
  if (state.mistakeFilter === 'unmastered') return state.mistakes.filter((m) => !m.mastered);
  return state.mistakes;
}

/** 取错题的知识点，缺失则归为「未标注知识点」 */
function knowledgeOf(m) {
  return String(m.knowledge || m.question?.knowledge || '').trim() || UNKNOWN_KNOWLEDGE;
}

/**
 * 生成知识点分组函数：把细碎、互相包含的知识点合并到更宽泛（更短）的那一个，
 * 例如「中国式现代化中国特色」并入「中国式现代化」，避免一组只有一道题。
 */
function knowledgeKeyOf(list) {
  const names = [...new Set(list.map(knowledgeOf))]
    .filter((n) => n !== UNKNOWN_KNOWLEDGE)
    .sort((a, b) => a.length - b.length);
  const alias = new Map();
  names.forEach((name, i) => {
    const lower = name.toLowerCase();
    for (let j = 0; j < i; j += 1) {
      const short = names[j];
      // 较短者至少 3 个字，避免「党」这类单字知识点吞掉一堆题目
      if (short.length >= 3 && lower.includes(short.toLowerCase())) {
        alias.set(name, short);
        return;
      }
    }
  });
  return (m) => {
    const k = knowledgeOf(m);
    return alias.get(k) || k;
  };
}

/** 错题本：先按科目分组，科目内再按知识点分组（同一知识点的错题合并为一组） */
function renderMistakes() {
  const el = $('#mistakeList');
  const list = visibleMistakes();
  if (!list.length) {
    el.innerHTML = `<div class="empty">暂无错题。完成评卷后，错题会自动进入这里。</div>`;
    return;
  }

  const keyOf = knowledgeKeyOf(list);
  const timeOf = (m) => new Date(m.lastWrongAt || m.createdAt || 0).getTime();
  const byTime = (a, b) => timeOf(b) - timeOf(a);

  // 科目导航 + 按科目过滤
  const counts = new Map();
  for (const m of list) {
    const k = subjectOf(m);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const navEntries = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  if (state.mistakeSubject && !counts.has(state.mistakeSubject)) state.mistakeSubject = '';
  renderSubjectNav($('#mistakeSubjectNav'), navEntries, state.mistakeSubject, (name) => {
    state.mistakeSubject = name;
    renderMistakes();
  });

  // 科目 → 知识点 两级分组
  const bySubject = new Map();
  for (const m of list) {
    const subject = subjectOf(m);
    if (state.mistakeSubject && subject !== state.mistakeSubject) continue;
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject).push(m);
  }
  if (!bySubject.size) {
    el.innerHTML = `<div class="empty">该科目下暂无错题</div>`;
    return;
  }

  const subjects = [...bySubject.entries()]
    .map(([subject, items]) => {
      const sorted = [...items].sort(byTime);

      const byKnowledge = new Map();
      for (const m of sorted) {
        const k = keyOf(m);
        if (!byKnowledge.has(k)) byKnowledge.set(k, []);
        byKnowledge.get(k).push(m);
      }
      const knowledgeGroups = [...byKnowledge.entries()]
        .map(([knowledge, ms]) => ({
          knowledge,
          items: ms,
          unmastered: ms.filter((m) => !m.mastered).length,
          latest: timeOf(ms[0]),
        }))
        .sort(
          (a, b) =>
            (a.knowledge === UNKNOWN_KNOWLEDGE ? 1 : 0) - (b.knowledge === UNKNOWN_KNOWLEDGE ? 1 : 0) ||
            b.unmastered - a.unmastered ||
            b.items.length - a.items.length ||
            b.latest - a.latest
        );

      return {
        subject,
        items: sorted,
        unmastered: sorted.filter((m) => !m.mastered).length,
        latest: timeOf(sorted[0]),
        knowledgeGroups,
      };
    })
    .sort((a, b) => b.unmastered - a.unmastered || b.items.length - a.items.length || b.latest - a.latest);

  el.innerHTML = subjects
    .map(({ subject, items, unmastered, knowledgeGroups }) => {
      const collapsed = Boolean(state.collapsedMistakeSubjects[subject]);
      const count = `${items.length} 题${unmastered ? ` · 未掌握 ${unmastered}` : ''}`;
      const inner = knowledgeGroups
        .map((g) => {
          const key = `${subject}::${g.knowledge}`;
          const kCollapsed = Boolean(state.collapsedMistakeKnowledges[key]);
          const kCount = `${g.items.length} 题${g.unmastered ? ` · 未掌握 ${g.unmastered}` : ''}`;
          return `
        <div class="paper-group knowledge-group${kCollapsed ? ' collapsed' : ''}">
          <div class="group-head" data-knowledge="${esc(key)}" title="同一知识点的错题：点击展开 / 收起">
            <span class="arrow">▾</span>
            <span class="gname">${esc(g.knowledge)}</span>
            <span class="gcount">${kCount}</span>
          </div>
          <div class="group-body">${g.items.map(mistakeHTML).join('')}</div>
        </div>`;
        })
        .join('');
      return `
      <div class="paper-group mistake-group${collapsed ? ' collapsed' : ''}">
        <div class="group-head" data-subject="${esc(subject)}" title="点击展开 / 收起">
          <span class="arrow">▾</span>
          <span class="gname">${esc(subject)}</span>
          <span class="gcount">${count}</span>
        </div>
        <div class="group-body">${inner}</div>
      </div>`;
    })
    .join('');

  $$('#mistakeList .mistake-group > .group-head').forEach((head) =>
    head.addEventListener('click', () => {
      const key = head.dataset.subject;
      state.collapsedMistakeSubjects[key] = !state.collapsedMistakeSubjects[key];
      renderMistakes();
    })
  );
  $$('#mistakeList .knowledge-group > .group-head').forEach((head) =>
    head.addEventListener('click', () => {
      const key = head.dataset.knowledge;
      state.collapsedMistakeKnowledges[key] = !state.collapsedMistakeKnowledges[key];
      renderMistakes();
    })
  );
}

function mistakeHTML(m) {
  const q = m.question || {};
  const retry = (state.mistakeRetry || {})[m.id];
  // 重做进行中：先不看答案与解析（避免「看懂了」替代「会做了」）
  const hideAnswer = Boolean(retry && !retry.result);

  const options = (q.options || []).length
    ? `<div class="options">${q.options
        .map(
          (o, j) =>
            `<div class="opt ${!hideAnswer && isRightOption(q, letter(j)) ? 'correct' : ''}"><span class="letter">${letter(
              j
            )}.</span><span>${esc(o)}</span></div>`
        )
        .join('')}</div>`
    : '';

  return `
  <div class="mistake-card ${m.mastered ? 'mastered' : ''}" data-id="${m.id}">
    <div class="mistake-head">
      <span class="q-type">${TYPE_LABELS[q.type] || ''}</span>
      <span class="tag">${esc(m.subject || '')}</span>
      <span class="tag ${m.mastered ? 'ok' : 'no'}">${m.mastered ? '已掌握' : `错 ${m.wrongTimes || 1} 次`}</span>
      ${
        m.mastery == null
          ? ''
          : `<span class="tag" title="掌握度：综合连续记得次数、复习间隔与客观作答正确率">掌握度 ${m.mastery}%</span>`
      }
      ${m.leech ? `<span class="tag no" title="遗忘次数多，建议换一种记忆方式">顽固卡</span>` : ''}
      ${m.nextDue ? `<span class="q-points">下次复习 ${esc(m.nextDue)}</span>` : ''}
      ${
        m.mastered && m.masteredByKnowledge
          ? `<span class="tag" title="做对同知识点的题目后自动掌握">知识点「${esc(m.masteredByKnowledge)}」做对后自动掌握</span>`
          : ''
      }
      <span class="q-points">来自：${esc(m.paperTitle || '')}</span>
    </div>
    <div class="q-stem">${esc(q.stem || '')}</div>
    ${materialHTML(q)}
    ${codeHTML(q)}
    ${options}
    ${
      hideAnswer
        ? '<div class="hint">重做中：答案与解析已暂时隐藏，先自己作答。</div>'
        : `<div class="answer-row">
             <span class="mine"><b>你的答案：</b>${esc(answerText(q.type, m.studentAnswer))}</span>
             <span class="std"><b>正确答案：</b>${esc(answerText(q.type, q.answer))}</span>
           </div>
           ${q.analysis ? `<div class="analysis"><b>解析：</b>${esc(q.analysis)}</div>` : ''}`
    }

    <div class="mistake-actions">
      <button class="ghost small" data-act="retry">${retry ? '收起重做' : '重做一遍'}</button>
      <button class="ghost small" data-act="explain">${m.explanation ? '查看讲解' : 'AI 讲解'}</button>
      <button class="ghost small" data-act="variants">${m.variants ? '重新生成变式题' : '生成同类变式题'}</button>
      <button class="${m.mastered ? 'ghost' : 'good'} small" data-act="master">${m.mastered ? '取消掌握' : '标记已掌握'}</button>
      <button class="bad small" data-act="delete">删除</button>
    </div>

    ${retry ? mistakeRetryHTML(m, retry) : ''}
    ${hideAnswer || !m.explanation ? '' : explainHTML(m)}
    ${m.variants ? variantHTML(m) : ''}
  </div>`;
}

/** 错题重做面板：先作答，做对即掌握并推进复习排期 */
function mistakeRetryHTML(m, st) {
  const q = m.question || {};
  return `
    <div class="flash-panel">
      <div class="hint">先不看解析自己做一遍：做对 → 标记已掌握并推进复习排期；做错 → 错误次数 +1、排期回到今天。</div>
      ${answerControlsHTML(q, m.id, st.answer, 'data-mk')}
      ${
        st.result
          ? `<div class="flash-feedback ${st.result.correct ? 'ok' : 'bad'}">
               <b>${st.result.correct ? '答对了，已标记掌握' : '还是不对，再看看解析'}</b>
               ${st.result.comment ? `<div>${esc(st.result.comment)}</div>` : ''}
               <div class="hint">正确答案：${esc(st.result.correctAnswerText || '')}</div>
             </div>`
          : `<div class="flash-actions"><button class="primary small" data-act="retry-submit">提交作答</button></div>`
      }
    </div>`;
}

function explainHTML(m) {
  const e = m.explanation;
  const sim = e.similar;
  return `
    <div class="explain">
      <h4>解题思路</h4><div class="body">${esc(e.idea)}</div>
      ${e.trap ? `<h4>易错点</h4><div class="body">${esc(e.trap)}</div>` : ''}
      ${e.remember ? `<h4>必须记住</h4><div class="body">${esc(e.remember)}</div>` : ''}
      ${
        sim
          ? `<h4>巩固练习</h4>
             <div class="q-stem">${esc(sim.stem)}</div>
             ${materialHTML(sim)}
             ${codeHTML(sim)}
             ${(sim.options || []).length ? `<div class="options">${sim.options.map((o, j) => `<div class="opt"><span class="letter">${letter(j)}.</span><span>${esc(o)}</span></div>`).join('')}</div>` : ''}
             <div class="analysis"><b>答案：</b>${esc(answerText(sim.type, sim.answer))}${sim.analysis ? `\n<b>解析：</b>${esc(sim.analysis)}` : ''}</div>`
          : ''
      }
    </div>`;
}

function variantHTML(m) {
  const v = m.variants;
  const saved = state.variantAnswers[m.id] || {};
  const questions = v.questions
    .map((q, i) => {
      let body = '';
      if (q.type === 'single' || q.type === 'multiple') {
        const type = q.type === 'single' ? 'radio' : 'checkbox';
        const cur = saved[q.id];
        body = `<div class="options">${(q.options || [])
          .map((o, j) => {
            const L = letter(j);
            const checked = q.type === 'single' ? cur === L : Array.isArray(cur) && cur.includes(L);
            return `<label class="opt"><input type="${type}" name="${q.id}" data-vqid="${q.id}" value="${L}" ${checked ? 'checked' : ''} /><span class="letter">${L}.</span><span>${esc(o)}</span></label>`;
          })
          .join('')}</div>`;
      } else if (q.type === 'judge') {
        body = `<div class="options">
          <label class="opt"><input type="radio" name="${q.id}" data-vqid="${q.id}" value="true" ${saved[q.id] === 'true' ? 'checked' : ''} /><span>正确</span></label>
          <label class="opt"><input type="radio" name="${q.id}" data-vqid="${q.id}" value="false" ${saved[q.id] === 'false' ? 'checked' : ''} /><span>错误</span></label>
        </div>`;
      } else if (q.type === 'blank' || q.type === 'fillcode') {
        const n = Math.max(1, q.blankCount || (Array.isArray(q.answer) ? q.answer.length : 1));
        const arr = Array.isArray(saved[q.id]) ? saved[q.id] : [];
        body = `<div class="blank-inputs">${Array.from({ length: n })
          .map(
            (_, j) =>
              `<input class="${q.type === 'fillcode' ? 'code-input' : ''}" name="${q.id}" data-vqid="${
                q.id
              }" placeholder="第 ${j + 1} 空${q.type === 'fillcode' ? '（补全代码）' : ''}" value="${esc(
                arr[j] || ''
              )}" spellcheck="false" />`
          )
          .join('')}</div>`;
      } else {
        body = answerBox(q, saved[q.id], q.id, `data-vqid="${q.id}"`);
      }
      const item = v.result ? v.result.items.find((x) => x.questionId === q.id) : null;
      let feedback = '';
      if (item) {
        feedback = `
          <div class="answer-row">
            <span class="${item.isCorrect ? '' : 'mine'}"><b>你的答案：</b>${esc(answerText(item.type, item.studentAnswer))}</span>
            <span class="std"><b>正确答案：</b>${esc(item.correctAnswerText)}</span>
            <span class="tag ${item.isCorrect ? 'ok' : 'no'}">${item.score} / ${item.points} 分</span>
          </div>
          ${item.comment ? `<div class="comment"><b>点评：</b>${esc(item.comment)}</div>` : ''}
          ${item.analysis ? `<div class="analysis"><b>解析：</b>${esc(item.analysis)}</div>` : ''}`;
      }
      return `
        <div class="q-block" style="border-bottom-style:solid">
          <div class="q-head">
            <span class="q-index">变式 ${i + 1}</span>
            <span class="q-type">${TYPE_LABELS[q.type] || q.type}</span>
            ${item ? `<span class="tag ${item.isCorrect ? 'ok' : 'no'}">${item.isCorrect ? '正确' : '错误'}</span>` : ''}
          </div>
          <div class="q-stem">${esc(q.stem)}</div>
          ${materialHTML(q)}
          ${codeHTML(q)}
          ${body}
          ${feedback}
        </div>`;
    })
    .join('');

  const passed = v.result && v.result.passed;
  return `
    <div class="variant-box">
      <div class="side-head">
        <h2>同类变式题</h2>
        ${passed ? `<span class="tag ok">全部正确，可以标记已掌握了</span>` : ''}
      </div>
      ${questions}
      <div class="mistake-actions">
        <button class="primary small" data-act="submit-variants">提交批改</button>
      </div>
    </div>`;
}

function onVariantInput(e) {
  // 错题「重做一遍」的作答输入
  const mk = e.target.dataset && e.target.dataset.mk;
  if (mk) {
    const m = state.mistakes.find((x) => x.id === mk);
    const q = (m || {}).question || {};
    const st = (state.mistakeRetry[mk] = state.mistakeRetry[mk] || { answer: '', result: null });
    if (q.type === 'multiple') {
      st.answer = $$(`input[data-mk="${mk}"]:checked`, $('#mistakeList')).map((x) => x.value);
    } else if (q.type === 'blank' || q.type === 'fillcode') {
      st.answer = $$(`input[data-mk="${mk}"]`, $('#mistakeList')).map((x) => x.value);
    } else {
      st.answer = e.target.value;
    }
    return;
  }

  const qid = e.target.dataset && e.target.dataset.vqid;
  if (!qid) return;
  const card = e.target.closest('.mistake-card');
  const id = card.dataset.id;
  const m = state.mistakes.find((x) => x.id === id);
  if (!m) return;
  const q = m.variants.questions.find((x) => x.id === qid);
  if (!q) return;
  const map = (state.variantAnswers[id] = state.variantAnswers[id] || {});

  if (q.type === 'multiple') {
    map[qid] = $$(`input[data-vqid="${qid}"]:checked`, card).map((el) => el.value);
  } else if (q.type === 'blank' || q.type === 'fillcode') {
    map[qid] = $$(`input[data-vqid="${qid}"]`, card).map((el) => el.value);
  } else {
    map[qid] = e.target.value;
  }
}

async function onMistakeAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.mistake-card');
  const id = card.dataset.id;
  const m = state.mistakes.find((x) => x.id === id);
  if (!m) return;

  const act = btn.dataset.act;
  try {
    if (act === 'retry') {
      // 展开 / 收起重做面板（展开时隐藏答案与解析）
      if (state.mistakeRetry[id]) delete state.mistakeRetry[id];
      else state.mistakeRetry[id] = { answer: '', result: null };
      renderMistakes();
    } else if (act === 'retry-submit') {
      const st = state.mistakeRetry[id];
      const answer = st && st.answer;
      const empty =
        answer == null || answer === '' || (Array.isArray(answer) && answer.every((x) => !String(x || '').trim()));
      if (!st) return;
      if (empty) return toast('先作答再提交', true);

      busy('正在判定…');
      const r = await api(`/mistakes/${id}/retry`, { method: 'POST', body: JSON.stringify({ answer }) });
      Object.assign(m, r.mistake || {});
      st.result = { correct: r.correct, comment: r.comment, correctAnswerText: r.correctAnswerText };
      if (r.card) m.mastery = r.card.mastery;
      renderMistakes();
      loadMistakes();
      toast(r.correct ? '答对了，已标记掌握并推进复习排期' : '还差一点，看完解析再重做一遍');
    } else if (act === 'explain') {
      if (m.explanation) {
        const box = $('.explain', card);
        if (box) box.classList.toggle('hidden');
        return;
      }
      busy('AI 正在讲解…');
      const { mistake } = await api(`/mistakes/${id}/explain`, { method: 'POST', body: '{}' });
      Object.assign(m, mistake);
      renderMistakes();
    } else if (act === 'variants') {
      busy('AI 正在生成变式题…');
      const { mistake } = await api(`/mistakes/${id}/variants`, {
        method: 'POST',
        body: JSON.stringify({ count: 3 }),
      });
      Object.assign(m, mistake);
      state.variantAnswers[id] = {};
      renderMistakes();
    } else if (act === 'submit-variants') {
      const answers = state.variantAnswers[id] || {};
      busy('AI 正在批改…');
      const { mistake } = await api(`/mistakes/${id}/variants/grade`, {
        method: 'POST',
        body: JSON.stringify({ answers }),
      });
      Object.assign(m, mistake);
      renderMistakes();
      toast(m.variants.result.passed ? '全部正确，很棒！' : '还有错误，看看解析再练一次');
    } else if (act === 'master') {
      const { mistake } = await api(`/mistakes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ mastered: !m.mastered }),
      });
      Object.assign(m, mistake);
      renderMistakes();
      loadMistakes();
    } else if (act === 'delete') {
      if (!confirm('确定删除这道错题？')) return;
      await api(`/mistakes/${id}`, { method: 'DELETE' });
      await loadMistakes();
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    idle();
  }
}

init();
