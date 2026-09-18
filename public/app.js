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
  answers: {},
  result: null,
  mistakes: [],
  mistakeFilter: 'all',
  variantAnswers: {},
  expanded: {},
  collapsedSubjects: {}, // 试卷列表「按科目」分组的折叠状态：{ [科目名]: true }
  collapsedMistakeSubjects: {}, // 错题本「按科目」分组的折叠状态：{ [科目名]: true }
  paperSubject: '', // 左栏选中的科目（'' = 全部科目）
  mistakeSubject: '',
};

/** 取条目所属科目名，空则归为「未分类」 */
function subjectOf(item) {
  return String(item.subject || '').trim() || '未分类';
}

/** 渲染左栏科目导航；entries 为 [{ name, count }] */
function renderSubjectNav(el, entries, activeName, onPick) {
  const rows = [{ name: '', label: '全部科目', count: entries.reduce((s, e) => s + e.count, 0) }].concat(
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
  initSideToggles();
  $('#modelPick').addEventListener('change', (e) => changeModel(e.target.value));
  $('#btnRefreshModels').addEventListener('click', () => loadModels(true));

  const dz = $('#dropzone');
  const fileInput = $('#outlineFiles');
  dz.addEventListener('click', () => fileInput.click());
  // 避免程序化 click 冒泡回 dropzone 造成递归
  fileInput.addEventListener('click', (e) => e.stopPropagation());
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
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
    addFiles(e.dataTransfer && e.dataTransfer.files);
  });
  // 拖到页面其它位置时不要让浏览器直接打开文件
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  $('#fileList').addEventListener('click', onFileAction);

  $('#examPane').addEventListener('input', onAnswerInput);
  $('#examPane').addEventListener('change', onAnswerInput);

  $$('.filters .chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      $$('.filters .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.mistakeFilter = chip.dataset.filter;
      renderMistakes();
    })
  );

  $('#mistakeList').addEventListener('input', onVariantInput);
  $('#mistakeList').addEventListener('change', onVariantInput);
  $('#mistakeList').addEventListener('click', onMistakeAction);
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
  ['generate', 'exam', 'mistakes'].forEach((v) => {
    $('#view-' + v).classList.toggle('hidden', v !== view);
  });
  if (view === 'exam') loadPapers();
  if (view === 'mistakes') loadMistakes();
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

/* ------------------------------ 大纲文档 ------------------------------ */

function addFiles(fileList) {
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
    if (state.outlineFiles.length >= MAX_FILES) {
      rejected.push(`${f.name}：最多上传 8 个文件`);
      continue;
    }
    if (state.outlineFiles.some((x) => x.name === f.name && x.size === f.size)) {
      rejected.push(`${f.name}：已添加`);
      continue;
    }
    state.outlineFiles.push({ file: f, name: f.name, size: f.size, chars: null, ok: null, error: '' });
  }

  if (rejected.length) toast(rejected.join('；'), true);
  renderFileList();
  previewFiles();
}

async function previewFiles() {
  const pending = state.outlineFiles.filter((f) => f.chars === null);
  if (!pending.length) return;

  const fd = new FormData();
  pending.forEach((f) => fd.append('files', f.file, f.name));
  try {
    const { files } = await api('/outline/preview', { method: 'POST', body: fd });
    files.forEach((r, i) => {
      const target = pending[i];
      if (!target) return;
      target.chars = r.chars;
      target.ok = r.ok;
      target.error = r.error || '';
    });
  } catch (e) {
    pending.forEach((p) => {
      p.chars = 0;
      p.ok = false;
      p.error = e.message;
    });
  }
  renderFileList();
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
  }
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
  if (!outline && !files.length && !state.activeSubject) {
    return toast('请先粘贴大纲或上传大纲文档，再保存到科目库', true);
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
  const idx = Number(btn.closest('.file-item').dataset.index);
  state.outlineFiles.splice(idx, 1);
  renderFileList();
}

