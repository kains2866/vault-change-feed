import { describe, it, expect } from 'vitest';
import { renderProtocolBlock } from '../src/core/protocolTemplate';
import { BLOCK_START, BLOCK_END, hasBlock } from '../src/core/protocolBlock';

describe('renderProtocolBlock', () => {
  it('输出以 BLOCK_START 开头、BLOCK_END 结尾，且 hasBlock(输出) 为 true', () => {
    const out = renderProtocolBlock();
    expect(out.startsWith(BLOCK_START)).toBe(true);
    expect(out.endsWith(BLOCK_END)).toBe(true);
    expect(hasBlock(out)).toBe(true);
  });

  it('两次渲染结果一致（纯函数）', () => {
    expect(renderProtocolBlock()).toBe(renderProtocolBlock());
  });

  it('措辞强化：包含稳定 id、只改自己 key、禁止直写 cursors.json 的硬约束', () => {
    const out = renderProtocolBlock();
    expect(out).toContain('ONLY your own reader key');
    expect(out).toContain('NEVER write `cursors.json` directly');
    expect(out).toContain('stable id');
    expect(hasBlock(out)).toBe(true);
  });
});
