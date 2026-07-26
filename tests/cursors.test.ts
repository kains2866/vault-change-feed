import { describe, it, expect } from 'vitest';
import { MemoryFileIO } from '../src/core/fileio';
import { readCursors, writeCursor } from '../src/core/cursors';

describe('cursors', () => {
  it('missing file -> empty object', async () => {
    expect(await readCursors(new MemoryFileIO(), 'c.json')).toEqual({});
  });

  it('corrupt file -> empty object', async () => {
    const io = new MemoryFileIO();
    await io.write('c.json', '{oops');
    expect(await readCursors(io, 'c.json')).toEqual({});
  });

  it('non-object json -> empty object', async () => {
    const io = new MemoryFileIO();
    await io.write('c.json', '[1,2]');
    expect(await readCursors(io, 'c.json')).toEqual({});
  });

  it('writeCursor roundtrip and preserves other readers', async () => {
    const io = new MemoryFileIO();
    await writeCursor(io, 'c.json', 'kimi-cli', 100);
    await writeCursor(io, 'c.json', 'copilot', 55);
    await writeCursor(io, 'c.json', 'kimi-cli', 130);
    expect(await readCursors(io, 'c.json')).toEqual({ 'kimi-cli': 130, copilot: 55 });
    expect(await io.exists('c.json.tmp')).toBe(false);
  });

  it('filters non-numeric values on read', async () => {
    const io = new MemoryFileIO();
    await io.write('c.json', JSON.stringify({ a: 3, b: 'x', c: null }));
    expect(await readCursors(io, 'c.json')).toEqual({ a: 3 });
  });
});
