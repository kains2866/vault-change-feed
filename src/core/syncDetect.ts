/** 云同步环境检测：根据 vault 路径与目录标记推断可能的多端同步来源（纯函数） */

export type SyncKind =
  | 'obsidian-sync'
  | 'icloud'
  | 'dropbox'
  | 'onedrive'
  | 'googledrive'
  | 'syncthing'
  | 'git';

export interface SyncSignals {
  /** 桌面端 adapter.getBasePath()；移动端可为 null */
  basePath: string | null;
  obsidianSyncEnabled: boolean;
  /** vault 根存在 .stfolder */
  hasStFolder: boolean;
  /** vault 根存在 .git */
  hasGit: boolean;
}

/** 路径关键词 → SyncKind，顺序即输出顺序（obsidian-sync 单独优先） */
const PATH_RULES: ReadonlyArray<[keyword: string, kind: SyncKind]> = [
  ['mobile documents', 'icloud'],
  ['dropbox', 'dropbox'],
  ['onedrive', 'onedrive'],
  ['google drive', 'googledrive'],
  ['googledrive', 'googledrive'],
];

/** 可多重命中；顺序：obsidian-sync 优先，其余按 PATH_RULES / flags 表序；全无 → 空数组 */
export function detectSync(signals: SyncSignals): SyncKind[] {
  const kinds: SyncKind[] = [];
  if (signals.obsidianSyncEnabled) kinds.push('obsidian-sync');
  if (signals.basePath !== null) {
    const p = signals.basePath.toLowerCase();
    for (const [keyword, kind] of PATH_RULES) {
      if (p.includes(keyword) && !kinds.includes(kind)) kinds.push(kind);
    }
  }
  if (signals.hasStFolder) kinds.push('syncthing');
  if (signals.hasGit) kinds.push('git');
  return kinds;
}
