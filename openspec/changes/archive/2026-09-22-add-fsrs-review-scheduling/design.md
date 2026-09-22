# Design

## Context

现有排期逻辑集中在 `src/routes.js` 的复习区块（`REVIEW_RESULTS` / `REVIEW_MAX_INTERVAL` / `masteryOf` / `scheduleReview` / `bumpObjective` / `interleave`），卡片文档存在 `data/db/reviews.json`，通过 `src/store.js` 读写。约束：

- 存储是零依赖 JSON 文档库（`src/db.js`），没有 schema 校验与迁移框架，历史卡片只有旧字段（`stability` / `difficulty` / `interval` / `streak` / `lapses` / `reviews` / `due` / `lastResult` / `lastReviewedAt` / `objective` / `whyLogs` / `cloze` / `mnemonic` / `feynman`）。
- 排期被 5 个入口复用：`/reviews/:id/answer`、`/reviews/:id/check`、`/reviews/:id/feynman`、`/mistakes/:id/retry`、`/mistakes/:id/variants/grade`。
- 前端 `public/app.js` 直接用 `card.due` 做排序、`due <= today` 判断到期、用 `interval` / `mastery` / `lapses` 展示，并在客户端把 `forgot` 重新 push 回本轮队列。
- `settings` 集合已用于存少量键值（如 `model`），`store.setSetting` 可用，但没有通用设置接口。

## Goals / Non-Goals

**Goals：**

- 让下次间隔真正依赖「距上次复习的实际经过时间」，且能在不引入依赖的前提下表达「目标保留率」。
- 用分钟级学习步替代「`interval = 0` + 前端内存队列」，使当天重来在刷新后可恢复。
- 保留 `due`（日期）语义以最小化前端改动，同时新增 `dueAt`（时间戳）承载精度。
- 让历史卡片零重置地迁移到新字段。

**Non-Goals：**

- 不实现完整的 FSRS 参数自学习（optimizer）：不根据个人复习历史拟合 `w0..w17`，稳定度/难度更新仍用近似规则，只新增可支撑将来拟合的复习日志。
- 不改动错题本两级分组、交错策略、AI 手段（挖空 / 助记 / 费曼 / 易混卡）本身。
- 不做日报 / 提醒 / 推送。
- 不引入数据库迁移脚本或新依赖。

## Decisions

### 1. 保留率的算法形式

采用 `R(t, S) = (1 + t / (9S))^-1`，反推目标保留率 `r` 下的间隔 `t = 9S(1/r - 1)`。

- 选它的理由：默认 `r = 0.9` 时 `t = S`，与现有「间隔 ≈ 稳定度」的实现平滑衔接，升级后既有卡片排期不会突变；公式简单、无需查表。
- 备选：FSRS-4.5 的 `R = (1 + (19/81)·t/S)^(-0.5)`（更贴近真 FSRS，但默认保留率下 `t ≈ 0.94S`，且常数不如 `9S` 形式直观）；简单幂律 `R = e^(-t/S)`（与现有代码差异最大）。
- 逾期通过「稳定度增长系数」进入计算：`g = clamp((1 - R) / (1 - r), 0.5, 2)`。按时复习（`R = r`）时 `g = 1`，与决策 2 的基准表一致；逾期成功回忆时 `g > 1`，提前复习时 `g < 1`。这样 `R` 同时参与「间隔换算」与「稳定度增长」，无需额外分叉惩罚逻辑。
- **方向更正（实现阶段发现）**：逾期后仍能成功回忆，说明记忆比按预期衰退得更慢，因此下次间隔应当更长（间隔重复的 spacing effect，与 FSRS 的 `SInc` 一致）。最初设想的「逾期 → 间隔增长变慢」与记忆规律相反，已同步更正 spec 的对应需求与场景。

### 2. 评分档位与更新规则

内部统一为 `again` / `hard` / `good` / `easy`，`forgot` / `fuzzy` / `known` 归一化映射。稳定度 / 难度更新：

| 档位 | 难度 D | 稳定度 S |
| --- | --- | --- |
| again | `D + 0.8` | `S × 0.28`（且进入 relearning） |
| hard | `D + 0.15` | `S × (1 + 0.55 × (1 - D/10))` |
| good | `D - 0.15` | `S × (1 + 1.8 × (1 - D/10))` |
| easy | `D - 0.4` | `S × (1 + 3.0 × (1 - D/10))` |

