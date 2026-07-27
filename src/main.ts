import { App, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile } from 'obsidian';
import * as fs from 'fs/promises';
import * as nodePath from 'path';
import { FileIO } from './core/fileio';
import { Baseline, makeTextEntry, makeBinaryEntry, serializeBaseline, parseBaseline, countLines } from './core/baseline';
import { hashContent } from './core/hash';
import { lineStat } from './core/diff';
import { isExcluded, isTextFile, ExcludeOptions } from './core/exclude';
import { reconcile, FileSnapshot } from './core/reconcile';
import { readLog, appendEvents, rotateIfNeeded } from './core/logStore';
import { EventFeed } from './core/feed';
import { hasBlock, upsertBlock, removeBlock } from './core/protocolBlock';
import { renderProtocolBlock } from './core/protocolTemplate';
import { getChanges, markRead, formatEvents, FeedPaths, GetChangesOptions } from './protocol';
import {
  VaultChangeFeedSettings,
  DEFAULT_SETTINGS,
  parseExtensions,
  parseGlobs,
} from './settings';

const LOG_FILE = 'changelog.jsonl';
const CURSORS_FILE = 'cursors.json';
const BASELINE_FILE = 'baseline.gz';
const EVENT_FLUSH_MS = 3000;
const ROTATE_MS = 3600_000;
/** AI agent 约定俗成的发现点（vault 根目录） */
const PROTOCOL_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

class NodeFileIO implements FileIO {
  constructor(private baseDir: string) {}
  private abs(p: string): string {
    return nodePath.join(this.baseDir, p);
  }
  async exists(p: string): Promise<boolean> {
    try {
      await fs.access(this.abs(p));
      return true;
    } catch {
      return false;
    }
  }
  async read(p: string): Promise<string> {
    return fs.readFile(this.abs(p), 'utf8');
  }
  async readBinary(p: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(this.abs(p)));
  }
  async write(p: string, data: string): Promise<void> {
    await fs.writeFile(this.abs(p), data, 'utf8');
  }
  async writeBinary(p: string, data: Uint8Array): Promise<void> {
    await fs.writeFile(this.abs(p), data);
  }
  async append(p: string, data: string): Promise<void> {
    await fs.appendFile(this.abs(p), data, 'utf8');
  }
  async rename(o: string, n: string): Promise<void> {
    await fs.rename(this.abs(o), this.abs(n));
  }
  async mkdirp(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }
}

interface PersistedData {
  settings: VaultChangeFeedSettings;
  lastSeq: number;
  /** 上次写入协议块时的插件版本（未安装过为 undefined） */
  lastProtocolVersion?: string;
  /** 首次运行引导 Notice 是否已展示过 */
  protocolNoticeShown?: boolean;
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

