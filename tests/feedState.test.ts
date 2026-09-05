import { describe, it, expect } from 'vitest';
import { MemoryFileIO } from '../src/core/fileio';
import {
  buildFeedState,
  writeFeedState,
  parseFeedState,
  FEED_STATE_FORMAT_VERSION,
} from '../src/core/feedState';

describe('feedState', () => {
  it('buildFeedState 补全 formatVersion 与 updatedAt', () => {
    const s = buildFeedState({ minSeq: 5, maxSeq: 12, count: 8 });
    expect(s.formatVersion).toBe(FEED_STATE_FORMAT_VERSION);
    expect(s.minSeq).toBe(5);
    expect(s.maxSeq).toBe(12);
    expect(s.count).toBe(8);
    expect(typeof s.updatedAt).toBe('number');
  });

  it('write/parse 往返一致（含空日志 null 边界）', async () => {
    const io = new MemoryFileIO();
    const state = buildFeedState({ minSeq: null, maxSeq: null, count: 0 });
    await writeFeedState(io, 'feed-state.json', state);
    const parsed = parseFeedState((await io.read('feed-state.json')) as string);
    expect(parsed).toEqual(state);
  });

  it('parse 拒绝损坏/版本不符数据 → null', () => {
    expect(parseFeedState('not json')).toBeNull();
    expect(parseFeedState(JSON.stringify({ formatVersion: 99, minSeq: 1, maxSeq: 2, count: 1, updatedAt: 1 }))).toBeNull();
    expect(parseFeedState(JSON.stringify({ formatVersion: 1, minSeq: 'x', maxSeq: 2, count: 1, updatedAt: 1 }))).toBeNull();
    expect(parseFeedState(JSON.stringify({ formatVersion: 1, minSeq: 1, maxSeq: 2, count: NaN, updatedAt: 1 }))).toBeNull();
    expect(parseFeedState('null')).toBeNull();
    expect(parseFeedState('[1]')).toBeNull();
  });
});
