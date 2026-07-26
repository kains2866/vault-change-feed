import { ChangeEvent } from './types';
import { FileIO } from './fileio';

export interface ReadResult {
  events: ChangeEvent[];
  minSeq: number | null;
  maxSeq: number | null;
}

export function parseLog(content: string): ReadResult {
  const events: ChangeEvent[] = [];
  let minSeq: number | null = null;
  let maxSeq: number | null = null;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as ChangeEvent;
      if (typeof e.seq !== 'number') continue;
      events.push(e);
      minSeq = minSeq === null ? e.seq : Math.min(minSeq, e.seq);
      maxSeq = maxSeq === null ? e.seq : Math.max(maxSeq, e.seq);
    } catch {
      // 坏行跳过（上次写入中断等）
    }
  }
  return { events, minSeq, maxSeq };
}

export function serializeEvent(e: ChangeEvent): string {
  return JSON.stringify(e);
}

export async function appendEvents(io: FileIO, path: string, events: ChangeEvent[]): Promise<void> {
  if (events.length === 0) return;
  const data = events.map(serializeEvent).join('\n') + '\n';
  if (await io.exists(path)) {
    await io.append(path, data);
  } else {
    await io.write(path, data);
  }
}

export async function readLog(io: FileIO, path: string): Promise<ReadResult> {
  if (!(await io.exists(path))) return { events: [], minSeq: null, maxSeq: null };
  return parseLog(await io.read(path));
}

/** 游标落后于日志最小 seq（出现空洞）即为 stale；新读者（cursor 0）除外 */
export function isStale(minSeq: number | null, cursor: number): boolean {
  return cursor > 0 && minSeq !== null && minSeq > cursor + 1;
}

/** 按条数/天数截断（先到先截），原子重写；返回是否发生了截断 */
export async function rotateIfNeeded(
  io: FileIO,
  path: string,
  maxEntries: number,
  maxAgeDays: number,
  now: number,
): Promise<boolean> {
  const { events } = await readLog(io, path);
  if (events.length === 0) return false;
  const cutoff = now - maxAgeDays * 86400000;
  let kept = events.filter(e => e.ts >= cutoff);
  if (kept.length > maxEntries) kept = kept.slice(kept.length - maxEntries);
  if (kept.length === events.length) return false;
  const tmp = path + '.tmp';
  await io.write(tmp, kept.map(serializeEvent).join('\n') + (kept.length ? '\n' : ''));
  await io.rename(tmp, path);
  return true;
}
