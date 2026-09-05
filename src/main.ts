import { App, DataAdapter, EventRef, Menu, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, moment } from 'obsidian';
import { detectLocale, setLocale, t } from './i18n';
import { FileIO } from './core/fileio';
import {
  Baseline,
  makeTextEntryBudgeted,
  makeBinaryEntry,
  entryContentBytes,
  isEntryUnchanged,
  serializeBaseline,
  parseBaseline,
  countLines,
} from './core/baseline';
import { lineStat } from './core/diff';
import { isExcluded, isTextFile, ExcludeOptions } from './core/exclude';
import { reconcile, FileSnapshot } from './core/reconcile';
import { readLog, appendEvents, rotateIfNeeded } from './core/logStore';
import { writeFeedState, buildFeedState, parseFeedState, FeedState } from './core/feedState';
import { readCursors } from './core/cursors';
import { analyzeFeedHealth } from './core/health';
import { EventFeed } from './core/feed';
import { decideLock, parseLock, verifyOwnership, WriterLock } from './core/writerLock';
import { detectSync, SyncSignals } from './core/syncDetect';
import { hasBlock, upsertBlock, removeBlock } from './core/protocolBlock';
import { renderProtocolBlock } from './core/protocolTemplate';
import { getChanges, markRead, formatEvents, FeedPaths, GetChangesOptions } from './protocol';
import type { ChangeEvent } from './core/types';
import {
  VaultChangeFeedSettings,
  DEFAULT_SETTINGS,
  parseExtensions,
  parseGlobs,
} from './settings';

const LOG_FILE = 'changelog.jsonl';
const CURSORS_FILE = 'cursors.json';
const BASELINE_FILE = 'baseline.gz';
const FEED_STATE_FILE = 'feed-state.json';
const EVENT_FLUSH_MS = 3000;
const ROTATE_MS = 3600_000;
const LOCK_FILE = 'writer.lock';
/** 写者锁心跳周期；待机实例的接管检查同周期 */
const LOCK_HEARTBEAT_MS = 30_000;
/** AI agent 约定俗成的发现点（vault 根目录）；GEMINI.md 仅保留用于清理旧版本残留块 */
const PROTOCOL_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;

/** 状态栏图标（Bootstrap Icons file-text，MIT）：内联以便随主题 fill 变色 */
const STATUS_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-file-text" viewBox="0 0 16 16">
  <path d="M5 4a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1H5zm-.5 2.5A.5.5 0 0 1 5 6h6a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5zM5 8a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1H5zm0 2a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1H5z"/>
  <path d="M2 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2zm10-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1z"/>
