/**
 * The browser's part of preparing a menu photo: decode the chosen file and draw it on a canvas, then
 * encode it again. A picture that went through a canvas has none of the original's metadata (EXIF,
 * GPS), which is the point; the plan and the guard are in `menu-editor/photo-plan.ts`.
 *
 * A native shell can bring its own `PhotoEngine`. Here: `createImageBitmap` (rotated as the camera
 * says), with an `<img>` as the fallback for a browser that cannot decode a file that way, and a
 * white background because JPEG has no transparency.
 */
import type { PhotoEngine, PhotoSource, PhotoType } from '../menu-editor/photo-plan.ts';

type Drawable = CanvasImageSource & { width: number; height: number };

async function decodeWithImageElement(file: Blob): Promise<{ image: Drawable; release(): void }> {
  const url = URL.createObjectURL(file);
  const element = new Image();
  element.decoding = 'async';
  element.src = url;
  try {
    await element.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return {
    image: Object.assign(element, { width: element.naturalWidth, height: element.naturalHeight }),
    release: () => URL.revokeObjectURL(url),
  };
}

async function decode(file: Blob): Promise<{ image: Drawable; release(): void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { image: bitmap, release: () => bitmap.close() };
    } catch {
      // some browsers refuse the option or the file type: try the plain way below
    }
  }
  return decodeWithImageElement(file);
}

function toBlob(canvas: HTMLCanvasElement, type: PhotoType, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('the canvas gave no picture'))),
      type,
      quality,
    );
  });
}

export function createWebPhotoEngine(): PhotoEngine {
  return {
    async open(file): Promise<PhotoSource> {
      const { image, release } = await decode(file);
      return {
        width: image.width,
        height: image.height,
        async encode(width, height, type, quality) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('no canvas');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, width, height);
          context.imageSmoothingQuality = 'high';
          context.drawImage(image, 0, 0, width, height);
          try {
            return await toBlob(canvas, type, quality);
          } finally {
            // iOS Safari keeps canvas memory until it is shrunk.
            canvas.width = 0;
            canvas.height = 0;
          }
        },
        close: release,
      };
    },
  };
}
