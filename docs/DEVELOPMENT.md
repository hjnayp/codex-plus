# codex+

`codex+` 为 Codex Desktop 提供本地增强：模型快捷键、思考强度前缀、待回答提醒、消息头像、项目 Git 分支与手动回收闲置对话。它不修改官方应用包或可执行文件，也不删除会话。

侧栏 Git 项目名称旁显示当前分支，worktree 按各自目录查询，多仓库分别显示；远程项目使用其原生主机配置。
颜色沿用 `git status` 默认含义：仅已暂存为绿色，未暂存或未跟踪为红色；干净仓库也为绿色，读取失败为灰色未知状态。
标签不显示图标，只显示最后一个 `/` 后的内容，例如 `feat/1012/登录优化` 显示为 `登录优化`；没有 `/` 的分支名原样显示。
分支字号比项目名小 2px，不添加分支悬停提示；完整分支、目录及状态数量保留在无障碍标签中，游离检出显示 `HEAD`。
使用原生 Git 订阅保留仓库监听，可见页面每五秒刷新一次，窗口重新聚焦时立即刷新；停用取消请求、释放订阅并移除标签。

当前进行中的对话有未回答的原生提问时，输入框上方持续显示“待你回答”和问题摘要，位置与目标进度相邻。
点击展开完整问题列表，点击异步问题通过原生入口打开对应的回答面板；同步阻塞提问定位原生提问区域。
已结束轮次的旧问题、已回答或跳过的问题不再提醒。普通问号、等待语音标记和代码示例不触发。
提醒读取当前已加载的原生对话记录，原生面板负责选项、自由回答和提交；不写草稿或自动发送答案。
切换对话、问题结束和停用会阻止尚未完成的打开操作；停用时移除提示。
当前原生异步面板默认在 30 秒后自动收起，收起本身不使问题失效；点击底部问题重新打开会取消倒计时。
提示不另设超时，原生 30 秒数值目前没有本插件配置入口；轮次结束后该轮问题才从提示中移除。


## 代码结构

源码全部为 TypeScript：Node 24 直接运行 `.ts`（类型剥离），`tsc --noEmit` 只做类型检查，esbuild 负责打包。

```text
src/
  core/                       宿主无关的纯逻辑
    hash-rules.ts             # 缩写：解析、递归展开、代码区判定，输出编辑区间
    prompt-directives.ts      首段模型/强度指令解析
  hosts/
    claude-code/hooks.ts      # 缩写的 Claude Code 适配器（prompt.submit / prompt.edit）
    codex-desktop/
      main.ts                 CLI 入口与命令表
      commands/               context（组装协作者）、lifecycle、threads（status/gc）、update
      daemon/                 守护进程主循环与状态文件
      config.ts cdp.ts app.ts keybindings.ts renderers.ts system.ts manual.ts
      page/                   在 Codex 页面内执行的代码
        runtime/              界面能力生命周期、React/DOM 工具
        composer.ts           # 缩写与指令的 Codex 输入框（ProseMirror）适配器
        features.ts           界面能力登记表
        features/*.ts         各界面能力，分别编译为独立 IIFE
        threads.ts            status/gc 的页面侧函数，按需注入执行
  build/bundle.ts             esbuild 打包 CLI 产物、页面脚本与 Claude Code hook
```

设计约定：

- **宿主适配器**：同一能力在多个宿主上运行时，规则只写在 `core/`，各宿主写适配器把宿主的输入模型投影成核心的文本、
  再把核心结果落回宿主。`#` 缩写目前有 Codex（`page/composer.ts`，ProseMirror 事务）与 Claude Code（`hooks.ts`，提示文本）两个适配器。
  只在一个宿主上存在的能力直接放在该宿主下，不预先抽象接口。
- **界面能力生命周期**：`page/runtime/feature.ts` 的 `installFeature` 统一处理版本幂等、替换旧实例、等待 DOM 与登记全局清理入口；
  每个能力只实现 `install()` 并返回 `dispose`。新增能力在 `page/features.ts` 登记即进入注入、打包和停止清理链。
- **命令与协作者**：`main.ts` 用命令表分发；`commands/context.ts` 按同一份配置组装 `CdpEndpoint`（持有当前端口）、
  `CodexApp`（macOS 进程控制）、`DaemonState`（状态目录通信）与 `KeybindingRestorer`，命令之间不再各自读取环境变量。

`page/features/reasoning-prefix.ts` 在原生提交前识别强度前缀（解析在 `core/prompt-directives.ts`），调用原生模型组件的 `onSelectModel` 切换指定模型与实际强度（仅强度前缀保留当前模型），
确认选择后用 ProseMirror 事务删除前缀，保留正文格式、mention 与附件，再交回原生提交。
`tests/test_codex_plus_reasoning_prefix.ts` 覆盖三个模型别名、四档、按键和按钮提交、失败、重复提交与生命周期隔离；
`tests/reasoning-prefix.lean` 检查四档映射与提交门禁的人工模型，不证明原生组件、编辑器或网络行为。

