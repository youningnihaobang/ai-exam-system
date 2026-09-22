# Design

## Context

动机见 proposal.md 的 Why；需求契约见 `specs/responsive-ui/spec.md`。影响方案的前端现状与约束：

- 前端是**无构建**的原生三件套：`public/index.html`（354 行，静态骨架，全部视图节点已存在）、`public/styles.css`（515 行，**唯一**样式表）、`public/app.js`（3453 行，绝大部分 DOM 由模板字符串生成）。
- 现有唯一断点 `@media (max-width: 900px)`（`styles.css:503-515`）共 10 条规则，做的是「`.layout` 改单列 + 隐藏 `.side-toggle` + 放开滚动容器 + `.tabs` 占整行」。它没有处理溢出、触摸目标、输入字号、安全区与视口高度。
- 侧栏收放由 `initSideToggles()`（`app.js:477-506`）实现：类名 `.collapsed` 挂在 `.layout` 上，状态存 `localStorage['ui.sideCollapsed']`，值形如 `{ exam: true, mistakes: false }`（**按视图的扁平结构**）。CSS 侧 `.layout.collapsed` 只做两件事：单列化 + 隐藏 `.side`（`styles.css:185-187`）。
- `.side-toggle` 是 `.layout` 的**绝对定位**子元素（`position: absolute; left: 291px`，`styles.css:176-182`），因此它不占栅格单元；变成 `position: static` 后就会成为一个正常栅格项，插入到 `.side` 之前。
- 视图切换是 `switchView()`（`app.js:508-521`）纯类名切换，五个 `<section class="view">` 同时在 DOM 里；滚动由 `.main-col`（桌面，独立滚动）或页面（窄屏，`overflow: visible`）承担。
- 无测试框架（`package.json` 只有 `start` / `dev` 两个脚本），无 CSS 预处理器，无 lint 配置。既有变更（`archive/2026-09-22-add-fsrs-review-scheduling`）的验证方式是 `node --input-type=module -e` 断言纯逻辑 + 浏览器人工验收。

## Goals / Non-Goals

**Goals：**

- 在 **320px ~ 900px** 宽度区间内实现 specs 定义的行为契约，且改动集中在 `styles.css` + 少量 `app.js` 收放逻辑，不引入构建步骤或新依赖。
- 让窄屏下的 `.side-toggle` 重新可用，并且**不与主内容重叠**（这是现有绝对定位方案在窄屏无法直接复用的原因）。
- 让收放状态记忆在「窄屏 / 桌面」两个断点下互不覆盖，同时兼容已存在的扁平格式 localStorage 值。
- 用**根因修复**（`min-width: 0`、`minmax(min(...), 1fr)`、`flex-wrap`、`overflow-wrap`）消除横向溢出，而不是用 `overflow-x: hidden` 掩盖。

**Non-Goals：**

- 不做视觉重设计：不改配色、圆角、字体族、卡片层级，也不引入设计系统或 CSS 框架。
- 不做暗色模式、PWA / 离线、底部 App 式 Tab Bar、手势（滑动切题）等新增交互。
- 不改任何接口、数据结构、服务端代码（`src/**` 不动）。
- 不引入 Playwright / Puppeteer 等浏览器自动化（会带来依赖与浏览器下载），溢出与安全区的最终判定仍是人工验收。
- 不追求 320px 以下（如 280px 折叠屏外屏）的完备支持。

## Decisions

### 1. 断点策略：一个语义主断点 + 一个压缩档

主断点沿用 **`max-width: 900px`**，与 spec 中「窄屏」的定义严格对齐，也让现有 10 条规则自然归入同一层级（不产生两套并存的窄屏语义）。另加 **`max-width: 420px`** 作为超窄压缩档，只调整内边距、间距与 `.stat-grid` 列数。

- 理由：spec 的验收场景按「< 900px」描述，若再引入 768 / 640 等中间断点，会立刻出现「这条规则属于哪档」的歧义，而收益仅是 tablet 竖屏的观感，不值当。
- 备选：移动优先重写（`base` 为窄屏 + `min-width` 媒体查询向上增强）。被否决——会把 515 行现有桌面规则的书写范式整体倒置，diff 巨大且无法用现有手工验收覆盖。
- 备选：引入容器查询（`@container`）。被否决——`.layout` / `.card` 的宽度由视口单决定，容器查询无额外收益，且降低老浏览器兜底能力。

