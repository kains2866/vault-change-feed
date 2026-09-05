import { describe, it, expect } from 'vitest';
import { EventFeed } from '../src/core/feed';

describe('EventFeed', () => {
  it('assigns seq from lastSeq+1 and queues', () => {
    const feed = new EventFeed(100);
    const e1 = feed.push('modify', 'a.md', { stat: { added: 1, removed: 0 } });
    const e2 = feed.push('create', 'b.md');
    expect(e1.seq).toBe(101);
    expect(e2.seq).toBe(102);
    expect(e1.source).toBe('live');
    expect(e1.stat).toEqual({ added: 1, removed: 0 });
    expect(e2.stat).toBeNull();
    expect(feed.pending).toBe(2);
  });

  it('rename carries oldPath', () => {
    const feed = new EventFeed(0);
    const e = feed.push('rename', 'new.md', { oldPath: 'old.md' });
    expect(e.oldPath).toBe('old.md');
  });

  it('drain returns and clears queue', () => {
    const feed = new EventFeed(0);
    feed.push('create', 'a.md');
    expect(feed.drain()).toHaveLength(1);
    expect(feed.pending).toBe(0);
    expect(feed.drain()).toEqual([]);
  });

  it('pushLoaded adopts external events and advances nextSeq', () => {
    const feed = new EventFeed(1);
    feed.pushLoaded({ seq: 50, ts: 1, op: 'create', path: 'x.md', stat: null, source: 'reconcile' });
    expect(feed.peekNextSeq()).toBe(51);
    expect(feed.pending).toBe(1);
  });

  it('超过队列上限：清空缓冲并注入 resync 通知读者，随后继续正常接收', () => {
    const feed = new EventFeed(0, 3);
    feed.push('create', 'a.md');
    feed.push('create', 'b.md');
    feed.push('create', 'c.md'); // 达到上限
    feed.push('create', 'd.md'); // 触发溢出：丢 a/b/c，注入 resync，再收 d
    feed.push('create', 'e.md');
    const drained = feed.drain();
    expect(drained[0].op).toBe('resync');
    expect(drained[0].source).toBe('system');
    expect(drained.slice(1).map(e => e.path)).toEqual(['d.md', 'e.md']);
    expect(feed.pending).toBe(0);
  });

  it('drain 后溢出标记复位，可再次缓冲', () => {
    const feed = new EventFeed(0, 2);
    feed.push('create', 'a.md');
    feed.push('create', 'b.md');
    feed.push('create', 'c.md'); // 溢出
    feed.drain();
    feed.push('create', 'x.md');
    feed.push('create', 'y.md');
    feed.push('create', 'z.md'); // 再次溢出 → 再次 resync
    const drained = feed.drain();
    expect(drained[0].op).toBe('resync');
  });
});
