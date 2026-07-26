import { describe, it, expect } from 'vitest';
import { reconcile, FileSnapshot } from '../src/core/reconcile';
import { Baseline, makeTextEntry, makeBinaryEntry } from '../src/core/baseline';
import { hashContent, binaryHash } from '../src/core/hash';

function textSnap(path: string, content: string, mtime = 1000): FileSnapshot {
  return { path, hash: hashContent(content), content, mtime };
}

function binSnap(path: string, size: number, mtime: number): FileSnapshot {
  return { path, hash: binaryHash(size, mtime), content: null, mtime };
}

describe('reconcile', () => {
  it('no changes -> no events, baseline replaced', () => {
    const old: Baseline = new Map([['a.md', makeTextEntry('x\ny')]]);
    const { events, baseline } = reconcile(old, [textSnap('a.md', 'x\ny')], 10, 9999);
    expect(events).toEqual([]);
    expect([...baseline.keys()]).toEqual(['a.md']);
  });

  it('create text file with line count stat', () => {
    const { events } = reconcile(new Map(), [textSnap('n.md', 'a\nb\nc', 2000)], 1, 9999);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1, op: 'create', path: 'n.md', ts: 2000,
      stat: { added: 3, removed: 0 }, source: 'reconcile',
    });
  });

  it('delete reports removed line count from old content', () => {
    const old: Baseline = new Map([['d.md', makeTextEntry('a\nb')]]);
    const { events } = reconcile(old, [], 1, 7777);
    expect(events[0]).toMatchObject({
      op: 'delete', path: 'd.md', ts: 7777,
      stat: { added: 0, removed: 2 },
    });
  });

  it('modify with precise diff stat when both contents available', () => {
    const old: Baseline = new Map([['m.md', makeTextEntry('a\nb\nc')]]);
    const { events } = reconcile(old, [textSnap('m.md', 'a\nX\nc\nd')], 1, 9999);
    expect(events[0]).toMatchObject({ op: 'modify', stat: { added: 2, removed: 1 } });
  });

  it('binary modify has null stat', () => {
    const old: Baseline = new Map([['p.png', makeBinaryEntry(100, 1000)]]);
    const { events } = reconcile(old, [binSnap('p.png', 200, 3000)], 1, 9999);
    expect(events[0]).toMatchObject({ op: 'modify', path: 'p.png', ts: 3000, stat: null });
  });

  it('delete+create with same hash pairs into rename', () => {
    const old: Baseline = new Map([['old.md', makeTextEntry('same content')]]);
    const { events, baseline } = reconcile(old, [textSnap('new.md', 'same content', 5000)], 1, 9999);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: 'rename', path: 'new.md', oldPath: 'old.md', ts: 5000,
      stat: { added: 0, removed: 0 },
    });
    expect(baseline.has('new.md')).toBe(true);
    expect(baseline.has('old.md')).toBe(false);
  });

  it('mixed operations sorted by ts then path, seq from startSeq', () => {
    const old: Baseline = new Map([
      ['del.md', makeTextEntry('gone')],
      ['mod.md', makeTextEntry('v1')],
    ]);
    const current = [
      textSnap('mod.md', 'v2', 3000),
      textSnap('new.md', 'hi', 1000),
    ];
    const { events } = reconcile(old, current, 42, 9000);
    expect(events.map(e => [e.seq, e.op])).toEqual([
      [42, 'create'],   // ts 1000
      [43, 'modify'],   // ts 3000
      [44, 'delete'],   // ts 9000 (scanTs)
    ]);
  });
});
