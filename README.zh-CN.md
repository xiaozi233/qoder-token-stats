# Qoder Token Stats

[English](README.md) | 简体中文

一个 Qoder 插件：报告模型生成本轮回答的速度。`Stop` 钩子在回答结束后测量这一轮，
把统计行交回给模型，由模型贴在回答末尾：

```
⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 3,389 tok / 生成 60.6s · 45 段 / 峰 84.6
```

依次是：吞吐、首字耗时、输出 token、生成秒数、段数、单段峰值速率。工具执行和权限
等待不算在内 —— 只统计模型自己生成的时间。

聊天里那一行由模型写出，偶尔会漏。桌面悬浮条显示同一份归档数据，完全不经过模型。

## 安装

```bash
git clone https://github.com/xiaozi233/qoder-token-stats.git
cd qoder-token-stats
node scripts/install.mjs --expose-token-usage
```

`--expose-token-usage` 会设置 `QODERCN_EXPOSE_TOKEN_USAGE=1`。不设它的话，Qoder 会把
写入会话日志的 token 数全部清零，数字只能是估算值，并带 `~` 标记。

然后**完全退出并重开 Qoder** —— 环境变量和插件注册表都在进程启动时读取。一个坑：
快捷方式和任务栏由 `explorer.exe` 拉起，而它只在登录时读一次环境变量，所以要么重启一次
资源管理器 / 注销一次，要么用仓库里的启动器启动，它会在自己进程里先把这个变量设好：

```powershell
powershell -File scripts/launch-with-usage.ps1 -CheckOnly   # Qoder 现在能看到什么
powershell -File scripts/launch-with-usage.ps1              # 用这个方式启动 Qoder
```

## 使用

- **统计行**：每轮回答末尾自动出现。
- **主动查询**：`node runtime/token-stats.mjs --session <id>` 可查本轮或任意历史会话。
  插件也注册了 `token-stats` skill，直接问「本轮多少 tok/s」即可。
- **关掉聊天里那一行**（悬浮条和 `--session` 照常工作）：在
  `~/.qoder-cn/token-stats.config.json` 写入 `{"tokenRateLine": false}`。

## 桌面悬浮条

一条透明置顶的横条，每秒读一次归档的统计行 —— 不经过模型、不需要提示、不用配置。
可以拖到任意位置，右键关闭。它写的是 `(上一轮)` 而不是 `(本轮)`：归档是在一轮**结束**
时写的，所以回答还在生成时它描述的是上一轮。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay.ps1   # 或双击 dashboard\overlay.cmd
powershell -NoProfile -File dashboard\overlay.ps1 -Status
powershell -NoProfile -File dashboard\overlay.ps1 -Stop

# 开机自动拉起（同时立刻启动它）；-Remove 删掉快捷方式并停掉悬浮条
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay-autostart.ps1 -Install
```

## 工作原理

Qoder 插件画不了 UI：钩子的 stdout 不会转发给模型，客户端的钩子渲染器只画状态、不画文字。
唯一能进入当轮可见内容的通道是 `Stop` 钩子回答 `{"decision":"deny","reason":…}` —— Qoder
把它作为续写消息重新注入。于是钩子负责测量、归档并把统计行交出去，模型负责贴出来。
在 `Stop` 测量还有个好处：数字覆盖的是完整的回答，而不是模型恰好把命令塞进去时的进度。

```
UserPromptSubmit → 生成本轮专属 key + 「Stop 时会把统计行给你，请原样贴出」
模型作答 → Stop → 测量、归档、用统计行 deny
模型贴出统计行 → Stop（stop_hook_active）→ 保持安静
```

每一轮都有自己的 key，所以不会为同一个位置抢写；而本轮 model 请求全部早于本轮时间戳时
什么都不打印，不会把上一轮当成当前轮。每轮唤醒一次模型要多花一次迭代，所以连续三次不理会
唤醒，该会话就安静八轮。

## 卸载

```bash
node scripts/install.mjs --uninstall              # 插件 + 环境变量
node scripts/install.mjs --uninstall --keep-env   # 保留环境变量
```

## 出问题了看哪

- `~/.qoder-cn/plugins/data/token-stats-local/errors.jsonl` —— 钩子失败、唤醒被压制、
  日志读不出来，每条都带 `kind`。
- 同目录的 `latest.md` —— 最后一轮的纯文本记录。
- 读不出来的日志绝不会被报成 0：CLI 会以退出码 2 并在 stderr 上说明原因。

## 开发

```bash
node scripts/test.mjs    # 46 个测试，跑在脱敏的真实日志 fixture 上，无第三方依赖
```

`set TOKEN_STATS_SOURCE=<本仓库路径>` 之后，钩子包装脚本会直接跑仓库里的 `runtime/*.mjs`
而不是安装副本，改完不用重装。正式使用时记得取消这个变量。

`dashboard/overlay.ps1` 必须保留 UTF-8 BOM —— PowerShell 5.1 会把无 BOM 的 `.ps1` 当 ANSI
读，里面的中文常量会解析失败。有测试守着这条。

## 许可证

MIT，见 [LICENSE](LICENSE)。
