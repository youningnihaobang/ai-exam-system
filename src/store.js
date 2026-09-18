import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// subjects：科目档案（大纲原文 / AI 分析结果 / 历年真题考点），一次解析，反复命题
// settings：前端设置（如选中的模型），重启后仍生效
const EMPTY = { papers: [], submissions: [], mistakes: [], subjects: [], settings: {}, seq: 1 };

let db = { ...EMPTY };
let writeChain = Promise.resolve();

export async function initStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const text = await fs.readFile(DB_FILE, 'utf-8');
    db = { ...EMPTY, ...JSON.parse(text) };
  } catch {
    db = { ...EMPTY };
    await persist();
  }
}

function persist() {
  writeChain = writeChain.then(() => fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf-8')).catch(() => {});
  return writeChain;
}

export const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function nextSeq() {
  return db.seq++;
}

export const getPapers = () => db.papers;
export const getSubmissions = () => db.submissions;
export const getMistakes = () => db.mistakes;
export const getSubjects = () => db.subjects;

export const getSettings = () => db.settings || (db.settings = {});

export function setSetting(key, value) {
  const s = getSettings();
  s[key] = value;
  persist();
  return s;
}

/** 按 id 或科目名查找档案（同名视为同一科目，避免重复入库） */
export function findSubject(idOrName) {
  if (!idOrName) return null;
  return (
    db.subjects.find((s) => s.id === idOrName) ||
    db.subjects.find((s) => s.name === String(idOrName).trim()) ||
    null
  );
}

export function findPaper(id) {
  return db.papers.find((p) => p.id === id) || null;
}
export function findSubmission(id) {
  return db.submissions.find((s) => s.id === id) || null;
}
export function findMistake(id) {
  return db.mistakes.find((m) => m.id === id) || null;
}

export function addPaper(paper) {
  db.papers.unshift(paper);
  persist();
  return paper;
}

export function removePaper(id) {
  db.papers = db.papers.filter((p) => p.id !== id);
  db.submissions = db.submissions.filter((s) => s.paperId !== id);
  db.mistakes = db.mistakes.filter((m) => m.paperId !== id);
  persist();
}

/**
 * 新建或更新科目档案：按 id → 科目名匹配，命中则合并更新（保留 createdAt）。
 * 这样「再次生成同一科目」只更新大纲 / 分析结果 / 真题考点，不会产生重复档案。
 */
export function upsertSubject(payload) {
  const name = String(payload?.name || '').trim();
  if (!name) return null;

  const now = new Date().toISOString();
  const idx = db.subjects.findIndex((s) => (payload.id && s.id === payload.id) || s.name === name);

  if (idx >= 0) {
    const prev = db.subjects[idx];
    const next = {
      ...prev,
      ...payload,
      id: prev.id,
      name,
      createdAt: prev.createdAt || now,
      updatedAt: now,
    };
    db.subjects[idx] = next;
    persist();
    return next;
  }

  const item = {
    id: uid('subject'),
    name,
    difficulty: payload.difficulty || '中等',
    notes: payload.notes || '',
    outline: payload.outline || null,
    analysis: payload.analysis || null,
    realExam: payload.realExam || null,
    useCount: 0,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  db.subjects.unshift(item);
  persist();
  return item;
}

export function removeSubject(id) {
  db.subjects = db.subjects.filter((s) => s.id !== id);
  persist();
}

/** 记录一次使用，便于前端按使用频次排序 */
export function touchSubject(id) {
  const s = db.subjects.find((x) => x.id === id);
  if (!s) return;
  s.useCount = (s.useCount || 0) + 1;
  s.lastUsedAt = new Date().toISOString();
  persist();
}

export function addSubmission(sub) {
  db.submissions.unshift(sub);
  persist();
  return sub;
}

export function addMistake(mistake) {
  db.mistakes.unshift(mistake);
  persist();
  return mistake;
}

export function save() {
  return persist();
}
