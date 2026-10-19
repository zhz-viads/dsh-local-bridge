# dsh-local-bridge

让 DeepSeek Harness、Claude Code 和 Codex 在同一台 Windows 电脑上互相传话。

几个助手分着做同一个任务时，经常要把任务复制到另一个聊天，再把回复搬回来。这个插件把收发变成了本地命令：Claude Code 或 Codex 可以向已经打开的 DSH 会话发消息、等待回复；DSH 也可以把任务和结果发到指定的 Claude Code 或 Codex 会话。

它复用现有聊天，保留各自的上下文。传输不占键鼠，也不用再开一个模型会话。具体任务仍由对应客户端执行，使用你自己的模型和账号额度。

## 能做什么

- 列出 DSH 中已有的会话，返回完整会话编号和运行状态。
- 把 UTF-8 正文文件发给指定 DSH 会话，按请求编号读取对应回复。
- DSH 会话忙时排队，同一会话里的桥接消息依次提交。
- 用相同请求编号重试同一条消息，避免重复投递；插件重载后恢复跟踪。
- 从 DSH 向已有的 Claude Code、Codex 聊天投递任务或结果。

它负责传话，不负责决定谁来做任务、替你批准权限，或让几个助手无限循环互发消息。

## 运行环境

当前验收环境是 **Windows 11 + DSH Desktop 0.2.1-rc.2 + Node.js 24**，源码要求 Node.js 22 或更高版本。

向 Codex 投递需要本机已安装 Codex 桌面版；向 Claude Code 投递需要正在运行的交互会话，以及 PowerShell 7。Claude 方向使用 Windows 命名管道，尚未验证 macOS、Linux 或其他 DSH 版本。

插件没有第三方生产依赖，也没有安装脚本。它在 DSH Host 内只调用 `session/list`、`session/prompt` 和 `session/follow`。

## 安装

