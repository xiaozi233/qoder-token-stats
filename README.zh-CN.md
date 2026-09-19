# Qoder Token Stats

[English](README.md) | 简体中文

一个 Qoder 插件，在每轮回答结束后打印本轮的 token 吞吐统计，格式对齐主界面那条状态栏：

```
⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 3,389 tok / 生成 60.6s · 45 段 / 峰 84.6
会话累计 27.8 tok/s · ~14,868 tok / 533.1s · 78 段 / 峰 60.9 · 3 轮
```

## 快速开始

```bash
git clone https://github.com/xiaozi233/qoder-token-stats.git
cd qoder-token-stats
node scripts/install.mjs        # 注册到 ~/.qoder-cn，两个配置文件都会先备份 .bak
```

然后**重启 Qoder**——插件注册表只在启动时 reconcile 一次。重启后 `Stop` 钩子会在每轮结束时
打印上面这行；同时 `token-stats` skill 会注册进来，你可以直接问 agent「本轮多少 tok/s」。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `.qoder-plugin/plugin.json` | 插件清单 |
| `hooks/hooks.json` | 注册 `Stop` 钩子 |
| `bin/token-stats.cmd` | Windows 包装脚本，先解析 JS 运行时再执行 `runtime/*.mjs` |
| `runtime/stats.mjs` | 解析 Qoder 会话日志、计算各项指标 |
| `runtime/stop-stats.mjs` | Stop 钩子入口 |
| `runtime/token-stats.mjs` | 按需查询的 CLI |
| `skills/token-stats/SKILL.md` | 教会 agent 怎么跑、怎么解释这些数字 |
| `scripts/install.mjs` | 写入用户插件注册表（改前留 `.bak` 备份） |

## 安装 / 卸载

```bash
node scripts/install.mjs            # 安装到 ~/.qoder-cn
node scripts/install.mjs --uninstall
```

## 改了代码不想重装

`install.mjs` 是往 `plugins/cache/local/` 里拷一份**快照**，并在 `SOURCE` 文件里记下源码目录。
改完之后二选一：

```bash
node scripts/install.mjs                                  # 重新同步快照
set TOKEN_STATS_SOURCE=<本仓库的绝对路径>                  # 或直接跑源码目录
```

设置了 `TOKEN_STATS_SOURCE` 之后，`bin/token-stats.cmd` 会执行源码目录里的 `runtime/*.mjs`
而不是安装副本。日常使用记得把这个变量去掉。

## 各项数字是怎么算出来的

Qoder 会把结构化事件追加到 `~/.qoder-cn/logs/sessions/<项目>/<会话>/segments/*.jsonl`。
一个「轮」= 共享同一个 `turn_id` 的事件集合；一个「段」= 一对
`model.request.started` → `model.response.completed`。生成秒数是所有段时长之和，
所以工具执行和权限等待的时间**不计入**。

各段的 token 数来自会话 transcript（`~/.qoder-cn/projects/<项目>/<会话>.jsonl`），
按 assistant 的 `message.id` 分组，再用时间戳最近邻配对到各个段——因为存在重试和失败请求，
两边的数量会不相等，按位置硬对齐会漂移。

| 字段 | 含义 |
| --- | --- |
| `tok/s(本轮)` | 本轮 token 数 ÷ 本轮模型生成总秒数 |
| `首字` | 轮开始 → 第一个 `tool.requested` 或 `model.response.completed` 事件 |
| `输出 tok` | assistant 的正文 + thinking + 工具调用参数 |
| `生成` | 各段时长之和（不含工具执行时间） |
| `段` | 本轮完成的大模型请求数 |
| `峰` | 本轮所有段里最高的单段速率 |

**token 总量是估算值，不是实测值。** 目前网关在每条 `model.response.completed` 上返回的
`output_tokens` 都是 0，所以插件改用字符估算：中日韩字符按 1 token/字、拉丁词按 1 token/词
计数，结果前面加 `~` 标记。一旦网关开始返回真实 usage，插件会自动改用真实值，`~` 也随之消失，
不需要任何配置。

`首字` 同理：Qoder 并不记录「首 token」事件，取的是「轮开始 → 第一次工具调用或整段响应完成」，
所以它是首字耗时的**上界**，不是实测值。

## 钩子输出格式

`stop-stats.mjs` 往 stdout 写 `{"systemMessage": "..."}`，与官方 `qoder-context` 插件用的是同一套
格式。如果当前 Qoder 版本不显示这个字段，改用 `node runtime/stop-stats.mjs --text` 输出纯文本；
或者直接看 `~/.qoder-cn/plugins/data/token-stats/latest.md`——不管显示与否，钩子每轮都会重写它，
并把历史追加到同目录的 `history.jsonl`。

## 实测数据

在作者机器上的真实会话跑出来的结果，包含两个历史 Bedrock mod 会话：

| 会话 | tok/s | 首字 | 输出 | 生成 | 段 | 峰 |
| --- | --- | --- | --- | --- | --- | --- |
| `9762dfc7`（本仓库） | 33.3 | 4.5s | ~18,820 | 565.2s | 81 | 60.9 |
| `c1f7d924` | 22.1 | 6.8s | ~2,857 | 129.3s | 11 | 38.3 |
| `093d9f7a` | 21.9（两轮均值） | — | ~9,737 | 445.5s | 21 | 28.0 |

## 已知限制

- **做不了常驻状态栏。** Qoder 插件只能提供 hooks、MCP server 和 skill 三类扩展，没有 UI 扩展点，
  所以最终形态是「每轮结束时打印一条 + 可查询的历史日志」，不是实时计数器。
- **代码密集的轮次估算会偏。** 分词器对标点、缩进、标识符的计法和这里的词数启发式差别较大。
- **只在 Windows 上验证过。** `bin/token-stats.cmd` 是批处理脚本；`runtime/*.mjs` 本身跨平台，
  但钩子需要一个对应的 POSIX 包装。

## 许可证

MIT，见 [LICENSE](LICENSE)。
