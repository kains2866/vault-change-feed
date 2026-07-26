import { describe, it, expect } from 'vitest';
import {
  Baseline,
  makeTextEntry,
  makeBinaryEntry,
  serializeBaseline,
  parseBaseline,
  countLines,
} from '../src/core/baseline';
import { hashContent, binaryHash } from '../src/core/hash';

describe('hashContent', () => {
  it('deterministic and differs on content change', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
    expect(hashContent('')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('countLines', () => {
  it('edge cases', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(2);
    expect(countLines('a\nb\nc')).toBe(3);
  });
});

describe('baseline serialize/parse', () => {
  it('roundtrip with text and binary entries', () => {
    const b: Baseline = new Map([
      ['笔记/a.md', makeTextEntry('你好\n世界')],
      ['附件/pic.png', makeBinaryEntry(12345, 1785000000000)],
    ]);
    const restored = parseBaseline(serializeBaseline(b));
    expect(restored).toEqual(b);
    expect(restored.get('附件/pic.png')!.content).toBeNull();
    expect(restored.get('附件/pic.png')!.hash).toBe(binaryHash(12345, 1785000000000));
  });

  it('throws on corrupt data', () => {
    expect(() => parseBaseline(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});