先从 [v0.1.1 Release](https://github.com/zhz-viads/dsh-local-bridge/releases/tag/v0.1.1) 下载 `dsh-local-bridge-v0.1.1-source.zip`。下面的 PowerShell 示例把源码放到当前用户的 DSH 本地插件目录：

```powershell
$pluginRoot = Join-Path $env:USERPROFILE '.dsh\local-plugins'
New-Item -ItemType Directory -Path $pluginRoot -Force | Out-Null
Expand-Archive -LiteralPath '.\dsh-local-bridge-v0.1.1-source.zip' -DestinationPath $pluginRoot
$plugin = Join-Path $pluginRoot 'dsh-local-bridge-v0.1.1'
dsh plugin --profile desktop add --ignore-scripts "file:$plugin"
```

这一步需要 DSH 命令行可用；如果 `dsh` 不在 PATH 中，使用你安装的 `dsh.cmd` 完整路径。安装后重载 DSH 桌面版，保留解压后的源码目录。插件的安装方式见 [DSH 官方文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

## 先列会话，再发消息

客户端可以直接用 Node 运行，不需要额外的快捷脚本：

```powershell
$cli = Join-Path $env:USERPROFILE '.dsh\local-plugins\dsh-local-bridge-v0.1.1\cli.mjs'
node $cli help
node $cli status
node $cli list
```

从 `list` 里复制完整的目标会话编号。下面两个编号只是示例，发送前换成实际编号；正文放在自己的 UTF-8 文件中：

```powershell
$targetSession = 'session-11111111-1111-4111-8111-111111111111'
$senderSession = '22222222-2222-4222-8222-222222222222'
node $cli send --session $targetSession --from codex --source-session $senderSession --file '.\message.txt' --wait 60
```

从 Claude Code 发出时，把 `--from codex` 改为 `--from claude`。DSH 会话编号使用 `list` 返回的完整值，通常带 `session-` 前缀；Claude Code、Codex 的会话编号使用对应客户端的完整 UUID。不要用聊天标题代替编号。

等待时间到了也可以继续查询。把下方的 `example-request` 换成发送时返回的 `requestId`：

```powershell
node $cli result 'example-request' --wait 60
node $cli result 'example-request' --wait 60 --format text   # 只看状态和回复正文
```

重试同一条请求时加上 `--id 原requestId`，并保持目标、来源和正文一致。重复使用编号却更换内容，会被拒绝。

从 DSH 向外投递时，`--source-session` 使用当前 DSH 会话的完整编号：

```powershell
$dshSession = 'session-11111111-1111-4111-8111-111111111111'
$peerSession = '22222222-2222-4222-8222-222222222222'
node $cli to-codex --thread $peerSession --source-session $dshSession --file '.\message.txt'
node $cli to-claude --session $peerSession --source-session $dshSession --file '.\message.txt'
```

## 按聊天名找会话

只知道聊天名时，先查出唯一的会话编号再发，不按相似名字猜：

```powershell
node $cli find --codex '测试'   # 查 Codex 聊天（读取本机 Codex 的会话索引，取每个聊天最新的名字）
node $cli find --dsh '测试'     # 查 DSH 会话（读取插件心跳里的会话列表）
```

`unique` 有值才可以直接用；为空时 `matches` 会列出所有同名会话，或者为空表示没找到，这时请让用户指定。Codex 的会话索引是它的内部文件，客户端升级后格式可能变化。

## 回复会写得短一些

插件注入给 DSH 的说明里约定：通过桥接收到的协作消息，第一句给结论，最多 5 条要点；不复述对方原文；超过约 800 字时把全文写进对方指定的文件，回复里只给路径和摘要。这只是写作约定，具体长度由模型把握。

## 收到回执，代表到了哪一步

| 状态 | 含义 |
| --- | --- |
| `queued` | 文件请求已进入队列 |
| `submitting` | 正在提交，是否已接收尚未确定 |
| `accepted` | DSH 已接收请求 |
| `running` | 请求对应的消息已进入具体轮次 |
| `completed` | 已观察到该请求对应轮次正常结束 |
| `cancelled` / `failed` | 对应轮次取消、失败，或桥接跟踪出错 |

DSH 方向会跟踪对应轮次的回复。从 DSH 发到 Claude Code、Codex 时，`written` 或 `queued` 只表示消息已交给传输通道，是否读到、是否做完，要看接收方的回复。

## 已知限制

- Codex 正忙时，消息进入它的待发送队列，通常等当前轮结束后处理。需要立即追加时，可由用户在界面上点击“引导”；插件不替你点击。
- 插件重载后，已接收或正在运行的请求恢复跟踪，不重新发出。恢复依赖最近 500 条消息的历史窗口，超长轮次尚未充分验证。
- 在界面里删除排队消息后，桥接跟踪最多等待 15 分钟再报告 `reply_timeout`，不会自动重发。
- DSH 中的权限确认需要用户处理；桥接等待不代表它能识别每一种权限弹窗。
- Claude Code 的命名管道协议和 DSH 的会话接口都可能随客户端升级变化。升级后先检查 `status`、`list`，再测试一条短消息。
- Windows 单元测试中的 Claude 适配器检查沿用 Codex 自带的 PowerShell 7 路径；其他 PowerShell 安装布局尚未验证。

## 本地记录与信任范围

通信文件放在 `%USERPROFILE%\.dsh\bridge\` 下：`inbox`、`work` 保存请求，`outbox` 保存回复，`status.json` 保存心跳和会话元数据。完成的请求、回复最多保留 200 条或 7 天；`ledger.jsonl` 保留用于去重的编号、来源、会话、状态与长度，过大时明确报错。

正文最多 32 KiB，请求文件最多 64 KiB。读写会检查链接、目录联接和越界路径，写入采用临时文件原子替换。格式不合要求的请求进入 `rejected`；若隔离过程中退出，可能只留下原文件，没有附加说明。

这些文件沿用当前 Windows 用户的访问权限，同一用户下的其他程序仍可能读取它们。`--from` 是发送方声明的身份；同伴消息不等于用户授权。伪造跨会话消息包裹标签的正文会被拒绝。

插件自身不发 HTTP 请求、不监听端口，也不读取 DeepSeek 的登录凭据或 Cookie。向 Claude Code 投递时，会在一次性进程内读取其会话登记与密钥，并核对进程、启动时间、会话和管道归属；密钥不写入通信记录。

## 验证摘要

公开副本重新执行 `node --test test/bridge.test.mjs`，26 项单元测试通过，覆盖去重、排队、请求校验、重载恢复、超时和异常文件处理。

v0.1.0 发布前的本机安装版还完成了 6 条真实往返核对：每条在 DSH 原生日志中恰好出现一次用户消息和一次 inbox 插入；accepted 后停用、启用插件能够恢复；DSH 发往 Claude Code、Codex 的消息都由接收方确认收到。这些是既定 Windows 环境下的历史验收结果。v0.1.1 的本机安装与公开源码使用同一份代码，本次更新不重复触发真实模型请求。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-local-bridge
```

卸载后重载桌面版。本地通信记录会保留；需要删除时，先确认其中没有还要用的任务和回复。

## 更新记录

- **0.1.1**：新增 `find`，按聊天名查唯一会话编号，跳过索引中格式错误的编号；`result` 和 `send --wait` 支持 `--format text`，只输出状态和回复正文；默认输出不再带内部跟踪字段；注入说明要求 DSH 通过桥接回复时简短、先给结论；本机安装与公开源码统一。
- **0.1.0**：首个公开版本。

## 许可证

Copyright 2026 z-fdg。按 [Apache License 2.0](LICENSE) 发布，署名见 [NOTICE](NOTICE)。这是独立开发的社区插件。

源码目前通过 GitHub 仓库和 Release 提供，尚未发布到 npm；`package.json` 的 `private: true` 用于防止意外发布到 npm。
