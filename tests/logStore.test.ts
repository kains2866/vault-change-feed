import { describe, it, expect } from 'vitest';
import { MemoryFileIO } from '../src/core/fileio';
import { appendEvents, readLog, parseLog, isStale, rotateIfNeeded } from '../src/core/logStore';
import { ChangeEvent } from '../src/core/types';

function ev(seq: number, ts = 1000): ChangeEvent {
  return { seq, ts, op: 'modify', path: `f${seq}.md`, stat: { added: 1, removed: 0 }, source: 'live' };
}

describe('appendEvents + readLog', () => {
  it('creates file then appends, preserving order', async () => {
    const io = new MemoryFileIO();
    await appendEvents(io, 'log.jsonl', [ev(1), ev(2)]);
    await appendEvents(io, 'log.jsonl', [ev(3)]);
    const r = await readLog(io, 'log.jsonl');
    expect(r.events.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(r.minSeq).toBe(1);
    expect(r.maxSeq).toBe(3);
  });

  it('readLog on missing file returns empty', async () => {
    const r = await readLog(new MemoryFileIO(), 'nope.jsonl');
    expect(r).toEqual({ events: [], minSeq: null, maxSeq: null });
  });

  it('appendEvents with empty array is a no-op', async () => {
    const io = new MemoryFileIO();
    await appendEvents(io, 'log.jsonl', []);
    expect(await io.exists('log.jsonl')).toBe(false);
  });
});

describe('parseLog', () => {
  it('skips corrupt lines and blank lines', () => {
    const good = JSON.stringify(ev(5));
    const r = parseLog(`${good}\n{bad json\n\n${JSON.stringify(ev(6))}\n`);
    expect(r.events.map(e => e.seq)).toEqual([5, 6]);
  });
});

describe('isStale', () => {
  it('new reader (cursor 0) is never stale', () => {
    expect(isStale(10, 0)).toBe(false);
  });
  it('contiguous log (minSeq == cursor+1) is not stale', () => {
    expect(isStale(101, 100)).toBe(false);
  });
  it('gap after rotation is stale', () => {
    expect(isStale(105, 100)).toBe(true);
  });
  it('empty log is not stale', () => {
    expect(isStale(null, 100)).toBe(false);
  });
});

describe('rotateIfNeeded', () => {
  it('truncates by maxEntries, keeping newest', async () => {
    const io = new MemoryFileIO();
    await appendEvents(io, 'log.jsonl', [ev(1), ev(2), ev(3), ev(4), ev(5)]);
    const rotated = await rotateIfNeeded(io, 'log.jsonl', 3, 90, 2000);
    expect(rotated).toBe(true);
    const r = await readLog(io, 'log.jsonl');
    expect(r.events.map(e => e.seq)).toEqual([3, 4, 5]);
  });

  it('truncates by age', async () => {
    const io = new MemoryFileIO();
    await appendEvents(io, 'log.jsonl', [ev(1, 1000), ev(2, 5000)]);
    const dayMs = 86400000;
    const rotated = await rotateIfNeeded(io, 'log.jsonl', 100, 1, 1000 + dayMs + 1);
    expect(rotated).toBe(true);
    const r = await readLog(io, 'log.jsonl');
    expect(r.events.map(e => e.seq)).toEqual([2]);
  });

  it('no-op when within limits', async () => {
    const io = new MemoryFileIO();
    await appendEvents(io, 'log.jsonl', [ev(1), ev(2)]);
    expect(await rotateIfNeeded(io, 'log.jsonl', 100, 90, 2000)).toBe(false);
  });
});
