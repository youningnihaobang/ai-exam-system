import * as store from './store.js';

/**
 * 后台任务队列（串行执行）。
 *
 * 评卷这类 AI 任务必须在服务端后台跑，并且同一时刻只允许一个任务真正执行：
 * 并发调用 CLI / 模型时，CLI 常常只响应其中一个，其余任务会失败或空转。
 * 因此所有评卷任务都进这里排队，按提交顺序依次执行。
 */

/** 最多保留多少个已结束的任务（防止 Map 无限增长） */
const MAX_KEEP = 30;

/** id → job */
const jobs = new Map();
/** 任务链：每个任务接在上一个任务的 then 之后，天然形成 FIFO 串行队列 */
let tail = Promise.resolve();

function trim() {
  if (jobs.size <= MAX_KEEP) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status === 'done' || j.status === 'error')
    .sort((a, b) => new Date(a.finishedAt || 0) - new Date(b.finishedAt || 0));
  for (const j of finished.slice(0, jobs.size - MAX_KEEP)) jobs.delete(j.id);
}

/**
 * 入队一个任务。run(report) 返回的结果存进 job.result；
 * report(progress) 可在执行中上报进度（如 AI 已输出字数）。
 * 返回 job，其中 job.promise 在任务结束后 resolve（结果读 job.result / job.error）。
 */
export function enqueue({ type = 'task', label = '', meta = {}, run }) {
  const job = {
    id: store.uid('job'),
    type,
    label: label || type,
    status: 'queued', // queued | running | done | error
    meta,
    progress: null,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(job.id, job);

  tail = tail.then(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    const at = Date.now();
    console.log(`[queue] ${job.label} 开始执行 · ${job.id}`);
    try {
      job.result = await run((progress) => {
        job.progress = progress || null;
      });
      job.status = 'done';
      console.log(`[queue] ${job.label} 完成 · 用时 ${((Date.now() - at) / 1000).toFixed(1)}s`);
    } catch (err) {
      job.status = 'error';
      job.error = err?.message || String(err);
      console.error(`[queue] ${job.label} 失败 · 用时 ${((Date.now() - at) / 1000).toFixed(1)}s · ${job.error}`);
    } finally {
      job.finishedAt = new Date().toISOString();
      trim();
    }
  });
  job.promise = tail;

  return job;
}

export const getJob = (id) => jobs.get(id) || null;

export function listJobs() {
  return [...jobs.values()];
}

/**
 * 找出仍在进行（排队中 / 执行中）的任务，用于避免重复提交。
 * match.type 与任务类型比对，其余字段与 job.meta 比对。
 */
export function findActiveJob(match = {}) {
  const { type, ...meta } = match;
  const keys = Object.keys(meta);
  return (
    listJobs()
      .filter((j) => j.status === 'queued' || j.status === 'running')
      .find((j) => (!type || j.type === type) && keys.every((k) => j.meta?.[k] === meta[k])) || null
  );
}

/** 对外输出的 task 视图：附带排队位置与等待任务数 */
export function jobView(job) {
  if (!job) return null;
  const waiting = listJobs()
    .filter((j) => j.status === 'queued')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return {
    id: job.id,
    type: job.type,
    label: job.label,
    status: job.status,
    meta: job.meta || {},
    progress: job.progress,
    error: job.error,
    position: job.status === 'queued' ? waiting.indexOf(job) + 1 : 0,
    waiting: waiting.length,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/** 队列概况：执行中的任务 + 排队中的任务 */
export function queueSnapshot() {
  const all = listJobs();
  const running = all.find((j) => j.status === 'running') || null;
  const queued = all
    .filter((j) => j.status === 'queued')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return {
    running: jobView(running),
    queued: queued.map(jobView),
    total: all.length,
  };
}
