import { query, unstable_v2_createSession } from '@tencent-ai/agent-sdk';
import 'dotenv/config';

const apiKey = process.env.CODEBUDDY_API_KEY || '';
const model = process.env.CODEBUDDY_MODEL || '';
/** 前端「模型设置」选中的模型；为空表示跟随 .env / CLI 默认 */
let activeModel = model;
// 默认国内版（中国版）：internal。海外版请显式设为 external，其余取值见 .env.example
const environment = process.env.CODEBUDDY_INTERNET_ENVIRONMENT || 'internal';
const cliPath = process.env.CODEBUDDY_CODE_PATH || '';

// 单次 AI 调用超时（毫秒）
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 240000;
// 允许的对话轮次：纯文本任务正常只需 1 轮，留余量给「输出较长被截断后续写」等情况
const MAX_TURNS = Number(process.env.AI_MAX_TURNS) || 4;
// 允许联网检索时的轮次：搜索 + 抓取 + 归纳需要更多轮
const WEB_MAX_TURNS = Number(process.env.AI_WEB_MAX_TURNS) || 12;
/** 联网检索使用的内置工具（CodeBuddy CLI 提供） */
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

const ENV_LABELS = {
  internal: '国内版（中国版）',
  external: '海外版（国际版）',
  ioa: 'iOA 企业版',
  cloudhosted: '专享版',
  selfhosted: '私有化部署',
};

/** 当前生效的模型（前端选择优先，其次 .env 的 CODEBUDDY_MODEL，最后交给 CLI 默认） */
export const currentModel = () => activeModel || '';

/** 切换运行时模型；传空字符串恢复默认（跟随 .env / CLI） */
export function setActiveModel(id) {
  activeModel = String(id || '').trim();
  return activeModel;
}

export function aiStatus() {
  return {
    provider: 'codebuddy-agent-sdk',
    configured: true,
    auth: apiKey ? 'API Key' : 'CLI 登录凭据',
    model: activeModel || '默认模型',
    envModel: model,
    environment: ENV_LABELS[environment] || environment,
  };
}

/* ------------------------------ 可用模型列表 ------------------------------ */

/** 模型列表缓存时长：避免每次打开页面都启动一次 CLI */
const MODELS_TTL_MS = 10 * 60 * 1000;
/** 拉取模型列表的超时（启动 CLI + 控制请求，通常 10~30s） */
const MODELS_TIMEOUT_MS = Number(process.env.AI_MODELS_TIMEOUT_MS) || 60000;
let modelsCache = { at: 0, models: [] };

/**
 * 通过 SDK 的 session 控制请求向 CLI 询问「当前账号可用的模型」。
 * 失败时返回空列表 + error，前端降级为手填 / 保持默认模型。
 */
export async function listModels({ refresh = false } = {}) {
  const fresh = modelsCache.models.length && Date.now() - modelsCache.at < MODELS_TTL_MS;
  if (!refresh && fresh) {
    return { models: modelsCache.models, current: activeModel || '', envModel: model, cached: true };
  }

  const env = { ...process.env };
  if (apiKey) env.CODEBUDDY_API_KEY = apiKey;
  if (environment) env.CODEBUDDY_INTERNET_ENVIRONMENT = environment;

  // 注意：不要传 requestTimeoutMs —— 会让 CLI 启动后立即退出（stdout closed）
  const session = unstable_v2_createSession({
    cwd: process.cwd(),
    env,
    ...(cliPath ? { pathToCodebuddyCode: cliPath } : {}),
  });

  const timer = setTimeout(() => {
    try {
      session.close();
    } catch (_) {
      /* 关闭失败不阻塞 */
    }
  }, MODELS_TIMEOUT_MS);

  try {
    await Promise.race([
      session.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`拉取模型列表超时（${Math.round(MODELS_TIMEOUT_MS / 1000)}s）`)), MODELS_TIMEOUT_MS)
      ),
    ]);

    // 简化列表给出顺序与名称，raw 列表补充描述与上下文长度
    // 顺序执行：控制请求并发时 CLI 可能只响应其中一个
    let simple = [];
    let full = [];
    try {
      simple = (await session.getAvailableModels()) || [];
    } catch (e) {
      console.warn(`[models] getAvailableModels 失败 · ${e?.message || e}`);
    }
    try {
      full = (await session.getAvailableModelsRaw()) || [];
    } catch (e) {
      console.warn(`[models] getAvailableModelsRaw 失败 · ${e?.message || e}`);
    }

    const map = new Map();
    const put = (id, patch) => {
      const key = String(id || '').trim();
      if (!key) return;
      const prev = map.get(key) || { id: key, name: key, description: '' };
      map.set(key, { ...prev, ...patch, id: key });
    };

    for (const m of Array.isArray(simple) ? simple : []) {
      put(m?.modelId, { name: m?.name || m?.modelId, description: m?.description || '' });
    }
    for (const m of Array.isArray(full) ? full : []) {
      const known = map.has(String(m?.id || '').trim());
      // raw 更全，但可能包含当前环境不可用的模型；仅在补充字段或 simple 为空时采用
      if (!known && map.size) continue;
      put(m?.id, {
        name: m?.name || m?.id,
        description: m?.descriptionZh || m?.description || '',
        maxOutputTokens: m?.maxOutputTokens || 0,
        supportsToolCall: Boolean(m?.supportsToolCall),
      });
    }

    const models = [...map.values()].filter((m) => m.id);
    if (models.length) modelsCache = { at: Date.now(), models };

    console.log(`[models] 可用模型 ${models.length} 个 · 当前 ${activeModel || '默认模型'}`);
    return {
      models: models.length ? models : modelsCache.models,
      current: activeModel || '',
      envModel: model,
      cached: false,
    };
  } catch (err) {
    console.error(`[models] 获取可用模型失败 · ${err?.message || err}`);
    return {
      models: modelsCache.models,
      current: activeModel || '',
      envModel: model,
      cached: true,
      error: `获取可用模型失败：${err?.message || err}`,
    };
  } finally {
    clearTimeout(timer);
    try {
      session.close();
    } catch (_) {
      /* 已关闭则忽略 */
    }
  }
}

