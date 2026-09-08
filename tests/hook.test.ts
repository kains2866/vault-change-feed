import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../extras/vault-feed-hook.mjs', import.meta.url));

function safeKey(id: string): string {
  const k = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return k.length > 0 ? k : 'device';
}

interface Fixture {
  root: string;
  feedDir: string;
}

/** 造一个 v2 布局的临时 vault：devices.json + events/<id>.jsonl + cursors/ */
function makeVault(configDir: string, byDevice: Record<string, Array<Record<string, unknown>>>): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'vcf-hook-'));
  const feedDir = join(root, configDir, 'plugins', 'vault-change-feed');
  mkdirSync(join(feedDir, 'events'), { recursive: true });
  mkdirSync(join(feedDir, 'cursors'), { recursive: true });
  const devices = Object.keys(byDevice).map((id, i) => ({ id, firstSeen: i + 1 }));
  writeFileSync(join(feedDir, 'devices.json'), JSON.stringify({ formatVersion: 1, devices }));
  for (const [dev, events] of Object.entries(byDevice)) {
    writeFileSync(
      join(feedDir, 'events', `${safeKey(dev)}.jsonl`),
      events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''),
    );
  }
  return { root, feedDir };
}

function cleanup(f: Fixture): void {
  rmSync(f.root, { recursive: true, force: true });
}

function runHook(cwd: string, reader: string, extra: string[] = []): { status: number | null; stdout: string } {
  const res = spawnSync(process.execPath, [HOOK, `--reader=${reader}`, '--format=kimi', ...extra], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
  return { status: res.status, stdout: String(res.stdout ?? '') };
}

function readCursor(f: Fixture, reader: string): Record<string, number> {
  const p = join(f.feedDir, 'cursors', `${safeKey(reader)}.json`);
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

const DEV = 'dev-1';
function ev(seq: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq,
    ts: 1000 + seq,
    op: 'modify',
    path: `f${seq}.md`,
    stat: { added: 1, removed: 0 },
    source: 'live',
    device: DEV,
    ...over,
  };
}

describe('vault-feed-hook 位置发现', () => {
  it('默认 .obsidian：注入未读并推进（按设备）游标', () => {
    const f = makeVault('.obsidian', {
      [DEV]: [ev(1, { op: 'create', stat: { added: 3, removed: 0 }, path: 'a.md' }), ev(2, { path: 'a.md' }), ev(3, { op: 'delete', stat: null, path: 'old/b.md' })],
    });
    try {
      const { status, stdout } = runHook(f.root, 'agent-a');
      expect(status).toBe(0);
      const msg = (JSON.parse(stdout) as { message: string }).message;
      expect(msg).toContain('3 change event(s)');
      expect(msg).toContain('delete old/b.md');
      expect(readCursor(f, 'agent-a')).toEqual({ [DEV]: 3 });
    } finally {
      cleanup(f);
    }
  });

  it('自定义 configDir 且从子目录上溯命中', () => {
    const f = makeVault('.my-conf', { [DEV]: [ev(1)] });
    try {
      const sub = join(f.root, 'Notes');
      mkdirSync(sub, { recursive: true });
      const { status, stdout } = runHook(sub, 'agent-b');
      expect(status).toBe(0);
      expect(readCursor(f, 'agent-b')).toEqual({ [DEV]: 1 });
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

describe('vault-feed-hook v2 语义', () => {
  it('游标已到最新：静默退出，不改游标文件', () => {
    const f = makeVault('.obsidian', { [DEV]: [ev(1)] });
    writeFileSync(join(f.feedDir, 'cursors', `${safeKey('agent-e')}.json`), JSON.stringify({ [DEV]: 1 }));
    try {
      const { status, stdout } = runHook(f.root, 'agent-e');
      expect(status).toBe(0);
      expect(stdout).toBe('');
      expect(readCursor(f, 'agent-e')).toEqual({ [DEV]: 1 });
    } finally {
      cleanup(f);
    }
  });

  it('多设备并行：各自日志独立 seq，只推进有未读的设备游标', () => {
    const dA = 'dev-a';
    const dB = 'dev-b';
    const f = makeVault('.obsidian', {
      [dA]: [ev(1, { device: dA, path: 'a.md' }), ev(2, { device: dA, path: 'a.md' })],
      [dB]: [ev(1, { device: dB, path: 'b.md' })],
    });
    writeFileSync(join(f.feedDir, 'cursors', `${safeKey('agent-f')}.json`), JSON.stringify({ [dA]: 2 }));
    try {
      const { status } = runHook(f.root, 'agent-f');
      expect(status).toBe(0);
      expect(readCursor(f, 'agent-f')).toEqual({ [dA]: 2, [dB]: 1 });
    } finally {
      cleanup(f);
    }
  });

  it('同内容 ch 去重：两设备同一次修改只注入一条', () => {
    const dA = 'dev-a';
    const dB = 'dev-b';
    const f = makeVault('.obsidian', {
      [dA]: [ev(1, { device: dA, path: 'same.md', ch: 'abc123', ts: 500 })],
      [dB]: [ev(1, { device: dB, path: 'same.md', ch: 'abc123', ts: 500, source: 'reconcile' })],
    });
    try {
      const { status, stdout } = runHook(f.root, 'agent-g');
      expect(status).toBe(0);
      const msg = (JSON.parse(stdout) as { message: string }).message;
      const lines = msg.split('\n').filter(l => l.startsWith('modify'));
      expect(lines).toHaveLength(1);
    } finally {
      cleanup(f);
    }
  });

  it('--max-events 部分消费：只推进已注入设备的游标并提示剩余', () => {
    const many = Array.from({ length: 250 }, (_, i) => ev(i + 1, { path: `g${i + 1}.md` }));
    const f = makeVault('.obsidian', { [DEV]: many });
    try {
      const first = runHook(f.root, 'agent-h', ['--max-events=10']);
      expect(first.status).toBe(0);
      const msg = (JSON.parse(first.stdout) as { message: string }).message;
      expect(msg).toContain('240 more change event(s) remain unread');
      expect(readCursor(f, 'agent-h')).toEqual({ [DEV]: 10 });
    } finally {
      cleanup(f);
    }
  });

  it('窗口内建了又删（合并为空）也推进到该设备 maxSeq，不死循环', () => {
    const windowed = [
      ev(1, { op: 'create', stat: { added: 1, removed: 0 }, path: 'tmp.md' }),
      ev(2, { op: 'delete', stat: null, path: 'tmp.md' }),
    ];
    const f = makeVault('.obsidian', { [DEV]: windowed });
    try {
      const { status } = runHook(f.root, 'agent-i');
      expect(status).toBe(0);
      expect(readCursor(f, 'agent-i')).toEqual({ [DEV]: 2 });
    } finally {
      cleanup(f);
    }
  });
});

