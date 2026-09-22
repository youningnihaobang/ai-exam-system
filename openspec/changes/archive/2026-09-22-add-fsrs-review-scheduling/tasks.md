# Tasks

## 1. 排期核心：评分归一化与保留率公式

- [x] 1.1 在新增的排期核心模块 `src/review.js` 定义四档评分常量（`again|hard|good|easy`）与旧档映射（`forgot→again`、`fuzzy→hard`、`known→good`），实现归一化函数；用 `node --input-type=module -e` 断言三档旧值映射结果正确、非法值返回空。
- [x] 1.2 在 `src/review.js` 实现保留率与间隔换算：`retention(t, S) = (1 + t/(9S))^-1` 与 `intervalFor(r, S) = 9S(1/r - 1)`，并夹在 `[1, REVIEW_MAX_INTERVAL]`；用 node 断言 `r = 0.9` 时 `intervalFor ≈ S`、`r` 越高间隔越短。
- [x] 1.3 在 `src/routes.js` 实现目标保留率读取（`REVIEW_DESIRED_RETENTION` → `settings['review.desiredRetention']` → 默认 `0.9`），非法值由 `resolveDesiredRetention` 回落；已断言合法值、越界值与 NaN 的回落行为。
- [x] 1.4 重写排期计算（`src/review.js` 的 `scheduleReview`）：加入 `elapsedDays` 与保留率 `R`，按 design.md 的四档表更新 `stability` / `difficulty`，并按 `g = clamp((1-R)/(1-r), 0.5, 2)` 缩放增长；`good` 及以上保留「不小于上次间隔」约束。断言结果：同上状态下以 `good` 复习，逾期 10 天得到 19 天、逾期 30 天得到 29 天。
- [x] 1.5 修正 `masteryOf`：无客观作答时该分量记 0；断言新卡（无 objective）掌握度为 0，且积累正确客观作答后掌握度上升。

## 2. 学习步、状态机与到期时间

- [x] 2.1 定义卡片状态常量与学习步常量 `[1, 10]`（分钟），实现状态迁移：`new`/`learning`/`relearning` 走分钟级学习步、`review` 走天级间隔，`again` 重置到第一步；断言新卡首评后 `state = learning` 且 `dueAt` 为 10 分钟后、再次通过后 `state = review`、`review` 卡提交 `again` 后 `state = relearning` 且 `lapses` 累计。
- [x] 2.2 卡片新增 `dueAt`（ISO 时间戳）并作为排期真值，统一在输出前由 `dueAt` 推导 `due`（本地时区 `YYYY-MM-DD`）；断言天级卡片的 `dueAt` 为当日 00:00、`due` 与之同日。
- [x] 2.3 实现惰性迁移 `ensureCardShape` / `needsCardShape`：补齐 `state`（按 `reviews > 0` 推断）、`step`、`dueAt`、`logs`、`lastElapsedDays`，且不改动 `stability`/`difficulty`/`interval`/`streak`/`lapses`/`reviews`；在 `GET /api/reviews`、`GET /api/mistakes` 批量调用并仅在确有变化时落盘。对 90 张真实历史卡片验证：补齐后 `state`/`dueAt`/`logs` 齐全、排期字段逐字段未变。

## 3. 复习日志与统计

- [x] 3.1 每次排期写入一条 `logs` 记录（`at` / `result` / `elapsedDays` / `interval` / `stability` / `difficulty` / `state`）并 `slice(-50)`；断言 51 次复习后日志长度为 50 且保留最近记录。
- [x] 3.2 `GET /api/reviews` 的 `stats` 新增 `retention`（`reviews` / `again` / `sampled` / `rate`，无日志时 `rate` 为 `null`）、`learning` 与 `desiredRetention`；用真实服务验证返回 `{"reviews":7,"again":1,"sampled":3,"rate":0.857}`、`learning` 与 `desiredRetention=0.9` 自洽。

## 4. 改动到期判断与联动入口

- [x] 4.1 `GET /api/reviews` 的 `?due=1` 由 `due <= today` 改为按 `dueAt` 时间戳判定，保持按知识点交错；验证 `?due=1` 返回 85 张、每张 `dueAt <= now`、相邻知识点不重复。
- [x] 4.2 5 个排期入口（`/reviews/:id/answer`、`/reviews/:id/check`、`/reviews/:id/feynman`、`/mistakes/:id/retry`、`/mistakes/:id/variants/grade`）全部改走统一的 `applySchedule()`；`feynman` 分数线改为产出四档（`≥90 easy / ≥80 good / ≥60 hard / 否则 again`）后归一化。
- [x] 4.3 新卡初始化（`/reviews/sync`、`/reviews/confusions`）补齐 `state`/`step`/`dueAt`/`logs`/`lastElapsedDays`；`GET /api/mistakes` 的 `nextDue` 改返回 `dueAt`，验证为可解析的 ISO 时间戳。

## 5. 前端适配

- [x] 5.1 `public/app.js` 新增 `cardDueTime()`，复习队列排序、客户端兜底到期判断、全部卡片列表的到期高亮都改用 `dueAt`（缺失回退 `due`）；`?due=1` 仍走服务端交错队列。
- [x] 5.2 复习卡片与卡片列表展示学习步信息：`state` 为 `learning`/`relearning` 时显示「下次复习 X 分钟后」与状态标签，`review` 时显示「间隔 N 天」；错题本 `nextDue` 用 `dueTextShort()` 格式化，不再裸显 ISO 串。
- [x] 5.3 复习看板新增三项统计：真实保留率、短期记忆中卡片数、生效目标保留率；无数据时保留率显示 `—`。
- [x] 5.4 评分按钮沿用三档，附上映射说明（忘了→again、模糊→hard、记得→good），服务端归一化生效；完成一轮复习后卡片排期按新规则推进（已验证 learning → review → relearning 全链路）。

## 6. 端到端验收

- [ ] 6.1 全流程验收：启动服务 → 首次复习（观察进入 `learning` 与分钟级到期）→ 连续通过至毕业 → 对已毕业卡片提交「忘了」（观察进入 `relearning` 且 `dueAt` 回到分钟级）→ 逾期数日后复习（观察间隔增长变快）；需在浏览器里实际操作一次并记录结果。
- [x] 6.2 兼容验收：对变更前的 90 张历史卡片启动，确认列表/看板不报错、既有 `interval`/`lapses` 未被重置、`GET /api/reviews` 同时返回 `dueAt` 与 `due` 且二者同日。
- [ ] 6.3 回归验收：确认出题 / 评卷 / 错题本 / 做题历史页面无新增报错，`openspec validate add-fsrs-review-scheduling --strict` 通过。（已完成一半：`--strict` 校验通过；页面回归待人工确认。）
