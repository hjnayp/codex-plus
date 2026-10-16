import { GC_DEFAULT_IDLE_MINUTES } from "./commands/threads.ts";

export function makeManual(commandName: string): string {
  return `NAME
    ${commandName} - 提供 Codex Desktop 本地界面增强

SYNOPSIS
    ${commandName} start
    ${commandName} launch
    ${commandName} restart
    ${commandName} stop
    ${commandName} status
    ${commandName} gc [-t <分钟>] [--dry-run]
    ${commandName} reload
    ${commandName} update
    ${commandName} --self-test
    ${commandName} --man
    ${commandName} man

DESCRIPTION
    以本机回环 CDP 启动官方 Codex Desktop（macOS ChatGPT.app），
    注入模型快捷键、待回答提醒与消息头像，不修改官方应用或回答正文。
    当前进行中轮次的未答原生问题在输入框上方显示“待你回答”和摘要，点击展开完整列表。
    点击异步问题打开原生回答面板；同步阻塞提问定位原生提问区域。已结束轮次、回答和跳过不再提醒。
    只读取当前已加载的原生对话记录，由原生面板处理回答和提交，不写草稿或自动发送。

    Ctrl+= 提升模型（Luna → Sol → Astra → Luna），Ctrl+- 降低模型（Astra → Sol → Luna → Astra）。
    仅监听这两个快捷键，只在 6 系三档中循环，保留思考强度与草稿，不发送内容。
    提交 prompt 时识别首段开头的 #l / #m / #h / #x，分别切换 low / medium / high / xhigh，
    也支持 #astra-l / #sol-h / #luna-x 等模型与强度组合，模型为 gpt-6-astra / gpt-6.1-sol / gpt-6-luna。
    #astra / #sol / #luna 只切换模型；#l / #m / #h / #x 只切换强度，支持 #sol #m 连续组合。
    发送前递归展开 codex+ 目录下 hash-rules.toml 中的 # 缩写；输入时不替换，代码与未知 token 不变。
    输入框内实时高亮合法缩写，规则文件支持 TOML 注释，高亮不改变草稿。
    trigger 可声明 #rvc1(ai=claude,module=opus)，text 使用 {ai}/{module}；#rvc1 使用默认值，
    #rvc1(module=fable) 具名覆盖，#rvc1(codex, sol) 按声明顺序传值，并支持向内层调用转发。
    调用错误或未完成时整段保留且不高亮；仅使用单个 #，位置参数必须在具名参数之前。
    修改规则后运行 codex+ reload；CODEX_PLUS_HASH_RULES_FILE 可指定规则文件。
    移除前缀后沿用原生发送流程。前缀须与正文以空白分隔，也可独占首段；后续消息沿用所选模型与档位。
    切换失败保留草稿且不发送；改写草稿、切换对话或停用会取消尚未完成的提交。
    Codex+ 不禁用原生快捷键；启动或停止时恢复旧版本遗留的禁用项，并保留用户改键。
    Codex+ 不筛选模型菜单，也不接管 Codex 的 openai_base_url，启动时不检查上游代理或因其配置变化重启 Codex。

    stop 会精确恢复启动前仍未被用户改写的官方键位。update 只发布 Codex+ 本身，不读取、筛选或改写 Codex 的模型配置。
    update 先把 src 下的模块与注入脚本打包成单文件产物 bin/codex+.mjs，再把 ~/.local/bin/codex+
    链接到 bin/codex+ 启动器；启动器只执行该产物，因此未打包的源码改动不会影响已安装的命令。

COMMANDS
    launch      App 入口；健康时仅激活，普通 Codex 已运行时自动切换 Codex+ 模式。
    start       启动守护进程；Codex 已以普通模式运行时会拒绝并提示 restart。
    restart     退出官方 Codex，再以增强模式启动。
    stop        停止守护进程并移除界面增强与模型快捷键适配，不退出官方 Codex。
    status      显示守护进程、官方 Codex 和本地 CDP 状态；Codex+ 模式下列出本机 App Server 已加载的全部对话，
                含前端不跟踪的子代理、预热的空白新对话与临时线程，并标注等待、进行中、查看中、闲置时长等状态。
    gc          手动回收闲置满指定分钟（-t，默认 ${GC_DEFAULT_IDLE_MINUTES}）的对话：调用 Codex 官方闲置对话回收器取消订阅，
                App Server 随后卸载对话并结束其 MCP 等子进程；再次打开对话时正常恢复。
                沿用官方保护：正在查看、有其他窗口跟随、进行中、等待审批或输入的对话不回收；
                另外跳过仍有后台终端或终端盘点失败的对话。官方默认闲置 3 小时自动回收。
                前端不跟踪的子代理也一并回收：子代理空闲满阈值、父对话未在进行或等待且无后台终端时取消订阅，
                App Server 随后卸载；预热的空白新对话与临时线程不回收。只处理本机，不处理云端与远程 SSH 主机。
                -t 0 回收所有不受保护的闲置对话。--dry-run 只列出将回收的对话。需要 Codex+ 模式。
                守护进程就绪后每 30 分钟自动执行一次 gc -t 30，结果写入守护进程日志。
    reload      验证并重新加载 hash-rules.toml，不重启 Codex；无效规则保留旧配置。
    update      把 src 打包成 bin/codex+.mjs，并打包 Claude Code 插件 claude/hooks/hash-rules.mjs；
                hash-rules.toml 不存在时从 hash-rules.example.toml 生成；
                把启动器链接到 ~/.local/bin，并把手册安装到 ~/.local/share/man/man1。源码改动只有重新执行 update 才会生效。

ENVIRONMENT
    CODEX_PLUS_CDP_PORT           指定本机 CDP 端口；未设置时优先 57331，冲突会自动选择并记住安全端口。
    CODEX_PLUS_STARTUP_TIMEOUT_MS 冷启动等待时间，默认 90000 毫秒。
    CODEX_PLUS_STOP_TIMEOUT_MS    优雅停止守护进程的等待时间，默认 7000 毫秒。
    CODEX_PLUS_FORCE_STOP_TIMEOUT_MS 超时后的强制停止等待时间，默认 2000 毫秒。
    CODEX_PLUS_STATE_DIR          状态与日志目录，默认 ~/.codex/codex+。
    CODEX_PLUS_CHATGPT_APP        官方 ChatGPT.app 路径，默认 /Applications/ChatGPT.app。
    CODEX_PLUS_INSTALL_PREFIX     update 安装命令与手册的前缀，默认 ~/.local。
    CODEX_PLUS_HASH_RULES_FILE    # 缩写规则文件，默认为 codex+ 目录下的 hash-rules.toml。

EXAMPLES
    ${commandName} reload
    ${commandName} update
    ${commandName} restart
    ${commandName} status
    ${commandName} gc --dry-run
    ${commandName} gc -t 30
    tail -f ~/.codex/codex+/daemon.log
`;
}
