import { ChangeEvent } from './types';
import type { Cursors } from './cursors';

/** feed 健康分析结果（纯函数，供 Check feed health 命令展示） */
export interface FeedHealth {
  total: number;
  minSeq: number | null;
  maxSeq: number | null;
  /** 重复 seq 的事件对数 */
  duplicateSeqs: number;
  /** seq 逆序（后一条小于前一条）的相邻对数 */
  descendingPairs: number;
  /** min..max 之间缺失的 seq 数量（轮转截断属正常，会显示为 informational） */
  missingSeqs: number;
  /** 游标数 */
  readers: number;
  /** 游标大于日志 maxSeq 的 reader 数（异常：游标写超了） */
  readersAhead: number;
}

export function analyzeFeedHealth(events: ChangeEvent[], cursors: Cursors): FeedHealth {
  let minSeq: number | null = null;
  let maxSeq: number | null = null;
  let duplicateSeqs = 0;
  let descendingPairs = 0;
  let missingSeqs = 0;
  let prev: number | null = null;
  const seqs = events.map(e => e.seq);
  for (const seq of seqs) {
    if (minSeq === null || seq < minSeq) minSeq = seq;
    if (maxSeq === null || seq > maxSeq) maxSeq = seq;
    if (prev !== null) {
      if (seq === prev) duplicateSeqs++;
      else if (seq < prev) descendingPairs++;
      else if (seq > prev + 1) missingSeqs += seq - prev - 1;
    }
    prev = seq;
  }
  let readers = 0;
  let readersAhead = 0;
  for (const v of Object.values(cursors)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    readers++;
    if (maxSeq !== null && v > maxSeq) readersAhead++;
  }
  return {
    total: events.length,
    minSeq,
    maxSeq,
    duplicateSeqs,
    descendingPairs,
    missingSeqs,
    readers,
    readersAhead,
  };
}
