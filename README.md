# Vault Change Feed

**Give your AI agents a changelog of your vault.** Every manual edit you make is recorded — so an AI can see what changed since its last visit, without rescanning your whole vault.

[![GitHub release](https://img.shields.io/github/v/release/kains2866/vault-change-feed)](https://github.com/kains2866/vault-change-feed/releases)
[![License: MIT](https://img.shields.io/github/license/kains2866/vault-change-feed)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/kains2866/vault-change-feed/total)](https://github.com/kains2866/vault-change-feed/releases)

[中文文档](https://github.com/kains2866/vault-change-feed/blob/main/README.zh-CN.md) · [Obsidian Community Listing](https://community.obsidian.md/plugins/vault-change-feed)

## Support / 支持

如果这个插件帮你省了时间，可以请我喝杯咖啡 ☕ — [Buy Me a Coffee](https://buymeacoffee.com/kains3772d) · 国内 [爱发电](https://ifdian.net/a/kains2866)

---

## What it does

- **Every edit is recorded** — create / modify / delete / rename, with line counts, on your phone and desktop alike
- **Made for multi-device vaults** — each device keeps its own log, so phone and computer can edit the same vault at the same time without conflicts
- **Clean history** — the same edit recorded by two devices is shown only once
- **Built for AI agents** — each agent has its own cursor and reads only what's new, so AI work costs less context
- **Zero setup for agents** — the read protocol is auto-installed into `AGENTS.md` / `CLAUDE.md` on first run
- **Human-friendly tools** — status-bar activity light, quick menu, recent-changes browser, pause, health check
- **Fully local** — no network, no telemetry. Everything stays in your vault.

## Installation

**Community market (recommended)**: Settings → Community plugins → Browse → search **Vault Change Feed** → Install → Enable.

**BRAT**: add `kains2866/vault-change-feed`.

**Manual**: copy `main.js`, `manifest.json` (and `styles.css`) from the [latest release](https://github.com/kains2866/vault-change-feed/releases/latest) into `<vault>/.obsidian/plugins/vault-change-feed/`, then enable.

## Quick use

- Status bar shows `VCF` (light glows after changes). Click it for quick actions: recent changes, health check, pause/resume, copy unread for an AI.
- Commands: `Copy unread changes for AI` · `Browse recent changes` · `Check feed health` · `Pause/Resume recording` · install/remove the AI protocol.
- Settings are short: what to track, exclusion rules, size/retention limits, and whether to install the AI protocol.

## For AI agents

The plugin installs a short reading protocol into your vault's `AGENTS.md` / `CLAUDE.md` on first enable. Agents follow it to fetch only their unread changes (each agent keeps its own cursor; a content-hash de-duplicates the same edit recorded by two devices). An optional SessionStart hook (`extras/vault-feed-hook.mjs`) injects those changes automatically. Data files live under `<configDir>/plugins/vault-change-feed/` (`events/`, `cursors/`, …).

## Compatibility notes

- Works on desktop and mobile; all file I/O goes through Obsidian's official API.
- Cloud-synced vaults (iCloud / Syncthing / Dropbox / OneDrive / git) are safe to use on several devices at once.
- Windows isn't smoke-tested yet — please report any issue you hit.
- v2 data layout is not compatible with 1.x; old logs are migrated automatically with a backup on first run after upgrading.

## Privacy

Fully local: no network calls, no uploads, no data collection.

## Development

```bash
npm install
npm run build
npm test
```

## License

[MIT](LICENSE) © tiyukains
