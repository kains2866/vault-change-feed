/** 轻量 i18n：跟随 Obsidian 界面语言（main.ts 在 onload 时 setLocale 一次） */

export type Locale = 'en' | 'zh';

let current: Locale = 'en';

/** 从 moment.locale() 等语言码推断 Locale（zh-cn/zh-tw → zh，其余 → en） */
export function detectLocale(lang: string): Locale {
  return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function setLocale(locale: Locale): void {
  current = locale;
}

const strings = {
  // 命令
  cmdCopyUnread: { en: 'Copy unread changes for AI', zh: '复制未读变更给 AI' },
  cmdInstallProtocol: { en: 'Install AI protocol for agents', zh: '为 AI agent 安装读取协议' },
  cmdRemoveProtocol: { en: 'Remove AI protocol from agent files', zh: '从 agent 文件中移除读取协议' },
  // Notice
  noticeBaselineCorrupted: {
    en: 'vault-change-feed: baseline corrupted, rebuilding',
    zh: 'vault-change-feed：基线已损坏，正在重建',
  },
  noticeAutoInstalled: {
    en: 'vault-change-feed: AI protocol auto-installed into {files} (manage in settings or commands)',
    zh: 'vault-change-feed：AI 协议已自动安装到 {files}（可在设置或命令中管理）',
  },
  noticeAutoInstallFailed: {
    en: 'vault-change-feed: protocol auto-install failed, see console',
    zh: 'vault-change-feed：协议自动安装失败，详情见控制台',
  },
  noticeFirstRunGuide: {
    en: 'vault-change-feed: run command "Install AI protocol for agents" to let AI agents discover the change feed',
    zh: 'vault-change-feed：运行命令「为 AI agent 安装读取协议」，让 AI 发现变更日志',
  },
  noticeInstalled: {
    en: 'vault-change-feed: AI protocol installed into {files}',
    zh: 'vault-change-feed：AI 协议已安装到 {files}',
  },
  noticeUpToDate: {
    en: 'vault-change-feed: protocol block already up to date',
    zh: 'vault-change-feed：协议块已是最新',
  },
  noticeNoTarget: {
    en: 'vault-change-feed: no target enabled (all protocol targets off in settings)',
    zh: 'vault-change-feed：没有启用的目标文件（设置中已全部关闭）',
  },
  noticeProtocolFailed: {
    en: 'vault-change-feed: protocol command failed, see console',
    zh: 'vault-change-feed：协议命令执行失败，详情见控制台',
  },
  noticeRemoved: {
    en: 'vault-change-feed: AI protocol removed from {files}',
    zh: 'vault-change-feed：AI 协议已从 {files} 移除',
  },
  noticeNoBlockFound: {
    en: 'vault-change-feed: no AI protocol block found in AGENTS.md / CLAUDE.md / GEMINI.md',
    zh: 'vault-change-feed：AGENTS.md / CLAUDE.md / GEMINI.md 中未找到协议块',
  },
  noticeFlushFailed: {
    en: 'vault-change-feed: failed to write changelog, will retry',
    zh: 'vault-change-feed：变更日志写入失败，稍后重试',
  },
  noticeCopied: {
    en: 'vault-change-feed: {count} change(s) copied',
    zh: 'vault-change-feed：已复制 {count} 条变更',
  },
  noticeStandby: {
    en: 'vault-change-feed: another Obsidian instance is recording changes; this instance is standing by',
    zh: 'vault-change-feed：另一个 Obsidian 实例正在记录变更，本实例待机中',
  },
  noticeSyncDetected: {
    en: 'vault-change-feed: cloud sync detected ({kinds}) — avoid multiple Obsidian instances on this vault; standby protection is on',
    zh: 'vault-change-feed：检测到云同步（{kinds}）——请避免多实例同时启用本插件，待机保护已开启',
  },
  fileDeleted: { en: '{path} (file deleted)', zh: '{path}（文件已删除）' },
  // 设置页
  sTrackedExtsName: { en: 'Tracked text extensions', zh: '跟踪的文本扩展名' },
  sTrackedExtsDesc: {
    en: 'Comma-separated, without dots. Changes to these files get diff stats.',
    zh: '逗号分隔、不带点。这些文件的变更会计算增删行数。',
  },
  sExcludeGlobsName: { en: 'Exclude globs', zh: '排除规则（glob）' },
  sExcludeGlobsDesc: {
    en: 'One per line. The vault config folder is always excluded.',
    zh: '每行一条。仓库配置目录恒被排除。',
  },
  sLargeFileName: { en: 'Large file threshold (KB)', zh: '大文件阈值（KB）' },
  sLargeFileDesc: {
    en: 'Text files larger than this skip diff stats.',
    zh: '超过该大小的文本文件跳过增删行数统计。',
  },
  sBudgetName: { en: 'Baseline content budget (KB)', zh: '基线内容预算（KB）' },
  sBudgetDesc: {
    en: 'Text kept in memory for diffing. Files beyond the budget store hash only (stat falls back to null).',
    zh: '用于 diff 的全文内存预算。超出预算的文件只存哈希（增删行数退化为 null）。',
  },
  sRetentionDaysName: { en: 'Retention days', zh: '日志保留天数' },
  sRetentionDaysDesc: {
    en: 'Log entries older than this are truncated.',
    zh: '早于该天数的事件将被截断。',
  },
  sRetentionMaxName: { en: 'Retention max entries', zh: '日志保留条数' },
  sRetentionMaxDesc: {
    en: 'Log is truncated to this many entries when exceeded — whichever limit hits first.',
    zh: '条数超出将被截断——与保留天数先到先截。',
  },
  sFlushIntervalName: { en: 'Baseline flush interval (s)', zh: '基线持久化周期（秒）' },
  sFlushIntervalDesc: {
    en: 'How often the baseline snapshot is persisted. Takes effect after reload.',
    zh: '基线快照的落盘周期。重载插件后生效。',
  },
  sAutoInstallName: { en: 'Auto-install AI protocol on first run', zh: '首次运行时自动安装 AI 协议' },
  sAutoInstallDesc: {
    en: 'Write the protocol block into AGENTS.md / CLAUDE.md / GEMINI.md automatically when the plugin is first enabled.',
    zh: '首次启用插件时自动把协议块写入 AGENTS.md / CLAUDE.md / GEMINI.md。',
  },
  sSyncAgentsName: { en: 'Sync AGENTS.md', zh: '同步 AGENTS.md' },
  sSyncAgentsDesc: {
    en: 'Install protocol block into AGENTS.md (read by most AI agents)',
    zh: '把协议块安装到 AGENTS.md（多数 AI agent 读取）',
  },
  sSyncClaudeName: { en: 'Sync CLAUDE.md', zh: '同步 CLAUDE.md' },
  sSyncClaudeDesc: {
    en: 'Install protocol block into CLAUDE.md (read by Claude Code)',
    zh: '把协议块安装到 CLAUDE.md（Claude Code 读取）',
  },
  sSyncGeminiName: { en: 'Sync GEMINI.md', zh: '同步 GEMINI.md' },
  sSyncGeminiDesc: {
    en: 'Install protocol block into GEMINI.md (read by Gemini CLI)',
    zh: '把协议块安装到 GEMINI.md（Gemini CLI 读取）',
  },
  sAutoSyncName: { en: 'Auto-sync protocol block', zh: '自动同步协议块' },
  sAutoSyncDesc: {
    en: 'Refresh the installed protocol block after plugin updates',
    zh: '插件升级后自动刷新已安装的协议块',
  },
} as const;

export type StringKey = keyof typeof strings;

/** 取当前语言的文案；vars 替换 {placeholder} */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
  let s: string = strings[key][current];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