## `#` 缩写规则

`hash-rules.toml` 是独立的 `#` 缩写规则文件，使用 TOML 的 `[[rules]]` 条目，分别填写 `trigger = "#ap"` 与 `text = "批准. "`，支持行内与独立注释。
规则支持递归引用。输入、粘贴时保留原文，发送或加入队列前才展开；
未知完整 token、代码块与行内代码保持原样。模型与强度前缀继续优先生效。
修改此文件后运行 `codex+ reload`，无需重新打包或重启 Codex；当前窗口与之后加载的页面均使用新规则。
TOML 语法错误、重复 trigger、循环引用或超长展开会使 reload 失败，旧规则继续生效。
输入框内会实际生效的缩写实时着色；模型/强度前缀仅在首段开头着色，正文中的同名 token 不着色。高亮只影响显示，不写入草稿或撤销历史；reload 后按新规则更新。
规则文件默认为插件根目录的 `hash-rules.toml`（不入库，首次 `update` 时从 `hash-rules.example.toml` 生成）；`CODEX_PLUS_HASH_RULES_FILE` 可在启动时指定其他路径。
`tests/test_codex_plus_hash_rules.ts` 使用真实 ProseMirror 事务验证发送前展开与富文本保留；守护进程测试覆盖 reload 及页面刷新。

参数化规则在 trigger 中按顺序声明默认值，text 使用 `{参数名}`：

```toml
[[rules]]
trigger = "#rvc1(ai=claude,module=opus)"
text = "将改动提交给 {ai} 审查, 使用 {module}"

[[rules]]
trigger = "#goandrv1(ai=claude,module=opus,think=high)"
text = "批准. 完成后, #rvui1 -> #rvcode(ai={ai},module={module},think={think})"
```

`#rvc1` 使用默认值，`#rvc1(module=fable)` 只覆盖 module，`#rvc1(codex, sol)` 按声明顺序传入 ai 和 module。
省略的位置使用默认值，也支持 `#rvc1(codex, module=sol)`；位置参数必须在具名参数前。
单引号或双引号可包围值（例如 `#rvc1("Codex, local", sol)`），双引号支持 JSON 转义；内层调用会保留参数值的边界。
需要定义被引用的 `#rvui1`、`#rvcode`；嵌套转发继续递归展开。未知参数、重复赋值、超额参数或未闭合调用整段保留且不高亮。
只使用单个 `#`；相同名称不能通过不同默认参数重复定义。模板中已定义规则的内层调用若参数写错，reload 会失败。
未闭合调用遇到后续由空白分隔的缩写时恢复解析，后面的合法缩写照常处理。
规则循环、递归深度超过 64、单次调用超过 10000 次、展开超长或工作量超限会被拒绝。

### Claude Code 插件

`claude/` 是同一份规则在 Claude Code 中的函数 hook 插件（`hash-rules@codex-plus`），源码为 `src/hosts/claude-code/hooks.ts`，
与 Codex 共用 `core/hash-rules.ts` 的解析、递归、参数与代码区判定。hook 环境只允许导入插件内相对路径，
`codex+ update` 用 esbuild 把它连同 `smol-toml` 打包为 `claude/hooks/hash-rules.mjs`（不入库）。

- `prompt.submit`：发送前展开；只处理人直接输入的提示（composer、Remote Control、`claude -p`/SDK），
  slash 命令、通知、其他会话和定时任务原样放行。展开失败或 hook 超时不发送，提示原因并把原文放回输入框。
- `prompt.edit`：输入框内给实际生效的缩写加 `warning` 色与下划线，只影响显示。
- 规则在运行时经 `$.fs` 读取 `../hash-rules.toml`，按修改时间与大小判断是否重新编译；修改规则无需重新打包或
  `/reload-plugins`。规则无效时保留旧规则，同一版本只提示一次。Codex 的模型与强度前缀不移植。

安装与更新：

```bash
codex+ update                                         # 打包 claude/hooks/hash-rules.mjs
claude plugin marketplace add "<codex+ 目录>"
claude plugin install hash-rules@codex-plus
```

本地 marketplace 直接读取仓库目录；源码改动后重新 `codex+ update`，再在会话中执行 `/reload-plugins`。

## 模块说明

`page/features/project-branches.ts` 持有分支标签，只读原生侧栏项目和 Git worker 查询，不执行 Git 写操作。
`tests/test_codex_plus_project_branches.ts` 用 Chromium 验证项目与主机隔离、颜色、刷新、错误和清理；
颜色决策另有人工模型，不替代实际 Git 与界面验收。

