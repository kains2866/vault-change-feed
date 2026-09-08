import { describe, it, expect } from 'vitest';
import { MemoryFileIO } from '../src/core/fileio';
import { appendEvents } from '../src/core/logStore';
import { getChanges, markRead, formatEvents } from '../src/protocol';
import { eventsFile, registerDevice } from '../src/core/v2store';
import { ChangeEvent } from '../src/core/types';

const DEV = 'dev-1';
const BASE = '';

function ev(seq: number, op: ChangeEvent['op'] = 'modify', path = `f${seq}.md`): ChangeEvent {
  return { seq, ts: 1000 + seq, op, path, stat: { added: seq, removed: 0 }, source: 'live', device: DEV };
}

async function seed(io: MemoryFileIO, rows: ChangeEvent[]): Promise<void> {
  await registerDevice(io, BASE, DEV, 1);
  await appendEvents(io, eventsFile(BASE, DEV), rows);
}

describe('getChanges / markRead (v2 分设备)', () => {
  it('new reader gets everything, then only increments', async () => {
    const io = new MemoryFileIO();
    await seed(io, [ev(1), ev(2), ev(3)]);
    const first = await getChanges(io, BASE, 'kimi-cli');
    expect(first.events.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(first.stale).toBe(false);
    expect(first.latestSeq).toBe(3);
    expect(first.perDevice).toEqual({ [DEV]: 3 });

    await markRead(io, BASE, 'kimi-cli', first.perDevice);
    await seed(io, [ev(4)]);
    const second = await getChanges(io, BASE, 'kimi-cli');
    expect(second.events.map(e => e.seq)).toEqual([4]);
  });

  it('readers are independent（每 reader 独立游标文件）', async () => {
    const io = new MemoryFileIO();
    await seed(io, [ev(1), ev(2)]);
    await markRead(io, BASE, 'a', { [DEV]: 2 });
    const b = await getChanges(io, BASE, 'b');
    expect(b.events).toHaveLength(2);
  });

  it('stale when rotation created a gap（该设备游标落后于 minSeq-1）', async () => {
    const io = new MemoryFileIO();
    await seed(io, [ev(10), ev(11), ev(12)]);
    await markRead(io, BASE, 'a', { [DEV]: 5 });
    const r = await getChanges(io, BASE, 'a');
    expect(r.stale).toBe(true);
    expect(r.events.map(e => e.seq)).toEqual([10, 11, 12]);
  });

  it('empty devices -> no events, not stale', async () => {
    const io = new MemoryFileIO();
    const r = await getChanges(io, BASE, 'a');
    expect(r).toEqual({ events: [], stale: false, perDevice: {}, latestSeq: 0 });
  });
});

describe('跨设备合并与 ch 去重', () => {
  const mk = (seq: number, dev: string, path: string, ts = 1000 + seq): ChangeEvent => ({
    seq,
    ts,
    op: 'modify',
    path,
    stat: { added: 1, removed: 0 },
    source: 'live',
    device: dev,
  });

  it('两台设备各自记录，游标按设备独立推进', async () => {
    const io = new MemoryFileIO();
    const dA = 'dev-a';
    const dB = 'dev-b';
    await registerDevice(io, BASE, dA, 1);
    await registerDevice(io, BASE, dB, 2);
    await appendEvents(io, eventsFile(BASE, dA), [
      mk(1, dA, 'x.md'),
      mk(2, dA, 'y.md'),
    ]);
    await appendEvents(io, eventsFile(BASE, dB), [
      mk(1, dB, 'z.md'),
    ]);
    const r = await getChanges(io, BASE, 'kimi-cli');
    // 排序键 (ts, device, seq)：dev-a 先于 dev-b
    expect(r.events.map(e => e.path)).toEqual(['x.md', 'z.md', 'y.md']);
    // A 全读 1..2；B 全读 1
    await markRead(io, BASE, 'kimi-cli', r.perDevice);
    await appendEvents(io, eventsFile(BASE, dB), [mk(2, dB, 'w.md')]);
    const next = await getChanges(io, BASE, 'kimi-cli');
    expect(next.events.map(e => e.path)).toEqual(['w.md']);
    expect(next.events[0].device).toBe(dB);
  });

  it('同一次物理修改被两台记录 → (path,op,ch) 去重只保留最早', async () => {
    const io = new MemoryFileIO();
    const dA = 'dev-a';
    const dB = 'dev-b';
    await registerDevice(io, BASE, dA, 1);
    await registerDevice(io, BASE, dB, 2);
    const a = mk(1, dA, 'same.md', 500);
    a.ch = 'abc123';
    await appendEvents(io, eventsFile(BASE, dA), [a]);
    // 设备 B 稍后观察到同一变更（reconcile）——ch 相同 → 应被去重
    await appendEvents(io, eventsFile(BASE, dB), [
      { ...a, device: dB, source: 'reconcile' },
    ]);
    const r = await getChanges(io, BASE, 'kimi-cli');
    expect(r.events).toHaveLength(1);
    expect(r.events[0].device).toBe(dA); // 保留最早
  });
});

describe('getChanges merge 选项', () => {
  const threeRaw: ChangeEvent[] = [
    { seq: 1, ts: 1, op: 'modify', path: 'a.md', stat: { added: 1, removed: 0 }, source: 'live', device: DEV },
    { seq: 2, ts: 2, op: 'modify', path: 'b.md', stat: { added: 2, removed: 0 }, source: 'live', device: DEV },
    { seq: 3, ts: 3, op: 'modify', path: 'a.md', stat: { added: 3, removed: 1 }, source: 'live', device: DEV },
  ];

  it('默认按文件合并未读事件', async () => {
    const io = new MemoryFileIO();
    await seed(io, threeRaw);
    const r = await getChanges(io, BASE, 'kimi-cli');
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
    await seed(io, threeRaw);
    const r = await getChanges(io, BASE, 'kimi-cli', { merge: false });
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

