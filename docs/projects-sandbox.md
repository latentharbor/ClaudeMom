# 本地 Projects 的进程沙箱

每个协调者、工作线程和计划任务都通过同一个受管执行器启动。
在 macOS 上，可信任务控制器使用系统 `/usr/bin/sandbox-exec`，将整个 CLI 及其 MCP、Shell
和其他子进程放进 Seatbelt 边界。其他平台、缺失执行器或策略加载失败时，任务明确失败，
不会直接启动 CLI，也没有设置或环境变量能关闭外层沙箱。

CLI 的内层 `sandbox.enabled` 保持关闭，避免重复嵌套只保护 Shell 的沙箱。
这不会关闭外层 Seatbelt；`dangerouslyDisableSandbox`、重试和权限卡都无法移除继承的系统边界。

| 资源 | 边界 |
| --- | --- |
| 文件读写 | 自己的 worktree、CLI 配置和临时目录；系统工具、固定运行时代码和仓库 Git 元数据只读 |
| Library 快照与 Git 链接 | 只读，文件权限和操作系统策略同时限制 |
| 个人凭证、其他会话、其他项目与本机应用数据 | 不在文件读取范围内 |
| 推理与项目工具 | 只连接本任务的独立 loopback broker；全局代理密钥只在可信控制器内存中使用 |
| 外网 | 经该 broker 按任务、域名和端口确认；固定解析后的公共 IP，拒绝私网、loopback、元数据、CGNAT 和 Fake-IP 地址 |
| 其他 IPC、应用控制与信号 | 不允许连接其他 Unix socket，不允许 Apple Events 或向其他沙箱外进程发信号 |
| 导出和自动收集 | 在同一个系统边界内读取产物；主进程接收受限大小的内容，不以自身权限读取模型选择的文件 |

域名获准后才进行 DNS 查询，并固定解析结果。网络域名授权只允许受控转发，不会让 CLI 获得直接外网或主代理的访问权。
直接 TCP、绕过代理、访问其他本机端口及私有网络均被拒绝。
需要额外文件时，应由用户导入 Library 或为项目配置正确仓库，再启动新的线程；批准 Shell 操作不会扩大文件范围。

每个任务的状态记录 `sandbox.required`、版本、后端与实际启动状态。
旧版无沙箱任务不会被重新标记为已隔离，也不会自动中断；用户停止这些任务之前，新执行器拒绝启动新任务。
安装升级时，先结束旧任务再切换。

实现使用 macOS Seatbelt，不提供容器或虚拟机。它不复刻官方云端 Projects 的执行环境。
官方 CLI Shell 沙箱与整个进程边界的区别见 <https://code.claude.com/docs/en/sandboxing#what-runs-outside-the-sandbox>。
