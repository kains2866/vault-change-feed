import { FileIO, commitTmp } from './fileio';

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

/** 原子写 feed-state（tmp + rename；目标已存在时带删旧回退，兼容部分适配器） */
export async function writeFeedState(io: FileIO, path: string, state: FeedState): Promise<void> {
  const tmp = path + '.tmp';
  await io.write(tmp, JSON.stringify(state));
  await commitTmp(io, tmp, path);
}

/** 解析校验；坏数据返回 null（调用方忽略，状态文件仅是加速端点） */
export function parseFeedState(content: string): FeedState | null {
  try {
    const v: unknown = JSON.parse(content);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (o.formatVersion !== FEED_STATE_FORMAT_VERSION) return null;

    // 逐步 typeof 收窄赋值，避免类型断言 lint（no-unnecessary-type-assertion）
    const state: FeedState = {
      formatVersion: FEED_STATE_FORMAT_VERSION,
      minSeq: null,
      maxSeq: null,
      count: 0,
      updatedAt: 0,
    };

    const minSeq = o.minSeq;
    if (minSeq !== null) {
      if (typeof minSeq !== 'number' || !Number.isFinite(minSeq)) return null;
      state.minSeq = minSeq;
    }
    const maxSeq = o.maxSeq;
    if (maxSeq !== null) {
      if (typeof maxSeq !== 'number' || !Number.isFinite(maxSeq)) return null;
      state.maxSeq = maxSeq;
    }
    const count = o.count;
    if (typeof count !== 'number' || !Number.isFinite(count)) return null;
    state.count = count;
    const updatedAt = o.updatedAt;
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
    state.updatedAt = updatedAt;

    return state;
  } catch {
    return null;
  }
}
