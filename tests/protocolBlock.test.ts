import { describe, it, expect } from 'vitest';
import { BLOCK_START, BLOCK_END, hasBlock, upsertBlock, removeBlock } from '../src/core/protocolBlock';

const BLOCK = `${BLOCK_START}\nsome protocol text\n${BLOCK_END}`;
const BLOCK_V2 = `${BLOCK_START}\nnew protocol text v2\n${BLOCK_END}`;

describe('hasBlock', () => {
  it('无标记 → false', () => {
    expect(hasBlock('# AGENTS\n\nuser content\n')).toBe(false);
  });

  it('两个标记齐全且 start 在 end 之前 → true', () => {
    expect(hasBlock(`before\n${BLOCK}\nafter\n`)).toBe(true);
  });

  it('只有 start → false', () => {
    expect(hasBlock(`${BLOCK_START}\ntext\n`)).toBe(false);
  });

  it('只有 end → false', () => {
    expect(hasBlock(`text\n${BLOCK_END}\n`)).toBe(false);
  });

  it('顺序颠倒（end 在 start 之前）→ false', () => {
    expect(hasBlock(`${BLOCK_END}\ntext\n${BLOCK_START}\n`)).toBe(false);
  });
});

describe('upsertBlock', () => {
  it('content 为 null（文件不存在）→ 块 + 换行', () => {
    expect(upsertBlock(null, BLOCK)).toBe(BLOCK + '\n');
  });

  it('content 为空串 → 块 + 换行（无前文不加分隔空行）', () => {
    expect(upsertBlock('', BLOCK)).toBe(BLOCK + '\n');
  });

  it('无标记的现有内容 → 追加到文末，空一行分隔，原文逐字保留', () => {
    const content = '# AGENTS\n\nuser content\n';
    expect(upsertBlock(content, BLOCK)).toBe(`# AGENTS\n\nuser content\n\n${BLOCK}\n`);
  });

  it('前文无尾换行 → 同样空一行分隔', () => {
    expect(upsertBlock('# AGENTS', BLOCK)).toBe(`# AGENTS\n\n${BLOCK}\n`);
  });

  it('前文已有多余空行 → 归并为一个空行分隔', () => {
    expect(upsertBlock('# AGENTS\n\n\n', BLOCK)).toBe(`# AGENTS\n\n${BLOCK}\n`);
  });

  it('替换已有块 → 新块替换，标记外内容逐字保留（块前块后都有用户内容）', () => {
    const content = `before\n\n${BLOCK}\nafter\n`;
    expect(upsertBlock(content, BLOCK_V2)).toBe(`before\n\n${BLOCK_V2}\nafter\n`);
  });

  it('幂等：两次 upsert 结果相同', () => {
    const content = '# AGENTS\n\nuser content\n';
    const once = upsertBlock(content, BLOCK);
    expect(upsertBlock(once, BLOCK)).toBe(once);
  });
});

describe('removeBlock', () => {
  it('有块 → 删除，前文后文正确拼接（块前空行一并去除）', () => {
    const content = `before\n\n${BLOCK}\n\nafter\n`;
    expect(removeBlock(content)).toBe('before\n\nafter\n');
  });

  it('块在文末 → 前文保留，不残留空行', () => {
    expect(removeBlock(`before\n\n${BLOCK}\n`)).toBe('before\n');
  });

  it('整个文件只有块 → 返回空串', () => {
    expect(removeBlock(BLOCK + '\n')).toBe('');
  });

  it('无块 → 原样返回', () => {
    const content = '# AGENTS\n\nuser content\n';
    expect(removeBlock(content)).toBe(content);
  });
});
