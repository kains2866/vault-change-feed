# Vault Change Feed

**给你的 AI agent 一本 vault 变更日志。** 你的每一次编辑都被记录为机器可读的事件流，每个读者（AI agent）各持一个读取游标——AI 管理知识库前读一次日志，就知道你自它上次访问以来改了什么，不用全量扫描。

[![GitHub release](https://img.shields.io/github/v/release/kains2866/vault-change-feed)](https://github.com/kains2866/vault-change-feed/releases)
[![License: MIT](https://img.shields.io/github/license/kains2866/vault-change-feed)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/kains2866/vault-change-feed/total)](https://github.com/kains2866/vault-change-feed/releases)

[English README](https://github.com/kains2866/vault-change-feed/blob/main/README.md) · [Obsidian 社区插件页](https://community.obsidian.md/plugins/vault-change-feed)

## Support / 支持

If this plugin saves you time, you can buy me a coffee — it keeps the development going.
如果这个插件帮你省了时间，可以请我喝杯咖啡 ☕

- **International**: <a href="https://buymeacoffee.com/kains3772d"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="48"></a>
- **中国大陆**: [爱发电](https://ifdian.net/a/kains2866)（微信 / 支付宝直达 · WeChat / Alipay）

---

## 安装

**社区市场（推荐）**：设置 → 第三方插件 → 浏览 → 搜索 **Vault Change Feed** → 安装并启用。AI 协议块会在首次启用时自动装好。

**手动安装**：把[最新 release](https://github.com/kains2866/vault-change-feed/releases/latest) 的 `main.js` 和 `manifest.json` 复制到 `<vault>/.obsidian/plugins/vault-change-feed/`，然后启用插件。

## 它解决什么问题

AI 不知道你背着它改了哪些笔记。全库扫描太贵；不问又会基于过期认知乱改。本插件持续记录「哪个文件、增/删/改/重命名、增删多少行」，AI 按需增量拉取。

## 工作原理

- **分设备日志（v2）**：每台运行本插件的设备把事件写入**自己的日志**（各自独立 seq）——多设备可并行编辑同一 vault，无序号冲突；同一物理变更被多台设备看到时，读取侧按内容哈希（`ch`）去重为一条
- 运行期：本设备监听 Obsidian 的 create / modify / delete / rename 事件，行级 diff 统计增删行数
- 启动时：与本设备基线快照对账，补记 Obsidian 关闭期间（其他设备、iCloud 同步、CLI 工具）发生的变更；同哈希的删+建自动识别为 rename
- 数据全部本地，存放在 `.obsidian/plugins/vault-change-feed/`：
  - `devices.json` — 已写入日志的设备清单
  - `events/<deviceId>.jsonl` — 各设备事件流（每设备独立 seq）
  - `state/<deviceId>.json` — 各设备轻量状态端点（`{minSeq, maxSeq, count, updatedAt}`），agent 先读它即可判断是否有新事件
  - `cursors/<reader>.json` — 每读者独立游标文件（`{deviceId: lastSeq}`）
  - `baseline-<deviceId>.gz` — 各设备内容基线（用于 diff 与对账）

写者锁（`writer.lock`）只用于串行化**同一设备**上的多个 Obsidian 实例；跨设备并行写各写各的文件，互不阻塞。

## 事件格式

```json
{"device": "8f3a-…", "seq": 1284, "ts": 1785000000000, "op": "modify", "path": "ML/过拟合.md", "ch": "0a9b8c7d…", "stat": {"added": 12, "removed": 3}, "source": "live"}
```

- `device` + `seq`：序号只在**同一设备内**递增，事件唯一键为 `(device, seq)`
- `op`：`create` / `modify` / `delete` / `rename`（带 `oldPath`）/ `resync`（基线重建，见到它建议全量重扫）
- `ch`：create/modify 记录后文件内容哈希（文本为 16 位 hex；旧数据可能没有）——读取侧按 `(path, op, ch)` 去重，消除"同一变更被多台设备各记一条"
- `stat`：`{added, removed}` 增删行数；`null` 表示「变了但幅度未知，请打开看」（二进制、超大文件）
- `source`：`live` / `reconcile`（启动补记）/ `system`
- `source`：`live` / `reconcile`（启动补记）/ `system`

## 让 AI 发现 feed

其他 AI agent（Kimi Code / Claude Code / Codex 等）安装插件后默认不知道 feed 存在。启用插件后，一段读取协议会**自动**以标记块（`<!-- vault-change-feed:start/end -->`）写入 vault 根目录的 `AGENTS.md` 与 `CLAUDE.md` —— AGENTS.md 为跨工具标准（Gemini CLI 现已支持 AGENTS.md），CLAUDE.md 对应 Claude Code，开箱即用、零操作。

- 可关闭：设置 `Auto-install AI protocol on first run` 关闭（`autoInstallProtocol: false`）后退回手动引导，仍有 `Install AI protocol for agents` / `Remove AI protocol from agent files` 命令手动管理
- 幂等：重复运行只更新标记块内部，块外你自己的内容逐字保留；没有块则追加到文末并空一行分隔
- 随版本自动刷新：插件升级后若协议文本有更新，会自动刷新已安装的块；自动同步只刷新已安装块的文件，不会替你创建新文件（可在设置里关闭 Auto-sync）
- 命令 `Remove AI protocol from agent files` 彻底移除三个文件里的块；若文件只剩协议块则直接删除该文件
- 写入目标可在设置中分别开关（Sync AGENTS.md / Sync CLAUDE.md）
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

可选 `--max-events=N`（默认 200）：限制每次会话注入的合并事件数。未读更多时只注入前 N 条，游标只推进到已注入部分（部分消费）并提示剩余——下次会话运行 hook 继续消费，避免长时间未用后单次注入超限被丢弃、变更静默丢失。

## 给 AI agent 的协议（README 即接口文档）

This vault is tracked by the **vault-change-feed** Obsidian plugin. Before editing notes, catch up on what the user changed since your last visit:

1. Read `.obsidian/plugins/vault-change-feed/cursors/<reader>.json` — 你的游标文件 `{deviceId: lastSeq}`。请固定使用一个 reader 名（如你的 agent 名 `"claude-code"`）；文件不存在 = 每台设备游标均为 0。只写你自己的文件。
2. Read `.obsidian/plugins/vault-change-feed/devices.json` → `devices[].id` 为所有已知写入设备。
3. 对每台设备读 `.obsidian/plugins/vault-change-feed/events/<deviceId>.jsonl`（每行一个 JSON 事件），取该设备 `seq` 大于其游标的事件。
   - 若某设备游标 > 0 且其最小 `seq` 大于 `游标+1` → 该日志轮转过、你漏了事件，停下做全量重扫。
   - 见到 `op: "resync"` → 基线重建，建议全量重扫。
   - `stat: null` 表示「变了但幅度未知，需要时打开文件看」。
4. 合并成一条时间线：先按 (`ts`, `device`, `seq`) 排序，再做内容去重——带 `ch` 的 create/modify 事件，每个 (`path`, `op`, `ch`) 只保留第一条（同一物理修改可能被两台设备都记录）。
5. 处理完后，把你的游标文件写为 `{deviceId: 该设备你实际读到的最大 seq}`；原子写：先写 `<file>.tmp` 再 rename 覆盖。绝不写超过你实际读到的 seq。

Inside Obsidian, other plugins/scripts can use the JS API instead of files:

```js
const api = app.plugins.plugins['vault-change-feed'].api;
const { events, stale, perDevice } = await api.getChanges('my-plugin');
// ...处理...
await api.markRead('my-plugin', perDevice);
```

JS API 的 `getChanges` 已做内容哈希去重，并默认把同一文件的未读事件合并为一条（`api.getChanges(name, { merge: false })` 可得去重后的原始流；不可无损合并的组除外，见下）。直接读各设备日志的外部 agent 看到的是原始事件流，如需合并可自行按以下规则实现：

- 先按 (`ts`, `device`, `seq`) 排序并丢弃重复 (`path`,`op`,`ch`) 的 create/modify，再按 `path` 分组（`resync` 不合并，原样保留）；合并产出的 `seq`/`ts` 取组内最大，`device`/`source` 取组内最后一条
- 窗口内 create 了又 delete → 整组丢弃；结尾是 delete 且组内含 rename → `delete`，path 取首个 rename 的 `oldPath`（不带 oldPath 字段，stat 取 delete 自身）；结尾是 delete → `delete`（stat 取最后一条 delete 自身）
- 组内 delete 与 rename 交织且不属上一条 → 不合并，组内事件原样输出（任何合并都会丢某个路径的命运）
- 删了又建 → `modify`（stat 为 null）；开头是 create → `create`；含 rename → `rename`（保留首个 rename 的 oldPath）；其余 → `modify`
- 后三种的 stat：组内全部非 null 则逐项累加，否则 null；输出按合并后 seq 升序

## 命令

- `Copy unread changes for AI` — 把未读变更的紧凑摘要复制到剪贴板（读者名 `manual`），直接粘给任意 AI 对话（上限 2000 条合并事件，超出部分保持未读、下次继续）。
- `Install AI protocol for agents` / `Remove AI protocol from agent files` — 管理 AGENTS.md / CLAUDE.md 中的协议块。
- `Pause recording` / `Resume recording` — 临时暂停产生 feed 事件（基线仍持续维护，恢复后不会误报）。
- `Browse recent changes` — 最近事件浏览器（Modal，可按路径筛选）。
- `Check feed health` — 自检弹窗：各设备日志 seq 连续性、重复/逆序、状态文件一致性。

状态栏显示 file-text 图标 + `VCF`（有变更落盘后约 10 秒内右侧亮 ●）；点击可弹出上述全部命令的快捷菜单，无需打开命令面板。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| Tracked text extensions | `md, markdown, txt, canvas, json, csv` | 这些扩展名计算 diff 统计 |
| Exclude globs | 空 | 额外排除规则；`.obsidian/` 恒排除 |
| Large file threshold | 1024 KB | 超过则 stat 为 null |
| Baseline content budget | 102400 KB（100 MB） | 用于 diff 的全文内存预算；超预算文件只存哈希（stat 退化为 null） |
| Retention days / max entries | 90 / 50000 | 日志轮转，先到先截 |
| Baseline flush interval | 300 s | 基线持久化周期 |
| Auto-install AI protocol on first run | 开 | 首次启用插件时自动把协议块写入 AGENTS.md / CLAUDE.md |
| Sync AGENTS.md | 开 | 把协议块安装到 vault 根目录 AGENTS.md |
| Sync CLAUDE.md | 开 | 把协议块安装到 vault 根目录 CLAUDE.md |
| Auto-sync protocol block | 开 | 插件升级后自动刷新已安装的协议块 |

## 平台与兼容性说明

- **已验证**：macOS 桌面端与移动端（文件操作全部走官方 vault adapter）。**Windows 尚未实机冒烟**——如发现问题请反馈；代码层已覆盖 Windows 常见坑（rename 覆盖失败、排除 glob 反斜杠分隔、崩溃/同步遗留的孤儿 `.tmp` 清理）。
- **第三方同步（iCloud / Syncthing / Dropbox / OneDrive / git）**：v2 起每台设备写入**自己的日志**，多设备可并行记录、无需指定单台写者；同一物理变更被多台看到时读取侧按内容哈希去重。Obsidian 关闭期间发生的变更，由任意设备下次启动对账补记。
- **超大库**：基线按内容预算在内存保留全文（默认桌面 100MB / 移动端 20MB）。若同步很大的库，可在设置中调低预算以减少内存与同步流量。
- **读者游标**：每个 AI reader 使用独立的 `cursors/<reader>.json`（`{deviceId: lastSeq}`）——读者之间无互踩；仍为 at-least-once 语义（最坏情况某 reader 重读），事件不会丢。

## 隐私

纯本地：不联网、不上传、不收集任何数据。所有文件都在你自己的 vault 里。

## 开发

```bash
npm install
npm run build   # 类型检查 + 打包 main.js
npm test        # vitest
```

桌面端与移动端均可使用（文件操作全部走 Obsidian vault API）。

