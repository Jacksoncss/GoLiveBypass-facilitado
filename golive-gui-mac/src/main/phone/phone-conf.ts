import { parseWgConfig } from '../config/parse';
import { CANONICAL_KEYS, DEFAULT_KEEPALIVE, DISCORD_ALLOWED_IPS, DISCORD_REJECT_V6 } from '../config/rewrite';

export const PHONE_DEVICE_NAME = 'GoLiveBypass-Celular';

function pick(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = CANONICAL_KEYS[line.slice(0, i).trim().toLowerCase()];
    if (key) out.push(`${key} = ${line.slice(i + 1).trim()}`);
  }
  return out;
}

const has = (lines: string[], key: string) => lines.some(l => l.startsWith(`${key} =`));

/**
 * Uma conf para iPhone e Android: split por IP como no Mac, com o IPv6 da
 * Cloudflare num buraco negro (a conf Free não tem IPv6) para o Discord cair
 * no IPv4 tunelado. Sem DNS: o celular mantém o dele.
 */
export function buildPhoneConf(raw: string): { ok: true; conf: string } | { ok: false; error: 'invalid_conf' } {
  const parsed = parseWgConfig(raw);
  const iface = pick(parsed.interfaceLines);
  const peer = pick(parsed.peerLines);
  if (!has(iface, 'PrivateKey') || !has(iface, 'Address') || !has(peer, 'PublicKey') || !has(peer, 'Endpoint')) {
    return { ok: false, error: 'invalid_conf' };
  }
  if (!has(peer, 'PersistentKeepalive')) peer.push(`PersistentKeepalive = ${DEFAULT_KEEPALIVE}`);
  const allowed = [DISCORD_ALLOWED_IPS, ...DISCORD_REJECT_V6].join(', ');
  return { ok: true, conf: ['[Interface]', ...iface, '', '[Peer]', ...peer, `AllowedIPs = ${allowed}`, ''].join('\n') };
}
