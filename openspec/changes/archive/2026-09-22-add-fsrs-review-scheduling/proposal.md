# Proposal

## Why

复习排期目前是「伪 FSRS」：`scheduleReview` 只按 `stability` 线性外推下次间隔，**完全没有使用「距上次复习实际过了多少天」**（`src/routes.js` 的 `scheduleReview` 只读取 `card.interval`）。因此一张卡隔 1 天复习和隔 30 天复习，得到的下次间隔完全相同——这正好违背记忆规律（逾期越久，稳定性衰减越多），导致该早复习的卡被推得太晚、不该早复习的卡被反复打扰。

同时缺少学习步与复习历史：新卡/遗忘卡 `interval = 0`、`due = 今天`，当天是否重来全凭前端会话内存（`public/app.js` 里 `forgot` 时把 id 重新 push 进本轮队列），刷新页面即丢失；卡片也没有逐次复习记录，无法计算真实保留率或做参数自校准。

## What Changes

- **引入基于「经过天数」的保留率模型**：排期计算加入 `elapsedDays`（距上次复习的实际天数），用可提取性 `R = (1 + t / (9S))^-1` 估算当前保留概率，再由目标保留率（`desiredRetention`，默认 0.9）**反推**下次间隔，而不是直接用 `Math.round(S)`。
- **评分从 3 档扩展为 4 档**：内部改用 `again` / `hard` / `good` / `easy`，覆盖现有 `forgot` / `fuzzy` / `known`（映射：`forgot→again`、`fuzzy→hard`、`known→good`），保留旧评分字符串作为兼容输入，前端三档入口不变。
- **新增分钟级学习步（learning steps）**：新卡与遗忘卡进入 `learning` / `relearning` 状态，按 1 分钟 → 10 分钟 → 毕业进入 `review` 状态推进，而不是当天一次性 `due = 今天`。卡片新增 `dueAt`（ISO 时间戳）承载分钟级精度；`due`（`YYYY-MM-DD`）继续输出以保持列表/筛选兼容。
- **新增复习日志与真实保留率**：卡片记录 `logs`（逐次 `{at, result, elapsedDays, interval, stability, difficulty, mastery}`，上限条数），`/api/reviews` 统计新增真实保留率（`again` 占比）与到期预测随学习步更新。
- **修正掌握度底座**：`masteryOf` 在尚无客观作答时不白送 12 分（`objRate == null` 分支），避免新卡掌握度虚高。
- **兼容与迁移**：既有卡片（无 `dueAt` / `logs` / `state`）在首次读取或下次评分时惰性补齐，不重置已有 `stability` / `difficulty` / `interval` / `lapses`；`forgot` / `fuzzy` / `known` 的 API 请求体继续可用。

## Capabilities

### New Capabilities

- `review-scheduling`: 复习卡片的间隔重复排期行为——评分档位、经过时间与保留率模型、目标保留率、学习步与复习状态机、到期时间精度、复习日志与真实保留率统计。

### Modified Capabilities

无（`openspec/specs/` 目前为空，这是一项全新能力）。

## Impact

- **后端**：
  - `src/routes.js`：`scheduleReview`、`masteryOf`、`bumpObjective`、`interleave`、`REVIEW_RESULTS`、`LEECH_LAPSES` 相关逻辑；`GET /api/reviews` 统计；`POST /api/reviews/:id/answer` / `/check` / `/feynman`；`POST /api/reviews/sync`、`/reviews/confusions`（新卡初始化）；`POST /api/mistakes/:id/retry`、`POST /api/mistakes/:id/variants/grade`（联动排期）；`GET /api/mistakes`（`nextDue`）。
  - 数据：`data/db/reviews.json` 卡片文档新增 `state` / `dueAt` / `learningStep` / `lastElapsedDays` / `logs` 字段；旧文档惰性补齐。
- **前端** `public/app.js` / `index.html` / `styles.css`：复习队列按 `dueAt` 排序与过滤、学习步卡片展示「X 分钟后再来」、评分按钮映射到 4 档、复习看板展示真实保留率；错题本 `nextDue` 展示保持可用。
- **接口兼容**：`/api/reviews/*` 请求与响应字段为增量变更；`result` 参数接受旧 3 档与新 4 档。
- **无新增依赖**，不影响出题 / 评卷 / 错题本主流程。
