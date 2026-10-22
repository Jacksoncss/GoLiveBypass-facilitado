import { describe, it, expect, vi } from 'vitest';
import { FailoverMonitor } from '../../src/main/tunnel/failover';
import { shouldAskRoutePreference } from '../../src/main/proton/route-prompt';

describe('FailoverMonitor', () => {
  it('troca só depois de três falhas seguidas', async () => {
    const results = [false, false, true, false, false, false];
    const onRouteDown = vi.fn(async () => {});
    const m = new FailoverMonitor({ probe: async () => results.shift()!, onRouteDown });
    const seen = [];
    for (let i = 0; i < 6; i++) seen.push(await m.tick());
    expect(seen).toEqual(['fail', 'fail', 'ok', 'fail', 'fail', 'switched']);
    expect(onRouteDown).toHaveBeenCalledTimes(1);
  });

  it('não sobrepõe sondas', async () => {
    let release!: (v: boolean) => void;
    const m = new FailoverMonitor({ probe: () => new Promise(r => { release = r; }), onRouteDown: async () => {} });
    const first = m.tick();
    expect(await m.tick()).toBe('skipped');
    release(true);
    expect(await first).toBe('ok');
  });
});

describe('shouldAskRoutePreference', () => {
  it('pergunta para quem ainda não decidiu nada', () => {
    expect(shouldAskRoutePreference({})).toBe(true);
  });
  it('rota salva vazia ou inválida não conta como rota usada', () => {
    expect(shouldAskRoutePreference({ protonServer: {} as any })).toBe(true);
    expect(shouldAskRoutePreference({ protonServer: null as any })).toBe(true);
    expect(shouldAskRoutePreference({ protonServer: '' as any })).toBe(true);
  });
  it('não pergunta depois de responder, com preferência, com rota ou no modo .conf', () => {
    expect(shouldAskRoutePreference({ protonRoutePreferencePrompted: true })).toBe(false);
    expect(shouldAskRoutePreference({ protonRoutePreference: 'auto' })).toBe(false);
    expect(shouldAskRoutePreference({ protonServer: { server: 'US-FREE#1', country: 'US', city: 'Miami' } })).toBe(false);
    expect(shouldAskRoutePreference({ connectionMode: 'conf' })).toBe(false);
  });
});
