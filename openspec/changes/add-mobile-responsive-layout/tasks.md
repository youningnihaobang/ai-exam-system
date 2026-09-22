# Tasks

## 1. 视口、安全区与动态视口高度

- [x] 1.1 `public/index.html` 的 viewport 改为 `width=device-width, initial-scale=1.0, viewport-fit=cover`；用 `node --input-type=module -e` 读文件断言：含 `viewport-fit=cover`，且不含 `maximum-scale` 与 `user-scalable`。
- [x] 1.2 `public/styles.css` 的 `:root` 新增 `--safe-t / --safe-r / --safe-b / --safe-l`（`env(safe-area-inset-*, 0px)`），并给 `html` 加 `-webkit-text-size-adjust: 100%`；断言 CSS 中存在这四个变量定义与 `-webkit-text-size-adjust`。
- [x] 1.3 在 `.topbar`、`main`、`.exam-footer`、`.toast`、`.overlay-box` 应用安全区留白，并给 `.toast` / `.overlay-box` 加 `max-width: calc(100vw - …)`；断言这些规则的声明块内出现 `var(--safe-`；devtools 320px 下顶栏文字、底部按钮、浮层均完整可见不被裁切。
- [x] 1.4 `.layout` 高度由 `calc(100vh - 122px)` 改为「先 `100vh` 回退、再 `100dvh` 覆盖」两行写法；断言 CSS 中 `(.layout)` 规则块同时含 `100vh` 与 `100dvh` 两行高度声明。

## 2. 窄屏侧栏收放与状态记忆

- [x] 2.1 在 `max-width: 900px` 媒体查询内把 `.side-toggle` 从「`display: none`」改为文档流内整行控件（`position: static; width: 100%; height: 44px; display: flex`），并用 `.layout.collapsed .side-toggle::after` / `.layout:not(.collapsed) .side-toggle::after` 注入「展开科目列表 / 收起科目列表」文案；断言媒体查询区块内含 `position: static` 与两处 `::after` 文案；devtools 375px 打开「答题评卷」时侧栏上方出现整行按钮。
- [x] 2.2 窄屏 `.layout { gap: 12px }`，`.subject-nav { max-height: 30vh; overflow-y: auto }`，`#paperList { max-height: 40vh }`（覆盖现有 420px 固定值）；展开侧栏后侧栏总高度不超过 70vh，且页面不出现横向滚动。
- [x] 2.3 改写 `public/app.js` 的 `initSideToggles()`：localStorage `ui.sideCollapsed` 值结构升级为 `{ wide: {...}, narrow: {...} }`，读取时把不含这两个键的旧扁平值整体归入 `wide`；用 `node --input-type=module -e` 对抽出的分桶 / 兼容读取逻辑做断言（旧值 → 全归 `wide`；按 mode 取值；两桶互不覆盖）。
- [x] 2.4 用 `matchMedia('(max-width: 900px)')` 的 `change` 监听在跨断点时重新 `apply()`；devtools 在 375px 收起侧栏后拉到 1280px，确认桌面按 `wide` 桶的已保存状态显示，且窄屏操作只写 `narrow` 分支（在 Application → Local Storage 中确认）。

## 3. 横向溢出治理

- [x] 3.1 给弹性 / 栅格子项补 `min-width: 0`（表单控件 `.field input/select/textarea`、`.actions > *`、`.side-head > *`、`.review-row .rr-main`、`.doc-item .n`、`.history-row .h-main`、`.topbar-right > *`）；判定标准：断言的修复声明存在，且 320px 下生成试卷页（含科目 / 难度 `.grid` 与「年份范围 / 真题考点占比」两列表单）无横向滚动。
- [x] 3.2 `.board` 轨道改为 `repeat(auto-fit, minmax(min(240px, 100%), 1fr))`；窄屏 `.score-text { min-width: 0 }`、`.cloze-row .cz-hint { flex: 0 0 100% }`；断言旧声明（`minmax(240px, 1fr)`、`min-width: 260px`、`flex: 0 0 120px`）已被覆盖；320px 下复习看板、成绩卡、挖空回忆三处均无横向滚动。
- [x] 3.3 给 `.actions`、`.side-head`、`.filters`、`.review-row`、`.doc-item`、`.subject-lib .actions` 补 `flex-wrap: wrap`；320px 下错题本与复习页头部（标题 + 三个筛选 chip）与解析文档库条目换行显示，不溢出卡片。
- [x] 3.4 窄屏覆盖 `.real-opts .grid.two { grid-template-columns: 1fr }`（现有 `.grid` 单列规则因特异性不足未生效）；320px 下勾选「参考历年真题」后两个输入框纵向排列，无横向滚动。
- [x] 3.5 给 `.q-stem`、`.analysis`、`.comment`、`.opt span`、`.doc-item`、`.history-row .h-title` 加 `overflow-wrap: anywhere`，`.code-block` 继续 `white-space: pre` + 块内 `overflow-x: auto`；用含长 URL 与连续英文串的试卷 / 解析验证 320px 下页面宽度不变。
- [x] 3.6 确认未使用遮罩式兜底：断言 CSS 中不存在 `html` / `body` 上的 `overflow-x: hidden` 声明（避免静默裁切内容与破坏 `position: sticky` 的滚动祖先链）。