function renderFileList() {
  const el = $('#fileList');
  if (!state.outlineFiles.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = state.outlineFiles
    .map(
      (f, i) => `
    <div class="file-item ${f.ok === false ? 'bad' : ''}" data-index="${i}">
      <span class="n" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="s">${humanSize(f.size)}${f.chars === null ? ' · 解析中…' : ` · ${f.chars} 字`}</span>
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
  busy(useRealExam ? 'AI 正在检索历年真题并命题…' : 'AI 正在命题，请稍候…');
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
  state.outlineFiles.forEach((f) => fd.append('files', f.file, f.name));

  busy(p.useRealExam ? 'AI 正在检索历年真题并依据大纲命题…' : 'AI 正在阅读大纲并命题…');
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
  if (!m) return '';
  const files = (m.files || []).map((f) => `${esc(f.name)}（${f.chars} 字）`).join('、');
  const cov = (m.coverage || []).map((c) => `<span class="chip-item">${esc(c)}</span>`).join('');
  return `
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
            <div class="m">${new Date(p.createdAt).toLocaleString('zh-CN')}</div>
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
    const { paper } = await api(`/papers/${id}?mode=exam`);
    state.paper = paper;
    state.answers = {};
    state.result = null;
    renderPaperList();
    renderExam();
  } catch (e) {
    toast(e.message, true);
  }
}

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
  pane.innerHTML = `
    <div class="card">
      <div class="side-head">
        <div>
          <h2>${esc(p.title)}</h2>
          <div class="hint">${p.questions.length} 题 · 共 ${total} 分 · 建议用时 ${p.duration} 分钟</div>
        </div>
        <button class="primary" id="btnSubmitExam">提交并评卷</button>
      </div>
      ${p.questions.map((q, i) => questionExamHTML(q, i)).join('')}
    </div>`;
  $('#btnSubmitExam').addEventListener('click', submitExam);
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
}

