import { ChangeEvent, ChangeOp, EventSource, LineStat } from './types';

export interface PushOptions {
  oldPath?: string;
  stat?: LineStat | null;
  source?: EventSource;
  ts?: number;
}

/** 事件队列：分配 seq、缓冲待写事件；带上限防落盘持续失败时内存无限增长 */
export class EventFeed {
  private nextSeq: number;
  private queue: ChangeEvent[] = [];
  private overflowed = false;
  private readonly maxQueue: number;

  /** maxQueue：缓冲上限（默认 50000）；溢出时清空缓冲并注入一条 resync 通知读者全量重扫 */
  constructor(lastSeq: number, maxQueue = 50000) {
    this.nextSeq = lastSeq + 1;
    this.maxQueue = maxQueue;
  }

  private enqueue(e: ChangeEvent): void {
    if (!this.overflowed && this.queue.length >= this.maxQueue) {
      this.overflowed = true;
      this.queue = [];
      this.queue.push({
        seq: this.nextSeq++,
        ts: Date.now(),
        op: 'resync',
        path: '',
        stat: null,
        source: 'system',
      });
    }
    this.queue.push(e);
  }

  push(op: ChangeOp, path: string, opts: PushOptions = {}): ChangeEvent {
    const e: ChangeEvent = {
      seq: this.nextSeq++,
      ts: opts.ts ?? Date.now(),
      op,
      path,
      stat: opts.stat ?? null,
      source: opts.source ?? 'live',
      ...(opts.oldPath !== undefined ? { oldPath: opts.oldPath } : {}),
    };
    this.enqueue(e);
    return e;
  }

  /** 接收外部已编号事件（如 reconcile 结果），并把序号推进到其后 */
  pushLoaded(e: ChangeEvent): void {
    this.enqueue(e);
    if (e.seq >= this.nextSeq) this.nextSeq = e.seq + 1;
  }

  peekNextSeq(): number {
    return this.nextSeq;
  }

  drain(): ChangeEvent[] {
    const q = this.queue;
    this.queue = [];
    this.overflowed = false;
    return q;
  }

  get pending(): number {
    return this.queue.length;
  }
}
