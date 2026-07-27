# Vault Change Feed

**给你的 AI agent 一本 vault 变更日志。** 你的每一次编辑都被记录为机器可读的事件流，每个读者（AI agent）各持一个读取游标——AI 管理知识库前读一次日志，就知道你自它上次访问以来改了什么，不用全量扫描。

[![GitHub release](https://img.shields.io/github/v/release/kains2866/vault-change-feed)](https://github.com/kains2866/vault-change-feed/releases)
[![License: MIT](https://img.shields.io/github/license/kains2866/vault-change-feed)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/kains2866/vault-change-feed/total)](https://github.com/kains2866/vault-change-feed/releases)

[English README](https://github.com/kains2866/vault-change-feed/blob/main/README.md) · [Obsidian 社区插件页](https://community.obsidian.md/plugins/vault-change-feed)

---

## 安装

**社区市场（推荐）**：设置 → 第三方插件 → 浏览 → 搜索 **Vault Change Feed** → 安装并启用。AI 协议块会在首次启用时自动装好。

**手动安装**：把[最新 release](https://github.com/kains2866/vault-change-feed/releases/latest) 的 `main.js` 和 `manifest.json` 复制到 `<vault>/.obsidian/plugins/vault-change-feed/`，然后启用插件。

## 它解决什么问题

AI 不知道你背着它改了哪些笔记。全库扫描太贵；不问又会基于过期认知乱改。本插件持续记录「哪个文件、增/删/改/重命名、增删多少行」，AI 按需增量拉取。

## 工作原理

- 运行期：监听 Obsidian 的 create / modify / delete / rename 事件，行级 diff 统计增删行数
- 启动时：与上次基线快照对账，补记 Obsidian 关闭期间（手机端、iCloud 同步、CLI 工具）发生的变更；同哈希的删+建自动识别为 rename（配对基于内容哈希；二进制文件经 iCloud 重新下载后 mtime 变化，可能退化为 delete+create 两条事件）
- 数据全部本地，存放在 `.obsidian/plugins/vault-change-feed/`：
  - `changelog.jsonl` — 事件流，一行一条
  - `cursors.json` — 各读者的读取游标
  - `baseline.gz` — 内容基线快照（用于 diff 与对账）

注意：插件已内置**待机保护**——多实例通过心跳写者锁（`writer.lock`）协调，只有持锁实例记录变更，其余实例待机（只读 API 仍可用），锁 90 秒过期后待机实例自动接管。但仍建议同一 vault 同一时间只在一个 Obsidian 实例中启用本插件。

## 事件格式

```json
{"seq": 1284, "ts": 1785000000000, "op": "modify", "path": "ML/过拟合.md", "stat": {"added": 12, "removed": 3}, "source": "live"}
```

- `op`：`create` / `modify` / `delete` / `rename`（带 `oldPath`）/ `resync`（基线重建，见到它建议全量重扫）
- `stat`：`{added, removed}` 增删行数；`null` 表示「变了但幅度未知，请打开看」（二进制、超大文件）
- `source`：`live` / `reconcile`（启动补记）/ `system`

## 让 AI 发现 feed

其他 AI agent（Kimi Code / Claude Code / Codex 等）安装插件后默认不知道 feed 存在。启用插件后，一段读取协议会**自动**以标记块（`<!-- vault-change-feed:start/end -->`）写入 vault 根目录的 `AGENTS.md`、`CLAUDE.md` 与 `GEMINI.md` —— 前两个是各 AI 工具约定俗成的发现点（AGENTS.md 为跨工具标准，CLAUDE.md 对应 Claude Code），GEMINI.md 对应默认不读 AGENTS.md 的 Gemini CLI，开箱即用、零操作。

- 可关闭：设置 `Auto-install AI protocol on first run` 关闭（`autoInstallProtocol: false`）后退回手动引导，仍有 `Install AI protocol for agents` / `Remove AI protocol from agent files` 命令手动管理
- 幂等：重复运行只更新标记块内部，块外你自己的内容逐字保留；没有块则追加到文末并空一行分隔
- 随版本自动刷新：插件升级后若协议文本有更新，会自动刷新已安装的块；自动同步只刷新已安装块的文件，不会替你创建新文件（可在设置里关闭 Auto-sync）
- 命令 `Remove AI protocol from agent files` 彻底移除三个文件里的块；若文件只剩协议块则直接删除该文件
- 写入目标可在设置中分别开关（Sync AGENTS.md / Sync CLAUDE.md / Sync GEMINI.md）
- 没有文件访问权的 AI（纯网页对话等）仍走 `Copy unread changes for AI` 命令，把未读变更粘给它

### 可选：SessionStart hook（免"自觉"，强制注入）

协议块依赖 AI 自觉读取；`extras/vault-feed-hook.mjs` 提供更强保证——挂在 agent 的 SessionStart hook 上，会话启动时自动把未读变更（合并后）注入上下文并推进游标。脚本从会话 cwd 向上查找受跟踪的 vault，目录不在 vault 内或无未读时完全静默。

Kimi Code（`~/.kimi-code/config.toml`）：

```toml
[[hooks]]
event = "SessionStart"
command = "node /path/to/extras/vault-feed-hook.mjs --reader=kimi-code --format=kimi"
timeout = 10
```

Claude Code（`~/.claude/settings.json` 的 `hooks.SessionStart`）：

```json
{ "type": "command", "command": "node /path/to/extras/vault-feed-hook.mjs --reader=claude-code --format=claude", "timeout": 10 }
```

`--reader` 为该 agent 的固定游标名；建议用 `node` 的绝对路径。

## 给 AI agent 的协议（README 即接口文档）

This vault is tracked by the **vault-change-feed** Obsidian plugin. Before editing notes, catch up on what the user changed since your last visit:

1. Read `.obsidian/plugins/vault-change-feed/cursors.json` and find your reader name (use your agent id, e.g. `"kimi-cli"`; absent means cursor `0`).
2. Read `.obsidian/plugins/vault-change-feed/changelog.jsonl` (one JSON event per line) and take events with `seq` greater than your cursor.
   - If your cursor is `> 0` and the smallest `seq` in the file is greater than `cursor + 1`, the log was rotated and you missed events — stop and do a full vault rescan instead.
   - If you see an event with `op: "resync"`, the plugin rebuilt its baseline — a full rescan is advised.
3. Event shape: `{"seq", "ts", "op": "create"|"modify"|"delete"|"rename"|"resync", "path", "oldPath"?, "stat": {"added", "removed"} | null, "source"}`. `stat: null` means "changed, magnitude unknown — open the file if you care".
4. After processing, write the largest `seq` you saw back to `cursors.json` under your reader name. Write atomically: write `cursors.json.tmp`, then rename it to `cursors.json`.

Inside Obsidian, other plugins/scripts can use the JS API instead of files:

```js
const api = app.plugins.plugins['vault-change-feed'].api;
const { events, stale, latestSeq } = await api.getChanges('my-plugin');
// ...处理...
await api.markRead('my-plugin', latestSeq);
```

JS API 的 `getChanges` 默认把同一文件的未读事件合并为一条（`api.getChanges(name, { merge: false })` 可得原始流；不可无损合并的组除外，见下）。直接读 `changelog.jsonl` 的外部 agent 看到的是原始事件流，如需合并可自行按以下规则实现：

- 先按 `seq` 排序（容忍日志乱序），再按 `path` 分组（`resync` 不合并，原样保留）；合并产出的 `seq`/`ts` 取组内最大，`source` 取组内最后一条
- 窗口内 create 了又 delete → 整组丢弃；结尾是 delete 且组内含 rename → `delete`，path 取首个 rename 的 `oldPath`（不带 oldPath 字段，stat 取 delete 自身）；结尾是 delete → `delete`（stat 取最后一条 delete 自身）
- 组内 delete 与 rename 交织且不属上一条 → 不合并，组内事件原样输出（任何合并都会丢某个路径的命运）
- 删了又建 → `modify`（stat 为 null）；开头是 create → `create`；含 rename → `rename`（保留首个 rename 的 oldPath）；其余 → `modify`
- 后三种的 stat：组内全部非 null 则逐项累加，否则 null；输出按合并后 seq 升序

## 命令

- `Copy unread changes for AI` — 把未读变更的紧凑摘要复制到剪贴板（读者名 `manual`），直接粘给任意 AI 对话。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| Tracked text extensions | `md, markdown, txt, canvas, json, csv` | 这些扩展名计算 diff 统计 |
| Exclude globs | 空 | 额外排除规则；`.obsidian/` 恒排除 |
| Large file threshold | 1024 KB | 超过则 stat 为 null |
| Baseline content budget | 102400 KB（100 MB） | 用于 diff 的全文内存预算；超预算文件只存哈希（stat 退化为 null） |
| Retention days / max entries | 90 / 50000 | 日志轮转，先到先截 |
| Baseline flush interval | 300 s | 基线持久化周期 |
| Auto-install AI protocol on first run | 开 | 首次启用插件时自动把协议块写入 AGENTS.md / CLAUDE.md / GEMINI.md |
| Sync AGENTS.md | 开 | 把协议块安装到 vault 根目录 AGENTS.md |
| Sync CLAUDE.md | 开 | 把协议块安装到 vault 根目录 CLAUDE.md |
| Auto-sync protocol block | 开 | 插件升级后自动刷新已安装的协议块 |

## 隐私

纯本地：不联网、不上传、不收集任何数据。所有文件都在你自己的 vault 里。

## 开发

```bash
npm install
npm run build   # 类型检查 + 打包 main.js
npm test        # vitest
```

桌面端与移动端均可使用（文件操作全部走 Obsidian vault API）。

## 支持

如果这个插件帮你省了时间，可以请我喝杯咖啡 ☕

<a href="https://buymeacoffee.com/kains3772d"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="48"></a>
