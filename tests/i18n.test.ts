import { describe, it, expect } from 'vitest';
import { detectLocale, setLocale, t } from '../src/i18n';

describe('detectLocale', () => {
  it('zh 系语言码 → zh', () => {
    expect(detectLocale('zh-cn')).toBe('zh');
    expect(detectLocale('zh-TW')).toBe('zh');
    expect(detectLocale('zh')).toBe('zh');
  });
  it('其他语言 → en', () => {
    expect(detectLocale('en')).toBe('en');
    expect(detectLocale('en-US')).toBe('en');
    expect(detectLocale('fr')).toBe('en');
    expect(detectLocale('ja')).toBe('en');
    expect(detectLocale('')).toBe('en');
  });
});

describe('t', () => {
  it('跟随 setLocale 切换语言', () => {
    setLocale('en');
    expect(t('cmdCopyUnread')).toBe('Copy unread changes for AI');
    setLocale('zh');
    expect(t('cmdCopyUnread')).toBe('复制未读变更给 AI');
  });

  it('vars 替换占位符', () => {
    setLocale('zh');
    expect(t('noticeCopied', { count: 5 })).toBe('vault-change-feed：已复制 5 条变更');
    setLocale('en');
    expect(t('noticeInstalled', { files: 'AGENTS.md' })).toBe(
      'vault-change-feed: AI protocol installed into AGENTS.md',
    );
  });

  it('不带 vars 时占位符原样保留', () => {
    setLocale('en');
    expect(t('noticeCopied')).toContain('{count}');
  });
});
