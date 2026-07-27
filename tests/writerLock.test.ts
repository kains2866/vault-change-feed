import { describe, it, expect } from 'vitest';
import { decideLock, parseLock, LOCK_STALE_MS } from '../src/core/writerLock';

describe('decideLock', () => {
  const now = 1_800_000_000_000;

  it('无锁 → take', () => {
    expect(decideLock(null, 'me', now)).toBe('take');
  });

  it('锁是我的 → take（无论新旧）', () => {
    expect(decideLock({ deviceId: 'me', ts: now - 1000 }, 'me', now)).toBe('take');
    expect(decideLock({ deviceId: 'me', ts: 0 }, 'me', now)).toBe('take');
  });

  it('别人的锁但已过期 → take', () => {
    expect(decideLock({ deviceId: 'other', ts: now - LOCK_STALE_MS - 1 }, 'me', now)).toBe('take');
  });

  it('别人的锁且新鲜 → standby', () => {
    expect(decideLock({ deviceId: 'other', ts: now }, 'me', now)).toBe('standby');
    expect(decideLock({ deviceId: 'other', ts: now - 1000 }, 'me', now)).toBe('standby');
  });

  it('stale 边界：now - ts 恰好等于 staleMs 仍 standby，超过才 take', () => {
    expect(decideLock({ deviceId: 'other', ts: now - LOCK_STALE_MS }, 'me', now)).toBe('standby');
    expect(decideLock({ deviceId: 'other', ts: now - 5000 }, 'me', now, 5000)).toBe('standby');
    expect(decideLock({ deviceId: 'other', ts: now - 5001 }, 'me', now, 5000)).toBe('take');
  });
});

describe('parseLock', () => {
  it('合法 JSON → WriterLock', () => {
    expect(parseLock(JSON.stringify({ deviceId: 'abc', ts: 123 }))).toEqual({
      deviceId: 'abc',
      ts: 123,
    });
  });

  it('坏 JSON → null', () => {
    expect(parseLock('not json {')).toBeNull();
    expect(parseLock('')).toBeNull();
    expect(parseLock('undefined')).toBeNull();
  });

  it('缺字段或字段类型错 → null', () => {
    expect(parseLock('{}')).toBeNull();
    expect(parseLock(JSON.stringify({ deviceId: 'abc' }))).toBeNull();
    expect(parseLock(JSON.stringify({ ts: 123 }))).toBeNull();
    expect(parseLock(JSON.stringify({ deviceId: 1, ts: 123 }))).toBeNull();
    expect(parseLock(JSON.stringify({ deviceId: 'abc', ts: '123' }))).toBeNull();
  });

  it('非对象 JSON → null', () => {
    expect(parseLock('null')).toBeNull();
    expect(parseLock('[1,2]')).toBeNull();
    expect(parseLock('"str"')).toBeNull();
  });
});
