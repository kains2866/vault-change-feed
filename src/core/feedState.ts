import { FileIO } from './fileio';

/**
 * feed-state.json：日志的轻量状态端点。外部 agent / hook 读它（约 200B）即可判断
 * 「是否有新事件 / 是否 stale」，不必每次读整个 changelog.jsonl。
 * formatVersion 同时作为日志格式演进锚点（见 P2-13）。
 */
export interface FeedState {
  formatVersion: 1;
  /** 日志当前最小 seq；空日志为 null */
  minSeq: number | null;
  /** 日志当前最大 seq；空日志为 null */
  maxSeq: number | null;
  /** 当前事件条数 */
  count: number;
  /** 状态刷新时间戳（ms） */
  updatedAt: number;
}

export const FEED_STATE_FORMAT_VERSION = 1 as const;

export function buildFeedState(partial: Omit<FeedState, 'formatVersion' | 'updatedAt'> & { updatedAt?: number }): FeedState {
  return {
    formatVersion: FEED_STATE_FORMAT_VERSION,
    minSeq: partial.minSeq,
    maxSeq: partial.maxSeq,
    count: partial.count,
    updatedAt: partial.updatedAt ?? Date.now(),
  };
}

/** 原子写 feed-state（tmp + rename） */
export async function writeFeedState(io: FileIO, path: string, state: FeedState): Promise<void> {
  const tmp = path + '.tmp';
  await io.write(tmp, JSON.stringify(state));
  await io.rename(tmp, path);
}

/** 解析校验；坏数据返回 null（调用方忽略，状态文件仅是加速端点） */
export function parseFeedState(content: string): FeedState | null {
  try {
    const v = JSON.parse(content) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const okNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
    if (
      o.formatVersion !== FEED_STATE_FORMAT_VERSION ||
      (o.minSeq !== null && !okNum(o.minSeq)) ||
      (o.maxSeq !== null && !okNum(o.maxSeq)) ||
      !okNum(o.count) ||
      !okNum(o.updatedAt)
    ) {
      return null;
    }
    return {
      formatVersion: FEED_STATE_FORMAT_VERSION,
      minSeq: o.minSeq as number | null,
      maxSeq: o.maxSeq as number | null,
      count: o.count as number,
      updatedAt: o.updatedAt as number,
    };
  } catch {
    return null;
  }
}