`page/features/pending-input.ts` 持有待回答提示，只读当前 React host props 中的原生 turn 和请求状态。
`tests/test_codex_plus_pending_input.ts` 使用 Chromium 验证有效提问、原生入口、不同问题选项、回答、切换和清理；
`tests/pending-input.lean` 验证问题 ID、有效状态和打开操作隔离的人工模型。

`page/threads.ts` 持有 `codex+ gc` 与 `status` 对话列表的页面侧逻辑，经 `toString` 注入每个 Codex 页面执行，不常驻页面（类型只在编译期存在）；
互相依赖的页面函数由调用方作为参数一并注入。`findLocalConversationManagerInPage` 在 React 树的 `manager` prop
与 hook state 的管理器数组中找本机（`hostId === "local"`）对话管理器，因此 Codex 停在非对话页面时同样可用；云端与远程 SSH 主机不处理。
gc 对前端跟踪的主对话使用官方闲置对话回收器（`manager.inactiveThreadUnsubscriber`），按其保护条件筛选，
只把官方 3 小时阈值换成 `-t` 指定的分钟数（默认 60），再加后台终端保护，最后调用官方 `unsubscribeInactiveConversation`；
官方实现同时把前端状态标记为 `needs_resume`，因此再次打开对话会正常 resume。
回收器接口缺失时拒绝回收。
前端不跟踪的子代理线程由 `listLoadedThreadsInPage` 从 App Server 列出，满足阈值且自身与父对话都未进行或等待时直接 `thread/unsubscribe`；
App Server 在线程没有订阅者且空闲时约 1 分钟后卸载并结束其 MCP 等进程。子代理盘点失败只跳过子代理，不影响主对话回收。
`listLoadedThreadsInPage` 同时供 `status` 使用：以 App Server 已加载列表为准，逐个 `thread/read` 补全来源，再叠加前端回收器状态；只读。
`tests/test_codex_plus.ts` 用假页面验证管理器查找、筛选、保护、子代理回收、dry-run、失败报告与对话列表分类。

`build/bundle.ts` 用 esbuild 把 CLI 打包成单文件产物，并把各界面能力编译成内联的 IIFE，供 `update` 发布；
源码检出运行时，注入脚本按需现场编译。

聊天中 GPT 回复左侧和用户消息右侧显示 88 px 圆形头像，通过 CSS 原生锚点随正文同步滚动，不占正文空间。连续出现的同角色消息只在第一条旁显示头像，角色切换后重新显示，保留原有消息间距与内容尺寸。点击任一头像打开上传窗口，支持 PNG、JPEG、WebP、GIF（GIF 使用静态首帧）；不限制原图文件大小。选图后可拖动图片或用方向键移动、滑杆缩放，通过圆形预览自定义范围；点击“保存”才替换头像，取消保留原图。裁剪结果缩成 256 × 256，仅保存在当前应用的本机存储中，不上传服务器。也可点击“恢复默认”。停用 Codex+ 会移除头像与定位属性，保留已保存的图片供下次启用。

## 用户场景

- 顶部不显示额度百分比或 TPS，回答末尾不显示 token/金额 footer；升级和页面刷新后不再恢复这些组件。
- `codex+ usage` 返回未知命令；运行守护进程不读取 session、不创建或改写用量数据库。
- `SC-CODEX-PLUS-011`：`update` 先把 `src` 下的模块、注入脚本打包成自包含的单文件产物
  `bin/codex+.mjs`，再把 `<前缀>/bin/codex+` 链接到 `bin/codex+` 启动器并安装手册；同一份源码重复打包
  得到相同产物与源码指纹，未执行 `update` 的源码改动不会进入产物。打包遇到无法解析的模块
  或语法错误时失败，不产出可疑产物。
- `SC-CODEX-PLUS-004`：用户可以通过 `--man`、`man`、`--self-test` 和聚焦测试验证命令，
  并把启动器链接到 `<前缀>/bin`、手册安装到 `<前缀>/share/man/man1`（前缀默认 `~/.local`）。
- `SC-CODEX-PLUS-019`：`codex+ stop` 先优雅停止守护进程；若其未在超时内退出则强制停止，并在
  确认进程已经退出后才清理状态文件，因此后续 `restart` 可以启动新的守护进程。
- `SC-CODEX-PLUS-045`：快捷键切换完成后，焦点回到当前输入框，用户可立即继续输入；不会停留在
  Codex 原生模型入口按钮上。
