import { describe, expect, test, vi } from 'vitest';
import { qrFileName, type SaveEnv, saveQrImage } from './qr-save.ts';

const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

function env(over: Partial<SaveEnv> = {}): SaveEnv & { download: ReturnType<typeof vi.fn> } {
  return { download: vi.fn(), inLineClient: false, ...over } as SaveEnv & {
    download: ReturnType<typeof vi.fn>;
  };
}

describe('saveQrImage', () => {
  test('uses the share sheet when the browser can share the file', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const e = env({ canShare: () => true, share });
    expect(await saveQrImage(png, 'qr.png', e)).toBe('shared');
    expect(share).toHaveBeenCalledOnce();
    const sent = share.mock.calls[0]?.[0].files[0] as File;
    expect(sent.name).toBe('qr.png');
    expect(sent.type).toBe('image/png');
    expect(e.download).not.toHaveBeenCalled();
  });

  test('closing the share sheet is not an error and does not fall back', async () => {
    const abort = Object.assign(new Error('closed'), { name: 'AbortError' });
    const e = env({ canShare: () => true, share: vi.fn().mockRejectedValue(abort) });
    expect(await saveQrImage(png, 'qr.png', e)).toBe('cancelled');
    expect(e.download).not.toHaveBeenCalled();
  });

  test('a share that fails otherwise falls back to a download outside LINE', async () => {
    const e = env({ canShare: () => true, share: vi.fn().mockRejectedValue(new Error('no')) });
    expect(await saveQrImage(png, 'qr.png', e)).toBe('downloaded');
    expect(e.download).toHaveBeenCalledOnce();
  });

  test('no share support: a normal browser downloads', async () => {
    const e = env();
    expect(await saveQrImage(png, 'qr.png', e)).toBe('downloaded');
  });

  test('canShare saying no skips the share sheet', async () => {
    const share = vi.fn();
    const e = env({ canShare: () => false, share });
    expect(await saveQrImage(png, 'qr.png', e)).toBe('downloaded');
    expect(share).not.toHaveBeenCalled();
  });

  test('inside LINE a download is never tried: the screen shows the picture to press and hold', async () => {
    const e = env({ inLineClient: true });
    expect(await saveQrImage(png, 'qr.png', e)).toBe('manual');
    expect(e.download).not.toHaveBeenCalled();
  });

  test('inside LINE the file link is followed, and the picture still opens for press and hold', async () => {
    const downloadLink = vi.fn();
    const e = env({ inLineClient: true, downloadLink });
    expect(await saveQrImage(png, 'qr.png', e)).toBe('manual');
    expect(downloadLink).toHaveBeenCalledOnce();
    expect(e.download).not.toHaveBeenCalled();
  });

  test('a link that throws inside LINE still ends in the manual way', async () => {
    const downloadLink = vi.fn(() => {
      throw new Error('blocked');
    });
    expect(await saveQrImage(png, 'qr.png', env({ inLineClient: true, downloadLink }))).toBe(
      'manual',
    );
  });

  test('the file link is not followed when the share sheet took the picture, or in a normal browser', async () => {
    const downloadLink = vi.fn();
    const shared = env({
      inLineClient: true,
      canShare: () => true,
      share: vi.fn().mockResolvedValue(undefined),
      downloadLink,
    });
    expect(await saveQrImage(png, 'qr.png', shared)).toBe('shared');
    expect(await saveQrImage(png, 'qr.png', env({ downloadLink }))).toBe('downloaded');
    expect(downloadLink).not.toHaveBeenCalled();
  });

  test('a download that throws ends in the manual way', async () => {
    const e = env({
      download: vi.fn(() => {
        throw new Error('blocked');
      }),
    });
    expect(await saveQrImage(png, 'qr.png', e)).toBe('manual');
  });
});

describe('qrFileName', () => {
  test('is the order number only, safe as a file name', () => {
    expect(qrFileName('L-012')).toBe('promptpay-L-012.png');
    expect(qrFileName('L/../012 x')).toBe('promptpay-L012x.png');
  });
});