### 2. 窄屏侧栏：把收放按钮变成文档流里的整行控件

在 `max-width: 900px` 下，`.side-toggle` 不再 `display: none`，而是改为：

- `position: static`（脱离绝对定位）→ 自然成为 `.layout` 的第一行栅格项，位于 `.side` 与 `.main-col` 之前；
- `width: 100%; height: 44px`，`display: flex; justify-content: center`，作为一条「展开 / 收起科目列表」的操作条；
- 通过 CSS 给 `.layout.collapsed .side-toggle::after` / `.layout:not(.collapsed) .side-toggle::after` 注入文案（`展开科目列表` / `收起科目列表`），与 JS 已写入的 `«` / `»` 箭头并列显示 —— 这样**不需要改 JS 的文案逻辑**（`app.js:491-501` 的 `btn.textContent` 保持原样）。
- 窄屏 `.layout { gap: 12px }`，`.side` 展开时高度受控：`.subject-nav { max-height: 30vh; overflow-y: auto }`、`#paperList { max-height: 40vh }`（覆盖 `styles.css:512` 的 420px 固定值）。

- 理由：绝对定位的浮层 / 抽屉方案需要遮罩层、滚动锁、`z-index` 与「点击空白收起」等配套逻辑（都要改 JS 与 DOM），而整行按钮方案只靠 CSS 就能满足 spec 的「首屏见主内容 + 可收放 + 不重叠 + 不产生横向滚动」四条场景。
- 备选：抽屉浮层。取舍见上，且窄屏 `#paperList` 本身有独立滚动，浮层内再滚动会形成嵌套滚动区，触控体验更差。
- 备选：窄屏隐藏侧栏、改用 `<select>` 选科目 / 试卷。被否决——需要新增 DOM 与渲染分支，违反 Non-Goals「不做视觉重设计」，且会与 `renderSubjectNav()` 的现有渲染逻辑分叉。

### 3. 收放状态的按断点记忆

`localStorage['ui.sideCollapsed']` 的值结构升级为 `{ wide: { exam: true }, narrow: { exam: false } }`（`narrow`/`wide` 由 `window.matchMedia('(max-width: 900px)')` 决定）。读取时做兼容：

- 若取到的对象**不含** `wide` 与 `narrow` 键 → 视为旧扁平格式，整体归入 `wide`（即「用户在桌面上的既有选择」被保留）；`narrow` 视为空 → 每个视图首次进入窄屏时按「收起」处理，满足 spec 的默认收起要求。
- 窄屏下用户显式操作后，只写 `narrow[view]`，不触碰 `wide[view]`；反之亦然 → 满足「MUST NOT 用另一断点的默认值覆盖用户的显式选择」。
- 用 `matchMedia(...).addEventListener('change', ...)` 在跨断点瞬间重新 `apply()` 一次，使布局与状态立即一致。

- 理由：spec 要求分断点隔离，扁平结构做不到；而「旧值归入 `wide`」既保住老用户桌面端的现状，又让窄屏拿到 spec 要求的默认收起，且无需一次性迁移脚本。
- 备选：换新 key（如 `ui.sideCollapsed.v2`）。被否决——旧 key 会永远残留，且首屏会出现一次「读旧→写新」的抖动窗口。

### 4. 溢出治理的三条手段

1. **弹性 / 栅格子项基线** `min-width: 0`：`.field input/select/textarea`、`.actions > *`、`.side-head > *`、`.review-row .rr-main`、`.doc-item .n`、`.history-row .h-main`、`.topbar-right > *`。关键是**表单控件**：`input` / `select` 的 `min-content` 由默认 `size=20` 或最长 `option` 决定，在 `1fr` 列里会直接顶破容器 —— 这是 `.grid` / `.real-opts .grid.two` 在窄屏溢出最容易被忽略的原因。
2. **不设下限的网格轨道**：`.board` 的 `repeat(auto-fit, minmax(240px, 1fr))` 改为 `repeat(auto-fit, minmax(min(240px, 100%), 1fr))`；`.score-text` 的 `min-width: 260px` 在窄屏改 `min-width: 0`；`.cloze-row .cz-hint` 的 `flex: 0 0 120px` 在窄屏改 `flex: 0 0 100%`（整行提示词，输入框换到下一行）。
3. **换行与断词**：`.actions`、`.side-head`、`.filters`、`.review-row`、`.doc-item`、`.subject-lib .actions`、`.mistake-actions`、`.q-nav-wrap` 补 `flex-wrap: wrap`；`.q-stem` / `.analysis` / `.comment` / `.option 文本` / `.doc-item` / `.history-row .h-title` 补 `overflow-wrap: anywhere`（长 URL、连续英文串不撑破卡片）；`.code-block` 维持 `white-space: pre; overflow-x: auto`（spec 允许的自包含滚动容器）。