- `SC-CODEX-PLUS-064`：只监听 `Ctrl+=` 和 `Ctrl+-`，在 6 Astra、6.1 Sol、6 Luna 三档循环；保留思考强度、草稿与焦点，不发送内容。其他组合键透传给原生界面。
- `SC-CODEX-PLUS-050`：不再禁用原生快捷键；启动或停止时恢复旧版本禁用项，并保留用户后续改键。
- 手动执行 `codex+ gc [-t <分钟>]` 时，只回收闲置满阈值（默认 60 分钟，`-t 0` 不限时长）且不受保护的对话：正在查看、有其他窗口跟随、进行中、
  等待审批或输入、仍有后台终端或终端盘点失败的对话都保留；`--dry-run` 只列出将回收的对话。
  前端不跟踪的子代理同样按阈值回收，其自身或父对话进行中、等待审批或输入时保留；预热的空白新对话与临时线程不回收。
  报告列出已回收对话的标题与闲置时长和各类跳过数量，并提示 App Server 约 1 分钟后才卸载；回收失败时列出失败对话并以退出码 1 结束。
- 守护进程就绪后每 30 分钟自动执行一次与 `codex+ gc -t 30` 相同的回收，报告与失败写入 `daemon.log`；上一轮未结束时跳过本轮。
  未处于 Codex+ 模式时提示先 `start`。
- `codex+ status` 在 Codex+ 模式下按 App Server 的 `thread/loaded/list` 列出全部已加载对话，每个对话各持有一套 MCP 等运行时进程。
  每行标注等待审批或输入、进行中、查看中或闲置时长，附工作目录；前端不跟踪的线程按类别标出：子代理（昵称、角色与父对话）、
  官方按目录预热的空白新对话、临时线程，以及前端已取消订阅、App Server 约 1 分钟后卸载的“已回收，等待卸载”对话。闲置的主对话与子代理在 `gc` 的回收范围内；读取失败只提示，不影响其余状态输出。
- `SC-CODEX-PLUS-065`：上游代理（如 Headroom）独立运行，Codex+ 不接管 `openai_base_url`。
  Codex+ 启动或复用守护进程时不检查上游代理的健康状态、路由或用户配置，也不记录配置摘要。
  `start` 不退出或重启 Codex；增强模式已运行时直接复用，普通模式已运行时提示使用 `restart`。
  `restart` 仍显式退出并重新启动 Codex；`launch` 保留普通模式切换为增强模式的行为。

## 已移除的功能

顶部额度百分比、TPS 和回答 footer 已移除。Codex+ 不再扫描 session JSONL、维护 token 账本或估算价格，也不再提供 `codex+ usage`。
升级注入会调用旧统计组件的清理入口，停止其观察器和定时器，再移除旧节点、样式与全局入口。
历史 `usage.sqlite` 保留在原位置，不再由 Codex+ 读取或改写。
性能优化、浏览器收藏和子代理头像替换已移除；升级时恢复旧样式与终端访问器，移除收藏界面和子代理头像样式。
已保存的收藏数据保留在本机存储中，不再读取或改写。

## 原理与边界

`update` 只发布 Codex+ 本身；它不读取、筛选或改写 Codex 的模型配置。模型快捷键在现有任务与新任务中
统一触发 Codex 原生模型菜单。Codex+ 不禁用原生快捷键；仅恢复旧版本遗留禁用项，用户改键不会被覆盖。

## 构建与安装布局

```bash
npm ci
node src/hosts/codex-desktop/main.ts update   # 首次安装；之后可直接执行 codex+ update
```

```text
bin/codex+.mjs                     # update 从 src 打包的单文件产物，不入库
bin/codex+                         # 启动器；只负责找 node 并执行同目录产物
claude/hooks/hash-rules.mjs        # update 打包的 Claude Code hook，不入库
hash-rules.toml                    # 用户规则，不存在时由 update 从 hash-rules.example.toml 生成，不入库
<前缀>/bin/codex+ -> bin/codex+    # 前缀默认 ~/.local，可用 CODEX_PLUS_INSTALL_PREFIX 覆盖
<前缀>/share/man/man1/codex+.1     # 来自 docs/codex+.1
```

源码与产物都按 `package.json`（`name` 为 `codex-plus`）向上定位插件根目录，不依赖外层仓库。
`update` 先打包再更新链接：注入脚本内联进产物，因此产物运行时不依赖 `src` 或 `node_modules`，
未打包的源码改动也不会影响已安装的命令。打包对同一份源码是确定性的，`update` 会输出源码指纹。
产物按「同目录临时文件 + 原子 rename」替换，所以通过已安装的 `codex+` 调用 `update` 覆盖正在运行的产物是安全的。
本机 CDP 客户端使用 Node 内置 `WebSocket`；`smol-toml` 在打包时内联。

## 验证

```bash
npm test             # node --test tests/*.ts（Chromium 场景需本机 Google Chrome）
npm run typecheck    # tsc --noEmit，覆盖 src 与 tests
claude plugin validate claude
lean tests/headroom-startup.lean
lean tests/pending-input.lean
lean tests/reasoning-prefix.lean
lean tests/message-avatars.lean
bin/codex+ --self-test
bin/codex+ --man
```
