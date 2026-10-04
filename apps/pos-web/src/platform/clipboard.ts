/**
 * Clipboard seam: features call `copyText()`; the P10 shells can swap in a native clipboard. The
 * web one uses the async Clipboard API and says plainly when the browser refused, so the screen can
 * show the text for a manual copy instead.
 *
 * iOS Safari only allows a copy inside the tap that asked for it: call `copyText` straight from the
 * click handler, with no awaited work before it.
 */
export interface TextClipboard {
  /** true when the text is on the clipboard, false when the browser would not (or cannot) copy. */
  copyText(text: string): Promise<boolean>;
}

export const webClipboard: TextClipboard = {
  async copyText(text) {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  },
};
