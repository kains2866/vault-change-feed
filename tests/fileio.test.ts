import { describe, it, expect } from 'vitest';
import { commitTmp, FileIO } from '../src/core/fileio';

/** 模拟 Obsidian DataAdapter：目标已存在时 rename 抛错（与真机冒烟一致） */
class NoOverwriteRenameIO implements FileIO {
  files = new Map<string, string | Uint8Array>();
  exists = async (p: string) => this.files.has(p);
  read = async (p: string) => String(this.files.get(p) ?? '');
  readBinary = async (p: string) => this.files.get(p) as Uint8Array;
  write = async (p: string, d: string) => { this.files.set(p, d); };
  writeBinary = async (p: string, d: Uint8Array) => { this.files.set(p, d); };
  append = async (p: string, d: string) => { this.files.set(p, String(this.files.get(p) ?? '') + d); };
  rename = async (o: string, n: string) => {
    if (this.files.has(n)) throw new Error('EEXIST: ' + n); // 模拟失败适配器
    const v = this.files.get(o);
    if (v === undefined) throw new Error('ENOENT: ' + o);
    this.files.delete(o);
    this.files.set(n, v);
  };
  remove = async (p: string) => { if (!this.files.delete(p)) throw new Error('ENOENT: ' + p); };
  mkdirp = async () => {};
}

describe('commitTmp', () => {
  it('目标不存在：直接 rename 成功', async () => {
    const io = new NoOverwriteRenameIO();
    await io.write('a.tmp', 'new');
    await commitTmp(io, 'a.tmp', 'a.json');
    expect(await io.read('a.json')).toBe('new');
    expect(io.files.has('a.tmp')).toBe(false);
  });

  it('目标已存在且 rename 失败：回退删旧再 rename（旧内容被新内容替换，无残留 tmp）', async () => {
    const io = new NoOverwriteRenameIO();
    await io.write('a.json', 'old');
    await io.write('a.tmp', 'new');
    await commitTmp(io, 'a.tmp', 'a.json');
    expect(await io.read('a.json')).toBe('new');
    expect(io.files.has('a.tmp')).toBe(false);
  });

  it('MemoryFileIO 常规覆盖路径同样生效', async () => {
    // MemoryFileIO 的 rename 本就覆盖目标
    const { MemoryFileIO } = await import('../src/core/fileio');
    const io = new MemoryFileIO();
    await io.write('a.json', 'old');
    await io.write('a.tmp', 'new');
    await commitTmp(io, 'a.tmp', 'a.json');
    expect(await io.read('a.json')).toBe('new');
    expect(io.files.has('a.tmp')).toBe(false);
  });
});
