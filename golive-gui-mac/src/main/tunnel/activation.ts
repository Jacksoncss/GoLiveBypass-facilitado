import type { PrivilegedError } from '../../shared/types';
import { runViaHelper, installHelper, helperReady, downWithInstalledHelper, type HelperAction } from '../privileged/helper';

export interface ActivationOpts {
  home: string;
  user: string;
  binDir: string;
}

export interface ActivationResult { ok: boolean; error?: PrivilegedError; detail?: string }

function classifyError(out: string): PrivilegedError {
  const s = out.toLowerCase();
  if (s.includes('user cancel') || s.includes('(-128)')) return 'user_cancelled';
  if (s.includes('handshake_timeout'))                  return 'handshake_timeout';
  if (s.includes('command not found') || s.includes('no such file')) return 'binary_missing';
  return 'wg_failed';
}

async function ensureHelper(opts: ActivationOpts): Promise<ActivationResult> {
  if (helperReady(opts.binDir)) return { ok: true };
  const r = await installHelper(opts.binDir);
  if (r.ok) return { ok: true };
  if (r.error === 'user_cancelled') return { ok: false, error: 'user_cancelled' };
  return { ok: false, error: 'wg_failed', detail: r.error };
}

async function run(action: HelperAction, opts: ActivationOpts): Promise<ActivationResult> {
  // Helper desatualizado não pode impedir de restaurar a rede nem exigir senha para isso
  if (action === 'down' && !helperReady(opts.binDir) && await downWithInstalledHelper()) return { ok: true };
  const install = await ensureHelper(opts);
  if (!install.ok) return install;
  const r = await runViaHelper(action, opts.user);
  if (r.code === 0) return { ok: true };
  return { ok: false, error: classifyError(r.stderr), detail: r.stderr.trim().slice(-500) };
}

export const runActivation   = (opts: ActivationOpts) => run('up', opts);
export const runDeactivation = (opts: ActivationOpts) => run('down', opts);