**明确不做**：不给 `body` / `html` 加 `overflow-x: hidden`。理由：它会把「真实溢出」变成「内容被静默裁掉」，同时破坏 `position: sticky` 的滚动祖先链（`.topbar` 与 `.exam-footer` 都依赖它），属于用症状掩盖病因。

### 5. 输入的 iOS 缩放：抬字号，不禁缩放

窄屏下把可聚焦文本类控件的 `font-size` 提到 **16px**：`.field input/select/textarea`、`textarea.answer-box`、`.answer-input`、`.blank-inputs input`、`.cloze-row input`、`.spec-row input`、`.subject-lib select.grow`、`.model-pick select`。用 `:where()` 或媒体查询内的同权重选择器覆盖即可，不动桌面端数值。

- 理由：Safari 的自动缩放阈值是控件 `font-size < 16px`；把字号抬到 16px 是唯一既满足 spec「不缩放」又满足「MUST NOT 禁用缩放」的做法。
- 备选：`<meta name="viewport" content="..., maximum-scale=1">`。被否决——直接违反 spec 的保留缩放场景，且是无障碍反模式。
- 副作用与缓解：16px 会让表单比桌面端「胖」一点。窄屏同时把 `main` 内边距收到 12px、`.card` 内边距收到 14px，纵向空间反而更省。

### 6. 触摸目标：44px 命中区，答题卡自身滚动

窄屏下：`.q-dot` 30×30 → 44×44；`.chip` → `min-height: 44px` 且 `.filters { flex-wrap: wrap }`；`.ghost.small` → `min-height: 44px`；`.opt` → `min-height: 44px`；`.check-line` → `min-height: 44px`；`.side-toggle` 已是 44px（决策 2）。

- 题量带来的副作用：30 题 × 44px 会把答题卡撑到 6 行、占掉半屏。缓解：`.q-nav { max-height: 96px; overflow-y: auto }`，让答题卡在自身区域内滚动（同 `.code-block` 的处理思路）。
- 「不重叠」是由 `gap: 6px` + 每个控件自身命中区即元素盒子保证的 —— 我们只放大控件盒子本身，不叠加透明伪元素扩展，因此天然不会越界到邻居。这是对 spec 中「命中区域可由内边距达成、不要求视觉尺寸放大」的取巧但安全的解释：可视尺寸也一并放大，避免出现过小视觉但过大热区的错位点击。

### 7. 视口与安全区

- `index.html` 的 viewport 改为 `width=device-width, initial-scale=1.0, viewport-fit=cover`，**不添加** `maximum-scale` / `user-scalable`。
- `:root` 新增四个变量：`--safe-t/-r/-b/-l: env(safe-area-inset-*, 0px)`；`.topbar` 用 `--safe-t/--safe-l/--safe-r` 留白，`.exam-footer`、`.toast` 用 `--safe-b`，`main` 用左右安全区。
- `.layout` 高度改为渐进式：`height: calc(100vh - 122px); height: calc(100dvh - 122px);`（窄屏本来就是 `height: auto`，页面滚动），满足 spec 的「跟随可见视口、不只依赖固定常量」。
- 补 `html { -webkit-text-size-adjust: 100% }`（防 iOS 横屏文字膨胀）与 `.overlay-box { max-width: calc(100vw - 32px) }`、`.toast { max-width: calc(100vw - 24px) }`。

### 8. 顶栏：tab 横向滚动 + 次要项收纳

- `.tabs` 在窄屏改为 `flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none;` 并隐藏 WebKit 滚动条 → 五个入口在 320px 下仍全部可达（spec 场景「最小宽度下切换全部视图」）。
- `.topbar` 已在 900px 折行；补充 `.brand p` 与 `.status` 的收缩（`.status { white-space: normal; max-width: 100% }`）与 `#modelPick { max-width: 100%; min-width: 0 }`。
- 不把 tab 做成底部导航：会改动 `index.html` 结构并引入新的固定定位层，超出 Non-Goals。

