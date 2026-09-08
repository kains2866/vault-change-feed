import { describe, it, expect } from 'vitest';
import { MemoryFileIO } from '../src/core/fileio';
import {
  eventsFile,
  deviceStateFile,
  readerCursorFile,
  devicesFile,
  baselineFile,
  deviceFileKey,
  readerFileKey,
  readDevicesIndex,
  registerDevice,
  readReaderCursor,
  writeReaderCursor,
  readDeviceState,
  buildDevicesIndex,
} from '../src/core/v2store';

describe('v2store 路径与文件名安全', () => {
  it('设备 id 用于文件名（uuid 安全）', () => {
    expect(eventsFile('d', 'abc-123_def')).toBe('d/events/abc-123_def.jsonl');
    expect(baselineFile('d', 'abc')).toBe('d/baseline-abc.gz');
    expect(deviceStateFile('d', 'abc')).toBe('d/state/abc.json');
    expect(readerCursorFile('d', 'my-agent')).toBe('d/cursors/my-agent.json');
    expect(devicesFile('d')).toBe('d/devices.json');
  });

  it('非法字符被替换为 _，空值回退', () => {
    expect(deviceFileKey('a/b:c*')).toBe('a_b_c_');
    expect(deviceFileKey('')).toBe('device');
    expect(readerFileKey('')).toBe('reader');
    expect(deviceFileKey('中文')).toBe('__'); // 非 ASCII 逐字符替换
  });
});

describe('devices 索引', () => {
  it('缺失文件 → 空索引；往返一致', async () => {
    const io = new MemoryFileIO();
    expect(await readDevicesIndex(io, 'd')).toEqual(buildDevicesIndex());
    await registerDevice(io, 'd', 'dev-1', 100);
    await registerDevice(io, 'd', 'dev-2', 200);
    await registerDevice(io, 'd', 'dev-1', 300); // 幂等
    const idx = await readDevicesIndex(io, 'd');
    expect(idx.devices).toEqual([
      { id: 'dev-1', firstSeen: 100 },
      { id: 'dev-2', firstSeen: 200 },
    ]);
  });

  it('损坏索引容错为空索引，且无 .tmp 残留', async () => {
    const io = new MemoryFileIO();
    await io.write('d/devices.json', 'not json');
    expect(await readDevicesIndex(io, 'd')).toEqual(buildDevicesIndex());
  });
});

describe('每 reader 游标', () => {
  it('读写往返；不同 reader 互不干扰（每 reader 独立文件）', async () => {
    const io = new MemoryFileIO();
    await writeReaderCursor(io, 'd', 'alice', { 'dev-1': 5, 'dev-2': 12 });
    await writeReaderCursor(io, 'd', 'bob', { 'dev-1': 1 });
    expect(await readReaderCursor(io, 'd', 'alice')).toEqual({ 'dev-1': 5, 'dev-2': 12 });
    expect(await readReaderCursor(io, 'd', 'bob')).toEqual({ 'dev-1': 1 });
  });

  it('覆盖写整文件原子（无 tmp 残留）；坏数据容错', async () => {
    const io = new MemoryFileIO();
    await writeReaderCursor(io, 'd', 'c', { a: 1 });
    await writeReaderCursor(io, 'd', 'c', { a: 9, b: 2 });
    expect(await readReaderCursor(io, 'd', 'c')).toEqual({ a: 9, b: 2 });
    expect(io.files.has('d/cursors/c.json.tmp')).toBe(false);
    await io.write('d/cursors/c.json', 'garbage');
    expect(await readReaderCursor(io, 'd', 'c')).toEqual({});
  });
});

describe('每设备状态文件', () => {
  it('缺失 → null；写入后可读', async () => {
    const io = new MemoryFileIO();
    expect(await readDeviceState(io, 'd', 'dev-1')).toBeNull();
    const state = { formatVersion: 1 as const, minSeq: 1, maxSeq: 3, count: 3, updatedAt: 10 };
    await io.write(deviceStateFile('d', 'dev-1'), JSON.stringify(state));
    expect(await readDeviceState(io, 'd', 'dev-1')).toEqual(state);
  });
});
