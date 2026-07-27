import { describe, it, expect } from 'vitest';
import { mergeEvents } from '../src/core/merge';
import { ChangeEvent } from '../src/core/types';

function ev(partial: Partial<ChangeEvent> & { seq: number }): ChangeEvent {
  return {
    ts: 1000 + partial.seq,
    op: 'modify',
    path: `f${partial.seq}.md`,
    stat: { added: 1, removed: 0 },
    source: 'live',
    ...partial,
  };
}

describe('mergeEvents', () => {
  it('纯 modify 同路径多条 → 一条，stat 累加，seq/ts 取最大', () => {
    const out = mergeEvents([
      ev({ seq: 1, path: 'a.md', ts: 100, stat: { added: 2, removed: 1 } }),
      ev({ seq: 2, path: 'a.md', ts: 300, stat: { added: 3, removed: 2 } }),
      ev({ seq: 3, path: 'a.md', ts: 200, stat: { added: 1, removed: 1 } }),
    ]);
    expect(out).toEqual([
      { seq: 3, ts: 300, op: 'modify', path: 'a.md', stat: { added: 6, removed: 4 }, source: 'live' },
    ]);
  });

  it('非相邻同路径合并，输出按合并后 max seq 排序', () => {
    const out = mergeEvents([
      ev({ seq: 1, path: 'A', stat: { added: 1, removed: 1 } }),
      ev({ seq: 2, path: 'B', stat: { added: 2, removed: 0 } }),
      ev({ seq: 3, path: 'A', stat: { added: 3, removed: 2 } }),
    ]);
    expect(out.map(e => [e.seq, e.path])).toEqual([
      [2, 'B'],
      [3, 'A'],
    ]);
    expect(out[1]).toMatchObject({ op: 'modify', stat: { added: 4, removed: 3 } });
  });

  it('create + modify → create，stat 累加', () => {
    const out = mergeEvents([
      ev({ seq: 1, path: 'n.md', op: 'create', stat: { added: 10, removed: 0 } }),
      ev({ seq: 2, path: 'n.md', op: 'modify', stat: { added: 3, removed: 2 } }),
    ]);
    expect(out).toEqual([
      { seq: 2, ts: 1002, op: 'create', path: 'n.md', stat: { added: 13, removed: 2 }, source: 'live' },
    ]);
  });

  it('modify + delete → delete，stat 为 delete 自己的 stat', () => {
    const out = mergeEvents([
      ev({ seq: 1, path: 'd.md', op: 'modify', stat: { added: 5, removed: 0 } }),
      ev({ seq: 2, path: 'd.md', op: 'delete', stat: { added: 0, removed: 10 } }),
    ]);
    expect(out).toEqual([
      { seq: 2, ts: 1002, op: 'delete', path: 'd.md', stat: { added: 0, removed: 10 }, source: 'live' },
    ]);
  });

  it('create + modify + delete → 整组丢弃（输出为空）', () => {
    const out = mergeEvents([
      ev({ seq: 1, path: 'tmp.md', op: 'create', stat: { added: 4, removed: 0 } }),
      ev({ seq: 2, path: 'tmp.md', op: 'modify', stat: { added: 1, removed: 1 } }),
      ev({ seq: 3, path: 'tmp.md', op: 'delete', stat: { added: 0, removed: 5 } }),
    ]);
    expect(out).toEqual([]);
  });

  it('delete + create → modify，stat null', () => {
    const out = mergeEvents([
      ev({ seq: 1, path: 'r.md', op: 'delete', stat: { added: 0, removed: 8 } }),
      ev({ seq: 2, path: 'r.md', op: 'create', stat: { added: 20, removed: 0 } }),
    ]);
    expect(out).toEqual([
      { seq: 2, ts: 1002, op: 'modify', path: 'r.md', stat: null, source: 'live' },
    ]);
  });

  it('rename + modify → rename，保留首个 oldPath，stat 累加', () => {
    const out = mergeEvents([
      ev({ seq: 1, path: 'new.md', op: 'rename', oldPath: 'old.md', stat: { added: 0, removed: 0 } }),
      ev({ seq: 2, path: 'new.md', op: 'modify', stat: { added: 3, removed: 1 } }),
    ]);
    expect(out).toEqual([
      { seq: 2, ts: 1002, op: 'rename', path: 'new.md', oldPath: 'old.md', stat: { added: 3, removed: 1 }, source: 'live' },
    ]);
  });

  it('链中含 stat null（如二进制）→ 合并 stat null', () => {
    const out = mergeEvents([
      ev({ seq: 1, path: 'b.md', op: 'modify', stat: { added: 1, removed: 0 } }),
      ev({ seq: 2, path: 'b.md', op: 'modify', stat: null }),
      ev({ seq: 3, path: 'b.md', op: 'modify', stat: { added: 2, removed: 2 } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].stat).toBeNull();
  });

  it('resync 原样保留且按自身 seq 参与排序', () => {
    const resync = ev({ seq: 2, op: 'resync', path: '', stat: null, source: 'system' });
    const out = mergeEvents([
      ev({ seq: 1, path: 'a.md', stat: { added: 1, removed: 0 } }),
      resync,
      ev({ seq: 3, path: 'a.md', stat: { added: 2, removed: 0 } }),
    ]);
    expect(out.map(e => e.seq)).toEqual([2, 3]);
    expect(out[0]).toEqual(resync);
    expect(out[1]).toMatchObject({ path: 'a.md', stat: { added: 3, removed: 0 } });
  });

  it('多 source 混合 → source 取组内最后一条', () => {
    const out = mergeEvents([
      ev({ seq: 1, path: 's.md', source: 'live' }),
      ev({ seq: 2, path: 's.md', source: 'reconcile' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('reconcile');
  });

  it('空输入 → 空数组', () => {
    expect(mergeEvents([])).toEqual([]);
  });

  it('纯函数：输入数组与元素不被修改', () => {
    const input = [
      ev({ seq: 1, path: 'a.md', stat: { added: 1, removed: 1 } }),
      ev({ seq: 2, path: 'a.md', stat: { added: 2, removed: 0 } }),
      ev({ seq: 3, op: 'resync', path: '', stat: null, source: 'system' }),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    mergeEvents(input);
    expect(input).toEqual(snapshot);
  });

  it('rename→delete 同组 → 一条 delete，path 为首个 rename 的 oldPath，stat 取 delete 自身，不带 oldPath', () => {
    const out = mergeEvents([
      ev({ seq: 1, path: 'B.md', op: 'rename', oldPath: 'A.md', stat: { added: 0, removed: 0 } }),
      ev({ seq: 2, path: 'B.md', op: 'delete', stat: { added: 0, removed: 7 } }),
    ]);
    expect(out).toEqual([
      { seq: 2, ts: 1002, op: 'delete', path: 'A.md', stat: { added: 0, removed: 7 }, source: 'live' },
    ]);
  });

  it('delete+rename 同组（非结尾 delete 情形）→ 不合并，原样按 seq 输出两条', () => {
    const d = ev({ seq: 1, path: 'A.md', op: 'delete', stat: { added: 0, removed: 5 } });
    const r = ev({ seq: 2, path: 'A.md', op: 'rename', oldPath: 'X.md', stat: { added: 0, removed: 0 } });
    const out = mergeEvents([d, r]);
    expect(out).toEqual([d, r]);
  });

  it('混合组：create A + modify A 组正常合并为 create；rename A→B + delete B 组输出 delete A', () => {
    const out = mergeEvents([
      ev({ seq: 1, path: 'A.md', op: 'create', stat: { added: 10, removed: 0 } }),
      ev({ seq: 2, path: 'A.md', op: 'modify', stat: { added: 3, removed: 1 } }),
      ev({ seq: 3, path: 'B.md', op: 'rename', oldPath: 'A.md', stat: { added: 0, removed: 0 } }),
      ev({ seq: 4, path: 'B.md', op: 'delete', stat: { added: 0, removed: 12 } }),
    ]);
    expect(out).toEqual([
      { seq: 2, ts: 1002, op: 'create', path: 'A.md', stat: { added: 13, removed: 1 }, source: 'live' },
      { seq: 4, ts: 1004, op: 'delete', path: 'A.md', stat: { added: 0, removed: 12 }, source: 'live' },
    ]);
  });

  it('输入未按 seq 排序 → 先按 seq 排序再合并', () => {
    const out = mergeEvents([
      ev({ seq: 6, path: 'u.md', op: 'modify', stat: { added: 2, removed: 0 } }),
      ev({ seq: 5, path: 'u.md', op: 'create', stat: { added: 9, removed: 0 } }),
    ]);
    expect(out).toEqual([
      { seq: 6, ts: 1006, op: 'create', path: 'u.md', stat: { added: 11, removed: 0 }, source: 'live' },
    ]);
  });
});
