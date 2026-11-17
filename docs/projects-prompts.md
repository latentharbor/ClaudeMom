# Projects Prompt 来源

本地 Projects 使用官方 Claude Code CLI 执行任务，界面使用 Claude Desktop 自带的 Projects 页面。
这不意味着本地项目的调度 Prompt 来自官方云端 Projects。

| 内容 | 来源 | 使用方式 |
| --- | --- | --- |
| CLI 内置系统提示词 | 本机 Desktop 缓存中的官方 Claude Code CLI | 不传 `--system-prompt` 替换；内容仍会随 CLI 版本、模型、工具清单和 `--print` 运行模式变化 |
| 项目协调、线程派发、记忆、汇报、历史检索及回复风格 | DS Project，固定提交见 `projects-protocol.mjs` | `third-party/ds-project/engine.js` 的 `context()` 和 `runtimeContext()` |
| 本机工具名称、不可用的 `todo_write` 说明、worktree 与禁止修改基线的约束 | ClaudeMom 本地适配 | `projects-ds-core.mjs` 在任务输入中追加；MCP 名称映射到 `local_project` |
| 任务、项目指令、Library、记忆与有限的历史快照 | 用户及本机项目数据 | 作为项目上下文和本轮请求输入 CLI；上下文不授予额外操作权限 |

构造路径是 `projects-ds-core.mjs` → `projects-runner.mjs` → `projects-job.mjs` → CLI stdin。
未复制或调用官方云端 Projects 的协调者 Prompt，也不能声称与它逐字一致。
DS Project 的上下文条数和字符预算同样属于该开源实现，不是未经证实的官方 Claude 常量。

工具权限和文件、网络边界由本机控制器与操作系统执行，不能靠 Prompt 取消。
每个任务使用独立系统沙箱及代理凭证；即使模型请求“不使用沙箱重试”，也不会解除外层边界。
