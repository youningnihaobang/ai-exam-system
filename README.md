# AI 智能试卷模拟系统

基于 Node + **CodeBuddy Agent SDK**（`@tencent-ai/agent-sdk`）的网页版试卷模拟工具：AI 出题 → 在线答题 → AI 评卷 → 错题改错。

## 功能

- **生成试卷（两种方式）**：
  1. **按题型配置**：选择科目与难度，自由组合 9 种题型与题量、分值，可填写附加要求，AI 生成结构化试卷（含答案、解析、知识点、建议用时）。
  2. **按大纲 / 文档**：粘贴大纲文字，或上传 `PDF / Word(.docx) / TXT / Markdown` 文档（可多选、可拖拽）；可先点「AI 分析大纲」让 AI 自动识别科目、难度与题型题量并回填表单，确认后再生成。系统解析正文后交给 AI 依据大纲命题；题型题量可留空由 AI 自定，也可指定。生成后回显大纲来源、解析字数与已覆盖知识点。

  | 题型 | 说明 | 默认分值 | 评分方式 |
  | --- | --- | --- | --- |
  | `single` 单选题 | 一个正确选项 | 3 | 系统判定 |
  | `multiple` 多选题 | 至少两个正确选项 | 4 | 系统判定 |
  | `judge` 判断题 | 判断陈述对错 | 2 | 系统判定 |
  | `blank` 填空题 | 支持多空，忽略大小写与标点 | 3 | 系统判定（判错后 AI 复核） |
  | `term` 名词解释题 | 解释概念，按要点给分 | 4 | AI 评分 |
  | `short` 简答题 | 按关键步骤/要点给分 | 8 | AI 评分 |
  | `discriminate` 辨析题 | 先判断正误再说明理由 | 6 | AI 评分 |
  | `material` 材料分析题 | 含材料原文，需结合材料作答 | 12 | AI 评分 |
  | `essay` 论述题 | 论点 + 论据 + 结论 | 15 | AI 评分 |

  3. **科目库（一次解析，反复命题）**：按大纲生成一次后，科目名称、大纲原文、AI 识别的题型结构与历年真题考点自动归档到 `data/db.json` 的 `subjects` 集合；以后在「科目库」下拉选中即可直接生成，不必再上传 / 解析大纲。也可点「保存 / 更新」手动归档，或「删除」档案（不影响已生成的试卷）。
- **参考历年真题（50% 真题考点 + 50% 大纲范围）**：勾选后命题前先用 `WebSearch / WebFetch` 联网检索该科目历年真题考点，再按比例（默认 50/50）分配：一半考真题高频考点，一半考大纲范围内真题低频或未考的知识点。检索结果随科目档案保存，下次复用；需要最新时勾「重新联网检索」。
- **在线答题**：按题型渲染答题卡（选项、判断、多空填空、简答作答区）。
- **智能评卷**：
  - 客观题本地判定（单选/多选/判断精确比对，填空忽略大小写与标点差异）；
  - 填空题本地判错时交给 AI 复核，避免同义答案被误判；
  - 简答题由 AI 按要点/步骤给分（支持 0.5 分粒度）并写失分点评；
  - 生成总分、正确率、整体评价、薄弱知识点与复习建议。
- **错题本与改错**：评卷后错题自动入本，支持
  - AI 讲解（解题思路 / 易错点 / 必须记住 / 一道巩固题）；
  - 生成 3 道同类变式题并再次作答批改，全部正确即可标记已掌握；
  - 错误次数统计、已掌握/未掌握筛选、手动标记与删除。

## 快速开始

```bash
npm install
cp .env.example .env
npm start          # 打开 http://localhost:3000
```

开发模式：`npm run dev`（node --watch 自动重启）。

### 认证（二选一）

1. **使用登录凭据**：在终端执行 `codebuddy login` 完成登录，`.env` 无需填写 Key。
2. **使用 API Key**：在 `.env` 中填写 `CODEBUDDY_API_KEY`（获取地址：<https://www.codebuddy.cn/profile/keys>）；使用中国版 / iOA 版 / 专享版 / 私有化时，需同步设置 `CODEBUDDY_INTERNET_ENVIRONMENT`。

> SDK 依赖 CodeBuddy CLI：若 `codebuddy` 不在 PATH 中，SDK 会使用包内置的可执行文件；也可通过 `CODEBUDDY_CODE_PATH` 显式指定。

### 按大纲 / 文档生成试卷

- 支持格式：`PDF`、`Word(.docx)`、`TXT / Markdown`；单个文件 ≤ 10MB，一次最多 8 个，可与粘贴的文本同时使用。
- 解析后的正文拼接后一次性交给 AI，超过 60000 字符自动截断（生成结果会给出提示）。
- 已知限制：
  - 旧版 `.doc` 不支持，请用 Word 另存为 `.docx`；
  - 扫描版 / 图片型 PDF 提取不到文字，上传后会提示，请改用文本或 Word 文档；
  - PDF 中的复杂公式、表格可能丢失结构，建议在粘贴文本中补充。
