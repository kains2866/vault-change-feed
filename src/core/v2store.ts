import { FileIO, commitTmp } from './fileio';
import { FeedState } from './feedState';

/**
 * v2 分设备布局：目录/文件名构造、设备索引、每 reader 游标、每设备状态。
 * 数据文件相对插件数据目录（base）：
 *   devices.json                    设备索引
 *   events/<deviceId>.jsonl         每设备事件流
 *   state/<deviceId>.json           每设备状态端点
 *   cursors/<readerName>.json       每读者游标 {deviceId: lastSeq}
 *   baseline-<deviceId>.gz          每设备基线（由 main 侧命名）
 */

export const V2_LAYOUT_VERSION = 1 as const;

export const DEVICES_FILE = 'devices.json';
export const EVENTS_DIR = 'events';
export const STATE_DIR = 'state';
export const CURSORS_DIR = 'cursors';

const P = (base: string): string => (base ? `${base}/` : '');

export const eventsFile = (base: string, device: string): string =>
  `${P(base)}${EVENTS_DIR}/${deviceFileKey(device)}.jsonl`;
export const deviceStateFile = (base: string, device: string): string =>
  `${P(base)}${STATE_DIR}/${deviceFileKey(device)}.json`;
export const readerCursorFile = (base: string, reader: string): string =>
  `${P(base)}${CURSORS_DIR}/${readerFileKey(reader)}.json`;
export const devicesFile = (base: string): string => `${P(base)}${DEVICES_FILE}`;
export const baselineFile = (base: string, device: string): string =>
  `${P(base)}baseline-${deviceFileKey(device)}.gz`;

/** 文件名安全键：仅保留 [A-Za-z0-9_-]，其余替换为 '_'；空值回退 'device'/'reader' */
export function safeFileKey(id: string, fallback: string): string {
  const k = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return k.length > 0 ? k : fallback;
}
export const deviceFileKey = (device: string): string => safeFileKey(device, 'device');
export const readerFileKey = (reader: string): string => safeFileKey(reader, 'reader');

/** devices.json 索引 */
export interface DevicesIndex {
  formatVersion: number;
  devices: Array<{ id: string; firstSeen: number }>;
}

export function buildDevicesIndex(devices: DevicesIndex['devices'] = []): DevicesIndex {
  return { formatVersion: V2_LAYOUT_VERSION, devices };
}

/** 容错读取设备索引；缺失/损坏 → 空索引 */
export async function readDevicesIndex(io: FileIO, base: string): Promise<DevicesIndex> {
  const p = devicesFile(base);
  if (!(await io.exists(p))) return buildDevicesIndex();
  try {
    const v = JSON.parse(await io.read(p)) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return buildDevicesIndex();
    const o = v as Record<string, unknown>;
    if (o.formatVersion !== V2_LAYOUT_VERSION || !Array.isArray(o.devices)) return buildDevicesIndex();
    const devices: DevicesIndex['devices'] = [];
    for (const d of o.devices) {
      if (
        d !== null &&
        typeof d === 'object' &&
        typeof (d as Record<string, unknown>).id === 'string' &&
        typeof (d as Record<string, unknown>).firstSeen === 'number'
      ) {
        devices.push({ id: (d as Record<string, unknown>).id as string, firstSeen: (d as Record<string, unknown>).firstSeen as number });
      }
    }
    return { formatVersion: V2_LAYOUT_VERSION, devices };
  } catch {
    return buildDevicesIndex();
  }
}

/** 登记设备（幂等）：原子写回索引 */
export async function registerDevice(io: FileIO, base: string, deviceId: string, now = Date.now()): Promise<void> {
  const index = await readDevicesIndex(io, base);
  if (!index.devices.some(d => d.id === deviceId)) {
    index.devices.push({ id: deviceId, firstSeen: now });
    const tmp = devicesFile(base) + '.tmp';
    await io.write(tmp, JSON.stringify(index));
    await commitTmp(io, tmp, devicesFile(base));
  }
}

/** 每 reader 游标：读取容错（数值成员），缺失 → {} */
export async function readReaderCursor(io: FileIO, base: string, reader: string): Promise<Record<string, number>> {
  const p = readerCursorFile(base, reader);
  if (!(await io.exists(p))) return {};
  try {
    const v = JSON.parse(await io.read(p)) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/** 每 reader 游标：整写原子（tmp + rename） */
export async function writeReaderCursor(
  io: FileIO,
  base: string,
  reader: string,
  perDevice: Record<string, number>,
): Promise<void> {
  const p = readerCursorFile(base, reader);
  const tmp = p + '.tmp';
  await io.write(tmp, JSON.stringify(perDevice));
  await commitTmp(io, tmp, p);
}

/** 每设备状态：直接复用 FeedState 形状；读取校验失败返回 null */
export async function readDeviceState(io: FileIO, base: string, device: string): Promise<FeedState | null> {
  const p = deviceStateFile(base, device);
  if (!(await io.exists(p))) return null;
  try {
    return JSON.parse(await io.read(p)) as FeedState;
  } catch {
    return null;
  }
}