/** web=true 时放开 WebSearch / WebFetch，让 Agent 能联网检索资料（如历年真题） */
function buildOptions({ web = false } = {}) {
  // 前端选中的模型优先，其次 .env，最后交给 CLI 默认
  const useModel = activeModel || model;
  const env = { ...process.env };
  if (apiKey) env.CODEBUDDY_API_KEY = apiKey;
  if (environment) env.CODEBUDDY_INTERNET_ENVIRONMENT = environment;

  return {
    // 出题/评卷是纯文本任务：不加载用户/项目配置，且不允许调用任何工具。
    // 注意：这里不能用 plan 模式——它会让模型先走一轮「计划 / 等待确认」的流程，
    // 在 allowedTools 为空时就白白耗尽轮次，导致 Max turns exceeded 且毫无输出。
    permissionMode: 'default',
    settingSources: [],
    // tools 是「可用工具集」：默认为空（纯文本任务）；需要联网时只放开搜索/抓取
    // allowedTools 是自动放行清单，避免出现权限询问把轮次耗光
    tools: web ? WEB_TOOLS : [],
    allowedTools: web ? WEB_TOOLS : [],
    maxTurns: web ? Math.max(MAX_TURNS, WEB_MAX_TURNS) : MAX_TURNS,
    // 开启流式增量：SDK 会推送 stream_event（content_block_delta），
    // 这样在模型输出完之前就能拿到「正在生成的内容」用于进度展示
    includePartialMessages: true,
    // 会话不落盘，避免污染 ~/.codebuddy
    persistSession: false,
    cwd: process.cwd(),
    env,
    // 只传 model：CLI 要求 fallbackModel 必须与主模型不同，传同一个会直接报错
    // 「Fallback model cannot be the same as the main model.」
    ...(useModel ? { model: useModel } : {}),
    ...(cliPath ? { pathToCodebuddyCode: cliPath } : {}),
  };
}

/** 从模型输出中尽力提取 JSON 对象（兼容 ```json 代码块与前后多余文字） */
export function extractJSON(text) {
  if (!text) throw new Error('AI 返回内容为空');
  let raw = String(text).trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error('AI 返回内容不是合法 JSON：' + raw.slice(0, 200));
  }
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/abort|cancel/i.test(msg)) return new Error(`AI 调用超时（超过 ${Math.round(TIMEOUT_MS / 1000)} 秒），请减少题量后重试`);
  if (/max turns|max_turns/i.test(msg)) {
    return new Error(
      `AI 轮次不足（当前上限 ${MAX_TURNS}）：模型在输出答案前就用完了轮次。可减少题量，或调大 AI_MAX_TURNS 后重试`
    );
  }
  if (/not found|ENOENT|CLI/i.test(msg)) {
    return new Error('未找到 CodeBuddy CLI，请先安装（npm i -g @tencent-ai/codebuddy-code）或通过 CODEBUDDY_CODE_PATH 指定路径');
  }
  if (/auth|login|401|403|token|unauthorized/i.test(msg)) {
    return new Error('CodeBuddy 认证失败，请先在终端执行 codebuddy login，或在 .env 中配置 CODEBUDDY_API_KEY');
  }
  return new Error('AI 服务调用失败：' + msg);
}

/** 无新增内容时的心跳间隔（毫秒），用于在终端确认任务仍在跑 */
const HEARTBEAT_MS = 15000;
/** 流式增量每产出这么多字打一条日志（避免刷屏） */
const LOG_STEP_CHARS = Number(process.env.AI_LOG_STEP_CHARS) || 2000;

function elapsed(from) {
  return ((Date.now() - from) / 1000).toFixed(1);
}