- 题型与题量留空时由 AI 依据大纲自行设计（建议 12~30 题、总分约 100 分）；勾选了题型则以勾选为准，与大纲原文冲突时以大纲为准。

## 配置（.env）

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `CODEBUDDY_API_KEY` | 可选，未登录时必填 | `cb-xxxx` |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | 可选：`internal`(中国版) / `ioa` / `cloudhosted` / `selfhosted`，留空为海外版 | `internal` |
| `CODEBUDDY_MODEL` | 可选，留空使用默认模型 | `deepseek-v3.1` |
| `CODEBUDDY_CODE_PATH` | 可选，CLI 可执行文件路径 | `/usr/local/bin/codebuddy` |
| `PORT` | 可选，默认 `3000` | `3000` |
| `AI_TIMEOUT_MS` | 可选，单次 AI 调用超时，默认 240000 | `240000` |

## 技术栈

- 后端：Node 18+（ESM）、Express、CodeBuddy Agent SDK（`query()` 单次查询）
- 存储：本地 JSON 文件（`data/db.json`，无需数据库）
- 前端：原生 HTML / CSS / JavaScript 单页应用，无构建步骤
- 文档解析：`multer`（内存上传）+ `pdf-parse`（PDF）+ `mammoth`（docx）+ `iconv-lite`（TXT 编码识别）

### AI 调用约定（`src/ai.js`）

- 使用 `query({ prompt, options })`，通过 `systemPrompt` 传入角色与输出规范，要求模型**只输出 JSON**；
- 任务为纯文本，故限制 `permissionMode: 'plan'`、`allowedTools: []`（不调用任何工具）、`maxTurns: 1`、`persistSession: false`（会话不落盘）；
- 从 assistant 文本流中拼接内容并解析 JSON（兼容 ` ```json ` 代码块），若模型返回 `structured_output` 则优先使用；
- 内置超时中断（AbortController）与认证 / CLI 缺失 / 超时的中文错误提示。

## 目录结构

```
src/
  server.js     # Express 服务入口
  routes.js     # 全部 API（生成试卷 / 评卷 / 错题本）
  ai.js         # CodeBuddy Agent SDK 调用封装（JSON 解析 + 超时 + 错误提示）
  prompts.js    # 命题 / 按大纲命题 / 大纲分析 / 评卷 / 讲解 / 变式题 Prompt
  parse.js      # 上传文档解析：PDF / docx / TXT（含编码识别与字数限制）
  normalize.js  # 题目与答案规范化、客观题判定
  store.js      # JSON 持久化
public/         # 前端页面
```

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | AI 配置状态 |
| POST | `/api/papers` | AI 生成试卷（按题型配置） |
| POST | `/api/outline/preview` | 解析上传的大纲文档，返回字数与预览（不调用 AI） |
| POST | `/api/outline/analyze` | AI 分析大纲：识别科目、难度与题型题量建议（`multipart/form-data`：`outline`/`files[]`） |
| POST | `/api/real-exam/analyze` | 联网检索历年真题考点（来源链接、高频考点、概述） |
| GET | `/api/subjects` | 科目库列表（不含大纲原文） |
| GET | `/api/subjects/:id` | 科目档案详情（含大纲原文与真题考点） |
| POST | `/api/subjects` | 新建 / 更新科目档案（按科目名去重） |
| DELETE | `/api/subjects/:id` | 删除科目档案 |
| POST | `/api/papers/from-subject` | 用科目档案命题：复用已存大纲与真题考点，无需重新上传解析 |
| GET | `/api/ai/progress` | 当前 AI 任务进度（阶段 / 已输出字数 / 已用秒数） |
| POST | `/api/papers/from-outline` | 按大纲 / 文档生成试卷（`multipart/form-data`：`subject`/`difficulty`/`notes`/`outline`/`specs`/`files[]`） |
| GET | `/api/papers` | 试卷列表 |
| GET | `/api/papers/:id?mode=exam` | 试卷详情（`mode=exam` 隐藏答案） |
| POST | `/api/papers/:id/grade` | 提交作答并 AI 评卷 |
| GET | `/api/mistakes` | 错题列表 |
| POST | `/api/mistakes/:id/explain` | AI 讲解错题 |
| POST | `/api/mistakes/:id/variants` | 生成同类变式题 |
| POST | `/api/mistakes/:id/variants/grade` | 变式题批改 |
| PATCH / DELETE | `/api/mistakes/:id` | 标记掌握 / 删除 |
