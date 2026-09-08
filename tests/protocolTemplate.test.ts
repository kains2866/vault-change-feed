import { describe, it, expect } from 'vitest';
import { renderProtocolBlock } from '../src/core/protocolTemplate';
import { BLOCK_START, BLOCK_END, hasBlock } from '../src/core/protocolBlock';

describe('renderProtocolBlock', () => {
  it('输出以 BLOCK_START 开头、BLOCK_END 结尾，且 hasBlock(输出) 为 true', () => {
    const out = renderProtocolBlock('.obsidian');
    expect(out.startsWith(BLOCK_START)).toBe(true);
    expect(out.endsWith(BLOCK_END)).toBe(true);
    expect(hasBlock(out)).toBe(true);
  });

  it('两次渲染结果一致（纯函数）', () => {
    expect(renderProtocolBlock('.obsidian')).toBe(renderProtocolBlock('.obsidian'));
  });

  it('v2 关键语义：每 reader 游标文件 / 设备索引 / events 目录 / ch 去重', () => {
    const out = renderProtocolBlock('.obsidian');
    expect(out).toContain('cursors/<reader>.json');
    expect(out).toContain('devices.json');
    expect(out).toContain('devices[].id');
    expect(out).toContain('events/<deviceId>.jsonl');
    expect(out).toContain('drop duplicates');
    expect(out).toContain('stable reader id');
    expect(out).toContain('full vault rescan');
  });

  it('自定义 configDir 会替换协议中的路径', () => {
    const out = renderProtocolBlock('.myconfig');
    expect(out).toContain('.myconfig/plugins/vault-change-feed/devices.json');
    expect(out).not.toContain('.obsidian/');
  });
});
