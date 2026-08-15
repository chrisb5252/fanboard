import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * Renders the join URL as a scannable QR code.
 *
 * The API returns `qrCode` as a URL string, not an image. Printing that string
 * on a TV is not a join flow — nobody types a UUID off a screen — so it has to
 * be encoded here.
 *
 * SVG rather than canvas: one <path>, no rasterisation, and it stays crisp at
 * any panel size. On an ARM stick that is meaningfully cheaper than drawing and
 * scaling a bitmap.
 *
 * Error correction level M tolerates roughly 15% damage, which covers a camera
 * at an angle across a room. The encode is memoised on the URL because the URL
 * changes essentially never, and the rotation would otherwise re-encode every
 * 35 seconds.
 */
function buildQrPath(value: string, cellSize: number): { path: string; size: number } | null {
  try {
    // Type 0 lets the library choose the smallest version that fits.
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();

    const count = qr.getModuleCount();
    const commands: string[] = [];

    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (qr.isDark(row, column)) {
          commands.push(`M${column * cellSize} ${row * cellSize}h${cellSize}v${cellSize}h-${cellSize}z`);
        }
      }
    }

    return { path: commands.join(''), size: count * cellSize };
  } catch {
    return null;
  }
}

export interface QrPanelProps {
  url: string;
  /** 'full' takes the screen during its rotation slot; 'strip' is the persistent footer. */
  variant: 'full' | 'strip';
}

export function QrPanel({ url, variant }: QrPanelProps) {
  const cellSize = 4;
  const qr = useMemo(() => buildQrPath(url, cellSize), [url]);

  if (qr === null) {
    return null;
  }

  const label = url.replace(/^https?:\/\//, '');

  if (variant === 'strip') {
    return (
      <div className="qr-strip">
        <svg
          className="qr-strip__code"
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          role="img"
          aria-label="Scan to join"
          shapeRendering="crispEdges"
        >
          <rect width={qr.size} height={qr.size} fill="#ffffff" />
          <path d={qr.path} fill="#000000" />
        </svg>
        <div className="qr-strip__text">
          <span className="qr-strip__cta">Scan to play</span>
          <span className="qr-strip__url">{label}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="zone zone--qr">
      <h1 className="zone__title">Scan to play</h1>
      <svg
        className="qr-full__code"
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        role="img"
        aria-label="Scan to join"
        shapeRendering="crispEdges"
      >
        <rect width={qr.size} height={qr.size} fill="#ffffff" />
        <path d={qr.path} fill="#000000" />
      </svg>
      <p className="qr-full__url">{label}</p>
      <p className="qr-full__hint">Point your camera at the code · pick winners · climb the board</p>
    </div>
  );
}
