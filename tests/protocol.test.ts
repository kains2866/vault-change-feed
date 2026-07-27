import { describe, it, expect } from 'vitest';
import { MemoryFileIO } from '../src/core/fileio';
import { appendEvents } from '../src/core/logStore';
import { getChanges, markRead, formatEvents, FeedPaths } from '../src/protocol';
import { ChangeEvent } from '../src/core/types';

const paths: FeedPaths = { log: 'changelog.jsonl', cursors: 'cursors.json' };

function ev(seq: number, op: ChangeEvent['op'] = 'modify', path = `f${seq}.md`): ChangeEvent {
  return { seq, ts: 1000 + seq, op, path, stat: { added: seq, removed: 0 }, source: 'live' };
}

describe('getChanges / markRead', () => {
  it('new reader gets everything, then only increments', async () => {
    const io = new MemoryFileIO();
    await appendEvents(io, paths.log, [ev(1), ev(2), ev(3)]);
    const first = await getChanges(io, paths, 'kimi-cli');
    expect(first.events.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(first.stale).toBe(false);
    expect(first.latestSeq).toBe(3);

    await markRead(io, paths, 'kimi-cli', first.latestSeq);
    await appendEvents(io, paths.log, [ev(4)]);
    const second = await getChanges(io, paths, 'kimi-cli');
    expect(second.events.map(e => e.seq)).toEqual([4]);
  });

  it('readers are independent', async () => {
    const io = new MemoryFileIO();
    await appendEvents(io, paths.log, [ev(1), ev(2)]);
    await markRead(io, paths, 'a', 2);
    const b = await getChanges(io, paths, 'b');
    expect(b.events).toHaveLength(2);
  });

  it('stale when rotation created a gap', async () => {
    const io = new MemoryFileIO();
    await appendEvents(io, paths.log, [ev(10), ev(11), ev(12)]);
    await markRead(io, paths, 'a', 5); // 游标落后于 minSeq-1
    const r = await getChanges(io, paths, 'a');
    expect(r.stale).toBe(true);
    expect(r.events.map(e => e.seq)).toEqual([10, 11, 12]);
  });

  it('empty log -> no events, not stale, latestSeq keeps cursor', async () => {
    const io = new MemoryFileIO();
    await markRead(io, paths, 'a', 7);
    const r = await getChanges(io, paths, 'a');
    expect(r).toEqual({ events: [], stale: false, latestSeq: 7 });
  });
});

describe('getChanges merge 选项', () => {
  const threeRaw: ChangeEvent[] = [
    { seq: 1, ts: 1, op: 'modify', path: 'a.md', stat: { added: 1, removed: 0 }, source: 'live' },
    { seq: 2, ts: 2, op: 'modify', path: 'b.md', stat: { added: 2, removed: 0 }, source: 'live' },
    { seq: 3, ts: 3, op: 'modify', path: 'a.md', stat: { added: 3, removed: 1 }, source: 'live' },
  ];

  it('默认按文件合并未读事件，latestSeq 仍基于原始日志', async () => {
    const io = new MemoryFileIO();
    await appendEvents(io, paths.log, threeRaw);
    const r = await getChanges(io, paths, 'kimi-cli');
    expect(r.events.map(e => [e.seq, e.path])).toEqual([
      [2, 'b.md'],
      [3, 'a.md'],
    ]);
    expect(r.events[1].stat).toEqual({ added: 4, removed: 1 });
    expect(r.latestSeq).toBe(3);
    expect(r.stale).toBe(false);
  });

  it('merge: false 返回原始事件流', async () => {
    const io = new MemoryFileIO();
    await appendEvents(io, paths.log, threeRaw);
    const r = await getChanges(io, paths, 'kimi-cli', { merge: false });
    expect(r.events.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(r.latestSeq).toBe(3);
  });
});

describe('formatEvents', () => {
  it('compact lines per op', () => {
    const out = formatEvents([
      { seq: 1, ts: 1, op: 'create', path: 'n.md', stat: { added: 10, removed: 0 }, source: 'live' },
      { seq: 2, ts: 2, op: 'modify', path: 'm.md', stat: { added: 3, removed: 1 }, source: 'live' },
      { seq: 3, ts: 3, op: 'delete', path: 'd.md', stat: null, source: 'live' },
      { seq: 4, ts: 4, op: 'rename', path: 'new.md', oldPath: 'old.md', stat: { added: 0, removed: 0 }, source: 'live' },
      { seq: 5, ts: 5, op: 'resync', path: '', stat: null, source: 'system' },
    ]);
    expect(out).toBe([
      'create +10/-0 n.md',
      'modify +3/-1 m.md',
      'delete d.md',
      'rename old.md → new.md',
      'resync — baseline rebuilt; full vault rescan advised',
    ].join('\n'));
  });
});