- D 仍夹在 `[1, 10]`，S 仍夹在 `[0.4, REVIEW_MAX_INTERVAL × 1.5]`。
- `hard` / `good` / `easy` 的稳定度增量统一乘以决策 1 的增长系数 `g`：表内数值是 `g = 1`（按时复习）时的基准；`again` 走固定回退 `S × 0.28`，不受 `g` 影响。学习步期间（卡片尚未毕业）`g` 固定为 1，因为分钟级间隔无法表达遗忘率。
- `good` 及以上仍保留「不小于上次间隔」（`max(interval, ceil(prevInterval × 1.05))`）以防间隔倒退；`hard` 允许与上次持平。
- 毕业（学习步走完）时同样使用基准增长（`g = 1`），并复用同一条「不小于上次间隔」保护。
- 前端三档按钮不变：`忘了→again`、`模糊→hard`、`记得→good`；`easy` 目前由费曼复述高分（≥ 90）与 API 直接传入触发，UI 不做独立入口。**决策理由**：避免一次改动同时变更交互与算法，缩小回归面。

### 3. 学习步与状态机

卡片新增 `state`（`new` / `learning` / `review` / `relearning`）与 `step`（学习步下标），学习步常量 `[1, 10]`（分钟）。

- 新卡入库：`state = 'new'`，`step = 0`，`dueAt = 创建时刻`（当天即可复习）。
- 卡片处于 `new` / `learning` / `relearning` 时提交评分：
  - `again` → `step = 0`，`dueAt = now + 1min`，`state = relearning`（若原来是 new/learning 则保持 learning）；
  - 其他档位 → `step += 1`；若 `step >= 学习步长度` 则毕业：按公式算出以天为单位的 `interval` 与 `dueAt`，`state = 'review'`；否则 `dueAt = now + 学习步[step] 分钟`。
- 卡片处于 `review` 时提交评分：`again` → `state = 'relearning'`、`step = 0`、`dueAt = now + 1min`、`lapses += 1`；其余档位按第 2 节算出 `interval` / `dueAt`，`state` 保持 `review`。

### 4. 到期时间的双字段表示

`dueAt`（ISO 时间戳）为唯一真值，`due` 由 `dueAt` 按本地时区推导（`dayStr(new Date(dueAt))`）后随响应输出。

- 这样 `GET /api/reviews?due=1` 的「今日到期」判断从 `due <= today` 改为 `dueAt <= now`，学习步卡片能在 10 分钟后重新出现；而列表展示、`?subject=`、复习看板预测继续用 `due`，前端改动最小。
- 前端主队列排序改为按 `dueAt` 升序（缺失时回退 `due`），`public/app.js` 的 `reviewDueCards()` 客户端兜底同样处理。

### 5. 复习日志与保留率统计

卡片新增 `logs`，元素为 `{ at, result, elapsedDays, interval, stability, difficulty }`，写入时 `slice(-50)`。`GET /api/reviews` 的 `stats` 新增：

- `retention`：`{ reviews, again, rate }` —— 基于 `logs` 统计（`rate = 1 - again / reviews`，无日志时为 `null` 并给出 `sampled` 卡片数）；
- `learning`：学习/重学状态卡片数，便于前端提示「今天还有 X 张在短期记忆里」。

不新增独立日志集合，避免为每张卡片维护第二份数据与额外落盘。

### 6. 目标保留率的配置

读取顺序：环境变量 `REVIEW_DESIRED_RETENTION` → `settings` 集合键 `review.desiredRetention` → 默认 `0.9`；取值非法或超出 `(0.7, 0.98)` 时回落默认值。生效值在 `GET /api/reviews` 的 `stats.desiredRetention` 中回显，便于验证。

- 决策理由：复用已有 `settings` 集合与 `getSettings()`，不新增设置接口；先不做 UI 开关，避免扩大本次范围。

### 7. 掌握度修正

`masteryOf` 中 `objRate == null` 时该分量记 0（原为白送 12）。因为 `mastery` 是**存量字段**，历史卡片会保留旧值，因此列表响应统一改为总是重算（不再优先读回存量 `mastery`），确保修正对旧卡同样生效；写回时仍照旧落一个 `mastery` 值，仅为兼容旧前端与旧代码。

