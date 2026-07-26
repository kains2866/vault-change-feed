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
}

export const DEFAULT_SETTINGS: VaultChangeFeedSettings = {
  trackedExtensions: 'md, markdown, txt, canvas, json, csv',
  excludeGlobs: '',
  largeFileKb: 1024,
  retentionDays: 90,
  retentionMaxEntries: 50000,
  flushIntervalSec: 300,
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
