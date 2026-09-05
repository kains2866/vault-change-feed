import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mergeEvents as mergeTs } from '../src/core/merge';
import type { ChangeEvent } from '../src/core/types';

const RUNTIME_FILE = fileURLToPath(new URL('../extras/merge-runtime.mjs', import.meta.url));

/** 关键语义场景：TS 单源与构建产物应输出完全一致 */
const SCENARIOS: ChangeEvent[][] = [
  // 窗口内建了又删 → 丢弃
  [
    { seq: 1, ts: 1, op: 'create', path: 'a.md', stat: { added: 2, removed: 0 }, source: 'live' },
    { seq: 2, ts: 2, op: 'delete', path: 'a.md', stat: null, source: 'live' },
  ],
  // create + modify 合并累加 stat
  [
    { seq: 1, ts: 1, op: 'create', path: 'b.md', stat: { added: 2, removed: 0 }, source: 'live' },
    { seq: 2, ts: 2, op: 'modify', path: 'b.md', stat: { added: 1, removed: 1 }, source: 'live' },
  ],
  // 含 rename 后 delete → delete，path 取 rename 的 oldPath
  [
    { seq: 1, ts: 1, op: 'rename', path: 'n.md', oldPath: 'o.md', stat: { added: 0, removed: 0 }, source: 'live' },
    { seq: 2, ts: 2, op: 'delete', path: 'n.md', stat: null, source: 'live' },
  ],
  // delete 与 rename 交织 → 拒合并原样输出
  [
    { seq: 1, ts: 1, op: 'delete', path: 'x.md', stat: null, source: 'live' },
    { seq: 2, ts: 2, op: 'rename', path: 'x.md', oldPath: 'y.md', stat: { added: 0, removed: 0 }, source: 'live' },
  ],
  // 乱序输入按 seq 排序
  [
    { seq: 3, ts: 3, op: 'modify', path: 'm.md', stat: { added: 1, removed: 0 }, source: 'live' },
    { seq: 1, ts: 1, op: 'create', path: 'm.md', stat: { added: 1, removed: 0 }, source: 'live' },
  ],
  // resync 不合并原样保留
  [
    { seq: 1, ts: 1, op: 'resync', path: '', stat: null, source: 'system' },
    { seq: 2, ts: 2, op: 'modify', path: 'm.md', stat: { added: 1, removed: 0 }, source: 'live' },
  ],
];

describe('merge 单源产物一致性', () => {
  it('extras/merge-runtime.mjs 与 src/core/merge.ts 输出一致', async () => {
    if (!existsSync(RUNTIME_FILE)) return; // 未执行构建：跳过产物断言
    const runtimeMod = (await import(RUNTIME_FILE)) as {
      mergeEvents: (events: ChangeEvent[]) => ChangeEvent[];
    };
    for (const events of SCENARIOS) {
      expect(runtimeMod.mergeEvents(events)).toEqual(mergeTs(events));
    }
  });

  it('产物可用（基本合并生效）', async () => {
    if (!existsSync(RUNTIME_FILE)) return;
    const runtimeMod = (await import(RUNTIME_FILE)) as {
      mergeEvents: (events: ChangeEvent[]) => ChangeEvent[];
    };
    const out = runtimeMod.mergeEvents(SCENARIOS[1]);
    expect(out).toHaveLength(1);
    expect(out[0].op).toBe('create');
    expect(out[0].stat).toEqual({ added: 3, removed: 1 });
  });
});
