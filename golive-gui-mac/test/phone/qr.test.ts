import { describe, it, expect } from 'vitest';
import { confToQrDataUrl } from '../../src/main/phone/qr';

const ANDROID = `[Interface]
PrivateKey = cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5MTI=
Address = 10.2.0.2/32
DNS = 10.2.0.1
IncludedApplications = com.discord

[Peer]
PublicKey = cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5cHViMTI=
Endpoint = 149.102.230.11:51820
PersistentKeepalive = 25
AllowedIPs = 0.0.0.0/0, ::/0
`;

describe('confToQrDataUrl', () => {
  it('devolve um SVG em data URL, sem a conf em texto', () => {
    const url = confToQrDataUrl(ANDROID);
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/<path|<rect/);
    expect(svg).not.toContain('PrivateKey');
  });

  it('conf grande demais para um QR legível falha com erro próprio', () => {
    expect(() => confToQrDataUrl('x'.repeat(4000))).toThrow('qr_too_large');
  });
});
