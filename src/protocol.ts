import { FileIO } from './core/fileio';
import { readLog, isStale } from './core/logStore';
import { readCursors, writeCursor } from './core/cursors';
import { ChangeEvent } from './core/types';

export interface FeedPaths {
  log: string;
  cursors: string;
}

export interface GetChangesResult {
  events: ChangeEvent[];
  stale: boolean;
  latestSeq: number;
}

/** 拉取 readerName 的未读事件；不推进游标（读者处理完自己 markRead） */
export async function getChanges(
  io: FileIO,
  paths: FeedPaths,
  readerName: string,
): Promise<GetChangesResult> {
  const [cursors, { events, minSeq, maxSeq }] = await Promise.all([
    readCursors(io, paths.cursors),
    readLog(io, paths.log),
  ]);
  const cursor = cursors[readerName] ?? 0;
  return {
    events: events.filter(e => e.seq > cursor),
    stale: isStale(minSeq, cursor),
    latestSeq: maxSeq ?? cursor,
  };
}

export async function markRead(
  io: FileIO,
  paths: FeedPaths,
  readerName: string,
  seq: number,
): Promise<void> {
  await writeCursor(io, paths.cursors, readerName, seq);
}

/** 紧凑文本格式，供复制给 AI 或人读 */
export function formatEvents(events: ChangeEvent[]): string {
  return events
    .map(e => {
      const stat = e.stat ? ` +${e.stat.added}/-${e.stat.removed}` : '';
      switch (e.op) {
        case 'rename':
          return `rename ${e.oldPath} → ${e.path}`;
        case 'resync':
          return 'resync — baseline rebuilt; full vault rescan advised';
        default:
          return `${e.op}${stat} ${e.path}`;
      }
    })
    .join('\n');
}
