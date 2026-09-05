import { describe, it, expect } from 'vitest';
import { analyzeFeedHealth } from '../src/core/health';
import type { ChangeEvent } from '../src/core/types';

function ev(seq: number): ChangeEvent {
  return { seq, ts: seq, op: 'modify', path: 'a.md', stat: null, source: 'live' };
}

describe('analyzeFeedHealth', () => {
  it('空日志：min/max null，其余 0', () => {
    expect(analyzeFeedHealth([], {})).toEqual({
      total: 0,
      minSeq: null,
      maxSeq: null,
      duplicateSeqs: 0,
      descendingPairs: 0,
      missingSeqs: 0,
      readers: 0,
      readersAhead: 0,
    });
  });

  it('正常连续日志无异常', () => {
    const h = analyzeFeedHealth([ev(1), ev(2), ev(3)], {});
    expect(h).toMatchObject({ total: 3, minSeq: 1, maxSeq: 3, duplicateSeqs: 0, descendingPairs: 0, missingSeqs: 0 });
  });

  it('检出重复 seq 与逆序', () => {
    const h = analyzeFeedHealth([ev(1), ev(1), ev(3), ev(2)], {});
    expect(h.duplicateSeqs).toBe(1); // 1,1
    expect(h.descendingPairs).toBe(1); // 3→2
  });

  it('检出缺失 seq（1,2,5 → 缺 3,4）', () => {
    const h = analyzeFeedHealth([ev(1), ev(2), ev(5)], {});
    expect(h.missingSeqs).toBe(2);
  });

  it('读者游标越过 maxSeq 被标记为 ahead（非数字条目忽略）', () => {
    const h = analyzeFeedHealth([ev(1), ev(2)], { ok: 1, far: 99, bad: 'x' as unknown as number });
    expect(h.readers).toBe(2);
    expect(h.readersAhead).toBe(1); // far=99 > 2
  });
});
