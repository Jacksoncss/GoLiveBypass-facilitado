import * as path from 'path';

export interface CloudIo {
  home: string;
  /** "Mesa e Documentos" ligado no iCloud: ~/Desktop e ~/Documents vão para a nuvem. */
  desktopDocumentsSynced(): boolean;
  /** Pasta resolvida (symlinks seguidos); devolve a própria pasta se não existir. */
  realDir(dir: string): string;
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + '/');

/** O arquivo com a chave privada iria para o iCloud? */
export function isCloudSyncedPath(file: string, io: CloudIo): boolean {
  const dir = io.realDir(path.dirname(file));
  if (dir.includes('/Library/Mobile Documents/') || file.includes('/Library/Mobile Documents/')) return true;
  if (!io.desktopDocumentsSynced()) return false;
  return [path.join(io.home, 'Desktop'), path.join(io.home, 'Documents')].some(d => under(dir, d) || under(path.dirname(file), d));
}