/** 当前正在执行的 AI 任务（同一时刻只有一个），供 /api/ai/progress 查询 */
let currentTask = null;

export function aiProgress() {
  if (!currentTask) return { running: false };
  return {
    running: true,
    label: currentTask.label,
    phase: currentTask.phase,
    chars: currentTask.chars,
    model: currentTask.model,
    elapsedSeconds: Math.round((Date.now() - currentTask.startedAt) / 1000),
  };
}

/**
 * 调用 CodeBuddy Agent，要求其只输出 JSON。
 * 返回解析后的对象；若模型返回了 structured_output 则优先使用。
 * label 用于日志与进度标识（命题 / 评卷 / 讲解等）。
 * onProgress 可选：流式过程中回调 { phase, chars, elapsedSeconds }。
 */
export async function chatJSON({ system, user, label = 'AI', onProgress, web = false } = {}) {
  // 联网检索多了「搜索 + 抓取」的耗时，放宽超时
  const timeoutMs = web ? Math.round(TIMEOUT_MS * 1.5) : TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let text = ''; // 以完整 assistant 消息为准，用于最终解析
  let streamed = ''; // 流式增量，仅用于进度与日志
  let structured = null;
  let result = null;
  const startedAt = Date.now();
  let lastLoggedChars = 0;

  const chars = (v) => String(v ?? '').length;
  const useModel = activeModel || model;
  console.log(
    `[ai] ${label} 开始 · 模型 ${useModel || '默认'} · 环境 ${ENV_LABELS[environment] || environment}${web ? ' · 联网检索' : ''} · 输入提示词 ${chars(system) + chars(user)} 字`
  );

  currentTask = { label, startedAt, chars: 0, phase: '启动中', model: useModel || '默认' };

  const report = (phase) => {
    if (!currentTask) return;
    currentTask.chars = streamed.length;
    if (phase) currentTask.phase = phase;
    const payload = {
      phase: currentTask.phase,
      chars: currentTask.chars,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
    if (streamed.length - lastLoggedChars >= LOG_STEP_CHARS) {
      lastLoggedChars = streamed.length;
      console.log(`[ai] ${label} 生成中 · 已输出 ${streamed.length} 字 · 已用 ${payload.elapsedSeconds}s`);
    }
    if (typeof onProgress === 'function') {
      try {
        onProgress(payload);
      } catch (_) {
        /* 进度回调失败不影响主流程 */
      }
    }
  };

  // 心跳：长时间没有新内容时，确认任务仍在进行
  const heartbeat = setInterval(() => {
    if (!currentTask) return;
    console.log(
      `[ai] ${label} ${currentTask.phase} · 已等待 ${elapsed(startedAt)}s · 已输出 ${currentTask.chars} 字`
    );
  }, HEARTBEAT_MS);

  try {
    const q = query({
      prompt: user,
      options: { ...buildOptions({ web }), systemPrompt: system, abortController: controller },
    });

    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'init') {
        // CLI 与模型就绪：可拿到实际使用的模型
        const realModel = message.model || useModel || '默认';
        if (currentTask) currentTask.model = realModel;
        console.log(`[ai] ${label} 已连接 · 模型 ${realModel} · 耗时 ${elapsed(startedAt)}s`);
        report('模型就绪');
      } else if (message.type === 'stream_event') {
        // 流式增量：模型正在逐字输出，这里就能拿到「当前写成什么样了」
        const ev = message.event || {};
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          streamed += ev.delta.text || '';
          report('正在生成');
        }
      } else if (message.type === 'tool_progress') {
        console.log(
          `[ai] ${label} 工具 ${message.tool_name} · 已运行 ${message.elapsed_time_seconds}s`
        );
      } else if (message.type === 'error') {
        console.error(`[ai] ${label} 运行报错 · ${message.error}`);
      } else if (message.type === 'assistant') {
        for (const block of message.message?.content || []) {
          if (block.type === 'text') text += block.text;
        }
      } else if (message.type === 'result') {
        result = message;
        if (message.structured_output) structured = message.structured_output;
        break; // 首个 result 即结束
      }
    }
  } catch (err) {
    const friendly = friendlyError(err);
    console.error(`[ai] ${label} 失败 · 耗时 ${elapsed(startedAt)}s · ${friendly.message}`);
    throw friendly;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timer);
    currentTask = null;
  }

  console.log(
    `[ai] ${label} 完成 · 耗时 ${elapsed(startedAt)}s · 共输出 ${streamed.length} 字 · 轮次 ${result?.num_turns ?? '-'}`
  );

  if (result && result.subtype !== 'success') {
    const detail = Array.isArray(result.errors) && result.errors.length ? `：${result.errors.join('；')}` : '';
    throw new Error(`AI 执行未完成（${result.subtype}）${detail}`);
  }
  if (!result) throw new Error('AI 未返回结果，请重试');

  if (structured) return structured;
  if (!text && typeof result.result === 'string') text = result.result;
  return extractJSON(text);
}