  async onload(): Promise<void> {
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.lastSeq = typeof data?.lastSeq === 'number' ? data.lastSeq : 0;
    if (typeof data?.lastProtocolVersion === 'string') this.lastProtocolVersion = data.lastProtocolVersion;
    this.protocolNoticeShown = data?.protocolNoticeShown === true;

    const basePath = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
    const dataDir = nodePath.join(basePath, this.app.vault.configDir, 'plugins', this.manifest.id);
    this.io = new NodeFileIO(dataDir);
    await this.io.mkdirp();

    this.addSettingTab(new VaultChangeFeedSettingTab(this.app, this));
    this.addCommand({
      id: 'copy-unread-for-ai',
      name: 'Copy unread changes for AI',
      callback: () => void this.copyUnread(),
    });
    this.addCommand({
      id: 'install-ai-protocol',
      name: 'Install AI protocol for agents',
      callback: () => void this.installProtocol(),
    });
    this.addCommand({
      id: 'remove-ai-protocol',
      name: 'Remove AI protocol from agent files',
      callback: () => void this.removeProtocol(),
    });

    // vault 索引完成后再初始化，避免启动期 create 事件风暴
    this.app.workspace.onLayoutReady(() => void this.initFeed());
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

  private async initFeed(): Promise<void> {
    // seq 恢复：无条件与日志尾部取 max，防 data.json 回退导致编号倒退
    const r = await readLog(this.io, LOG_FILE);
    this.lastSeq = Math.max(this.lastSeq, r.maxSeq ?? 0);
    this.feed = new EventFeed(this.lastSeq);

    // 载入基线；缺失（首跑）或损坏都走 resync：静默重建基线 + 一条 resync 事件
    let oldBaseline: Baseline | null = null;
    if (await this.io.exists(BASELINE_FILE)) {
      try {
        oldBaseline = parseBaseline(await this.io.readBinary(BASELINE_FILE));
      } catch {
        oldBaseline = null;
        new Notice('vault-change-feed: baseline corrupted, rebuilding');
      }
    }

    const snapshots = await this.scanVault();

    if (oldBaseline === null) {
      this.baseline = new Map(snapshots.map(s => [s.path, { hash: s.hash, content: s.content }]));
      this.feed.push('resync', '', { source: 'system', stat: null });
    } else {
      const { events, baseline } = reconcile(oldBaseline, snapshots, this.feed.peekNextSeq(), Date.now());
      this.baseline = baseline;
      for (const e of events) this.feed.pushLoaded(e);
    }
    this.baselineDirty = true;
    await this.flushEvents();
    await this.saveBaseline();
    await this.rotate();

    // 对账完成后再注册监听，缩小竞态窗口
    this.registerEvent(this.app.vault.on('create', f => void this.onCreate(f)));
    this.registerEvent(this.app.vault.on('modify', f => void this.onModify(f)));
    this.registerEvent(this.app.vault.on('delete', f => void this.onDelete(f)));
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => void this.onRename(f, oldPath)));

    this.registerInterval(window.setInterval(() => void this.flushEvents(), EVENT_FLUSH_MS));
    this.registerInterval(
      window.setInterval(
        () => void (async () => { await this.flushEvents(); await this.saveBaseline(); })(),
        this.settings.flushIntervalSec * 1000,
      ),
    );
    this.registerInterval(window.setInterval(() => void this.rotate(), ROTATE_MS));

    // 首次运行引导：两个公约文件都没装过协议块才提示；无论是否提示只检查一次
    if (!this.protocolNoticeShown) {
      if (!(await this.hasAnyProtocolBlock([...PROTOCOL_FILES]))) {
        new Notice(
          'vault-change-feed: run command "Install AI protocol for agents" to let AI agents discover the change feed',
          10000,
        );
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

  /** 启用的协议块目标文件（vault 根目录） */
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

  /**
   * 把协议块 upsert 到每个启用的目标文件（幂等）。
   * onlyExisting 为 true 时只刷新 hasBlock 已为真的文件（自动同步路径用），其余跳过。
   */
  private async installProtocol(onlyExisting = false): Promise<void> {
    try {
      const block = renderProtocolBlock();
      const written: string[] = [];
      for (const path of this.protocolTargets()) {
        const content = await this.readVaultFileOrNull(path);
        if (onlyExisting && (content === null || !hasBlock(content))) continue;
        await this.app.vault.adapter.write(path, upsertBlock(content, block));
        written.push(path);
      }
      this.lastProtocolVersion = this.manifest.version;
      await this.saveData(this.persistedData());
      new Notice(
        written.length > 0
          ? `vault-change-feed: AI protocol installed into ${written.join(', ')}`
          : onlyExisting
            ? 'vault-change-feed: protocol block already up to date'
            : 'vault-change-feed: no target enabled (AGENTS.md / CLAUDE.md both off in settings)',
      );
    } catch (err) {
      new Notice('vault-change-feed: protocol command failed, see console');
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
          await this.app.vault.adapter.remove(path);
          removed.push(`${path} (file deleted)`);
        } else {
          await this.app.vault.adapter.write(path, rest);
          removed.push(path);
        }
      }
      new Notice(
        removed.length > 0
          ? `vault-change-feed: AI protocol removed from ${removed.join(', ')}`
          : 'vault-change-feed: no AI protocol block found in AGENTS.md / CLAUDE.md',
      );
    } catch (err) {
      new Notice('vault-change-feed: protocol command failed, see console');
      console.error('vault-change-feed removeProtocol failed', err);
    }
  }

