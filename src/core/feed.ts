import { ChangeEvent, ChangeOp, EventSource, LineStat } from './types';

export interface PushOptions {
  oldPath?: string;
  stat?: LineStat | null;
  source?: EventSource;
  ts?: number;
}

/** 事件队列：分配 seq、缓冲待写事件 */
export class EventFeed {
  private nextSeq: number;
  private queue: ChangeEvent[] = [];

  constructor(lastSeq: number) {
    this.nextSeq = lastSeq + 1;
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
    this.queue.push(e);
    return e;
  }

  /** 接收外部已编号事件（如 reconcile 结果），并把序号推进到其后 */
  pushLoaded(e: ChangeEvent): void {
    this.queue.push(e);
    if (e.seq >= this.nextSeq) this.nextSeq = e.seq + 1;
  }

  peekNextSeq(): number {
    return this.nextSeq;
  }

  drain(): ChangeEvent[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  get pending(): number {
    return this.queue.length;
  }
}
