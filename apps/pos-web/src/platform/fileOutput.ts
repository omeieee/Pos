/**
 * File output seam: features call `save()` (download a file) or `print()` (the browser's print
 * dialog for an HTML page); the P10 shells can swap in native share and printing. The web one
 * downloads through a temporary link and prints through a hidden frame, so nothing leaves the page.
 */
export interface FileOutput {
  save(fileName: string, mimeType: string, content: string): void;
  /** Opens the print dialog for a self-contained HTML document. */
  print(html: string): void;
}

export const webFileOutput: FileOutput = {
  save(fileName, mimeType, content) {
    const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
  print(html) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    frame.onload = () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 60_000);
    };
    frame.srcdoc = html;
    document.body.append(frame);
  },
};
