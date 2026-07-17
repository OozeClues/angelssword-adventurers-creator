import { Component, input, output, signal } from '@angular/core';

@Component({
  selector: 'app-upload-zone',
  template: `
    <div
      class="upload-zone"
      [class.has-content]="hasContent()"
      [class.drag-over]="dragOver()"
      [class.hidden]="hidden()"
      [attr.title]="title()"
      [style.padding]="compact() ? '1rem' : null"
      (dragenter)="onDragEnter($event)"
      (dragover)="onDragEnter($event)"
      (dragleave)="onDragLeave($event)"
      (drop)="onDrop($event)"
    >
      <ng-content></ng-content>
      @if (!hasProjectedContent()) {
        <div class="upload-icon" [style.font-size]="compact() ? '1.5rem' : null">{{ icon() }}</div>
        <div class="upload-text" [style.font-size]="compact() ? '0.75rem' : null">{{ text() }}</div>
        @if (hint()) {
          <div class="upload-hint">{{ hint() }}</div>
        }
      }
      <input
        #fileInput
        type="file"
        [attr.accept]="accept()"
        [multiple]="multiple()"
        (change)="onInputChange($event)"
      />
      <button
        type="button"
        class="upload-clear-btn"
        title="Clear"
        (click)="clear($event)"
      >
        ✕
      </button>
    </div>
  `,
})
export class UploadZoneComponent {
  readonly accept = input('image/*');
  readonly multiple = input(false);
  readonly title = input('');
  readonly icon = input('🖼️');
  readonly text = input('Drop files here or click to browse');
  readonly hint = input('');
  readonly compact = input(false);
  readonly hidden = input(false);
  /** When parent wants to force has-content state (e.g. handoff). */
  readonly forceContent = input(false);

  readonly filesSelected = output<FileList>();
  readonly cleared = output<void>();

  readonly dragOver = signal(false);
  readonly localContent = signal(false);

  hasContent(): boolean {
    return this.forceContent() || this.localContent();
  }

  /** Content projection check — always false for default template path. */
  hasProjectedContent(): boolean {
    return false;
  }

  onDragEnter(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(true);
  }

  onDragLeave(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(false);
  }

  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(false);
    const files = e.dataTransfer?.files;
    if (files?.length) {
      this.localContent.set(true);
      this.filesSelected.emit(files);
    }
  }

  onInputChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) {
      this.localContent.set(true);
      this.filesSelected.emit(input.files);
    }
  }

  clear(e: Event): void {
    e.stopPropagation();
    e.preventDefault();
    this.localContent.set(false);
    this.cleared.emit();
  }

  markEmpty(): void {
    this.localContent.set(false);
  }

  markLoaded(): void {
    this.localContent.set(true);
  }
}
