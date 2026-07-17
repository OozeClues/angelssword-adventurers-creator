/** DOM helpers used by the ported ModelExporter engine (legacy init* style). */

export function initUploadZone(
  zoneId: string,
  inputId: string,
  onFile: (files: FileList) => void,
  onClear?: () => void
): void {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  if (!zone || !input) return;

  if (!zone.querySelector('.upload-clear-btn')) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'upload-clear-btn';
    clearBtn.title = 'Clear';
    clearBtn.innerHTML = '✕';
    clearBtn.type = 'button';
    zone.appendChild(clearBtn);
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      input.value = '';
      zone.classList.remove('has-content');
      onClear?.();
    });
  }

  ['dragenter', 'dragover'].forEach((evt) => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
    });
  });
  zone.addEventListener('drop', (e) => {
    const de = e as DragEvent;
    const files = de.dataTransfer?.files;
    if (files?.length) {
      zone.classList.add('has-content');
      onFile(files);
    }
  });
  input.addEventListener('change', () => {
    if (input.files?.length) {
      zone.classList.add('has-content');
      onFile(input.files);
    }
  });
}

export function initModeSelector(containerId: string, onChange: (mode: string) => void): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.mode-btn, .seg-btn, .export-mode-btn') as HTMLElement | null;
    if (!btn) return;
    container.querySelectorAll('.mode-btn, .seg-btn, .export-mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset['mode'] || btn.dataset['ratio'] || '';
    onChange(mode);
  });
}

export function initColorSwatches(containerId: string, onChange: (color: string) => void): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.addEventListener('click', (e) => {
    const swatch = (e.target as HTMLElement).closest('.color-swatch') as HTMLElement | null;
    if (!swatch) return;
    container.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
    swatch.classList.add('selected');
    const color = swatch.dataset['color'];
    if (color) onChange(color);
  });
}
