export interface FileIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  write(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  append(path: string, data: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdirp(): Promise<void>;
}

/**
 * 原子提交：先把内容写到 tmp，再 rename 覆盖 target。
 * 部分适配器（Obsidian DataAdapter）在目标已存在时 rename 会失败——此时回退为
 * 先删目标再 rename（tmp 已写全量内容，删除旧目标不丢数据）。rename 成功即跳过回退。
 */
export async function commitTmp(io: FileIO, tmp: string, target: string): Promise<void> {
  try {
    await io.rename(tmp, target);
    return;
  } catch {
    // 目标已存在导致 rename 失败（或平台差异）：删旧再 rename
  }
  if (await io.exists(target)) await io.remove(target);
  await io.rename(tmp, target);
}

export class MemoryFileIO implements FileIO {
  files = new Map<string, string | Uint8Array>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined || typeof v !== 'string') throw new Error('ENOENT: ' + path);
    return v;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const v = this.files.get(path);
    if (v === undefined || typeof v === 'string') throw new Error('ENOENT: ' + path);
    return v;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }

  async append(path: string, data: string): Promise<void> {
    const v = this.files.get(path);
    this.files.set(path, (typeof v === 'string' ? v : '') + data);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const v = this.files.get(oldPath);
    if (v === undefined) throw new Error('ENOENT: ' + oldPath);
    this.files.delete(oldPath);
    this.files.set(newPath, v);
  }

  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error('ENOENT: ' + path);
  }

  async mkdirp(): Promise<void> {}
}
