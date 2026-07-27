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
