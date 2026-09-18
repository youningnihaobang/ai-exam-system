import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 轻量 JSON 文档数据库（NoSQL 风格，零依赖）
 *
 * - 一个集合 = 一个 JSON 文件（data/db/<集合名>.json），文件内容为该集合的文档数组
 * - 文档以对象形式存库，读写走内存，落盘异步串行 + 临时文件改名，避免写坏文件
 * - 首次启动时若发现旧的单文件 data/db.json，会自动拆分迁移到集合文件并备份为 db.legacy.json
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_DIR = path.join(DATA_DIR, 'db');
const LEGACY_FILE = path.join(DATA_DIR, 'db.json');

/** 需要从旧单文件库迁移到集合文件的字段 */
const LEGACY_COLLECTIONS = ['papers', 'submissions', 'mistakes', 'subjects', 'documents'];

class Collection {
  constructor(name) {
    this.name = name;
    this.file = path.join(DB_DIR, `${name}.json`);
    this.docs = [];
    this.chain = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf-8'));
      this.docs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.docs) ? parsed.docs : [];
    } catch {
      this.docs = [];
    }
    return this;
  }

  /** 异步串行落盘：先写 .tmp 再改名，避免进程中断留下半截 JSON */
  persist() {
    const text = JSON.stringify(this.docs, null, 2);
    const tmp = `${this.file}.tmp`;
    this.chain = this.chain
      .then(() => fs.writeFile(tmp, text, 'utf-8'))
      .then(() => fs.rename(tmp, this.file))
      .catch((err) => console.error(`[db] 集合 ${this.name} 写入失败：${err.message}`));
    return this.chain;
  }

  /* ------------------------------ 读取 ------------------------------ */

  all() {
    return this.docs;
  }

  count() {
    return this.docs.length;
  }

  find(pred) {
    return this.docs.find(pred) || null;
  }

  filter(pred) {
    return this.docs.filter(pred);
  }

  byId(id) {
    return this.docs.find((d) => d?.id === id) || null;
  }

  /* ------------------------------ 写入 ------------------------------ */

  /** 新文档插到头部（列表默认按时间倒序展示） */
  insert(doc) {
    this.docs.unshift(doc);
    this.persist();
    return doc;
  }

  insertMany(docs) {
    const list = Array.isArray(docs) ? docs : [];
    this.docs.unshift(...list);
    this.persist();
    return list;
  }

  /** 按 id 更新：patch 可以是对象或 (doc) => 部分字段 */
  update(id, patch) {
    const doc = this.byId(id);
    if (!doc) return null;
    Object.assign(doc, typeof patch === 'function' ? patch(doc) || {} : patch || {});
    this.persist();
    return doc;
  }

  remove(id) {
    const idx = this.docs.findIndex((d) => d?.id === id);
    if (idx < 0) return null;
    const [doc] = this.docs.splice(idx, 1);
    this.persist();
    return doc;
  }

  /** 整体替换（用于按条件过滤后回写） */
  replace(docs) {
    this.docs = Array.isArray(docs) ? docs : [];
    this.persist();
    return this.docs;
  }

  clear() {
    this.docs = [];
    this.persist();
  }
}

const collections = new Map();

export const db = {
  dir: DB_DIR,
  legacyFile: LEGACY_FILE,

  /** 取集合句柄（同一个集合名返回同一实例）；需在 initDb 之前调用才能被自动加载 */
  collection(name) {
    const key = String(name || '').trim();
    if (!key) throw new Error('集合名不能为空');
    if (!collections.has(key)) collections.set(key, new Collection(key));
    return collections.get(key);
  },

  names() {
    return [...collections.keys()];
  },

  /** 把所有集合的内存数据落盘 */
  async flush() {
    await Promise.all([...collections.values()].map((c) => c.persist()));
  },

  /** 初始化：建目录 → 迁移旧库 → 加载各集合 */
  async init() {
    await fs.mkdir(DB_DIR, { recursive: true });
    await migrateLegacy();
    await Promise.all([...collections.values()].map((c) => c.load()));
    return db;
  },

  /** 统计信息，便于日志与调试 */
  stats() {
    return [...collections.values()].map((c) => ({ collection: c.name, documents: c.docs.length, file: path.relative(DATA_DIR, c.file) }));
  },
};

/** 旧版单文件 data/db.json → data/db/<集合>.json */
async function migrateLegacy() {
  let legacy = null;
  try {
    legacy = JSON.parse(await fs.readFile(LEGACY_FILE, 'utf-8'));
  } catch {
    return;
  }

  const existing = await fs.readdir(DB_DIR).catch(() => []);
  if (existing.some((f) => f.endsWith('.json'))) return; // 已经是新结构，忽略旧文件

  for (const name of LEGACY_COLLECTIONS) {
    const docs = Array.isArray(legacy?.[name]) ? legacy[name] : [];
    await fs.writeFile(path.join(DB_DIR, `${name}.json`), JSON.stringify(docs, null, 2), 'utf-8');
  }

  // settings 原本是键值对象、seq 是自增号，统一转成文档集合
  const settings = Object.entries(legacy?.settings || {}).map(([key, value]) => ({ id: key, value }));
  if (legacy?.seq) settings.push({ id: 'seq', value: Number(legacy.seq) || 1 });
  await fs.writeFile(path.join(DB_DIR, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');

  await fs.rename(LEGACY_FILE, path.join(DATA_DIR, 'db.legacy.json')).catch(() => {});
  console.log(`[db] 旧版 data/db.json 已迁移为文档数据库（${LEGACY_COLLECTIONS.length + 1} 个集合），原文件备份为 data/db.legacy.json`);
}
