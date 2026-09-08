import { FileIO } from './core/fileio';
import { ChangeEvent } from './core/types';
import { mergeEvents } from './core/merge';
import { getChangesV2 } from './core/feedv2';
import { writeReaderCursor } from './core/v2store';

export { mergeEvents };

export interface GetChangesResult {
  /** 未读事件（默认已按文件做同路径合并；含跨设备 ch 去重） */
  events: ChangeEvent[];
  /** 是否有设备日志轮转导致空洞（建议全量重扫） */
  stale: boolean;
  /** 各设备本次读取见到的最大 seq（markRead 用） */
  perDevice: Record<string, number>;
  /** 兼容字段：perDevice 的最大值（无设备日志时为 0） */
  latestSeq: number;
}

export interface GetChangesOptions {
  /** 默认 true：读取侧按文件合并未读事件；false 返回原始事件流（仍做 ch 去重） */
  merge?: boolean;
}

/** 拉取 reader 的未读事件（跨设备合并 + ch 去重）；不推进游标（读者处理完自己 markRead） */
export async function getChanges(
  io: FileIO,
  base: string,
  readerName: string,
  opts: GetChangesOptions = {},
): Promise<GetChangesResult> {
  const r = await getChangesV2(io, base, readerName);
  const events = (opts.merge ?? true) ? mergeEvents(r.events) : r.events;
  const latestSeq = Object.keys(r.latestPerDevice).length
    ? Math.max(...Object.values(r.latestPerDevice))
    : 0;
  return { events, stale: r.stale, perDevice: r.latestPerDevice, latestSeq };
}

/** 标记 reader 已读到 perDevice（各设备最大 seq）；按每 reader 独立文件整写原子 */
export async function markRead(
  io: FileIO,
  base: string,
  readerName: string,
  perDevice: Record<string, number>,
): Promise<void> {
  await writeReaderCursor(io, base, readerName, perDevice);
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
