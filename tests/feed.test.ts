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
});