async function submitExam() {
  const p = state.paper;
  if (!p) return;
  const unanswered = p.questions.filter((q) => {
    const a = state.answers[q.id];
    if (a == null || a === '') return true;
    return Array.isArray(a) && a.every((x) => String(x).trim() === '');
  });
  if (unanswered.length && !confirm(`还有 ${unanswered.length} 道题未作答，确定提交吗？`)) return;

  busy('AI 正在评卷…');
  try {
    const { submission } = await api(`/papers/${p.id}/grade`, {
      method: 'POST',
      body: JSON.stringify({ answers: state.answers }),
    });
    state.result = submission;
    renderExam();
    loadMistakes();
    toast('评卷完成');
  } catch (e) {
    toast(e.message, true);
  } finally {
    idle();
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
          <div class="hint">${esc(r.summary || '')}</div>
        </div>
      </div>
      ${chips ? `<div class="side-head"><h2>薄弱知识点</h2></div><div class="chips">${chips}</div>` : ''}
      ${r.advice ? `<div class="analysis"><b>复习建议：</b>${esc(r.advice)}</div>` : ''}
      <div class="actions" style="margin:16px 0">
        <button class="ghost" id="btnRetry">重新作答</button>
        <span class="total">错题已自动收入错题本，可在「错题本」中改错</span>
      </div>
    </div>
    <div class="card">
      <h2>逐题解析</h2>
      ${r.details.map((d, i) => resultItemHTML(d, i)).join('')}
    </div>`;
  $('#btnRetry').addEventListener('click', () => {
    state.result = null;
    state.answers = {};
    renderExam();
  });
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

/** 错题本：按科目分组，未掌握多的科目排前面 */
function renderMistakes() {
  const el = $('#mistakeList');
  const list = visibleMistakes();
  if (!list.length) {
    el.innerHTML = `<div class="empty">暂无错题。完成评卷后，错题会自动进入这里。</div>`;
    return;
  }

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

  const groups = new Map();
  for (const m of list) {
    const key = subjectOf(m);
    if (state.mistakeSubject && key !== state.mistakeSubject) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  if (!groups.size) {
    el.innerHTML = `<div class="empty">该科目下暂无错题</div>`;
    return;
  }

  const ordered = [...groups.entries()]
    .map(([subject, items]) => {
      const sorted = [...items].sort(
        (a, b) =>
          new Date(b.lastWrongAt || b.createdAt || 0) - new Date(a.lastWrongAt || a.createdAt || 0)
      );
      return {
        subject,
        items: sorted,
        unmastered: sorted.filter((m) => !m.mastered).length,
        latest: new Date(sorted[0].lastWrongAt || sorted[0].createdAt || 0).getTime(),
      };
    })
    .sort((a, b) => b.unmastered - a.unmastered || b.latest - a.latest);

  el.innerHTML = ordered
    .map(({ subject, items, unmastered }) => {
      const collapsed = Boolean(state.collapsedMistakeSubjects[subject]);
      const count = `${items.length} 题${unmastered ? ` · 未掌握 ${unmastered}` : ''}`;
      return `
      <div class="paper-group mistake-group${collapsed ? ' collapsed' : ''}">
        <div class="group-head" data-subject="${esc(subject)}" title="点击展开 / 收起">
          <span class="arrow">▾</span>
          <span class="gname">${esc(subject)}</span>
          <span class="gcount">${count}</span>
        </div>
        <div class="group-body">${items.map(mistakeHTML).join('')}</div>
      </div>`;
    })
    .join('');

  $$('#mistakeList .group-head').forEach((head) =>
    head.addEventListener('click', () => {
      const key = head.dataset.subject;
      state.collapsedMistakeSubjects[key] = !state.collapsedMistakeSubjects[key];
      renderMistakes();
    })
  );
}

function mistakeHTML(m) {
  const q = m.question || {};
  const options = (q.options || []).length
    ? `<div class="options">${q.options
        .map((o, j) => `<div class="opt ${isRightOption(q, letter(j)) ? 'correct' : ''}"><span class="letter">${letter(j)}.</span><span>${esc(o)}</span></div>`)
        .join('')}</div>`
    : '';

  return `
  <div class="mistake-card ${m.mastered ? 'mastered' : ''}" data-id="${m.id}">
    <div class="mistake-head">
      <span class="q-type">${TYPE_LABELS[q.type] || ''}</span>
      <span class="tag">${esc(m.subject || '')}</span>
      <span class="tag ${m.mastered ? 'ok' : 'no'}">${m.mastered ? '已掌握' : `错 ${m.wrongTimes || 1} 次`}</span>
      <span class="q-points">来自：${esc(m.paperTitle || '')}</span>
    </div>
    <div class="q-stem">${esc(q.stem || '')}</div>
    ${materialHTML(q)}
    ${codeHTML(q)}
    ${options}
    <div class="answer-row">
      <span class="mine"><b>你的答案：</b>${esc(answerText(q.type, m.studentAnswer))}</span>
      <span class="std"><b>正确答案：</b>${esc(answerText(q.type, q.answer))}</span>
    </div>
    ${q.analysis ? `<div class="analysis"><b>解析：</b>${esc(q.analysis)}</div>` : ''}

    <div class="mistake-actions">
      <button class="ghost small" data-act="explain">${m.explanation ? '查看讲解' : 'AI 讲解'}</button>
      <button class="ghost small" data-act="variants">${m.variants ? '重新生成变式题' : '生成同类变式题'}</button>
      <button class="${m.mastered ? 'ghost' : 'good'} small" data-act="master">${m.mastered ? '取消掌握' : '标记已掌握'}</button>
      <button class="bad small" data-act="delete">删除</button>
    </div>

    ${m.explanation ? explainHTML(m) : ''}
    ${m.variants ? variantHTML(m) : ''}
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
    if (act === 'explain') {
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
