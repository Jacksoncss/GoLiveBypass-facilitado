import qrcode from 'qrcode-generator';

/** QR gerado no próprio processo: a conf nunca sai do Mac por rede. */
export function confToQrDataUrl(conf: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(conf, 'Byte');
  try {
    qr.make();
  } catch {
    throw new Error('qr_too_large');
  }
  const svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
