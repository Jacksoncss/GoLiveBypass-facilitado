import type { AppSettings } from '../../shared/types';

/**
 * Pergunta única de rota automática ou manual. Só no modo Proton e para quem
 * ainda não decidiu: sem preferência, sem rota lembrada e sem ter respondido.
 * O "prompted" nunca é limpo, nem ao sair da conta, para a pergunta não voltar.
 */
export function shouldAskRoutePreference(s: AppSettings): boolean {
  if (s.protonRoutePreferencePrompted === true) return false;
  if ((s.connectionMode ?? 'proton') !== 'proton') return false;
  if (s.protonRoutePreference === 'auto' || s.protonRoutePreference === 'manual') return false;
  return !hasUsedRoute(s.protonServer);
}

// Mesma regra da GUI: objeto vazio não é rota lembrada.
function hasUsedRoute(v: unknown): boolean {
  return typeof v === 'object' && v !== null && Object.keys(v).length > 0;
}