  /** 扫描 vault 生成快照；读不到的文件（iCloud 占位等）跳过，下轮对账再试 */
  private async scanVault(): Promise<FileSnapshot[]> {
    const opts = this.excludeOpts();
    const capBytes = this.settings.largeFileKb * 1024;
    const out: FileSnapshot[] = [];
    for (const f of this.app.vault.getFiles()) {
      if (isExcluded(f.path, opts)) continue;
      if (isTextFile(f.path, opts.trackedExtensions) && f.stat.size <= capBytes) {
        try {
          const content = await this.app.vault.cachedRead(f);
          out.push({ path: f.path, hash: hashContent(content), content, mtime: f.stat.mtime });
        } catch {
          // iCloud 占位文件等：跳过
        }
      } else {
        out.push({
          path: f.path,
          hash: makeBinaryEntry(f.stat.size, f.stat.mtime).hash,
          content: null,
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

  private async onCreate(f: TAbstractFile): Promise<void> {
    if (!(f instanceof TFile) || this.isExcludedPath(f.path)) return;
    try {
      if (this.shouldTrackText(f)) {
        const content = await this.app.vault.cachedRead(f);
        this.baseline.set(f.path, makeTextEntry(content));
        this.feed.push('create', f.path, { stat: { added: countLines(content), removed: 0 } });
      } else {
        this.baseline.set(f.path, makeBinaryEntry(f.stat.size, f.stat.mtime));
        this.feed.push('create', f.path, { stat: null });
      }
      this.baselineDirty = true;
    } catch {
      // iCloud 占位文件，下次启动对账兜底
    }
  }

  private async onModify(f: TAbstractFile): Promise<void> {
    if (!(f instanceof TFile) || this.isExcludedPath(f.path)) return;
    try {
      if (this.shouldTrackText(f)) {
        const content = await this.app.vault.cachedRead(f);
        const old = this.baseline.get(f.path);
        const stat = old && old.content !== null ? lineStat(old.content, content) : null;
        this.baseline.set(f.path, makeTextEntry(content));
        this.feed.push('modify', f.path, { stat });
      } else {
        this.baseline.set(f.path, makeBinaryEntry(f.stat.size, f.stat.mtime));
        this.feed.push('modify', f.path, { stat: null });
      }
      this.baselineDirty = true;
    } catch {
      // iCloud 占位文件，下次启动对账兜底
    }
  }

  private onDelete(f: TAbstractFile): void {
    if (!(f instanceof TFile) || this.isExcludedPath(f.path)) return;
    const old = this.baseline.get(f.path);
    const stat = old && old.content !== null ? { added: 0, removed: countLines(old.content) } : null;
    this.baseline.delete(f.path);
    this.feed.push('delete', f.path, { stat });
    this.baselineDirty = true;
  }

  private onRename(f: TAbstractFile, oldPath: string): void {
    if (!(f instanceof TFile)) return;
    const oldExcluded = this.isExcludedPath(oldPath);
    const newExcluded = this.isExcludedPath(f.path);
    if (oldExcluded && newExcluded) return;
    const entry = this.baseline.get(oldPath);
    if (entry) {
      this.baseline.delete(oldPath);
      // 新路径被排除时不移动基线条目，否则下次对账会把排除路径当失踪文件产生幽灵 delete
      if (!newExcluded) this.baseline.set(f.path, entry);
      this.baselineDirty = true;
    }
    if (oldExcluded) {
      this.feed.push('create', f.path, { stat: null });
    } else if (newExcluded) {
      this.feed.push('delete', oldPath, { stat: null });
    } else {
      this.feed.push('rename', f.path, { oldPath, stat: { added: 0, removed: 0 } });
    }
  }

  private async flushEvents(): Promise<void> {
    if (!this.feed || this.feed.pending === 0) return;
    const events = this.feed.drain();
    try {
      await appendEvents(this.io, LOG_FILE, events);
      this.lastSeq = Math.max(this.lastSeq, events[events.length - 1].seq);
      await this.saveData(this.persistedData());
    } catch (err) {
      // 失败重入队列，下轮重试
      for (const e of events) this.feed.pushLoaded(e);
      new Notice('vault-change-feed: failed to write changelog, will retry');
      console.error('vault-change-feed flush failed', err);
    }
  }

  private async saveBaseline(): Promise<void> {
    if (!this.baselineDirty) return;
    await this.io.writeBinary(BASELINE_FILE, serializeBaseline(this.baseline));
    this.baselineDirty = false;
  }

  private async rotate(): Promise<void> {
    try {
      await rotateIfNeeded(
        this.io,
        LOG_FILE,
        this.settings.retentionMaxEntries,
        this.settings.retentionDays,
        Date.now(),
      );
    } catch (err) {
      console.error('vault-change-feed rotate failed', err);
    }
  }

  private async copyUnread(): Promise<void> {
    const res = await getChanges(this.io, this.feedPaths(), 'manual');
    const header = res.stale ? 'STALE: log truncated, full vault rescan advised.\n' : '';
    const body = res.events.length > 0 ? formatEvents(res.events) : '(no changes)';
    await navigator.clipboard.writeText(header + body);
    await markRead(this.io, this.feedPaths(), 'manual', res.latestSeq);
    new Notice(`vault-change-feed: ${res.events.length} change(s) copied`);
  }

  async onunload(): Promise<void> {
    // 尽力而为：插件卸载时把队列与基线落盘
    if (this.feed) await this.flushEvents();
    if (this.baselineDirty) await this.saveBaseline();
  }

  private persistedData(): PersistedData {
    return {
      settings: this.settings,
      lastSeq: this.lastSeq,
      lastProtocolVersion: this.lastProtocolVersion,
      protocolNoticeShown: this.protocolNoticeShown,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.persistedData());
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
      .setName('Tracked text extensions')
      .setDesc('Comma-separated, without dots. Changes to these files get diff stats.')
      .addText(t =>
        t.setValue(s.trackedExtensions).onChange(async v => {
          s.trackedExtensions = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Exclude globs')
      .setDesc('One per line. The .obsidian config dir is always excluded.')
      .addTextArea(t =>
        t.setValue(s.excludeGlobs).onChange(async v => {
          s.excludeGlobs = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Large file threshold (KB)')
      .setDesc('Text files larger than this skip diff stats.')
      .addText(t =>
        t.setValue(String(s.largeFileKb)).onChange(async v => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            s.largeFileKb = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('Retention days')
      .setDesc('Log entries older than this are truncated.')
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
      .setName('Retention max entries')
      .setDesc('Log is truncated to this many entries when exceeded — whichever limit hits first.')
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
      .setName('Baseline flush interval (s)')
      .setDesc('How often the baseline snapshot is persisted. Takes effect after reload.')
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
      .setName('Sync AGENTS.md')
      .setDesc('Install protocol block into AGENTS.md (read by most AI agents)')
      .addToggle(t =>
        t.setValue(s.syncAgentsMd).onChange(async v => {
          s.syncAgentsMd = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Sync CLAUDE.md')
      .setDesc('Install protocol block into CLAUDE.md (read by Claude Code)')
      .addToggle(t =>
        t.setValue(s.syncClaudeMd).onChange(async v => {
          s.syncClaudeMd = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Auto-sync protocol block')
      .setDesc('Refresh the installed protocol block after plugin updates')
      .addToggle(t =>
        t.setValue(s.autoSyncProtocol).onChange(async v => {
          s.autoSyncProtocol = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
