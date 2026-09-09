# Vault Change Feed

**给你的 AI agent 一本仓库变更日志。** 你的每一次手动修改都会被记录——AI 只要看"你改了什么"，不用每次全量扫描整个库。

[![GitHub release](https://img.shields.io/github/v/release/kains2866/vault-change-feed)](https://github.com/kains2866/vault-change-feed/releases)
[![License: MIT](https://img.shields.io/github/license/kains2866/vault-change-feed)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/kains2866/vault-change-feed/total)](https://github.com/kains2866/vault-change-feed/releases)

[English README](https://github.com/kains2866/vault-change-feed/blob/main/README.md) · [Obsidian 社区插件页](https://community.obsidian.md/plugins/vault-change-feed)

## Support / 支持

如果这个插件帮你省了时间，可以请我喝杯咖啡 ☕ — 国内 [爱发电](https://ifdian.net/a/kains2866)（微信/支付宝）· [Buy Me a Coffee](https://buymeacoffee.com/kains3772d)

---

## 它能做什么

- **每次修改都被记录** — 增删改/重命名/删除，带行数，手机和电脑都能记
- **为多设备而生** — 每台设备各自一份日志，手机和电脑可同时编辑同一个库，互不冲突
- **历史干净** — 同一修改被两台设备各记一次时，只显示一条
- **面向 AI** — 每个 AI 有自己的游标，只读自己没看过的新变更，省上下文
- **AI 零配置接入** — 首次启用自动把读取协议写进 `AGENTS.md` / `CLAUDE.md`
- **人也好用** — 状态栏活动灯、快捷菜单、最近变更浏览、暂停、健康检查
- **纯本地** — 不联网、无遥测，一切都在你的库内

## 安装

**社区市场（推荐）**：设置 → 第三方插件 → 浏览 → 搜索 **Vault Change Feed** → 安装 → 启用。

**BRAT**：添加 `kains2866/vault-change-feed`。

**手动**：从[最新 release](https://github.com/kains2866/vault-change-feed/releases/latest) 复制 `main.js`、`manifest.json`（及 `styles.css`）到 `<vault>/.obsidian/plugins/vault-change-feed/`，然后启用。

## 快速上手

- 状态栏显示 `VCF`（有变更时右侧亮 ●）。点击即可用快捷菜单：最近变更、健康检查、暂停/恢复、复制给 AI。
- 命令：`Copy unread changes for AI` · `Browse recent changes` · `Check feed health` · `Pause/Resume recording` · 安装/移除 AI 协议。
- 设置很精简：跟踪哪些扩展名、排除规则、大小与保留限制、是否安装 AI 协议。

## 给 AI agent 的说明

首次启用时插件会往库根目录的 `AGENTS.md` / `CLAUDE.md` 写入一段简短读取协议。Agent 照它读取自己未读的变更即可（每个 agent 独立游标；同一修改被两台设备记录时按内容哈希去重）。可选 SessionStart hook（`extras/vault-feed-hook.mjs`）会在会话启动时自动注入这些变更。数据文件位于 `<configDir>/plugins/vault-change-feed/`（`events/`、`cursors/` 等）。

## 兼容性说明

- 桌面与移动端均可用；文件操作全部走 Obsidian 官方 API。
- 云同步库（iCloud / Syncthing / Dropbox / OneDrive / git）可放心多设备同时使用。
- Windows 尚未实机冒烟——遇到问题请反馈。
- v2 数据布局与 1.x 不兼容；升级后首次运行会自动迁移旧日志并保留备份。

## 隐私

纯本地：不联网、不上传、不收集任何数据。

## 开发

```bash
npm install
npm run build
npm test
```

## License

[MIT](LICENSE) © tiyukains