</svg>`;

/** 活动指示灯点亮时长（ms）：最近一次 live 变更落盘后显示 ● */
const ACTIVITY_DOT_MS = 10_000;

/** 快照 → 基线条目（携带 size/mtime 元信息，供下次启动 stat 预筛） */
function baselineFromSnapshots(snapshots: FileSnapshot[]): Baseline {
  return new Map(
    snapshots.map(s => [
      s.path,
      { hash: s.hash, content: s.content, ...(s.size !== undefined ? { size: s.size, mtime: s.mtime } : {}) },
    ]),
  );
}

/** 基于 vault.adapter 的 FileIO：全部走 Obsidian 官方 API，桌面/移动端通用 */
class AdapterFileIO implements FileIO {
  constructor(
    private adapter: DataAdapter,
    private baseDir: string,
  ) {}
  private abs(p: string): string {
    return `${this.baseDir}/${p}`;
  }
  async exists(p: string): Promise<boolean> {
    return this.adapter.exists(this.abs(p));
  }
  async read(p: string): Promise<string> {
    return this.adapter.read(this.abs(p));
  }
  async readBinary(p: string): Promise<Uint8Array> {
    return new Uint8Array(await this.adapter.readBinary(this.abs(p)));
  }
  async write(p: string, data: string): Promise<void> {
    await this.adapter.write(this.abs(p), data);
  }
  async writeBinary(p: string, data: Uint8Array): Promise<void> {
    // Uint8Array 可能是大 buffer 上的视图，按实际范围切片
    await this.adapter.writeBinary(
      this.abs(p),
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    );
  }
  async append(p: string, data: string): Promise<void> {
    await this.adapter.append(this.abs(p), data);
  }
  async rename(o: string, n: string): Promise<void> {
    await this.adapter.rename(this.abs(o), this.abs(n));
  }
  async remove(p: string): Promise<void> {
    await this.adapter.remove(this.abs(p));
  }
  async mkdirp(): Promise<void> {
    // 插件目录的父级（configDir/plugins）必然存在，单层 mkdir 即可
    if (!(await this.adapter.exists(this.baseDir))) {
      await this.adapter.mkdir(this.baseDir);
    }
  }
}

interface PersistedData {
  settings: VaultChangeFeedSettings;
  lastSeq: number;
  /** 上次写入协议块时的插件版本（未安装过为 undefined） */
  lastProtocolVersion?: string;
  /** 首次运行引导 Notice 是否已展示过 */
  protocolNoticeShown?: boolean;
  /** 本设备 ID（写者锁身份），首次运行生成并持久化 */
  deviceId?: string;
  /** 云同步提示是否已展示过（只提示一次） */
  syncNoticeShown?: boolean;
}

export default class VaultChangeFeedPlugin extends Plugin {
  settings: VaultChangeFeedSettings = { ...DEFAULT_SETTINGS };
  api = {
    getChanges: (readerName: string, opts?: GetChangesOptions) =>
      getChanges(this.io, this.feedPaths(), readerName, opts),
    markRead: (readerName: string, seq: number) => markRead(this.io, this.feedPaths(), readerName, seq),
  };

  private io!: FileIO;
  private feed!: EventFeed;
  private baseline: Baseline = new Map();
  private baselineDirty = false;
  private lastSeq = 0;
  private lastProtocolVersion?: string;
  private protocolNoticeShown = false;
  private deviceId = '';
  private syncNoticeShown = false;
  /** 基线全文当前占用的估算字节数（initFeed 对账后全量重算，之后增量维护） */
  private baselineContentBytes = 0;
  /** 当前写者注册的 vault 事件引用（写者降级时动态撤销） */
  private liveEventRefs: EventRef[] = [];
  /** 当前写者注册的定时器 id（写者降级时动态清理） */
  private writerTimers: number[] = [];
  /** 当前实例是否为活跃写者（rig 已注册、可写日志）；false = 待机中 */
  private writerLive = false;
  /** 待机接管轮询定时器；null = 未在轮询 */
  private standbyTimer: number | null = null;
  /** 设置变更后的防抖重扫定时器；null = 无待执行重扫 */
  private rescanTimer: number | null = null;
  /** 静默对账进行中标志（防重入） */
  private rescanRunning = false;
  /** 协议块写入抑制表：path → 过期时间戳（自激写入不记录为 feed 事件） */
  private suppressedWrites = new Map<string, number>();
  /** feed-state 内存态：增量维护，rotate/init 时全量重算 */
  private feedState: FeedState = { formatVersion: 1, minSeq: null, maxSeq: null, count: 0, updatedAt: 0 };
  /** 待展开的文件夹重命名：oldFolder → {newFolder, timer}（给子文件独立事件留窗口） */
  private pendingFolderRenames = new Map<string, { newPath: string; timer: number }>();
  /** 状态栏元素（图标 + VCF + 活动指示灯；点击弹快捷菜单） */
  private statusBarEl: HTMLElement | null = null;
  private statusLabelEl: HTMLElement | null = null;
  private statusDotEl: HTMLElement | null = null;
  /** 最近一次 live 变更落盘时间戳（活动灯依据）；0 = 尚无 */
  private activityAt = 0;

  async onload(): Promise<void> {
    // moment.locale 为非官方 API，可能抛异常；退回 navigator.language
    let lang = 'en';
    try {
      lang = moment.locale() || 'en';
    } catch {
      lang = (typeof navigator !== 'undefined' && navigator.language) || 'en';
    }
    setLocale(detectLocale(lang));
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    // 首次安装的平台默认值：移动端内存/电量更紧张 → 更小基线预算、更长落盘周期
    const defaults = Platform.isMobile
      ? { ...DEFAULT_SETTINGS, baselineContentBudgetKb: 20480, flushIntervalSec: 600 }
      : DEFAULT_SETTINGS;
    this.settings = { ...defaults, ...(data?.settings ?? {}) };
    this.lastSeq = typeof data?.lastSeq === 'number' ? data.lastSeq : 0;
    if (typeof data?.lastProtocolVersion === 'string') this.lastProtocolVersion = data.lastProtocolVersion;
    this.protocolNoticeShown = data?.protocolNoticeShown === true;
    this.syncNoticeShown = data?.syncNoticeShown === true;

    // 设备 ID：写者锁的身份标识；没有则生成并立即持久化
    this.deviceId = typeof data?.deviceId === 'string' ? data.deviceId : '';
    if (this.deviceId.length === 0) {
      try {
        this.deviceId = crypto.randomUUID();
      } catch {
        this.deviceId = Date.now().toString(36) + Math.random().toString(36).slice(2);
      }
      await this.saveData(this.persistedData());
    }

    const dataDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.io = new AdapterFileIO(this.app.vault.adapter, dataDir);
    await this.io.mkdirp();

    this.addSettingTab(new VaultChangeFeedSettingTab(this.app, this));
    this.addCommand({
      id: 'copy-unread-for-ai',
      name: t('cmdCopyUnread'),
      callback: () => void this.copyUnread(),
    });
    this.addCommand({
      id: 'install-ai-protocol',
      name: t('cmdInstallProtocol'),
      callback: () => void this.installProtocol(),
    });
    this.addCommand({
      id: 'remove-ai-protocol',
      name: t('cmdRemoveProtocol'),
      callback: () => void this.removeProtocol(),
    });
    this.addCommand({
      id: 'check-feed-health',
      name: t('cmdHealth'),
      callback: () => void this.checkFeedHealth(),
    });
    this.addCommand({
      id: 'pause-recording',
      name: t('cmdPause'),
      callback: () => void this.pauseRecording(),
    });
    this.addCommand({
      id: 'resume-recording',
      name: t('cmdResume'),
      callback: () => void this.resumeRecording(),
    });
    this.addCommand({
      id: 'browse-events',
      name: t('cmdBrowse'),
      callback: () => void this.browseEvents(),
    });

    // 状态栏小部件：图标 + VCF 文本 + 活动灯，点击弹快捷菜单（2s 周期刷新）
    this.setupStatusBar();
    this.registerInterval(window.setInterval(() => this.updateStatusBar(), 2000));

    // vault 索引完成后再启动，避免启动期 create 事件风暴；多实例时进入待机
    this.app.workspace.onLayoutReady(() => void this.startFeed());
  }

  private feedPaths(): FeedPaths {
    return { log: LOG_FILE, cursors: CURSORS_FILE };
  }

  private excludeOpts(): ExcludeOptions {
    return {
      configDir: this.app.vault.configDir,
      trackedExtensions: parseExtensions(this.settings.trackedExtensions),
      extraGlobs: parseGlobs(this.settings.excludeGlobs),
    };
  }

  /** 读 writer.lock；缺失/损坏一律视为无锁 */
  private async readLock(): Promise<WriterLock | null> {
    try {
      if (!(await this.io.exists(LOCK_FILE))) return null;
      return parseLock(await this.io.read(LOCK_FILE));
    } catch {
      return null;
    }
  }

  /**
   * 条件心跳 / 抢占（read-then-write）：仅当锁不存在、是自己或已过期才覆盖写入；
   * 他人持有的新鲜锁不覆盖（防 split-brain）。返回是否成功写入。
   */
  private async writeLock(): Promise<boolean> {
    try {
      const existing = await this.readLock();
      if (decideLock(existing, this.deviceId, Date.now()) === 'standby') return false;
      await this.io.write(LOCK_FILE, JSON.stringify({ deviceId: this.deviceId, ts: Date.now() }));
      return true;
    } catch {
      return false;
    }
  }

  /** 抢占锁并回读验证仍是自己；被并发抢占（回读不是自己）返回 false */
  private async acquireLock(): Promise<boolean> {
    if (!(await this.writeLock())) return false;
    const lock = await this.readLock();
    return lock !== null && lock.deviceId === this.deviceId;
  }

  /**
   * 启动入口：竞争写者锁。抢到并验证后初始化；否则进入待机——不注册 vault 监听、
   * 不写任何文件，周期性检查锁以便接管。只读接口（api.getChanges）待机下仍可用。
   */
  private async startFeed(): Promise<void> {
    const existing = await this.readLock();
    if (decideLock(existing, this.deviceId, Date.now()) === 'standby' || !(await this.acquireLock())) {
      this.enterStandby();
      return;
    }
    await this.initFeed();
  }

  /** 进入待机（尚未成为写者）：展示提示并启动接管轮询 */
  private enterStandby(): void {
    if (this.writerLive) return; // 已是写者，不降级
    new Notice(t('noticeStandby'));
    this.ensureStandbyPoll();
  }

  /** 写者失去所有权后降级为待机：清理写者 rig 并转为接管轮询 */
  private demoteToStandby(): void {
    if (!this.writerLive) return; // 已在待机
    this.teardownWriter();
    new Notice(t('noticeStandbyLost'));
    this.ensureStandbyPoll();
  }

  /** 待机接管轮询只注册一次 */
  private ensureStandbyPoll(): void {
    if (this.standbyTimer !== null) return;
    this.standbyTimer = window.setInterval(() => void this.tryTakeover(), LOCK_HEARTBEAT_MS);
  }

  /** 待机实例的接管检查：锁被释放或过期则抢占（带回读验证）并升级为写者 */
  private async tryTakeover(): Promise<void> {
    if (this.writerLive) return; // 已是写者
    const existing = await this.readLock();
    if (decideLock(existing, this.deviceId, Date.now()) === 'standby') return;
    if (!(await this.acquireLock())) return;
    await this.initFeed();
  }

  /** 写事件前的所有权校验（check-before-write）；失权则降级待机并返回 false */
  private async checkWriterAlive(): Promise<boolean> {
    const lock = await this.readLock();
    if (verifyOwnership(lock, this.deviceId, Date.now())) return true;
    this.demoteToStandby();
    return false;
  }

  /** 撤销写者 rig（vault 监听 + 定时器），标记为待机；幂等 */
  private teardownWriter(): void {
    for (const ref of this.liveEventRefs) this.app.vault.offref(ref);
    this.liveEventRefs = [];
    for (const id of this.writerTimers) window.clearInterval(id);
    this.writerTimers = [];
    for (const { timer } of this.pendingFolderRenames.values()) window.clearTimeout(timer);
    this.pendingFolderRenames.clear();
    if (this.rescanTimer !== null) {
      window.clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    this.writerLive = false;
  }

  /** 注册写者 rig：vault 变更监听 + 各周期定时器；同时登记到实例字段供动态撤销 */
  private registerWriterRig(): void {
    const trackEvent = (ref: EventRef): void => {
      this.liveEventRefs.push(ref);
      this.registerEvent(ref);
    };
    const trackTimer = (ms: number, fn: () => void): void => {
      const id = window.setInterval(fn, ms);
      this.writerTimers.push(id);
      this.registerInterval(id);
    };
    trackEvent(this.app.vault.on('create', f => void this.onCreate(f)));
    trackEvent(this.app.vault.on('modify', f => void this.onModify(f)));
    trackEvent(this.app.vault.on('delete', f => void this.onDelete(f)));
    trackEvent(this.app.vault.on('rename', (f, oldPath) => void this.onRename(f, oldPath)));
    trackTimer(EVENT_FLUSH_MS, () => void this.flushEvents());
    trackTimer(this.settings.flushIntervalSec * 1000, () =>
      void (async () => {
        await this.flushEvents();
        await this.saveBaseline();
      })(),
    );
    trackTimer(ROTATE_MS, () => void this.rotate());
    // 写者锁条件心跳：证明本实例存活，防止待机实例误接管；失权时不再续写锁
    trackTimer(LOCK_HEARTBEAT_MS, () => void this.writeLock());
  }

  /** 设置变更后的防抖重扫：最后一次变更后延迟执行，避免逐键触发全库扫描 */
  scheduleSettingsRescan(delayMs = 1200): void {
    if (this.rescanTimer !== null) window.clearTimeout(this.rescanTimer);
    this.rescanTimer = window.setTimeout(() => {
      this.rescanTimer = null;
      void this.rescanAfterSettings();
    }, delayMs);
  }

  /**
   * 静默对账：跟踪设置（扩展名/排除/阈值/预算）变更后，让基线立即按新规则重建。
   * 不重放事件——新纳入的文件静默采纳（无 create），新排除的文件静默移除（无 delete，
   * 避免排除目录时产生幽灵删除）；扫描窗口内的竞态变更由后续 live 事件自然覆盖。
   * 防抖 + 串行保护；待机或失权时跳过（接管后的 initFeed 会按新设置对账）。
   */
  private async rescanAfterSettings(): Promise<void> {
    if (this.rescanRunning || !this.feed) return;
    if (!(await this.checkWriterAlive())) return;
    this.rescanRunning = true;
    try {
      await this.flushEvents();
      const snapshots = await this.scanVault();
      this.baseline = baselineFromSnapshots(snapshots);
      this.baselineContentBytes = 0;
      for (const e of this.baseline.values()) this.baselineContentBytes += entryContentBytes(e);
      this.baselineDirty = true;
      await this.saveBaseline();
      new Notice(t('noticeSettingsRescanned'));
    } catch (err) {
      console.error('vault-change-feed settings rescan failed', err);
    } finally {
      this.rescanRunning = false;
    }
  }

  /** 收集云同步检测信号；桌面/移动端兼容，单项失败降级不误判 */
  private async collectSyncSignals(): Promise<SyncSignals> {
    let basePath: string | null = null;
    try {
      basePath = (this.app.vault.adapter as any).getBasePath() as string;
    } catch {
      basePath = null;
    }
    let obsidianSyncEnabled = false;
    try {
      obsidianSyncEnabled = (this.app as any).internalPlugins?.plugins?.sync?.enabled === true;
    } catch {
      obsidianSyncEnabled = false;
    }
    const hasStFolder = await this.app.vault.adapter.exists('.stfolder');
    const hasGit = await this.app.vault.adapter.exists('.git');
    return { basePath, obsidianSyncEnabled, hasStFolder, hasGit };
  }

  private async initFeed(): Promise<void> {
    // 幂等：接管场景下可能残留 rig / 轮询定时器，先清理再初始化
    this.teardownWriter();
    if (this.standbyTimer !== null) {
      window.clearInterval(this.standbyTimer);
      this.standbyTimer = null;
    }
    // 清理崩溃/同步中断遗留的孤儿 .tmp（Windows rename 失败、同步副本等场景）
    await this.cleanupOrphanTmp();

    // seq 恢复：无条件与日志尾部取 max，防 data.json 回退导致编号倒退
    const r = await readLog(this.io, LOG_FILE);
    this.lastSeq = Math.max(this.lastSeq, r.maxSeq ?? 0);
    this.feed = new EventFeed(this.lastSeq);

    // 载入基线；缺失（首跑）或损坏都走 resync：静默重建基线 + 一条 resync 事件
    let oldBaseline: Baseline | null = null;
    if (await this.io.exists(BASELINE_FILE)) {
      try {
        oldBaseline = await parseBaseline(await this.io.readBinary(BASELINE_FILE));
      } catch {
        oldBaseline = null;
        new Notice(t('noticeBaselineCorrupted'));
      }
    }

    // 有旧基线时启动扫描可跳过 size+mtime 未变的文件（预筛免全量重读）
    const snapshots = await this.scanVault(oldBaseline !== null, oldBaseline);

    if (this.settings.recordingPaused) {
      // 暂停窗口跨重启：静默采纳当前快照为基线，不重放暂停期间的变更事件
      this.baseline = baselineFromSnapshots(snapshots);
    } else if (oldBaseline === null) {
      this.baseline = baselineFromSnapshots(snapshots);
      this.feed.push('resync', '', { source: 'system', stat: null });
    } else {
      const { events, baseline } = reconcile(oldBaseline, snapshots, this.feed.peekNextSeq(), Date.now());
      this.baseline = baseline;
      for (const e of events) this.feed.pushLoaded(e);
    }

    // 预算计数器：对账后基线才是最新状态，全量重算一次，之后增量维护
    this.baselineContentBytes = 0;
    for (const e of this.baseline.values()) this.baselineContentBytes += entryContentBytes(e);

    // 云同步检测：多端同步环境下尤其要避免多实例写入；只提示一次
    const syncDetected = detectSync(await this.collectSyncSignals());
    if (syncDetected.length > 0 && !this.syncNoticeShown) {
      new Notice(t('noticeSyncDetected', { kinds: syncDetected.join(', ') }), 10000);
      this.syncNoticeShown = true;
      await this.saveData(this.persistedData());
    }

    this.baselineDirty = true;
    await this.flushEvents();
    await this.saveBaseline();
    await this.rotate();

    // 对账完成后再注册监听，缩小竞态窗口；注册完才标记为活跃写者
    this.registerWriterRig();
    this.writerLive = true;

    // 首次运行引导：autoInstallProtocol 开则自动写入缺失的协议块（无块才写，已有块不动）；
    // 关则退回旧的 Notice 提示；无论走哪条路只执行一次
    if (!this.protocolNoticeShown) {
      if (this.settings.autoInstallProtocol) {
        try {
          const installed: string[] = [];
          for (const path of this.protocolTargets()) {
            const content = await this.readVaultFileOrNull(path);
            if (content === null || !hasBlock(content)) {
              this.suppressProtocolWrite(path);
              await this.app.vault.adapter.write(path, upsertBlock(content, renderProtocolBlock(this.app.vault.configDir)));
              installed.push(path);
            }
          }
          if (installed.length > 0) {
            this.lastProtocolVersion = this.manifest.version;
            new Notice(t('noticeAutoInstalled', { files: installed.join(', ') }), 10000);
          }
        } catch (err) {
          new Notice(t('noticeAutoInstallFailed'));
          console.error('vault-change-feed auto-install failed', err);
        }
      } else if (!(await this.hasAnyProtocolBlock([...PROTOCOL_FILES]))) {
        new Notice(t('noticeFirstRunGuide'), 10000);
      }
      this.protocolNoticeShown = true;
      await this.saveData(this.persistedData());
    }

    // 插件升级后自动刷新已安装的协议块；onlyExisting：只刷新已有块的文件，不创建新文件
    if (this.settings.autoSyncProtocol && this.lastProtocolVersion !== this.manifest.version) {
      if (await this.hasAnyProtocolBlock(this.protocolTargets())) {
        await this.installProtocol(true);
      }
    }
  }

  /** 启用的协议块目标文件（vault 根目录）；Gemini CLI 已支持 AGENTS.md，不再单列 GEMINI.md */
  private protocolTargets(): string[] {
    const targets: string[] = [];
    if (this.settings.syncAgentsMd) targets.push('AGENTS.md');
    if (this.settings.syncClaudeMd) targets.push('CLAUDE.md');
    return targets;
  }

  /** 读 vault 根文件；不存在返回 null。必须走 adapter 让 Obsidian 感知变更 */
  private async readVaultFileOrNull(path: string): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) return null;
    return adapter.read(path);
  }

  private async hasAnyProtocolBlock(paths: string[]): Promise<boolean> {
    for (const p of paths) {
      const content = await this.readVaultFileOrNull(p);
      if (content !== null && hasBlock(content)) return true;
    }
    return false;
  }

  /** 登记一次自激写入抑制（默认 60s 窗口，覆盖 adapter 事件到达 + flush 周期） */
  private suppressProtocolWrite(path: string, windowMs = 60_000): void {
    this.suppressedWrites.set(path, Date.now() + windowMs);
  }

  /** path 是否处于自激写入抑制窗口；过期条目顺带清理 */
  private isSuppressed(path: string): boolean {
    const expiry = this.suppressedWrites.get(path);
    if (expiry === undefined) return false;
    if (expiry > Date.now()) return true;
    this.suppressedWrites.delete(path);
    return false;
  }

  /** 无条件把协议块 upsert 到指定文件（install 命令 / 自动同步的刷新语义） */
  private async writeProtocolFile(path: string): Promise<void> {
    const content = await this.readVaultFileOrNull(path);
    this.suppressProtocolWrite(path);
    await this.app.vault.adapter.write(path, upsertBlock(content, renderProtocolBlock(this.app.vault.configDir)));
  }

  /**
   * 把协议块 upsert 到每个启用的目标文件（幂等）。
   * onlyExisting 为 true 时只刷新 hasBlock 已为真的文件（自动同步路径用），其余跳过。
   */
  private async installProtocol(onlyExisting = false): Promise<void> {
    try {
      const written: string[] = [];
      for (const path of this.protocolTargets()) {
        if (onlyExisting) {
          const content = await this.readVaultFileOrNull(path);
          if (content === null || !hasBlock(content)) continue;
        }
        await this.writeProtocolFile(path);
        written.push(path);
      }
      this.lastProtocolVersion = this.manifest.version;
      await this.saveData(this.persistedData());
      new Notice(
        written.length > 0
          ? t('noticeInstalled', { files: written.join(', ') })
          : onlyExisting
            ? t('noticeUpToDate')
            : t('noticeNoTarget'),
      );
    } catch (err) {
      new Notice(t('noticeProtocolFailed'));
      console.error('vault-change-feed installProtocol failed', err);
    }
  }

  /** 从两个公约文件移除协议块（无论启用与否，移除要彻底）；文件只剩块则删文件 */
  private async removeProtocol(): Promise<void> {
    try {
      const removed: string[] = [];
      for (const path of PROTOCOL_FILES) {
        const content = await this.readVaultFileOrNull(path);
        if (content === null || !hasBlock(content)) continue;
        const rest = removeBlock(content);
        if (rest.trim().length === 0) {
          this.suppressProtocolWrite(path);
          await this.app.vault.adapter.remove(path);
          removed.push(t('fileDeleted', { path }));
        } else {
          this.suppressProtocolWrite(path);
          await this.app.vault.adapter.write(path, rest);
          removed.push(path);
        }
      }
      new Notice(
        removed.length > 0
          ? t('noticeRemoved', { files: removed.join(', ') })
          : t('noticeNoBlockFound'),
      );
    } catch (err) {
      new Notice(t('noticeProtocolFailed'));
      console.error('vault-change-feed removeProtocol failed', err);
    }
  }

  /** 清理已知的孤儿 .tmp（原子写中断/同步遗留）；单个失败忽略 */
  private async cleanupOrphanTmp(): Promise<void> {
    for (const base of [LOG_FILE, CURSORS_FILE, FEED_STATE_FILE]) {
      try {
        const p = `${base}.tmp`;
        if (await this.io.exists(p)) await this.io.remove(p);
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 扫描 vault 生成快照；读不到的文件（iCloud 占位等）跳过，下轮对账再试。
   * skipUnchanged=true 时，若旧基线中存在 size+mtime 均未变的文本条目，直接复用其
   * hash/content 跳过 cachedRead——绝大多数启动只做 stat 不读文件。
   * refBaseline 仅供预筛比对（initFeed 传旧基线）；rescan 路径传 false 强制全读。
   */
  private async scanVault(skipUnchanged = false, refBaseline: Baseline | null = null): Promise<FileSnapshot[]> {
    const opts = this.excludeOpts();
    const capBytes = this.settings.largeFileKb * 1024;
    const budgetBytes = this.settings.baselineContentBudgetKb * 1024;
    let usedBytes = 0;
    const out: FileSnapshot[] = [];
    for (const f of this.app.vault.getFiles()) {
      if (isExcluded(f.path, opts)) continue;
      if (isTextFile(f.path, opts.trackedExtensions) && f.stat.size <= capBytes) {
        // 预筛：未变文本文件直接复用基线条目，跳过内容读取
        if (skipUnchanged && refBaseline !== null) {
          const prev = refBaseline.get(f.path);
          if (prev !== undefined && isEntryUnchanged(prev, f.stat.size, f.stat.mtime)) {
            out.push({
              path: f.path,
              hash: prev.hash,
              content: prev.content,
              size: f.stat.size,
              mtime: f.stat.mtime,
            });
            usedBytes += entryContentBytes(prev);
            continue;
          }
        }
        try {
          const content = await this.app.vault.cachedRead(f);
          // 预算决策快照 content：超预算只存哈希（hash 仍按全文算，变更检测不受影响）
          const entry = makeTextEntryBudgeted(content, usedBytes, budgetBytes, f.stat.size, f.stat.mtime);
          out.push({ path: f.path, hash: entry.hash, content: entry.content, size: f.stat.size, mtime: f.stat.mtime });
          usedBytes += entryContentBytes(entry);
        } catch {
          // iCloud 占位文件等：跳过
        }
      } else {
        out.push({
          path: f.path,
          hash: makeBinaryEntry(f.stat.size, f.stat.mtime).hash,
          content: null,
          size: f.stat.size,
          mtime: f.stat.mtime,
        });
      }
    }
    return out;
  }

  private shouldTrackText(f: TFile): boolean {
    const opts = this.excludeOpts();
    return (
      !isExcluded(f.path, opts) &&
      isTextFile(f.path, opts.trackedExtensions) &&
      f.stat.size <= this.settings.largeFileKb * 1024
    );
  }

  private isExcludedPath(path: string): boolean {
    return isExcluded(path, this.excludeOpts());
  }

  /** 当前是否处于记录状态（Pause recording 关闭时暂停产生事件） */
  private recording(): boolean {
    return !this.settings.recordingPaused;
  }

  /** 切换暂停并落盘；随后把已排队事件冲刷掉，保证暂停边界干净 */
  private async setRecordingPaused(paused: boolean): Promise<void> {
    if (this.settings.recordingPaused === paused) return;
    this.settings.recordingPaused = paused;
    await this.saveSettings();
    await this.flushEvents();
    this.updateStatusBar();
  }

  private async pauseRecording(): Promise<void> {
    await this.setRecordingPaused(true);
    new Notice(t('noticePaused'));
  }

  private async resumeRecording(): Promise<void> {
    await this.setRecordingPaused(false);
    new Notice(t('noticeResumed'));
  }

  private async onCreate(f: TAbstractFile): Promise<void> {
    if (!(f instanceof TFile) || this.isExcludedPath(f.path)) return;
    // 自激写入（协议块安装/刷新）命中抑制窗口：更新基线但不推事件
    const suppressed = this.isSuppressed(f.path);
    const record = this.recording() && !suppressed;
    try {
      if (this.shouldTrackText(f)) {
        const content = await this.app.vault.cachedRead(f);
        const old = this.baseline.get(f.path);
        if (old) this.baselineContentBytes -= entryContentBytes(old);
        const entry = makeTextEntryBudgeted(
          content,
          this.baselineContentBytes,
          this.settings.baselineContentBudgetKb * 1024,
          f.stat.size,
          f.stat.mtime,
        );
        this.baseline.set(f.path, entry);
        this.baselineContentBytes += entryContentBytes(entry);
        if (record) this.feed.push('create', f.path, { stat: { added: countLines(content), removed: 0 } });
      } else {
        const old = this.baseline.get(f.path);
        if (old) this.baselineContentBytes -= entryContentBytes(old);
        this.baseline.set(f.path, makeBinaryEntry(f.stat.size, f.stat.mtime));
        if (record) this.feed.push('create', f.path, { stat: null });
      }
      this.baselineDirty = true;
    } catch {
      // iCloud 占位文件，下次启动对账兜底
    }
  }

  private async onModify(f: TAbstractFile): Promise<void> {
    if (!(f instanceof TFile) || this.isExcludedPath(f.path)) return;
    const suppressed = this.isSuppressed(f.path);
    const record = this.recording() && !suppressed;
    try {
      if (this.shouldTrackText(f)) {
        const content = await this.app.vault.cachedRead(f);
        const old = this.baseline.get(f.path);
        const stat = old && old.content !== null ? lineStat(old.content, content) : null;
        if (old) this.baselineContentBytes -= entryContentBytes(old);
        const entry = makeTextEntryBudgeted(
          content,
          this.baselineContentBytes,
          this.settings.baselineContentBudgetKb * 1024,
          f.stat.size,
          f.stat.mtime,
        );
        this.baseline.set(f.path, entry);
        this.baselineContentBytes += entryContentBytes(entry);
        if (record) this.feed.push('modify', f.path, { stat });
      } else {
        const old = this.baseline.get(f.path);
        if (old) this.baselineContentBytes -= entryContentBytes(old);
        this.baseline.set(f.path, makeBinaryEntry(f.stat.size, f.stat.mtime));
        if (record) this.feed.push('modify', f.path, { stat: null });
      }
      this.baselineDirty = true;
    } catch {
      // iCloud 占位文件，下次启动对账兜底
    }
  }

  private onDelete(f: TAbstractFile): void {
    if (!(f instanceof TFile) || this.isExcludedPath(f.path)) return;
    const suppressed = this.isSuppressed(f.path);
    const record = this.recording() && !suppressed;
    const old = this.baseline.get(f.path);
    const stat = old && old.content !== null ? { added: 0, removed: countLines(old.content) } : null;
    if (old) this.baselineContentBytes -= entryContentBytes(old);
    this.baseline.delete(f.path);
    if (record) this.feed.push('delete', f.path, { stat });
    this.baselineDirty = true;
  }

  private onRename(f: TAbstractFile, oldPath: string): void {
    if (f instanceof TFolder) {
      // Obsidian 移动文件夹时是否逐个派发子文件 rename 事件因实现而异：文件夹事件
      // 到达后先等一个短窗口（子文件若会单独上报，其处理器会把基线条目移走）；
      // 窗口结束时仍停留在旧前缀下的条目说明没有被单独上报，由这里统一展开补记。
      const oldFolder = oldPath.replace(/\/+$/, '');
      if (this.baseline.size === 0) return;
      const hasChildren = [...this.baseline.keys()].some(p => p.startsWith(oldFolder + '/'));
      if (!hasChildren) return;
      const prev = this.pendingFolderRenames.get(oldFolder);
      if (prev) window.clearTimeout(prev.timer);
      const timer = window.setTimeout(() => void this.flushFolderRename(oldFolder, f.path), 250);
      this.pendingFolderRenames.set(oldFolder, { newPath: f.path, timer });
      return;
    }
    if (!(f instanceof TFile)) return;
    this.applyFileRename(oldPath, f.path);
  }

  /** 单个文件的基线迁移与事件（TFile 事件与文件夹展开共用；语义与原实现一致） */
  private applyFileRename(oldPath: string, newPath: string): void {
    const oldExcluded = this.isExcludedPath(oldPath);
    const newExcluded = this.isExcludedPath(newPath);
    if (oldExcluded && newExcluded) return;
    const entry = this.baseline.get(oldPath);
    if (entry) {
      this.baseline.delete(oldPath);
      // 新路径被排除时不移动基线条目，否则下次对账会把排除路径当失踪文件产生幽灵 delete
      if (!newExcluded) this.baseline.set(newPath, entry);
      this.baselineDirty = true;
    } else if (!oldExcluded && !newExcluded && this.baseline.has(newPath)) {
      // 文件夹展开已迁移过该条目（迟到的子文件事件）→ 去重，不再重复上报
      return;
    }
    if (!this.recording()) return; // 暂停：只迁移基线，不产生事件
    if (oldExcluded) {
      this.feed.push('create', newPath, { stat: null });
    } else if (newExcluded) {
      this.feed.push('delete', oldPath, { stat: null });
    } else {
      this.feed.push('rename', newPath, { oldPath, stat: { added: 0, removed: 0 } });
    }
  }

  /** 文件夹重命名窗口到期：把仍停留在旧前缀下的受跟踪条目统一迁移并补记 rename */
  private async flushFolderRename(oldFolder: string, newFolder: string): Promise<void> {
    this.pendingFolderRenames.delete(oldFolder);
    if (!this.writerLive) return; // 已降级/待机：交给接管实例的启动对账
    const newFolderNorm = newFolder.replace(/\/+$/, '');
    // 收集时迭代快照，避免迁移过程改动 Map 影响遍历
    const pending = [...this.baseline.keys()].filter(p => p.startsWith(oldFolder + '/'));
    for (const path of pending) {
      if (!this.baseline.has(path)) continue; // 窗口内已被单独处理
      this.applyFileRename(path, newFolderNorm + path.slice(oldFolder.length));
    }
    this.baselineDirty = true;
  }

  private async flushEvents(): Promise<void> {
    if (!this.feed || this.feed.pending === 0) return;
    // check-before-write：失权则不落盘（队列丢弃，接管实例的启动对账会兜底）
    if (!(await this.checkWriterAlive())) return;
    const events = this.feed.drain();
    try {
      await appendEvents(this.io, LOG_FILE, events);
      this.lastSeq = Math.max(this.lastSeq, events[events.length - 1].seq);
      await this.saveData(this.persistedData());
      // 增量维护 feed-state（min 以内存态为准；rotate 会全量重算修正）
      if (this.feedState.minSeq === null) this.feedState.minSeq = events[0].seq;
      this.feedState.maxSeq = events[events.length - 1].seq;
      this.feedState.count += events.length;
      this.feedState.updatedAt = Date.now();
      await this.persistFeedState();
      // 状态栏活动灯：仅当本批含用户编辑产生的 live 事件（启动对账的 reconcile/system 不亮灯）
      if (events.some(e => e.source === 'live')) {
        this.activityAt = Date.now();
        this.updateStatusBar();
      }
    } catch (err) {
      // 失败重入队列，下轮重试
      for (const e of events) this.feed.pushLoaded(e);
      new Notice(t('noticeFlushFailed'));
      console.error('vault-change-feed flush failed', err);
    }
  }

  /** feed-state 写入（加速端点，失败静默不影响主链路） */
  private async persistFeedState(): Promise<void> {
    try {
      await writeFeedState(this.io, FEED_STATE_FILE, this.feedState);
    } catch {
      // 忽略：状态文件非关键路径
    }
  }

  /** 依据当前日志全量重算 feed-state（init / rotate 后调用，修正增量维护的 min/count） */
  private async refreshFeedState(): Promise<void> {
    try {
      const r = await readLog(this.io, LOG_FILE);
      this.feedState = buildFeedState({ minSeq: r.minSeq, maxSeq: r.maxSeq, count: r.events.length });
      await this.persistFeedState();
    } catch {
      // 忽略
    }
  }

  private async saveBaseline(): Promise<void> {
    if (!this.baselineDirty) return;
    if (this.feed && !(await this.checkWriterAlive())) return;
    await this.io.writeBinary(BASELINE_FILE, await serializeBaseline(this.baseline));
    this.baselineDirty = false;
  }

  private async rotate(): Promise<void> {
    if (!this.feed) return;
    if (!(await this.checkWriterAlive())) return;
    try {
      await rotateIfNeeded(
        this.io,
        LOG_FILE,
        this.settings.retentionMaxEntries,
        this.settings.retentionDays,
        Date.now(),
      );
      await this.refreshFeedState();
    } catch (err) {
      console.error('vault-change-feed rotate failed', err);
    }
  }

  /** 搭建状态栏：图标 + 标签 + 活动指示灯；点击弹快捷菜单 */
  private setupStatusBar(): void {
    const el = this.addStatusBarItem();
    el.empty();
    el.style.display = 'inline-flex';
    el.style.alignItems = 'center';
    el.style.gap = '4px';
    el.style.cursor = 'pointer';
    const icon = el.createSpan();
    icon.innerHTML = STATUS_ICON_SVG;
    const svg = icon.querySelector('svg');
    if (svg) {
      svg.style.display = 'block';
      svg.style.width = '11px';
      svg.style.height = '11px';
    }
    this.statusLabelEl = el.createSpan({ text: 'VCF' });
    this.statusDotEl = el.createSpan({ text: '●' });
    this.statusDotEl.style.color = 'var(--interactive-accent)';
    this.statusDotEl.style.fontSize = '9px';
    this.statusDotEl.style.lineHeight = '1';
    this.statusDotEl.style.display = 'none';
    el.addEventListener('click', ev => this.showStatusMenu(ev));
    this.statusBarEl = el;
  }

  /** 状态栏刷新：纯文本模式（写者/暂停/待机）+ 活动指示灯 + 详情 tooltip */
  private updateStatusBar(): void {
    const label = this.statusLabelEl;
    if (!label) return;
    if (this.writerLive) {
      if (this.settings.recordingPaused) {
        label.textContent = 'VCF · paused';
        label.title = t('statusPausedTooltip');
      } else {
        label.textContent = 'VCF';
        label.title = `${t('statusWriterTooltip')} · ${this.feedState.count} events`;
      }
    } else if (this.standbyTimer !== null) {
      label.textContent = 'VCF · standby';
      label.title = t('statusStandbyTooltip');
    } else {
      label.textContent = 'VCF';
      label.title = t('statusIdleTooltip');
    }
    // 活动灯：最近 10s 内有 live 变更落盘 → 点亮
    const dot = this.statusDotEl;
    if (dot) {
      dot.style.display =
        this.writerLive && !this.settings.recordingPaused && Date.now() - this.activityAt < ACTIVITY_DOT_MS
          ? 'inline-block'
          : 'none';
    }
  }

  /** 点击状态栏：弹出快捷菜单（等价 Cmd+P 内的常用命令） */
  private showStatusMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(item =>
      item.setTitle(t('cmdBrowse')).onClick(() => void this.browseEvents()),
    );
    menu.addItem(item =>
      item.setTitle(t('cmdHealth')).onClick(() => void this.checkFeedHealth()),
    );
    menu.addItem(item =>
      item
        .setTitle(this.settings.recordingPaused ? t('cmdResume') : t('cmdPause'))
        .onClick(() =>
          void (this.settings.recordingPaused ? this.resumeRecording() : this.pauseRecording()),
        ),
    );
    menu.addItem(item =>
      item.setTitle(t('cmdCopyUnread')).onClick(() => void this.copyUnread()),
    );
    menu.showAtMouseEvent(event);
  }

  /** 事件浏览器：最近 400 条原始事件，按路径筛选 */
  private async browseEvents(): Promise<void> {
    try {
      const { events } = await readLog(this.io, LOG_FILE);
      const sorted = [...events].sort((a, b) => a.seq - b.seq);
      new FeedBrowserModal(this.app, sorted.slice(-400)).open();
    } catch (err) {
      new Notice(t('noticeBrowseFailed'));
      console.error('vault-change-feed browse failed', err);
    }
  }

  /** Check feed health：解析日志/游标/状态文件并弹出报告 */
  private async checkFeedHealth(): Promise<void> {
    try {
      const { events } = await readLog(this.io, LOG_FILE);
      const cursors = await readCursors(this.io, CURSORS_FILE);
      const h = analyzeFeedHealth(events, cursors);

      let stateLine = 'feed-state.json: not present';
      if (await this.io.exists(FEED_STATE_FILE)) {
        const parsed = parseFeedState(await this.io.read(FEED_STATE_FILE));
        stateLine = parsed
          ? `feed-state.json: ok (max=${parsed.maxSeq}, count=${parsed.count})${parsed.maxSeq === h.maxSeq ? '' : ' — WARN: maxSeq differs from log!'}`
          : 'feed-state.json: unreadable/invalid';
      }

      const issues: string[] = [];
      if (h.duplicateSeqs > 0) issues.push(`duplicate seq pairs: ${h.duplicateSeqs}`);
      if (h.descendingPairs > 0) issues.push(`out-of-order seq pairs: ${h.descendingPairs}`);
      if (h.readersAhead > 0) issues.push(`readers with cursor > maxSeq: ${h.readersAhead}`);
      if (h.total === 0) issues.push('log is empty (normal on first run)');

      const lines = [
        `changelog.jsonl: ${h.total} events, seq range [${h.minSeq ?? '-'}..${h.maxSeq ?? '-'}]`,
        `seq continuity: ${h.missingSeqs} missing number(s)${h.missingSeqs > 0 ? ' (log rotation may truncate — informational)' : ''}`,
        `cursors.json: ${h.readers} reader(s), ${h.readersAhead} ahead of log`,
        stateLine,
      ];
      if (issues.length > 0) lines.push('', 'Issues:', ...issues);

      new FeedHealthModal(this.app, lines.join('\n')).open();
      new Notice(
        issues.length > 0 ? t('noticeHealthIssues', { n: issues.length }) : t('noticeHealthOk'),
        issues.length > 0 ? 8000 : 3000,
      );
    } catch (err) {
      new Notice(t('noticeHealthFailed'));
      console.error('vault-change-feed health check failed', err);
    }
  }

  private async copyUnread(): Promise<void> {
    const MAX_COPY_EVENTS = 2000;
    const res = await getChanges(this.io, this.feedPaths(), 'manual');
    const truncated = res.events.length > MAX_COPY_EVENTS;
    const shown = truncated ? res.events.slice(0, MAX_COPY_EVENTS) : res.events;
    const header = res.stale ? 'STALE: log truncated, full vault rescan advised.\n' : '';
    const body = shown.length > 0 ? formatEvents(shown) : '(no changes)';
    const tail = truncated
      ? `\n…and ${res.events.length - shown.length} merged change(s) remain unread (clipboard cap ${MAX_COPY_EVENTS}).`
      : '';
    await navigator.clipboard.writeText(header + body + tail);
    // 与 hook 同策略：只把已复制部分标记已读，剩余下次命令继续消费
    await markRead(this.io, this.feedPaths(), 'manual', truncated ? shown[shown.length - 1].seq : res.latestSeq);
    new Notice(
      truncated ? t('noticeCopiedTruncated', { count: shown.length }) : t('noticeCopied', { count: res.events.length }),
    );
  }

  onunload(): void {
    // 尽力而为：插件卸载时把队列与基线落盘，最后释放写者锁（fire-and-forget）
    void (async () => {
      if (this.writerLive) {
        await this.flushEvents();
        if (this.baselineDirty) await this.saveBaseline();
      }
      // 只有仍持有锁的写者才清理锁文件；锁已易主时不删，避免破坏接管实例
      const lock = await this.readLock();
      if (lock !== null && lock.deviceId === this.deviceId) {
        try {
          await this.io.remove(LOCK_FILE);
        } catch {
          // 锁清理失败不管
        }
      }
    })();
  }

  private persistedData(): PersistedData {
    return {
      settings: this.settings,
      lastSeq: this.lastSeq,
      lastProtocolVersion: this.lastProtocolVersion,
      protocolNoticeShown: this.protocolNoticeShown,
      deviceId: this.deviceId,
      syncNoticeShown: this.syncNoticeShown,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.persistedData());
  }
}

/** feed 健康报告弹窗 */
class FeedHealthModal extends Modal {
  constructor(app: App, private report: string) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: t('healthTitle') });
    const pre = contentEl.createEl('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.userSelect = 'text';
    pre.setText(this.report);
    const btn = contentEl.createEl('button', { text: t('healthClose') });
    btn.style.marginTop = '12px';
    btn.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 事件浏览器弹窗：最近事件 + 路径筛选 */
class FeedBrowserModal extends Modal {
  private filter = '';

  constructor(app: App, private events: ChangeEvent[]) {
    super(app);
    this.setTitle(t('browseTitle'));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const input = contentEl.createEl('input', { type: 'text', placeholder: t('browsePlaceholder') });
    input.style.width = '100%';
    input.style.marginBottom = '8px';
    const pre = contentEl.createEl('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.userSelect = 'text';
    pre.style.maxHeight = '60vh';
    pre.style.overflow = 'auto';
    const render = (): void => {
      const q = this.filter.trim().toLowerCase();
      const shown = q ? this.events.filter(e => e.path.toLowerCase().includes(q)) : this.events;
      const rows = formatEvents(shown);
      pre.setText(`${shown.length} / ${this.events.length} events\n${rows}`);
    };
    input.addEventListener('input', () => {
      this.filter = input.value;
      render();
    });
    render();
    const closeBtn = contentEl.createEl('button', { text: t('healthClose') });
    closeBtn.style.marginTop = '12px';
    closeBtn.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class VaultChangeFeedSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VaultChangeFeedPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName(t('sTrackedExtsName'))
      .setDesc(t('sTrackedExtsDesc'))
      .addText(t =>
        t.setValue(s.trackedExtensions).onChange(async v => {
          s.trackedExtensions = v;
          await this.plugin.saveSettings();
          this.plugin.scheduleSettingsRescan();
        }),
      );

    new Setting(containerEl)
      .setName(t('sExcludeGlobsName'))
      .setDesc(t('sExcludeGlobsDesc'))
      .addTextArea(t =>
        t.setValue(s.excludeGlobs).onChange(async v => {
          s.excludeGlobs = v;
          await this.plugin.saveSettings();
          this.plugin.scheduleSettingsRescan();
        }),
      );

    new Setting(containerEl)
      .setName(t('sLargeFileName'))
      .setDesc(t('sLargeFileDesc'))
      .addText(t =>
        t.setValue(String(s.largeFileKb)).onChange(async v => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            s.largeFileKb = n;
            await this.plugin.saveSettings();
            this.plugin.scheduleSettingsRescan();
          }
        }),
      );

    new Setting(containerEl)
      .setName(t('sBudgetName'))
      .setDesc(t('sBudgetDesc'))
      .addText(t =>
        t.setValue(String(s.baselineContentBudgetKb)).onChange(async v => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            s.baselineContentBudgetKb = n;
            await this.plugin.saveSettings();
            this.plugin.scheduleSettingsRescan();
          }
        }),
      );

    new Setting(containerEl)
      .setName(t('sRetentionDaysName'))
      .setDesc(t('sRetentionDaysDesc'))
      .addText(t =>
        t.setValue(String(s.retentionDays)).onChange(async v => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            s.retentionDays = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName(t('sRetentionMaxName'))
      .setDesc(t('sRetentionMaxDesc'))
      .addText(t =>
        t.setValue(String(s.retentionMaxEntries)).onChange(async v => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 100) {
            s.retentionMaxEntries = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName(t('sFlushIntervalName'))
      .setDesc(t('sFlushIntervalDesc'))
      .addText(t =>
        t.setValue(String(s.flushIntervalSec)).onChange(async v => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 30) {
            s.flushIntervalSec = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName(t('sAutoInstallName'))
      .setDesc(t('sAutoInstallDesc'))
      .addToggle(t =>
        t.setValue(s.autoInstallProtocol).onChange(async v => {
          s.autoInstallProtocol = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t('sSyncAgentsName'))
      .setDesc(t('sSyncAgentsDesc'))
      .addToggle(t =>
        t.setValue(s.syncAgentsMd).onChange(async v => {
          s.syncAgentsMd = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t('sSyncClaudeName'))
      .setDesc(t('sSyncClaudeDesc'))
      .addToggle(t =>
        t.setValue(s.syncClaudeMd).onChange(async v => {
          s.syncClaudeMd = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t('sAutoSyncName'))
      .setDesc(t('sAutoSyncDesc'))
      .addToggle(t =>
        t.setValue(s.autoSyncProtocol).onChange(async v => {
          s.autoSyncProtocol = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
