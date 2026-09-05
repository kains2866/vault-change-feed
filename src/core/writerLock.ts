/** 多实例写者锁：lock 文件内容、抢占决策（纯函数，不含 IO） */

export interface WriterLock {
  deviceId: string;
  ts: number;
}

export type LockDecision = 'take' | 'standby';

/** 锁心跳间隔 30s；超过 90s 未心跳视为写者已死，允许接管 */
export const LOCK_STALE_MS = 90_000;

/** 无锁 → take；锁是我的 → take；锁过期（now - ts > staleMs）→ take；否则 standby。 */
export function decideLock(
  existing: WriterLock | null,
  myDeviceId: string,
  now: number,
  staleMs: number = LOCK_STALE_MS,
): LockDecision {
  if (existing === null) return 'take';
  if (existing.deviceId === myDeviceId) return 'take';
  if (now - existing.ts > staleMs) return 'take';
  return 'standby';
}

/**
 * 所有权校验（check-before-write 用）：本设备当前是否仍被允许作为写者。
 * 无锁 / 锁是自己 / 锁已过期 → true；他人持有的新鲜锁 → false。
 * 与 `decideLock(...) === 'take'` 等价，语义强调「写前必须证明自己仍持锁」，
 * 防止写者休眠被接管后（split-brain）仍继续写入。
 */
export function verifyOwnership(
  existing: WriterLock | null,
  myDeviceId: string,
  now: number,
  staleMs: number = LOCK_STALE_MS,
): boolean {
  return decideLock(existing, myDeviceId, now, staleMs) === 'take';
}

/** 解析 lock 文件内容；坏 JSON / 缺字段 / 类型不符一律返回 null（视为无锁） */
export function parseLock(content: string): WriterLock | null {
  try {
    const v = JSON.parse(content) as unknown;
    if (
      typeof v !== 'object' ||
      v === null ||
      Array.isArray(v) ||
      typeof (v as WriterLock).deviceId !== 'string' ||
      typeof (v as WriterLock).ts !== 'number'
    ) {
      return null;
    }
    return v as WriterLock;
  } catch {
    return null;
  }
}
