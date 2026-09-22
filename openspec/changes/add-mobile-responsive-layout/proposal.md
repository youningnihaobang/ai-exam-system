# Proposal

## Why

前端目前只有一条浅层断点 `@media (max-width: 900px)`（`public/styles.css:503`），它做的事只是「把两栏拍成一栏」：`.layout` 改单列、隐藏侧栏折叠按钮、放开滚动容器。这只解决了「放得下」，没解决「用得动」——真机（375/390/320px 宽）上仍有一批可复现的问题：

- **手机上没有侧栏折叠入口**：`.side-toggle` 在 ≤900px 被 `display: none`（`styles.css:508`），而 `.layout` 仍是「侧栏在前、内容在后」的文档流顺序。进入「答题评卷 / 错题本 / 复习」时，用户必须先滚过整个科目导航 + 试卷列表（`#paperList` 还固定 `max-height: 420px`，`styles.css:512`）才能看到主内容，且无法收起。
- **iOS 聚焦输入框会把页面放大**：`.field input/select/textarea`（`styles.css:110-113`）与 `textarea.answer-box`（`styles.css:353-356`）字号都是 13~14px，低于 Safari 触发自动缩放的门槛，一聚焦整页跳一下。
- **固定最小宽度导致横向溢出**：`.board` 的 `minmax(240px, 1fr)`（`styles.css:453`）、`.score-text` 的 `min-width: 260px`（`styles.css:383`）、`.cloze-row .cz-hint` 的 `flex: 0 0 120px` 配 `input` 的 `min-width: 160px`（`styles.css:480-481`）。320px 宽的机器在「复习看板」「成绩卡」「挖空回忆」处必然出现左右滚动。
- **没有换行的弹性容器**：`.actions`（`styles.css:147`）与 `.side-head`（`styles.css:189`）都是 `display: flex` 且不换行，「错题本 / 复习」页头部塞着 `h2` + 三个筛选 chip，窄屏直接溢出。
- **触摸目标偏小**：题号卡 `.q-dot` 30×30（`styles.css:301`）、`.ghost.small` padding `5px 12px`（`styles.css:166`）、`.chip` padding `5px 14px`（`styles.css:428`），都不到 44px 的可点击尺寸建议。
- **视口与安全区没处理**：`index.html:5` 的 viewport 没有 `viewport-fit=cover`，`.layout` 用 `calc(100vh - 122px)`（`styles.css:172`）是 dt 高度的硬编码；带刘海 / 底部指示条的机型上，顶部栏与常驻的 `.exam-footer`（`styles.css:307`）会与系统 UI 重叠。
- **顶栏在窄屏堆成多层**：`index.html:10-35` 的 `.topbar` 一行内放了品牌、5 个 tab、后台评卷提示、模型下拉和 AI 状态，`flex-wrap` 之后能占掉大半个首屏。

现在做的理由：五个功能页（生成 / 答题 / 错题本 / 复习 / 历史）都已成型，桌面端布局稳定，是补移动端体验的合适时机——再往后拖，每新增一个页面都要再补一次适配。

## What Changes

- **补齐移动端视口与安全区**：viewport 加 `viewport-fit=cover`；`<main>`、`.topbar`、`.exam-footer`、`.toast` 等贴边元素用 `env(safe-area-inset-*)` 留白，不再依赖硬编码的栅格高度。
- **用动态视口高度替代 `100vh`**：`.layout` 的高度改用 `100dvh`（带 `100vh` 回退），避免移动浏览器地址栏收放时内容跳动 / 被截断。
- **手机端侧栏改为可收起**：≤ 断点时不再 `display: none` 掉 `.side-toggle`，侧栏默认收起、可展开覆盖在内容上方（或展开后自动收起），让「答题 / 错题本 / 复习 / 历史」进入即见主内容；`#paperList` 的固定 `max-height` 在窄屏放开。
- **消除横向溢出**：`.board` / `.score-text` / `.cloze-row` / `.subject-lib` / `.blank-inputs` 等处的固定或过大的 `min-width` 在窄屏改为 `min-width: 0` 或自适应列；`.actions`、`.side-head`、`.mistake-head`、`.doc-item` 等弹性容器补 `flex-wrap`；代码块与长串（URL / 英文）保持块内横向滚动而不是撑破页面。
- **输入控件不触发 iOS 自动缩放**：窄屏下把可聚焦输入类控件的字号提到 16px（不通过 `maximum-scale` 禁止缩放，保留可访问性）。
- **触摸目标达标**：`.q-dot`、`.chip`、`.small` 按钮、`.opt` 行等在窄屏下增大内边距或最小尺寸，保证主要交互控件达到约 44×44 的触摸区域。
- **顶栏在窄屏收敛**：tab 条改为横向可滚动 / 不换行溢出，品牌副标题与模型下拉、AI 状态在窄屏精简或换行收纳，使顶栏不占用过多首屏高度；`.topbar` 保持 `sticky` 且不遮挡内容。
- **答题页常驻操作条适配虚拟键盘与安全区**：`.exam-footer` 保证在移动端不被底部系统 UI 或输入法遮挡，题号答题卡在题量大时自身可滚动而不把页面顶开。
- **桌面端零回归**：≥ 断点的两栏布局、侧栏折叠记忆（`ui.sideCollapsed`）、单题作答与键盘 `←` `→` 切题等现有行为保持不变。

## Capabilities

### New Capabilities

- `responsive-ui`: 前端在窄屏 / 手机浏览器下的展示与交互行为——视口与安全区处理、断点下的布局收敛（侧栏可收起、单列内容）、横向溢出约束、可点击目标与输入字号、常驻操作条的可见性，以及桌面端行为不回归。

### Modified Capabilities

无。现有 `review-scheduling` 定义的是排期算法行为，本次不改变它的任何需求；适配改动落在展示层。`openspec/specs/` 中也没有覆盖前端布局的能力，故只新增能力。

## Impact

- **前端结构** `public/index.html`：viewport meta 增加 `viewport-fit=cover`；必要时为顶栏 / 侧栏补充收起态所需的挂点（不引入构建步骤）。
- **前端样式** `public/styles.css`：主要改动面。新增 / 重写断点规则（现仅 `@media (max-width: 900px)` 一条），加入安全区变量、`dvh`、溢出约束、触摸目标与输入字号规则。
- **前端脚本** `public/app.js`：`initSideToggles()`（`app.js:477`）需支持窄屏默认收起与断点变化时的状态同步；`scrollExamTop()` / `gotoQuestion()` 的滚动目标需与新的滚动容器一致。不涉及接口调用改动。
- **后端 / 数据 / 接口**：无改动。`src/**` 与 `data/db/*.json` 不受影响。
- **依赖**：无新增依赖，前端仍为无构建的原生 HTML / CSS / JS 单页。
- **兼容性**：仅影响视口宽度小于断点时的渲染；桌面端与既有 localStorage 键（`ui.sideCollapsed`、`exam.autoNext`）保持兼容。
