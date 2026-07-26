import { describe, it, expect } from 'vitest';
import { globToRegExp, isExcluded, isTextFile, ExcludeOptions } from '../src/core/exclude';

const opts: ExcludeOptions = {
  configDir: '.obsidian',
  trackedExtensions: ['md', 'txt', 'canvas'],
  extraGlobs: [],
};

describe('globToRegExp', () => {
  it('* matches within a segment', () => {
    expect(globToRegExp('*.tmp').test('a.tmp')).toBe(true);
    expect(globToRegExp('*.tmp').test('dir/a.tmp')).toBe(false);
  });
  it('** crosses segments', () => {
    expect(globToRegExp('Private/**').test('Private/a/b/c.md')).toBe(true);
    expect(globToRegExp('**/secret.md').test('a/b/secret.md')).toBe(true);
    expect(globToRegExp('**/secret.md').test('secret.md')).toBe(true);
  });
  it('escapes regex chars', () => {
    expect(globToRegExp('a+b.md').test('a+b.md')).toBe(true);
    expect(globToRegExp('a+b.md').test('axb.md')).toBe(false);
  });
});

describe('isExcluded', () => {
  it('configDir always excluded (incl. plugin own outputs)', () => {
    expect(isExcluded('.obsidian/plugins/vault-change-feed/changelog.jsonl', opts)).toBe(true);
    expect(isExcluded('.obsidian/workspace.json', opts)).toBe(true);
  });
  it('normal notes not excluded', () => {
    expect(isExcluded('ML/过拟合.md', opts)).toBe(false);
  });
  it('extraGlobs applied', () => {
    const o = { ...opts, extraGlobs: ['Private/**', '日记/secret.md'] };
    expect(isExcluded('Private/x.md', o)).toBe(true);
    expect(isExcluded('日记/secret.md', o)).toBe(true);
    expect(isExcluded('日记/其他.md', o)).toBe(false);
  });
});

describe('isTextFile', () => {
  it('by extension, case-insensitive', () => {
    expect(isTextFile('a/b.md', opts.trackedExtensions)).toBe(true);
    expect(isTextFile('a/b.MD', opts.trackedExtensions)).toBe(true);
    expect(isTextFile('a/pic.png', opts.trackedExtensions)).toBe(false);
    expect(isTextFile('Makefile', opts.trackedExtensions)).toBe(false);
  });
});
