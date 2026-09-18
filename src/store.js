import crypto from 'node:crypto';
import { db } from './db.js';

/**
 * 数据访问层：全部走 JSON 文档数据库（src/db.js，每个集合一个文档文件）
 * - papers 试卷 / submissions 答卷 / mistakes 错题 / subjects 科目档案 / documents 解析文档 / settings 设置
 */

const papers = db.collection('papers');
const submissions = db.collection('submissions');
const mistakes = db.collection('mistakes');
const subjects = db.collection('subjects');
const documents = db.collection('documents');
const settings = db.collection('settings');

export async function initStore() {
  await db.init();
}

export const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 自增序号（存放在 settings 集合的 seq 文档里） */
export function nextSeq() {
  const doc = settings.byId('seq') || settings.insert({ id: 'seq', value: 1 });
  const value = Number(doc.value) || 1;
  doc.value = value + 1;
  settings.persist();
  return value;
}

export const getPapers = () => papers.all();
export const getSubmissions = () => submissions.all();
export const getMistakes = () => mistakes.all();
export const getSubjects = () => subjects.all();
export const getDocuments = () => documents.all();

/* ------------------------------ 设置 ------------------------------ */

/** settings 集合是键值文档（id 为键名，seq 除外），这里还原成普通对象 */
export const getSettings = () => {
  const out = {};
  for (const doc of settings.all()) {
    if (doc?.id && doc.id !== 'seq') out[doc.id] = doc.value;
  }
  return out;
};

export function setSetting(key, value) {
  const id = String(key || '').trim();
  if (!id) return getSettings();
  const doc = settings.byId(id);
  if (doc) Object.assign(doc, { value });
  else settings.insert({ id, value });
  settings.persist();
  return getSettings();
}

/* ------------------------------ 查找 ------------------------------ */

/** 按 id 或科目名查找档案（同名视为同一科目，避免重复入库） */
export function findSubject(idOrName) {
  if (!idOrName) return null;
  return (
    subjects.byId(idOrName) ||
    subjects.find((s) => s.name === String(idOrName).trim()) ||
    null
  );
}

export const findPaper = (id) => papers.byId(id);
export const findSubmission = (id) => submissions.byId(id);
export const findMistake = (id) => mistakes.byId(id);
export const findDocument = (id) => documents.byId(id);

/* ------------------------------ 试卷 ------------------------------ */

export function addPaper(paper) {
  return papers.insert(paper);
}

export function removePaper(id) {
  papers.remove(id);
  submissions.replace(submissions.all().filter((s) => s.paperId !== id));
  mistakes.replace(mistakes.all().filter((m) => m.paperId !== id));
}

/* ------------------------------ 科目档案 ------------------------------ */

/**
 * 新建或更新科目档案：按 id → 科目名匹配，命中则合并更新（保留 createdAt）。
 * 这样「再次生成同一科目」只更新大纲 / 分析结果 / 真题考点，不会产生重复档案。
 */
export function upsertSubject(payload) {
  const name = String(payload?.name || '').trim();
  if (!name) return null;

  const now = new Date().toISOString();
  const prev = subjects.find((s) => (payload.id && s.id === payload.id) || s.name === name);

  if (prev) {
    const next = {
      ...prev,
      ...payload,
      id: prev.id,
      name,
      createdAt: prev.createdAt || now,
      updatedAt: now,
    };
    Object.assign(prev, next);
    subjects.persist();
    return prev;
  }

  const item = {
    id: uid('subject'),
    name,
    difficulty: payload.difficulty || '中等',
    notes: payload.notes || '',
    outline: payload.outline || null,
    analysis: payload.analysis || null,
    realExam: payload.realExam || null,
    pastPaper: payload.pastPaper || null,
    useCount: 0,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return subjects.insert(item);
}

export function removeSubject(id) {
  subjects.remove(id);
}

/** 记录一次使用，便于前端按使用频次排序 */
export function touchSubject(id) {
  const s = subjects.byId(id);
  if (!s) return;
  s.useCount = (s.useCount || 0) + 1;
  s.lastUsedAt = new Date().toISOString();
  subjects.persist();
  return s;
}

/* ------------------------------ 答卷 / 错题 ------------------------------ */

export function addSubmission(sub) {
  return submissions.insert(sub);
}

export function addMistake(mistake) {
  return mistakes.insert(mistake);
}

/* ------------------------------ 解析文档 ------------------------------ */

const hashOf = (text) => crypto.createHash('sha1').update(String(text)).digest('hex');

/**
 * 保存一份「解析出来的文件」：上传的真题 / 大纲文档提取出的正文存进 documents 集合。
 * 同内容（sha1）且同文件名视为同一份，重复解析只更新归属与时间，不再建新文档。
 */
export function saveParsedDocument({ name, size = 0, text, kind = 'outline', subject = '', source = 'upload', meta = {} }) {
  const content = String(text || '').trim();
  if (!content) return null;

  const now = new Date().toISOString();
  const hash = hashOf(content);
  const fileName = String(name || '').trim() || '（未命名）';
  const exist = documents.find((d) => d.hash === hash && d.name === fileName);

  if (exist) {
    Object.assign(exist, {
      kind: kind || exist.kind,
      subject: subject ? String(subject).trim() : exist.subject || '',
      size: Number(size) || exist.size || 0,
      updatedAt: now,
    });
    documents.persist();
    return exist;
  }

  return documents.insert({
    id: uid('doc'),
    name: fileName,
    ext: String(fileName.split('.').pop() || '').toLowerCase(),
    size: Number(size) || 0,
    chars: content.length,
    hash,
    text: content,
    kind,
    subject: subject ? String(subject).trim() : '',
    source,
    ...meta,
    createdAt: now,
    updatedAt: now,
  });
}

export function updateDocument(id, patch) {
  return documents.update(id, patch);
}

export function removeDocument(id) {
  return documents.remove(id);
}

/** 列表用摘要（不带全文，避免响应过大） */
export function documentSummary(doc) {
  return {
    id: doc.id,
    name: doc.name,
    ext: doc.ext,
    size: doc.size,
    chars: doc.chars,
    kind: doc.kind,
    subject: doc.subject || '',
    source: doc.source || 'upload',
    preview: String(doc.text || '').slice(0, 160),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** 整体落盘（保持旧调用方式可用） */
export function save() {
  return db.flush();
}