### 9. 验证方式

两层，均在 tasks 中落地：

1. **确定性静态断言**（可重复、进任务）：
   - `index.html`：包含 `viewport-fit=cover`；**不包含** `user-scalable` 与 `maximum-scale`。
   - `styles.css`：存在 `100dvh`；存在 `env(safe-area-inset` 系列；窄屏媒体查询内出现 `min-width: 0` 与 `flex-wrap` 等关键修复；`.board` 已改用 `minmax(min(`；旧的高危声明（`min-width: 260px`、`flex: 0 0 120px`）已被窄屏规则覆盖。
   - 用一个临时 `node --input-type=module -e` 脚本读文件做包含 / 正则断言（沿用既有变更的验证风格，不新增文件、不新增依赖）。
2. **人工验收**（devtools 设备模拟 320 / 375 / 414 / 768 + 桌面 1280）：
   - 逐页检查横向滚动（`document.scrollingElement.scrollWidth <= clientWidth`）、首屏主内容可见、侧栏收放、底部操作条、聚焦输入不缩放。
   - 安全区（`env()` 生效）无法在 devtools 复现，标为「可选真机验证」。

## Risks / Trade-offs

- [窄屏侧栏默认收起，会让部分用户以为「试卷列表不见了」] → 整行按钮常驻在内容顶部并带文案（`展开科目列表`），比原来被 `display:none` 掉的 24px 小箭头更显眼，可发现性实际提升。
- [`ui.sideCollapsed` 结构升级，若用户浏览器里存着旧扁平值] → 读取时按「无 wide/narrow 键 → 整体归入 wide」兼容；解析失败照旧回退 `{}`（沿用 `app.js:479-484` 的 try/catch）。最坏情况是用户桌面端收放状态丢失一次，不影响数据。
- [窄屏输入字号 16px 可能让 `.specs` 三列行变挤（`1fr 120px 120px`）] → 窄屏把 `.spec-row` 减到 `1fr 72px 72px` 并缩小内边距 / 间距；若仍溢出，退路是让 `.spec-row` 改为两列并把题型名整行置顶（`grid-column: 1 / -1`）。
- [只放大命中区到 44px 会拉长题量多时的答题卡] → `.q-nav` 限高 + 自身纵向滚动（决策 6），代价是答题卡内出现一个小滚动区；对 30 题以上的卷子是净收益。
- [无浏览器自动化，溢出 / 安全区回归靠人工] → 用决策 9 的静态断言兜住「规则是否存在」，人工只判断「效果是否正确」；与既有变更的验收策略一致，不额外引入依赖。
- [`overflow-wrap: anywhere` 用在 `.opt` / `.q-stem` 上会改变长英文串的折行观感] → 只对窄屏生效，桌面端保持 `pre-wrap` 的原有断词行为。
- [900px 主断点沿用旧值，tablet 竖屏（768）与手机共用一套规则] → 768px 下 44px 触摸目标与 16px 输入字号同样合适，未见需要区分的场景；若后续发现 600-900px 需要独立档位，再新增断点即可，不影响本次 spec。

## Migration Plan

1. 直接替换 `public/index.html` 的 viewport 声明与 `public/styles.css` 的断点区块；`app.js` 只改 `initSideToggles()` 与（可选）`main-col` 滚动目标。前端无构建，浏览器刷新即生效，无需部署编排。
2. 回滚策略：CSS / HTML / JS 三个文件均可用 git 单文件回退；`localStorage` 的新结构对旧代码而言只是「多了一层嵌套」，旧代码读 `saved[key]` 会得到 `undefined` → 回退后表现为收放状态丢失一次，不影响数据与接口。
3. 观察点：窄屏首屏是否还出现横向滚动；`ui.sideCollapsed` 在窄屏操作后是否只写 `narrow` 分支（devtools Application → Local Storage 可直接确认）。

## Open Questions

- 是否需要真机（尤其 iOS Safari）验证安全区与输入法遮挡：取决于是否手边有设备，可在实现阶段直接确认，不影响 spec 与任务拆分。
- `.brand p`（品牌副标题）与 `.status` 在 320px 下是「收进第二行」还是「直接隐藏」：属视觉细节，实现时按观感定，不改变任何 spec 场景。
