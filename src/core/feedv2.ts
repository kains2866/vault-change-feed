import { ChangeEvent } from './types';
import { FileIO } from './fileio';
import { readLog } from './logStore';
import { readDevicesIndex, eventsFile, readReaderCursor } from './v2store';

/**
 * v2 读取：跨设备事件收集、ch 去重、游标（每设备）、stale 判定。
 * base = 插件数据目录（io 根），路径由 v2store 构造（events/<deviceId>.jsonl）。
 */

export interface DeviceLog {
  device: string;
  events: ChangeEvent[];
  minSeq: number | null;
  maxSeq: number | null;
}

export interface V2ReadResult {
  /** ch 去重后的原始事件（跨设备统一时间线；未做同文件合并） */
  events: ChangeEvent[];
  /** 各设备日志最大 seq（本次读取已见） */
  latestPerDevice: Record<string, number>;
  /** 是否有设备因日志轮转出现空洞（cursor 落后于该设备 minSeq-1） */
  stale: boolean;
  staleDevices: string[];
}

/** 读取全部设备日志（遍历 devices 索引；行损坏容错） */
export async function readAllDeviceLogs(io: FileIO, base: string): Promise<DeviceLog[]> {
  const index = await readDevicesIndex(io, base);
  const out: DeviceLog[] = [];
  for (const { id } of index.devices) {
    try {
      const { events, minSeq, maxSeq } = await readLog(io, eventsFile(base, id));
      out.push({ device: id, events, minSeq, maxSeq });
    } catch {
      // 单设备读取失败跳过（可能仍在上一次同步中）
    }
  }
  return out;
}

/** 追加设备归属（事件行可能缺 device，按文件归属补全） */
export function attributeLog(device: string, events: ChangeEvent[]): ChangeEvent[] {
  return events.map(e => ({ ...e, device: e.device ?? device }));
}

/** ch 去重（create/modify 且带 ch；跨设备同一物理变更只保留最早一条） */
export function dedupeByContent(events: ChangeEvent[]): ChangeEvent[] {
  const seen = new Set<string>();
  const out: ChangeEvent[] = [];
  for (const e of events) {
    if ((e.op === 'create' || e.op === 'modify') && typeof e.ch === 'string' && e.ch.length > 0) {
      const key = `${e.path}|${e.op}|${e.ch}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(e);
  }
  return out;
}

/**
 * 读取合并：每设备取 seq > 游标 的事件 → 跨设备按 (ts, device, seq) 排序
 * → ch 去重。stale：某设备 cursor>0 且其日志 minSeq > cursor+1（轮转截断）。
 */
export async function getChangesV2(
  io: FileIO,
  base: string,
  reader: string,
): Promise<V2ReadResult> {
  const cursors = await readReaderCursor(io, base, reader);
  const logs = await readAllDeviceLogs(io, base);

  const unread: ChangeEvent[] = [];
  const latestPerDevice: Record<string, number> = {};
  const staleDevices: string[] = [];
  for (const log of logs) {
    const cursor = cursors[log.device] ?? 0;
    const evs = log.events.filter(e => e.seq > cursor);
    unread.push(...attributeLog(log.device, evs));
    if (log.maxSeq !== null) latestPerDevice[log.device] = log.maxSeq;
    if (cursor > 0 && log.minSeq !== null && log.minSeq > cursor + 1) {
      staleDevices.push(log.device);
    }
  }

  unread.sort((a, b) => a.ts - b.ts || (a.device ?? '').localeCompare(b.device ?? '') || a.seq - b.seq);
  const events = dedupeByContent(unread);
  return { events, latestPerDevice, stale: staleDevices.length > 0, staleDevices };
}
