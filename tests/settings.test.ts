import { describe, it, expect } from 'vitest';
import { parseGlobs, parseExtensions } from '../src/settings';

describe('parseGlobs', () => {
  it('按行拆分并去空', () => {
    expect(parseGlobs('a/**\n\n b.md \n')).toEqual(['a/**', 'b.md']);
  });

  it('兼容 Windows 反斜杠分隔（统一为 /）', () => {
    expect(parseGlobs('archive\\2026\nsub\\**\\*.md')).toEqual(['archive/2026', 'sub/**/*.md']);
  });

  it('已经用 / 的不受影响', () => {
    expect(parseGlobs('notes/drafts/**')).toEqual(['notes/drafts/**']);
  });
});

describe('parseExtensions', () => {
  it('小写化、去点、去空、逗号拆分', () => {
    expect(parseExtensions(' md , TXT,.JSON,')).toEqual(['md', 'txt', 'json']);
  });
});