### 8. 惰性迁移

新增 `ensureCardShape(card)`（配 `needsCardShape` 判断是否需要落盘）：在列表读取路径（`GET /api/reviews`、`GET /api/mistakes`）批量补齐并仅在确有变化时落盘；每次排期计算前由 `scheduleReview` 对卡片副本再兜底一次，避免单卡入口依赖列表接口。补齐字段：

- 有 `due` 无 `dueAt` → `dueAt = 当天 00:00`；
- 无 `state` → 有 `reviews > 0` 的视为 `review`，否则 `new`；
- 无 `step` → `0`；无 `logs` → `[]`；无 `lastElapsedDays` → 由 `lastReviewedAt` 与上上次推导或置 `0`；
- **不触碰** `stability` / `difficulty` / `interval` / `streak` / `lapses` / `reviews`。

### 9. 排期逻辑抽成独立模块

排期核心（评分归一化、保留率与间隔换算、`masteryOf`、`ensureCardShape`、`scheduleReview`、日志统计）从 `src/routes.js` 抽到新的 `src/review.js`，只依赖 `dayStr` 这类本地日期工具，不 import SDK / 存储。

- 理由：`routes.js` 已 2600+ 行且间接依赖 `@tencent-ai/agent-sdk`，其中的模块私有函数无法被 `node -e` 直接断言；抽成纯模块后，本变更要求的行为断言（任务 1.1–1.5、2.1–2.3、3.1）可以在不启动服务、不加载 SDK 的前提下执行。
- `routes.js` 只保留「读存储 → 调用 `scheduleReview` → 写回」的编排，并新增 `applySchedule()` 作为 5 个入口的统一排期出口。
- 备选：把函数留在 `routes.js` 里并用 `export` 暴露——被否决，因为 import `routes.js` 会连带加载 SDK，断言脚本需要完整的 CLI / 认证环境。

## Risks / Trade-offs

- [上线后历史卡片掌握度整体下降（客观分量不再白送 12 分）] → 这是刻意的准确性修正；在变更说明中标注，且 `retention` / `learning` 新指标共同平滑看板数值，避免用户误解为「退步」。
- [新旧数据混排导致 `due` / `dueAt` 不一致] → 统一由 `dueAt` 推导 `due`，并在输出时对缺失 `dueAt` 的卡片即时补齐，保证同一张卡的两种表示恒等。
- [客户端会话队列与服务端学习步重复] → 短期内客户端 `forgot` 重入队列的行为保留，由服务端 `dueAt` 作为真值；行为上「重来」会比纯客户端队列更严格（受 `dueAt` 约束），但不会丢失进度。后续可让前端按 `dueAt` 决定是否立刻展示。
- [`easy` 档暂无 UI 入口，算法分支缺真实流量] → 保留三档映射，`easy` 只在 API 层可测；用接口测试覆盖四档即可。
- [`logs` 上限 50 会丢失长期历史，无法做完整参数拟合] → 当前目标是「真实保留率 + 可观测」，不追求拟合；若将来要做 optimizer 再单独提变更升级为独立日志集合。
- [设置分散在 env 与 `settings` 集合，无 UI] → 在 `stats.desiredRetention` 回显生效值降低排查成本。

## Migration Plan

1. 部署新逻辑；无需数据迁移脚本，历史卡片在首次读取时惰性补齐字段（`dueAt` 取当天 00:00，`state` 按 `reviews` 推断）。
2. 回滚策略：新字段是增量且 `due` 仍被输出，回滚旧代码后卡片仍可被旧逻辑读写（旧代码忽略未知字段），排期进度不丢失。
3. 观察点：`stats.retention` 与 `stats.learning` 出现后，确认「今日待复习」数量不会因学习步而异常膨胀。

## Open Questions

- 学习步时长（`[1, 10]` 分钟）与最大日志条数（50）是否需要做成配置：可后续放进同一 `settings` 键组，不影响本次接口与数据结构。
- 是否给 `easy` 增加前端入口：取决于观察 `retention` 后是否需要 4 档区分度，可独立提变更。