## 4. 触摸目标与输入字号

- [x] 4.1 窄屏把可聚焦文本类控件的 `font-size` 提到 16px（`.field input/select/textarea`、`textarea.answer-box`、`.answer-input`、`.blank-inputs input`、`.cloze-row input`、`.spec-row input`、`.subject-lib select.grow`、`.model-pick select`）；断言窄屏媒体查询内出现 `font-size: 16px` 且作用于表单控件；devtools 375px 聚焦答题文本框与大纲文本框时视口缩放比例不变、页面不跳变，且生成试卷表单各字段仍正常换行。
- [x] 4.2 `.q-dot` 在窄屏放大到 44×44，并给 `.q-nav` 加 `max-height: 96px; overflow-y: auto`；断言尺寸声明存在；devtools 量取题号按钮命中区 ≥44×44，且在 30 题卷上答题卡不把题目区顶出首屏。
- [x] 4.3 窄屏把 `.chip`、`.ghost.small`、`.opt`、`.check-line` 的命中区提到 ≥44px（内边距 / `min-height`）；量取「全部 / 未掌握 / 已掌握」与错题卡「重做一遍」按钮高度 ≥44px，并确认点击相邻 chip 边缘时命中的是所点那一个、未触发邻居。
- [x] 4.4 新增 `max-width: 420px` 压缩档：`main` 内边距 12px、`.card` 14px、`.actions` gap 收窄、`.spec-row` 列宽改 `1fr 72px 72px` 并缩小内边距 / 间距；320px 下题型配置行（题型名 + 题量 + 每题分值）三列完整可编辑且不溢出。

## 5. 顶栏与常驻操作条

- [x] 5.1 窄屏 `.tabs` 改 `flex-wrap: nowrap; overflow-x: auto` 并隐藏滚动条；`.topbar-right` / `.status` / `#modelPick` 允许收缩换行，`#modelPick` 加 `max-width: 100%; min-width: 0`；320px 下五个 tab 均可点选并正确切换视图，顶栏无横向滚动，模型下拉与 AI 状态完整可见可操作。
- [x] 5.2 `.exam-footer` 加底部安全区留白并确认窄屏下仍吸底；375px 下滚动长题干时「上一题 / 下一题 / 提交并评卷」始终可见可点，聚焦作答框唤起输入法后仍可点击。
- [x] 5.3 校对 `gotoQuestion()` / `scrollExamTop()`（`public/app.js`）在新滚动结构下的滚动目标：窄屏 `.main-col` 不再独立滚动时回退页面滚动；窄屏切题后题干顶部可见且不被吸顶栏遮挡。

## 6. 端到端验收

- [ ] 6.1 横向滚动验收：在 320 / 375 / 414 / 768 四个宽度下依次打开生成试卷、答题评卷、做题历史、错题本、复习五个页面，执行 `document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth` 并记录每页结果。
- [ ] 6.2 交互验收：窄屏首次进入各视图时侧栏默认收起且主内容首屏可见 → 点整行按钮可展开 / 收起 → 刷新后保持；再从窄屏拉宽到桌面宽度，确认两个断点的收放状态互不影响。
- [ ] 6.3 桌面零回归：1280px 下两栏并排、侧栏收放入口与记忆、键盘 `←` `→` 切题、「答完自动下一题」记忆均照旧生效。
- [ ] 6.4 `openspec validate add-mobile-responsive-layout --strict` 通过；`npm start` 后打开各页面无新增控制台报错，且未改动任何接口请求 / 响应。
- [ ] 6.5 真机安全区（可选，无设备则记录为未验证）：在带刘海与 Home 指示条的手机上确认顶栏与底部常驻操作条不被系统 UI 遮挡。
