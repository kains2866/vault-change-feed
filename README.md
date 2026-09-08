# Vault Change Feed

**Give your AI agents a changelog of your vault.** Every edit you make is recorded as a machine-readable event feed with per-reader cursors — so any AI can catch up on what changed since its last visit, instead of blindly rescanning thousands of notes.

[![GitHub release](https://img.shields.io/github/v/release/kains2866/vault-change-feed)](https://github.com/kains2866/vault-change-feed/releases)
[![License: MIT](https://img.shields.io/github/license/kains2866/vault-change-feed)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/kains2866/vault-change-feed/total)](https://github.com/kains2866/vault-change-feed/releases)

[中文文档](https://github.com/kains2866/vault-change-feed/blob/main/README.zh-CN.md) · [Obsidian Community Listing](https://community.obsidian.md/plugins/vault-change-feed)

## Support / 支持

If this plugin saves you time, you can buy me a coffee — it keeps the development going.
如果这个插件帮你省了时间，可以请我喝杯咖啡 ☕

- **International**: <a href="https://buymeacoffee.com/kains3772d"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="48"></a>
- **中国大陆**: [爱发电](https://ifdian.net/a/kains2866)（微信 / 支付宝直达 · WeChat / Alipay）

---

## Features

- **Live change tracking** — create / modify / delete / rename events with line-level diff stats (`+added / −removed`)
- **Offline backfill** — startup reconciliation catches edits made while Obsidian was closed (phone, iCloud sync, CLI tools); content-hash rename detection included
- **Incremental AI reads** — each reader (AI agent) keeps its own cursor and pulls only what's new; per-file merge on read collapses edit bursts into one cumulative line
- **Self-describing to agents** — a reading-protocol block is auto-installed into `AGENTS.md` / `CLAUDE.md` on first run, so coding agents discover the feed with zero setup
- **Rotation + stale signal** — the log is capped (90 days / 50k entries by default); readers are told explicitly when they must do a full rescan
- **Fully local** — no network, no telemetry, works on desktop and mobile

## The problem

Your AI assistant has no idea what you edited between sessions. Scanning the whole vault every time is expensive; not scanning means it works from stale knowledge. This plugin continuously records *which file changed, how, and by how much* — the AI pulls that incrementally, on demand.

## Installation

**Community market (recommended):** Settings → Community plugins → Browse → search **Vault Change Feed** → Install → Enable. The AI protocol block installs itself on first run.

**BRAT:** add `kains2866/vault-change-feed` as a beta plugin.

**Manual:** copy `main.js` and `manifest.json` from the [latest release](https://github.com/kains2866/vault-change-feed/releases/latest) into `<vault>/.obsidian/plugins/vault-change-feed/`, then enable the plugin.

## How it works

- **Per-device logs (v2)**: every device that runs the plugin appends to its OWN event log with an independent per-device `seq` — devices can edit the same vault in parallel with no sequence conflicts. A single physical change observed by more than one device is de-duplicated at read time by content hash (`ch`).
- **Live**: listens to Obsidian's create / modify / delete / rename events on this device and computes line-level diff stats
- **On startup**: reconciles against this device's last baseline snapshot to backfill changes made while Obsidian was closed (other devices' edits included). A delete+create pair with identical content hash is reported as a rename
- **All data stays local**, under `<configDir>/plugins/vault-change-feed/`:
  - `devices.json` — which devices have written logs
  - `events/<deviceId>.jsonl` — per-device event streams (each with its own `seq`)
  - `state/<deviceId>.json` — tiny per-device status endpoint (`{minSeq, maxSeq, count, updatedAt}`) for quick "anything new?" checks
  - `cursors/<reader>.json` — per-reader read cursors (`{deviceId: lastSeq}`)
  - `baseline-<deviceId>.gz` — per-device content baselines (diffs and reconciliation)

The writer lock (`writer.lock`) only serializes multiple Obsidian instances on the SAME device; across synced devices nothing blocks parallel writing — each device owns its own files.

## Event format

```json
{"device": "8f3a-…", "seq": 1284, "ts": 1785000000000, "op": "modify", "path": "ML/overfitting.md", "ch": "0a9b8c7d…", "stat": {"added": 12, "removed": 3}, "source": "live"}
```

- `device` + `seq`: sequence numbers are unique per device only — identify an event by `(device, seq)`
- `op`: `create` / `modify` / `delete` / `rename` (carries `oldPath`) / `resync` (baseline rebuilt — full rescan advised)
- `ch`: content hash of the file after a `create`/`modify` (16 hex chars for text files; absent on legacy rows) — readers use `(path, op, ch)` to de-duplicate the same change seen by several devices
- `stat`: `{added, removed}` line counts; `null` means "changed, magnitude unknown — open the file" (binaries, oversized files)
- `source`: `live` / `reconcile` (startup backfill) / `system`

## Letting AI agents discover the feed

AI agents don't know the feed exists out of the box. On first enable, the plugin **automatically** installs a reading-protocol block (wrapped in `<!-- vault-change-feed:start/end -->` markers) into the vault-root `AGENTS.md` and `CLAUDE.md` — the conventional discovery points for coding agents (AGENTS.md is the cross-tool standard, now also read by Gemini CLI; CLAUDE.md for Claude Code). Zero clicks needed.

- **Opt-out**: disable `Auto-install AI protocol on first run` to fall back to a one-time notice; the `Install AI protocol for agents` / `Remove AI protocol from agent files` commands remain available
- **Idempotent**: re-runs update only the marked block; your own content outside the markers is preserved verbatim
- **Refreshes with the plugin**: after updates, installed blocks are refreshed automatically — but auto-sync only touches files that already have a block, it never creates new ones (can be disabled)
- **Clean removal**: the remove command strips the block from all three files, deleting a file only if nothing else remains
- **Per-file toggles**: Sync AGENTS.md / Sync CLAUDE.md
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

Optional `--max-events=N` (default 200) caps how many merged events are injected per session start. If more changes are pending, only the first N are injected, the cursor advances only to the injected ones (partial consumption), and a hint reports the remainder — rerunning the hook (next session) consumes them. This prevents a long gap from blowing the context window and silently losing changes to a hook timeout.

## Protocol for AI agents (this README is the interface doc)

This vault is tracked by the **vault-change-feed** Obsidian plugin (v2, per-device logs). Before editing notes, catch up on what the user changed since your last visit:

1. Read `.obsidian/plugins/vault-change-feed/cursors/<reader>.json` — your cursor file `{deviceId: lastSeq}`. Use ONE stable reader id forever (e.g. your agent id like `"claude-code"`); a missing file means cursor 0 for every device. Only ever write YOUR file.
2. Read `.obsidian/plugins/vault-change-feed/devices.json` → `devices[].id` lists every known writing device.
3. For each device, read `.obsidian/plugins/vault-change-feed/events/<deviceId>.jsonl` (one JSON event per line) and take events with `seq` greater than that device's cursor.
   - If that device's cursor is `> 0` and its smallest `seq` is greater than `cursor + 1`, that log was rotated and you missed events — stop and do a full vault rescan instead.
   - An event with `op: "resync"` means the baseline was rebuilt — do a full rescan.
   - `stat: null` means "changed, magnitude unknown — open the file if you care".
4. Merge into one timeline: sort by (`ts`, `device`, `seq`), then de-duplicate — for `create`/`modify` events carrying a content hash `ch`, keep only the FIRST event per (`path`, `op`, `ch`): the same physical edit may be recorded by two devices.
5. After processing, write your cursor file as `{deviceId: largestSeqYouReadForThatDevice}`. Write atomically: write `<file>.tmp` first, then rename it over the file. Never write a cursor larger than the largest `seq` you actually read for that device.

Inside Obsidian, other plugins/scripts can use the JS API instead of files:

```js
const api = app.plugins.plugins['vault-change-feed'].api;
const { events, stale, perDevice } = await api.getChanges('my-plugin');
// ...handle events...
await api.markRead('my-plugin', perDevice);
```

The JS API's `getChanges` already de-duplicates by content hash and merges unread events per file by default (`api.getChanges(name, { merge: false })` returns the de-duplicated raw stream; groups that can't be merged losslessly are passed through, see below). External agents reading the raw device logs may implement the same merging:

- Sort by (`ts`, `device`, `seq`), drop duplicate (`path`, `op`, `ch`) create/modify events, then group by `path` (`resync` is never merged); merged events take the group's max `seq`/`ts` and the last event's `device`/`source`
- Created and deleted within the window → group dropped; last event is `delete` and the group contains a rename → `delete` on the first rename's `oldPath` (no `oldPath` field, stat from the delete itself); last event is `delete` → `delete` (stat from the last delete)
- Deletes and renames interleaved beyond the case above → not merged, group emitted as-is (any merge would lose some path's fate)
- Deleted then re-created → `modify` (stat `null`); starts with create → `create`; contains a rename → `rename` (keeps the first rename's `oldPath`); otherwise → `modify`
- For the last three, `stat` is the per-line sum if all entries are non-null, else `null`; output sorted by merged seq

## Commands

- `Copy unread changes for AI` — copies a compact summary of unread changes (reader `manual`) to the clipboard, ready to paste into any AI chat (capped at 2000 merged events; the rest stay unread and are picked up on the next run)
- `Install AI protocol for agents` / `Remove AI protocol from agent files` — manage the discovery blocks in `AGENTS.md` / `CLAUDE.md`
- `Pause recording` / `Resume recording` — temporarily stop producing feed events (the baseline is still kept up to date, so nothing is misreported later)
- `Browse recent changes` — modal browser over the most recent events, filterable by file path
- `Check feed health` — self-diagnostic (per-device seq continuity, duplicates, out-of-order, state consistency) with a report modal

The status bar shows a file-text icon + `VCF` (with a light that glows ● for ~10 s after user changes are recorded). Click it for a quick menu with all of the above commands — no command palette needed.

## Settings

| Setting | Default | Description |
|---|---|---|
| Tracked text extensions | `md, markdown, txt, canvas, json, csv` | These extensions get diff stats |
| Exclude globs | empty | Extra exclusion rules; the vault config folder is always excluded |
| Large file threshold | 1024 KB | Larger files get `stat: null` |
| Baseline content budget | 102400 KB (100 MB) | Text kept in memory for diffing; beyond the budget, files store hash only (`stat` falls back to `null`) |
| Retention days / max entries | 90 / 50000 | Log rotation, whichever limit hits first |
| Baseline flush interval | 300 s | Baseline persistence period |
| Auto-install AI protocol on first run | on | Install the protocol block on first enable |
| Sync AGENTS.md / Sync CLAUDE.md | on | Per-file install targets |
| Auto-sync protocol block | on | Refresh installed blocks after plugin updates |

## Platform & compatibility notes

- **Tested**: macOS desktop and mobile (file operations go through the official vault adapter). **Windows** is not yet smoke-tested — please report any issue; code hardening already covers the usual Windows pitfalls (rename-overwrite failures, backslash separators in exclude globs, orphaned `.tmp` leftovers from crashes/sync).
- **Third-party sync (iCloud / Syncthing / Dropbox / OneDrive / git)**: since v2 every device appends to its OWN log, so multiple devices may write in parallel — no shared sequence, no single-writer election needed. The same physical edit seen by two devices is de-duplicated at read time by content hash. When Obsidian is closed, startup reconciliation on any device backfills changes it missed.
- **Heavy vaults**: the baseline keeps text in memory up to the content budget (default 100 MB desktop / 20 MB mobile). If you sync a very large vault, lower the budget in settings to cut memory and sync traffic.
- **Reader cursors**: each AI reader has its own `cursors/<reader>.json` (`{deviceId: lastSeq}`) — no contention between readers; at-least-once semantics still apply (worst case a reader re-reads), events are never lost.

## Privacy

Fully local: no network calls, no uploads, no data collection. Everything lives in your own vault.

## Development

```bash
npm install
npm run build   # typecheck + bundle main.js
npm test        # vitest
```

Works on desktop and mobile (all file operations go through the Obsidian vault API).


## License

[MIT](LICENSE) © tiyukains
