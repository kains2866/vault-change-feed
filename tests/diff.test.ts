import { describe, it, expect } from 'vitest';
import { lineStat } from '../src/core/diff';

describe('lineStat', () => {
  it('identical content -> 0/0', () => {
    expect(lineStat('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
  });

  it('pure addition', () => {
    expect(lineStat('a', 'a\nb\nc')).toEqual({ added: 2, removed: 0 });
  });

  it('pure removal', () => {
    expect(lineStat('a\nb\nc', 'a')).toEqual({ added: 0, removed: 2 });
  });

  it('one line rewritten -> 1/1', () => {
    expect(lineStat('hello', 'hallo')).toEqual({ added: 1, removed: 1 });
  });

  it('middle line changed, prefix/suffix trimmed', () => {
    expect(lineStat('a\nb\nc\nd', 'a\nx\nc\nd')).toEqual({ added: 1, removed: 1 });
  });

  it('empty old content: single empty line counts as removed', () => {
    expect(lineStat('', 'a\nb')).toEqual({ added: 2, removed: 1 });
  });

  it('unicode and long lines', () => {
    const old = '过拟合\n' + 'x'.repeat(5000);
    const nw = '过拟合\n' + 'y'.repeat(5000) + '\n新增';
    expect(lineStat(old, nw)).toEqual({ added: 2, removed: 1 });
  });

  it('returns null when middle section exceeds MAX_DIFF_LINES', () => {
    const a = Array.from({ length: 6001 }, (_, i) => 'a' + i).join('\n');
    const b = Array.from({ length: 6001 }, (_, i) => 'b' + i).join('\n');
    expect(lineStat(a, b)).toBeNull();
  });
});
