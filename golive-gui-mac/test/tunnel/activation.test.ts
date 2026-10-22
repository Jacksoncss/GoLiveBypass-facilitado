import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runActivation, runDeactivation } from '../../src/main/tunnel/activation';

// Mock do módulo helper para evitar chamadas ao SO em testes unitários
vi.mock('../../src/main/privileged/helper', () => ({
  helperReady: vi.fn(() => true),
  installHelper: vi.fn(async () => ({ ok: true })),
  runViaHelper: vi.fn(async () => ({ code: 0, stderr: '', usedPrompt: false })),
  downWithInstalledHelper: vi.fn(async () => false),
}));

import * as helperMod from '../../src/main/privileged/helper';

const opts = {
  home: '/Users/test',
  user: 'test',
  binDir: '/res/bin',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(helperMod.helperReady).mockReturnValue(true);
});

describe('runActivation', () => {
  it('helper retorna 0 → ok', async () => {
    vi.mocked(helperMod.runViaHelper).mockResolvedValue({ code: 0, stderr: '', usedPrompt: false });
    expect(await runActivation(opts)).toEqual({ ok: true });
  });

  it('stderr com handshake_timeout → erro tipado', async () => {
    vi.mocked(helperMod.runViaHelper).mockResolvedValue({ code: 2, stderr: 'handshake_timeout', usedPrompt: false });
    expect(await runActivation(opts)).toMatchObject({ ok: false, error: 'handshake_timeout' });
  });

  it('cancelamento do usuário → user_cancelled', async () => {
    vi.mocked(helperMod.runViaHelper).mockResolvedValue({ code: 1, stderr: 'User canceled.', usedPrompt: true });
    expect(await runActivation(opts)).toMatchObject({ ok: false, error: 'user_cancelled' });
  });

  it('helper não instalado → instala e continua', async () => {
    vi.mocked(helperMod.helperReady).mockReturnValue(false);
    vi.mocked(helperMod.installHelper).mockResolvedValue({ ok: true });
    vi.mocked(helperMod.runViaHelper).mockResolvedValue({ code: 0, stderr: '', usedPrompt: false });
    expect(await runActivation(opts)).toEqual({ ok: true });
    expect(helperMod.installHelper).toHaveBeenCalledTimes(1);
  });
});

describe('runDeactivation', () => {
  it('helper retorna 0 → ok', async () => {
    vi.mocked(helperMod.runViaHelper).mockResolvedValue({ code: 0, stderr: '', usedPrompt: false });
    expect(await runDeactivation(opts)).toEqual({ ok: true });
  });

  it('cancelamento → user_cancelled', async () => {
    vi.mocked(helperMod.runViaHelper).mockResolvedValue({ code: 1, stderr: 'User cancelled.', usedPrompt: true });
    expect(await runDeactivation(opts)).toMatchObject({ ok: false, error: 'user_cancelled' });
  });
});

describe('runDeactivation com helper desatualizado', () => {
  it('derruba pelo helper instalado sem reinstalar nem pedir senha', async () => {
    vi.mocked(helperMod.helperReady).mockReturnValue(false);
    vi.mocked(helperMod.downWithInstalledHelper).mockResolvedValue(true);
    expect(await runDeactivation(opts)).toEqual({ ok: true });
    expect(helperMod.installHelper).not.toHaveBeenCalled();
    expect(helperMod.runViaHelper).not.toHaveBeenCalled();
  });

  it('sem helper utilizável, cai na reinstalação como antes', async () => {
    vi.mocked(helperMod.helperReady).mockReturnValue(false);
    vi.mocked(helperMod.downWithInstalledHelper).mockResolvedValue(false);
    vi.mocked(helperMod.installHelper).mockResolvedValue({ ok: true });
    vi.mocked(helperMod.runViaHelper).mockResolvedValue({ code: 0, stderr: '', usedPrompt: false });
    expect(await runDeactivation(opts)).toEqual({ ok: true });
    expect(helperMod.installHelper).toHaveBeenCalled();
  });

  it('ativar nunca usa o atalho: up exige o helper desta versão', async () => {
    vi.mocked(helperMod.helperReady).mockReturnValue(false);
    vi.mocked(helperMod.downWithInstalledHelper).mockResolvedValue(true);
    await runActivation(opts);
    expect(helperMod.downWithInstalledHelper).not.toHaveBeenCalled();
    expect(helperMod.installHelper).toHaveBeenCalled();
  });
});
