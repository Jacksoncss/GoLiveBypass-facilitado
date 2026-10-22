export type TunnelState = 'active' | 'inactive' | 'unknown';

export interface WgConfig {
  interfaceLines: string[];
  peerLines: string[];
}

export interface ActivateResult {
  state: TunnelState;
  publicIp: string | null;
}

export type PrivilegedError =
  | 'user_cancelled'
  | 'handshake_timeout'
  | 'binary_missing'
  | 'wg_failed';

export interface AppSettings {
  lastTunnelState?: TunnelState;
  protonUser?: string;
  /** Opt-in explícito: instalar o Vencord e ligar o FakeNitro ao ativar. */
  vencordOptIn?: boolean;
  /** Mostra o log na janela principal. */
  devMode?: boolean;
  theme?: ThemeChoice;
  /** De onde veio o perfil atual: conta Proton ou .conf importado. */
  connectionMode?: 'proton' | 'conf';
  protonRoutePreference?: 'auto' | 'manual';
  protonRoutePreferencePrompted?: boolean;
  /** Rota do perfil atual. */
  protonServer?: SavedRoute;
  /** Troca de servidor quando a rota Proton cai (padrão: ligado). */
  autoFailover?: boolean;
  /** Última conf gerada para o celular: só metadados, nunca a conf. */
  phoneConf?: PhoneMeta;
}

export interface PhoneMeta {
  server: string;
  country: string;
  city: string;
  /** Unix, segundos. */
  expiresAt?: number;
  generatedAt: string;
}

export interface SavedRoute {
  server: string;
  country: string;
  city: string;
  pingMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
}

export type ThemeChoice = 'system' | 'light' | 'dark';

/** Preferências que a janela de Configurações lê e grava. */
export interface UiSettings {
  openAtLogin: boolean;
  devMode: boolean;
  theme: ThemeChoice;
  routePreference: 'auto' | 'manual';
  autoFailover: boolean;
  connectionMode: 'proton' | 'conf';
  /** Primeira abertura no modo Proton sem rota decidida. */
  askRoutePreference: boolean;
}

export interface UpdateInfo {
  available: boolean;
  latestVersion?: string;
  downloadUrl?: string;
  currentVersion: string;
}

export interface ProtonFetchProgress {
  message: string;
}
