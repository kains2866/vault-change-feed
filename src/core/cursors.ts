import { FileIO } from './fileio';

export type Cursors = Record<string, number>;

export async function readCursors(io: FileIO, path: string): Promise<Cursors> {
  if (!(await io.exists(path))) return {};
  try {
    const obj = JSON.parse(await io.read(path));
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: Cursors = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeCursor(io: FileIO, path: string, name: string, seq: number): Promise<void> {
  const cursors = await readCursors(io, path);
  cursors[name] = seq;
  const tmp = path + '.tmp';
  await io.write(tmp, JSON.stringify(cursors, null, 2));
  await io.rename(tmp, path);
}
