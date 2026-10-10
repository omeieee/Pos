/**
 * Saving the PromptPay QR picture on a phone.
 *
 * LINE's in-app browser is a WebView: on iOS and Android it often ignores `<a download>`, and the
 * picture on the page is cross-origin (the API), so a long-press can save a file the bank app will
 * not read. So the picture is fetched once, redrawn as a PNG on this device, shown from a
 * `blob:` URL (a long-press saves that) and offered through the share sheet when the browser has
 * one. When nothing works the screen says "press and hold the picture".
 */

/** What happened when the customer pressed "บันทึก QR". */
export type SaveOutcome =
  | 'shared' // the phone's share sheet took the picture (it has "Save Image")
  | 'downloaded' // a normal browser saved the file
  | 'cancelled' // the customer closed the share sheet: nothing to say
  | 'manual'; // neither works here: show the picture large and tell them to press and hold

export interface SaveEnv {
  /** `navigator.canShare` and `navigator.share`, when the browser has them. */
  canShare?: (data: { files: File[] }) => boolean;
  share?: (data: { files: File[]; title?: string }) => Promise<void>;
  /** Saves through a link click. Not used inside LINE's own browser, which drops it. */
  download: (file: File) => void;
  /** `liff.isInClient()`: the app runs inside LINE's browser. */
  inLineClient: boolean;
}

/** The share sheet first, then a plain download (outside LINE only), else the manual way. */
export async function saveQrImage(png: Blob, fileName: string, env: SaveEnv): Promise<SaveOutcome> {
  const file = new File([png], fileName, { type: 'image/png' });
  if (env.share && env.canShare?.({ files: [file] })) {
    try {
      await env.share({ files: [file], title: fileName });
      return 'shared';
    } catch (e) {
      // Closing the sheet is an answer, not an error; any other failure goes on to the next way.
      if (e instanceof Error && e.name === 'AbortError') return 'cancelled';
    }
  }
  if (!env.inLineClient) {
    try {
      env.download(file);
      return 'downloaded';
    } catch {
      // fall through to the manual way
    }
  }
  return 'manual';
}

/** The browser's own pieces, for `saveQrImage`. */
export function browserSaveEnv(inLineClient: boolean): SaveEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    ...(nav?.canShare ? { canShare: (d: { files: File[] }) => nav.canShare(d) } : {}),
    ...(nav?.share ? { share: (d: { files: File[]; title?: string }) => nav.share(d) } : {}),
    inLineClient,
    download(file) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(file);
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    },
  };
}

/** The saved picture's name: the order number only, so a stranger learns nothing from the gallery. */
export function qrFileName(orderNo: string): string {
  return `promptpay-${orderNo.replace(/[^A-Za-z0-9-]/g, '')}.png`;
}

/**
 * Redraws the server's picture (PNG, or SVG from an older build) as a PNG with a white margin, so
 * it saves as a normal photo and scans from the gallery. Needs a browser (canvas).
 */
export async function toPng(source: Blob, size = 720): Promise<Blob> {
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    image.decoding = 'async';
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('qr image'));
    });
    image.src = url;
    await loaded;
    const margin = Math.round(size * 0.06);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false; // a QR must stay crisp
    ctx.drawImage(image, margin, margin, size - 2 * margin, size - 2 * margin);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
