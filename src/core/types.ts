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
  /** v2：写入设备 id；旧数据/旧测试可缺省 */
  device?: string;
  /** v2：create/modify 记录后的文件内容哈希（16 hex）；delete/rename/resync 为 null */
  ch?: string | null;
}
