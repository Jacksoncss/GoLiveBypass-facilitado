import { describe, it, expect } from 'vitest';
import { isCloudSyncedPath } from '../../src/main/phone/cloud';

const home = '/Users/u';
const io = (docsSynced: boolean, real: Record<string, string> = {}) => ({
  home,
  desktopDocumentsSynced: () => docsSynced,
  realDir: (d: string) => real[d] ?? d,
});

describe('isCloudSyncedPath', () => {
  it('pasta do iCloud Drive', () => {
    expect(isCloudSyncedPath('/Users/u/Library/Mobile Documents/com~apple~CloudDocs/x.conf', io(false))).toBe(true);
  });
  it('Mesa e Documentos só contam quando sincronizados pelo iCloud', () => {
    expect(isCloudSyncedPath('/Users/u/Desktop/GoLiveBypass.conf', io(true))).toBe(true);
    expect(isCloudSyncedPath('/Users/u/Documents/sub/GoLiveBypass.conf', io(true))).toBe(true);
    expect(isCloudSyncedPath('/Users/u/Desktop/GoLiveBypass.conf', io(false))).toBe(false);
    expect(isCloudSyncedPath('/Users/u/Downloads/GoLiveBypass.conf', io(true))).toBe(false);
  });
  it('symlink que aponta para o iCloud', () => {
    expect(isCloudSyncedPath('/Users/u/atalho/x.conf', io(false, { '/Users/u/atalho': '/Users/u/Library/Mobile Documents/com~apple~CloudDocs/pasta' }))).toBe(true);
  });
  it('não confunde pasta com nome parecido', () => {
    expect(isCloudSyncedPath('/Users/u/DesktopBackup/x.conf', io(true))).toBe(false);
  });
});
