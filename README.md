# Vault Change Feed

Records every change in your Obsidian vault as a machine-readable event feed, with an independent read cursor per reader (AI agent). Before an AI manages your notes, it reads the feed once and knows exactly what you changed since its last visit — no full-vault rescan needed.

[中文文档](README.zh-CN.md)

## The problem

Your AI assistant has no idea what you edited between sessions. Scanning the whole vault every time is expensive; not scanning means it works from stale knowledge. This plugin continuously records *which file changed, how (create/modify/delete/rename), and by how many lines* — the AI pulls that incrementally, on demand.

## How it works

- **Live**: listens to Obsidian's create / modify / delete / rename events and computes line-level diff stats
- **On startup**: reconciles against the last baseline snapshot to backfill changes made while Obsidian was closed (phone, iCloud sync, CLI tools). A delete+create pair with identical content hash is reported as a rename (hash-based pairing; binary files re-downloaded by iCloud get a fresh mtime and may degrade to delete+create)
- **All data stays local**, under `.obsidian/plugins/vault-change-feed/`:
  - `changelog.jsonl` — the event stream, one JSON event per line
  - `cursors.json` — per-reader read cursors
  - `baseline.gz` — content baseline snapshot (for diffs and reconciliation)

Note: enable the plugin in only **one Obsidian instance per vault at a time** (concurrent writers cause seq conflicts and file overwrites).

## Event format

```json
{"seq": 1284, "ts": 1785000000000, "op": "modify", "path": "ML/overfitting.md", "stat": {"added": 12, "removed": 3}, "source": "live"}
```

- `op`: `create` / `modify` / `delete` / `rename` (carries `oldPath`) / `resync` (baseline rebuilt — full rescan advised)
- `stat`: `{added, removed}` line counts; `null` means "changed, magnitude unknown — open the file" (binaries, oversized files)
- `source`: `live` / `reconcile` (startup backfill) / `system`

## Letting AI agents discover the feed

AI agents don't know the feed exists out of the box. On first enable, the plugin **automatically** installs a reading-protocol block (wrapped in `<!-- vault-change-feed:start/end -->` markers) into the vault-root `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` — the conventional discovery points for coding agents (AGENTS.md is the cross-tool standard; CLAUDE.md for Claude Code; GEMINI.md for Gemini CLI, which doesn't read AGENTS.md by default). Zero clicks needed.

- **Opt-out**: disable `Auto-install AI protocol on first run` to fall back to a one-time notice; the `Install AI protocol for agents` / `Remove AI protocol from agent files` commands remain available
- **Idempotent**: re-runs update only the marked block; your own content outside the markers is preserved verbatim
- **Refreshes with the plugin**: after updates, installed blocks are refreshed automatically — but auto-sync only touches files that already have a block, it never creates new ones (can be disabled)
- **Clean removal**: the remove command strips the block from all three files, deleting a file only if nothing else remains
- **Per-file toggles**: Sync AGENTS.md / Sync CLAUDE.md / Sync GEMINI.md
- AIs without filesystem access (plain web chats) use the `Copy unread changes for AI` command instead

### Optional: SessionStart hook (enforced, not "please read")

The protocol block relies on the AI choosing to read it. `extras/vault-feed-hook.mjs` goes further: hooked into an agent's SessionStart event, it injects merged unread changes into the context automatically and advances the cursor. The script walks up from the session cwd to find a tracked vault, and stays completely silent outside a vault or when nothing is unread.

Kimi Code (`~/.kimi-code/config.toml`):

```toml
[[hooks]]
event = "SessionStart"
command = "node /path/to/extras/vault-feed-hook.mjs --reader=kimi-code --format=kimi"
timeout = 10
```

Claude Code (`hooks.SessionStart` in `~/.claude/settings.json`):

```json
{ "type": "command", "command": "node /path/to/extras/vault-feed-hook.mjs --reader=claude-code --format=claude", "timeout": 10 }
```

`--reader` is the agent's stable cursor name. Use an absolute `node` path.

## Protocol for AI agents (this README is the interface doc)

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
// ...handle events...
await api.markRead('my-plugin', latestSeq);
```

The JS API's `getChanges` merges unread events per file by default (`api.getChanges(name, { merge: false })` returns the raw stream; groups that can't be merged losslessly are passed through, see below). External agents reading `changelog.jsonl` directly see the raw event stream and may implement the same merging:

- Sort by `seq` first (the log may be out of order), then group by `path` (`resync` is never merged); merged events take the group's max `seq`/`ts` and the last event's `source`
- Created and deleted within the window → group dropped; last event is `delete` and the group contains a rename → `delete` on the first rename's `oldPath` (no `oldPath` field, stat from the delete itself); last event is `delete` → `delete` (stat from the last delete)
- Deletes and renames interleaved beyond the case above → not merged, group emitted as-is (any merge would lose some path's fate)
- Deleted then re-created → `modify` (stat `null`); starts with create → `create`; contains a rename → `rename` (keeps the first rename's `oldPath`); otherwise → `modify`
- For the last three, `stat` is the per-line sum if all entries are non-null, else `null`; output sorted by merged seq

## Commands

- `Copy unread changes for AI` — copies a compact summary of unread changes (reader `manual`) to the clipboard, ready to paste into any AI chat.

## Settings

| Setting | Default | Description |
|---|---|---|
| Tracked text extensions | `md, markdown, txt, canvas, json, csv` | These extensions get diff stats |
| Exclude globs | empty | Extra exclusion rules; `.obsidian/` is always excluded |
| Large file threshold | 1024 KB | Larger files get `stat: null` |
| Retention days / max entries | 90 / 50000 | Log rotation, whichever limit hits first |
| Baseline flush interval | 300 s | Baseline persistence period |
| Auto-install AI protocol on first run | on | Install the protocol block on first enable |
| Sync AGENTS.md / CLAUDE.md / GEMINI.md | on | Per-file install targets |
| Auto-sync protocol block | on | Refresh installed blocks after plugin updates |

## Privacy

Fully local: no network calls, no uploads, no data collection. Everything lives in your own vault.

## Development

```bash
npm install
npm run build   # typecheck + bundle main.js
npm test        # vitest
```

Desktop only (`isDesktopOnly: true`, uses Node fs).
