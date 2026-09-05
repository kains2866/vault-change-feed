import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../extras/vault-feed-hook.mjs', import.meta.url));

interface Fixture {
  root: string;
  feedDir: string;
  logPath: string;
  cursorsPath: string;
}

/** 造一个带 feed 的临时 vault（configDir 可自定义，如 '.obsidian' / 'my-conf'） */
function makeVault(configDir: string, events: Array<Record<string, unknown>>): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'vcf-hook-'));
  const feedDir = join(root, configDir, 'plugins', 'vault-change-feed');
  mkdirSync(feedDir, { recursive: true });
  const logPath = join(feedDir, 'changelog.jsonl');
  const cursorsPath = join(feedDir, 'cursors.json');
  writeFileSync(logPath, events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  writeFileSync(cursorsPath, JSON.stringify({}));
  return { root, feedDir, logPath, cursorsPath };
}

function cleanup(f: Fixture): void {
  rmSync(f.root, { recursive: true, force: true });
}

function runHook(cwd: string, reader: string): { status: number | null; stdout: string } {
  const res = spawnSync(process.execPath, [HOOK, `--reader=${reader}`, '--format=kimi'], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
  return { status: res.status, stdout: String(res.stdout ?? '') };
}

function readCursors(path: string): Record<string, number> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const SAMPLE = [
  { seq: 1, ts: 1000, op: 'create', path: 'a.md', stat: { added: 3, removed: 0 }, source: 'live' },
  { seq: 2, ts: 1001, op: 'modify', path: 'a.md', stat: { added: 1, removed: 1 }, source: 'live' },
  { seq: 3, ts: 1002, op: 'delete', path: 'old/b.md', stat: null, source: 'live' },
];

describe('vault-feed-hook 位置发现', () => {
  it('默认配置目录 .obsidian：注入未读并推进游标', () => {
    const f = makeVault('.obsidian', SAMPLE);
    try {
      const { status, stdout } = runHook(f.root, 'agent-a');
      expect(status).toBe(0);
      const msg = (JSON.parse(stdout) as { message: string }).message;
      expect(msg).toContain('3 change event(s)');
      // 同文件 create+modify 会合并为一条累计 create
      expect(msg).toContain('create +4/-1 a.md');
      expect(msg).toContain('delete old/b.md');
      expect(readCursors(f.cursorsPath)['agent-a']).toBe(3);
    } finally {
      cleanup(f);
    }
  });

  it('自定义 configDir（非 .obsidian）：同样注入并推进游标', () => {
    const f = makeVault('my-conf', SAMPLE);
    try {
      const { status, stdout } = runHook(f.root, 'agent-b');
      expect(status).toBe(0);
      const msg = (JSON.parse(stdout) as { message: string }).message;
      expect(msg).toContain('3 change event(s)');
      expect(readCursors(f.cursorsPath)['agent-b']).toBe(3);
    } finally {
      cleanup(f);
    }
  });

  it('自定义 configDir 且从 vault 子目录向上查找也能命中', () => {
    const f = makeVault('.config-vault', SAMPLE);
    try {
      const sub = join(f.root, 'Notes', 'Deep');
      mkdirSync(sub, { recursive: true });
      const { status, stdout } = runHook(sub, 'agent-c');
      expect(status).toBe(0);
      expect((JSON.parse(stdout) as { message: string }).message).toContain('3 change event(s)');
      expect(readCursors(f.cursorsPath)['agent-c']).toBe(3);
    } finally {
      cleanup(f);
    }
  });

  it('不在受跟踪 vault 内：静默退出（无输出）', () => {
    const outside = mkdtempSync(join(tmpdir(), 'vcf-outside-'));
    try {
      const { status, stdout } = runHook(outside, 'agent-d');
      expect(status).toBe(0);
      expect(stdout).toBe('');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('vault-feed-hook 游标语义', () => {
  it('游标已到最新：静默退出，不改游标文件', () => {
    const f = makeVault('.obsidian', SAMPLE);
    writeFileSync(f.cursorsPath, JSON.stringify({ 'agent-e': 3 }));
    try {
      const { status, stdout } = runHook(f.root, 'agent-e');
      expect(status).toBe(0);
      expect(stdout).toBe('');
      expect(readCursors(f.cursorsPath)).toEqual({ 'agent-e': 3 });
    } finally {
      cleanup(f);
    }
  });

  it('推进自己的游标且保留其他 reader 的条目', () => {
    const f = makeVault('.obsidian', SAMPLE);
    writeFileSync(f.cursorsPath, JSON.stringify({ other: 1 }));
    try {
      const { status } = runHook(f.root, 'agent-f');
      expect(status).toBe(0);
      expect(readCursors(f.cursorsPath)).toEqual({ other: 1, 'agent-f': 3 });
    } finally {
      cleanup(f);
    }
  });

  it('feed 文件缺失（仅安装目录存在与否）：不在 vault 判定不误报', () => {
    const root = mkdtempSync(join(tmpdir(), 'vcf-empty-'));
    // 空目录下即使存在插件外观目录（无 changelog）也不应命中——用未安装场景验证静默
    mkdirSync(join(root, '.obsidian', 'plugins'), { recursive: true });
    try {
      const { status, stdout } = runHook(root, 'agent-g');
      expect(status).toBe(0);
      expect(stdout).toBe('');
      expect(existsSync(join(root, '.obsidian', 'plugins', 'vault-change-feed', 'cursors.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
