import { describe, it, expect } from 'vitest';
import { detectSync, SyncSignals } from '../src/core/syncDetect';

const none: SyncSignals = {
  basePath: null,
  obsidianSyncEnabled: false,
  hasStFolder: false,
  hasGit: false,
};

describe('detectSync 路径启发', () => {
  it('iCloud：路径含 Mobile Documents', () => {
    expect(
      detectSync({
        ...none,
        basePath: '/Users/x/Library/Mobile Documents/iCloud~md~obsidian/Documents/vault',
      }),
    ).toEqual(['icloud']);
  });

  it('路径匹配大小写不敏感', () => {
    expect(detectSync({ ...none, basePath: '/users/x/library/mobile documents/vault' })).toEqual([
      'icloud',
    ]);
    expect(detectSync({ ...none, basePath: 'C:\\Users\\x\\DROPBOX\\vault' })).toEqual(['dropbox']);
  });

  it('Dropbox / OneDrive', () => {
    expect(detectSync({ ...none, basePath: '/Users/x/Dropbox/vault' })).toEqual(['dropbox']);
    expect(detectSync({ ...none, basePath: 'C:\\Users\\x\\OneDrive\\vault' })).toEqual([
      'onedrive',
    ]);
  });

  it('Google Drive：两种写法都命中', () => {
    expect(detectSync({ ...none, basePath: '/Users/x/Google Drive/vault' })).toEqual([
      'googledrive',
    ]);
    expect(detectSync({ ...none, basePath: '/Volumes/GoogleDrive/vault' })).toEqual([
      'googledrive',
    ]);
  });
});

describe('detectSync flags', () => {
  it('obsidianSyncEnabled → obsidian-sync', () => {
    expect(detectSync({ ...none, obsidianSyncEnabled: true })).toEqual(['obsidian-sync']);
  });

  it('hasStFolder → syncthing；hasGit → git', () => {
    expect(detectSync({ ...none, hasStFolder: true })).toEqual(['syncthing']);
    expect(detectSync({ ...none, hasGit: true })).toEqual(['git']);
  });
});

describe('detectSync 组合与兜底', () => {
  it('多重命中：obsidian-sync 优先，其余按固定顺序', () => {
    expect(
      detectSync({
        basePath: '/Users/x/Dropbox/vault',
        obsidianSyncEnabled: true,
        hasStFolder: true,
        hasGit: true,
      }),
    ).toEqual(['obsidian-sync', 'dropbox', 'syncthing', 'git']);
  });

  it('icloud + onedrive 同时命中时按表序（icloud 在前）', () => {
    // 人为构造同时含两个关键词的路径，验证顺序而非现实场景
    expect(
      detectSync({ ...none, basePath: '/Mobile Documents/OneDrive/vault' }),
    ).toEqual(['icloud', 'onedrive']);
  });

  it('全无 → 空数组', () => {
    expect(detectSync(none)).toEqual([]);
  });

  it('basePath 为 null（移动端）时只看 flags', () => {
    expect(detectSync({ ...none, basePath: null, hasGit: true })).toEqual(['git']);
    expect(detectSync({ ...none, basePath: null })).toEqual([]);
  });
});
