export interface VaultChangeFeedSettings {
  /** 逗号分隔的文本扩展名（小写、不带点） */
  trackedExtensions: string;
  /** 换行分隔的额外排除 glob */
  excludeGlobs: string;
  /** 超过该大小的文本文件跳过 diff（KB） */
  largeFileKb: number;
  retentionDays: number;
  retentionMaxEntries: number;
  /** 基线持久化周期（秒） */
  flushIntervalSec: number;
  /** 把协议块安装到 vault 根目录 AGENTS.md */
  syncAgentsMd: boolean;
  /** 把协议块安装到 vault 根目录 CLAUDE.md */
  syncClaudeMd: boolean;
  /** GEMINI.md 是否写入协议块（Gemini CLI 的发现点） */
  syncGeminiMd: boolean;
  /** 插件版本变化后自动刷新已安装的协议块 */
  autoSyncProtocol: boolean;
  /** 首次启用插件时自动把协议块写入 AGENTS.md / CLAUDE.md */
  autoInstallProtocol: boolean;
}

export const DEFAULT_SETTINGS: VaultChangeFeedSettings = {
  trackedExtensions: 'md, markdown, txt, canvas, json, csv',
  excludeGlobs: '',
  largeFileKb: 1024,
  retentionDays: 90,
  retentionMaxEntries: 50000,
  flushIntervalSec: 300,
  syncAgentsMd: true,
  syncClaudeMd: true,
  syncGeminiMd: true,
  autoSyncProtocol: true,
  autoInstallProtocol: true,
};

export function parseExtensions(s: string): string[] {
  return s
    .split(',')
    .map(x => x.trim().toLowerCase().replace(/^\./, ''))
    .filter(x => x.length > 0);
}

export function parseGlobs(s: string): string[] {
  return s
    .split('\n')
    .map(x => x.trim())
    .filter(x => x.length > 0);
}
