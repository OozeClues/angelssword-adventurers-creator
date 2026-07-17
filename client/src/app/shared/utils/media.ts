export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

export function base64ToBlob(base64: string, mimeType = 'image/png'): Blob {
  const raw = base64.includes(',') ? base64.split(',')[1] : base64;
  const bytes = atob(raw);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function fileToDataUrl(file: File | Blob): Promise<string> {
  return blobToBase64(file);
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

export function colorName(hex: string): string {
  const names: Record<string, string> = {
    '#00FF00': 'Green',
    '#FF00FF': 'Magenta',
    '#0000FF': 'Blue',
    '#FFFF00': 'Yellow',
    '#00FFFF': 'Cyan',
  };
  return names[hex.toUpperCase()] || hex;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

/**
 * Smooth-scroll an element into view inside the app's main scroller (.tab-content).
 * Falls back to element.scrollIntoView when the shell scroller isn't found.
 */
export function scrollAppResultsIntoView(el: HTMLElement | null | undefined): void {
  if (!el) return;
  // Wait a frame so newly rendered result cards have layout.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const scroller = document.querySelector('.tab-content') as HTMLElement | null;
      if (scroller) {
        const scrollerRect = scroller.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const nextTop =
          scroller.scrollTop + (elRect.top - scrollerRect.top) - 16; // small top padding
        scroller.scrollTo({
          top: Math.max(0, nextTop),
          behavior: 'smooth',
        });
      } else {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}
