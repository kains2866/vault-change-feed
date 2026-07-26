# Vault Change Feed

把 Obsidian vault 的变更记录为机器可读的事件流，并为每个读者（AI agent）维护独立的读取游标。AI 在管理知识库前读一次日志，就知道你自它上次访问以来改了什么，不用全量扫描。

## 它解决什么问题

AI 不知道你背着它改了哪些笔记。全库扫描太贵；不问又会基于过期认知乱改。本插件持续记录「哪个文件、增/删/改/重命名、增删多少行」，AI 按需增量拉取。

## 工作原理

- 运行期：监听 Obsidian 的 create / modify / delete / rename 事件，行级 diff 统计增删行数
- 启动时：与上次基线快照对账，补记 Obsidian 关闭期间（手机端、iCloud 同步、CLI 工具）发生的变更；同哈希的删+建自动识别为 rename（配对基于内容哈希；二进制文件经 iCloud 重新下载后 mtime 变化，可能退化为 delete+create 两条事件）
- 数据全部本地，存放在 `.obsidian/plugins/vault-change-feed/`：
  - `changelog.jsonl` — 事件流，一行一条
  - `cursors.json` — 各读者的读取游标
  - `baseline.gz` — 内容基线快照（用于 diff 与对账）

注意：同一 vault 同一时间只在一个 Obsidian 实例中启用本插件（多实例同时写入会导致 seq 冲突与文件互相覆盖）。

## 事件格式

```json
{"seq": 1284, "ts": 1785000000000, "op": "modify", "path": "ML/过拟合.md", "stat": {"added": 12, "removed": 3}, "source": "live"}
```

- `op`：`create` / `modify` / `delete` / `rename`（带 `oldPath`）/ `resync`（基线重建，见到它建议全量重扫）
- `stat`：`{added, removed}` 增删行数；`null` 表示「变了但幅度未知，请打开看」（二进制、超大文件）
- `source`：`live` / `reconcile`（启动补记）/ `system`

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

## 命令

- `Copy unread changes for AI` — 把未读变更的紧凑摘要复制到剪贴板（读者名 `manual`），直接粘给任意 AI 对话。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| Tracked text extensions | `md, markdown, txt, canvas, json, csv` | 这些扩展名计算 diff 统计 |
| Exclude globs | 空 | 额外排除规则；`.obsidian/` 恒排除 |
| Large file threshold | 1024 KB | 超过则 stat 为 null |
| Retention days / max entries | 90 / 50000 | 日志轮转，先到先截 |
| Baseline flush interval | 300 s | 基线持久化周期 |

## 隐私

纯本地：不联网、不上传、不收集任何数据。所有文件都在你自己的 vault 里。

## 开发

```bash
npm install
npm run build   # 类型检查 + 打包 main.js
npm test        # vitest
```

桌面端专用（`isDesktopOnly: true`，使用 Node fs）。
