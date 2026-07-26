export type ChangeOp = 'create' | 'modify' | 'delete' | 'rename' | 'resync';
export type EventSource = 'live' | 'reconcile' | 'system';

export interface LineStat {
  added: number;
  removed: number;
}

export interface ChangeEvent {
  seq: number;
  ts: number;
  op: ChangeOp;
  path: string;
  oldPath?: string;
  stat: LineStat | null;
  source: EventSource;
}
