import { gzipSync, strToU8 } from 'fflate';
import { describe, it, expect } from 'vitest';
import {
  Baseline,
  makeTextEntry,
  makeTextEntryBudgeted,
  makeBinaryEntry,
  entryContentBytes,
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

  it('throws on semantically invalid entries', () => {
    const gz = (v: unknown) => gzipSync(strToU8(JSON.stringify(v)));
    expect(() => parseBaseline(gz(['not', 'a', 'map']))).toThrow();
    expect(() => parseBaseline(gz({ 'a.md': { hash: 123, content: null } }))).toThrow();
    expect(() => parseBaseline(gz({ 'a.md': { hash: 'abc', content: 42 } }))).toThrow();
    expect(() => parseBaseline(gz({ 'a.md': null }))).toThrow();
  });
});

describe('makeTextEntryBudgeted', () => {
  it('预算内：与 makeTextEntry 完全一致（全文 + 哈希）', () => {
    const e = makeTextEntryBudgeted('你好\n世界', 0, 1024);
    expect(e).toEqual(makeTextEntry('你好\n世界'));
  });

  it('超预算：content 为 null，但 hash 与全文版一致（变更检测仍精确）', () => {
    const content = 'x'.repeat(1000);
    const e = makeTextEntryBudgeted(content, 0, 10);
    expect(e.content).toBeNull();
    expect(e.hash).toBe(makeTextEntry(content).hash);
  });

  it('usedBytes 计入预算：存量 + 新文件超预算则只存哈希', () => {
    // 'abcd' 占 8 字节；已用 96 + 8 = 104 > 100 → 超预算
    expect(makeTextEntryBudgeted('abcd', 96, 100).content).toBeNull();
    expect(makeTextEntryBudgeted('abcd', 92, 100).content).toBe('abcd');
  });

  it('边界：恰好等于预算不超限（规则是 > 才超）', () => {
    expect(makeTextEntryBudgeted('abc', 94, 100).content).toBe('abc');
  });
});

describe('entryContentBytes', () => {
  it('content 非 null → content.length * 2', () => {
    expect(entryContentBytes({ hash: 'h', content: 'abcd' })).toBe(8);
    expect(entryContentBytes(makeTextEntry(''))).toBe(0);
  });

  it('content 为 null → 0', () => {
    expect(entryContentBytes({ hash: 'h', content: null })).toBe(0);
    expect(entryContentBytes(makeBinaryEntry(123, 456))).toBe(0);
  });
});
