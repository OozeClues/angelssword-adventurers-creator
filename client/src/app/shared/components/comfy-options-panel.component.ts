import { Component, Input, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  SettingsService,
  type ComfyImageRole,
} from '../../core/settings.service';
import { ToastService } from '../../core/toast.service';
import { UploadZoneComponent } from './upload-zone.component';

/**
 * Floating sidebar panel: workflow, models, VRAM free-before-run, and
 * LoadImage slot assignment for Local ComfyUI (image or video tab).
 */
@Component({
  selector: 'app-comfy-options-panel',
  imports: [FormsModule, UploadZoneComponent],
  template: `
    <div class="glass-panel comfy-options-panel">
      <div class="panel-title">
        <span class="title-icon">🖥️</span>
        Local ComfyUI
        @if (settings.comfyModelsLoading()) {
          <span class="text-dim" style="font-size: 0.7rem; font-weight: 500; margin-left: 0.35rem"
            >loading…</span
          >
        }
      </div>
      <div class="panel-subtitle">
        @if (settings.comfyConnected()) {
          {{ settings.comfyBaseUrl() || 'connected' }}
        } @else {
          Not connected — open <strong>Settings</strong> to scan or enter a URL.
        }
      </div>

      @if (settings.comfyConnected()) {
        <div class="flex items-center gap-sm mt-1" style="flex-wrap: wrap">
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            title="Open the full ComfyUI graph editor in a new tab"
            (click)="openComfyUi()"
          >
            🔗 Open ComfyUI
          </button>
          <button type="button" class="btn btn-sm btn-secondary" (click)="refresh()">
            ↻ Refresh
          </button>
        </div>

        <div class="form-row mt-1">
          <label>{{ kind === 'image' ? 'Image' : 'Video' }} workflow</label>
          <select
            class="form-select"
            [ngModel]="templateId()"
            (ngModelChange)="onTemplateChange($event)"
            [attr.title]="kind === 'image' ? 'Image workflow source' : 'Video workflow source'"
          >
            <option value="custom">Custom (API JSON)…</option>
            @if (history().length) {
              <optgroup label="From history">
                @for (h of history(); track h.id) {
                  <option [value]="h.id">{{ h.title }}</option>
                }
              </optgroup>
            }
            @if (templates().length) {
              <optgroup label="Templates">
                @for (t of templates(); track t.id) {
                  <option [value]="t.id">{{ settings.comfyTemplateOptionLabel(t) }}</option>
                }
              </optgroup>
            }
          </select>
          @if (workflowDesc()) {
            <div class="text-dim mt-1" style="font-size: 0.72rem">{{ workflowDesc() }}</div>
          }
        </div>

        @if (templateId() === 'custom') {
          <div class="form-row mt-1">
            <label>Custom workflow JSON</label>
            <app-upload-zone
              accept=".json,application/json"
              icon="📄"
              text="Drop workflow JSON"
              hint="Save / Save (API Format)"
              [compact]="true"
              [forceContent]="!!workflowFileName()"
              (filesSelected)="onCustomFile($event)"
              (cleared)="clearCustomFile()"
            />
            @if (workflowFileName()) {
              <div class="text-dim mt-1" style="font-size: 0.7rem">
                Loaded: <strong>{{ workflowFileName() }}</strong>
              </div>
            }
            <textarea
              rows="4"
              class="comfy-workflow-ta mt-1"
              [class.drag-over]="taDrag()"
              [ngModel]="customWorkflow()"
              (ngModelChange)="onCustomText($event)"
              (dragenter)="onTaDrag($event, true)"
              (dragover)="onTaDrag($event, true)"
              (dragleave)="onTaDrag($event, false)"
              (drop)="onTaDrop($event)"
              placeholder="Paste API or UI JSON…"
            ></textarea>
          </div>
        }

        <div class="form-row mt-1">
          <div class="flex items-center gap-sm" style="flex-wrap: wrap">
            <label class="toggle-switch" [attr.title]="freeBeforeTitle">
              <input
                type="checkbox"
                [checked]="freeBeforeRun()"
                (change)="onFreeBefore($event)"
              />
              <span class="slider"></span>
            </label>
            <label style="margin-bottom: 0">Unload models before run</label>
          </div>
          <div class="text-dim mt-1" style="font-size: 0.7rem">
            Frees VRAM via Comfy <code>/free</code> so heavy checkpoints have headroom. Cold load next time.
          </div>
        </div>

        <div class="info-section-label mt-1">Models</div>
        @if (!hasModels()) {
          <div class="text-dim" style="font-size: 0.72rem">
            No checkpoint / UNet / LoRA loaders detected (or no workflow selected).
          </div>
        } @else {
          @for (c of modelSlots().checkpoints; track c.nodeId + '::' + c.field) {
            <div class="comfy-model-row">
              <label
                >{{ c.title }}
                <span class="text-dim">({{ c.classType }} · {{ c.field }})</span></label
              >
              <select
                class="form-select"
                [ngModel]="c.selected"
                (ngModelChange)="settings.updateComfyCheckpoint(kind, c.nodeId, $event, c.field)"
              >
                <option [value]="settings.workflowDefaultValue">
                  {{ settings.workflowDefaultOptionLabel(c.current) }}
                </option>
                @for (m of settings.modelSlotOptions(c); track m) {
                  <option [value]="m">{{ m }}</option>
                }
              </select>
            </div>
          }
          @for (u of modelSlots().unets; track u.nodeId + '::' + u.field) {
            <div class="comfy-model-row">
              <label
                >{{ u.title }}
                <span class="text-dim">({{ u.classType }} · {{ u.field }})</span></label
              >
              <select
                class="form-select"
                [ngModel]="u.selected"
                (ngModelChange)="settings.updateComfyUnet(kind, u.nodeId, $event, u.field)"
              >
                <option [value]="settings.workflowDefaultValue">
                  {{ settings.workflowDefaultOptionLabel(u.current) }}
                </option>
                @for (m of settings.modelSlotOptions(u); track m) {
                  <option [value]="m">{{ m }}</option>
                }
              </select>
            </div>
          }
          @for (cl of modelSlots().clips; track cl.nodeId + '::' + cl.field) {
            <div class="comfy-model-row">
              <label
                >{{ cl.title }}
                <span class="text-dim">(text encoder · {{ cl.field }})</span></label
              >
              <select
                class="form-select"
                [ngModel]="cl.selected"
                (ngModelChange)="settings.updateComfyClip(kind, cl.nodeId, $event, cl.field)"
              >
                <option [value]="settings.workflowDefaultValue">
                  {{ settings.workflowDefaultOptionLabel(cl.current) }}
                </option>
                @for (m of settings.modelSlotOptions(cl); track m) {
                  <option [value]="m">{{ m }}</option>
                }
              </select>
            </div>
          }
          @for (l of modelSlots().loras; track l.nodeId) {
            <div class="comfy-lora-card">
              <div class="flex items-center gap-sm" style="flex-wrap: wrap">
                <label class="toggle-switch" title="Enable LoRA">
                  <input
                    type="checkbox"
                    [checked]="l.enabled"
                    (change)="
                      settings.updateComfyLora(kind, l.nodeId, {
                        enabled: $any($event.target).checked
                      })
                    "
                  />
                  <span class="slider"></span>
                </label>
                <span style="font-size: 0.8rem">{{ l.title || 'LoRA' }}</span>
              </div>
              <select
                class="form-select mt-1"
                [disabled]="!l.enabled"
                [ngModel]="l.selected"
                (ngModelChange)="settings.updateComfyLora(kind, l.nodeId, { selected: $event })"
              >
                <option [value]="settings.workflowDefaultValue">
                  {{ settings.workflowDefaultOptionLabel(l.lora_name) }}
                </option>
                @for (m of settings.modelSlotOptions(l); track m) {
                  <option [value]="m">{{ m }}</option>
                }
              </select>
            </div>
          }
          @for (v of modelSlots().vaes; track v.nodeId + '::' + v.field) {
            <div class="comfy-model-row">
              <label
                >{{ v.title }}
                <span class="text-dim">(VAE · {{ v.field }})</span></label
              >
              <select
                class="form-select"
                [ngModel]="v.selected"
                (ngModelChange)="settings.updateComfyVae(kind, v.nodeId, $event, v.field)"
              >
                <option [value]="settings.workflowDefaultValue">
                  {{ settings.workflowDefaultOptionLabel(v.current) }}
                </option>
                @for (m of settings.modelSlotOptions(v); track m) {
                  <option [value]="m">{{ m }}</option>
                }
              </select>
            </div>
          }
        }

        <div class="info-section-label mt-1">Image inputs</div>
        <div class="text-dim" style="font-size: 0.72rem; margin-bottom: 0.35rem">
          {{ imageSlots().length }} LoadImage node{{ imageSlots().length === 1 ? '' : 's' }} in
          workflow.
          @if (imageSlots().length === 0) {
            Text/image-to-video only (no reference injection).
          } @else {
            Assignments stay <strong>None</strong> until you upload a reference; then a free slot is
            chosen and you can reassign.
          }
        </div>

        @if (imageSlots().length) {
          @for (role of roles(); track role.key) {
            <div class="comfy-model-row" [class.comfy-role-inactive]="!isRoleActive(role.key)">
              <label>{{ role.label }}</label>
              <select
                class="form-select"
                [disabled]="!isRoleActive(role.key)"
                [ngModel]="bindingValue(role.key)"
                (ngModelChange)="onBinding(role.key, $event)"
              >
                <option value="">None — not used</option>
                @for (slot of imageSlots(); track slot.nodeId) {
                  <option [value]="slot.nodeId" [title]="slot.classType + ' · node ' + slot.nodeId">
                    {{ settings.comfyImageSlotLabel(slot) }}
                  </option>
                }
              </select>
              @if (!isRoleActive(role.key)) {
                <div class="text-dim mt-1" style="font-size: 0.68rem">
                  Upload this reference to enable assignment.
                </div>
              }
            </div>
          }
        }

      }
    </div>
  `,
  styles: [
    `
      .comfy-options-panel .comfy-workflow-ta {
        width: 100%;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.7rem;
        line-height: 1.35;
        resize: vertical;
        min-height: 4rem;
      }
      .comfy-options-panel .comfy-workflow-ta.drag-over {
        outline: 1px dashed var(--accent-gold, #dbb858);
        background: rgba(219, 184, 88, 0.06);
      }
      .comfy-options-panel .comfy-model-row {
        margin-bottom: 0.45rem;
      }
      .comfy-options-panel .comfy-model-row label {
        font-size: 0.75rem;
        display: block;
        margin-bottom: 0.2rem;
      }
      .comfy-options-panel .comfy-lora-card {
        margin-bottom: 0.5rem;
        padding: 0.4rem 0.5rem;
        border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        border-radius: var(--radius, 6px);
      }
      .comfy-options-panel .form-select {
        font-size: 0.78rem;
      }
      .comfy-options-panel .comfy-role-inactive {
        opacity: 0.55;
      }
    `,
  ],
})
export class ComfyOptionsPanelComponent {
  @Input({ required: true }) kind!: 'image' | 'video';
  /**
   * App image roles that currently have an uploaded reference.
   * Inactive roles stay None / disabled until the parent adds them here.
   */
  readonly activeRoles = input<ComfyImageRole[]>([]);

  readonly settings = inject(SettingsService);
  private readonly toast = inject(ToastService);

  readonly workflowFileName = signal('');
  readonly taDrag = signal(false);

  constructor() {
    // When a reference becomes active, auto-pick a free LoadImage if still None
    effect(() => {
      const active = this.activeRoles();
      const kind = this.kind;
      if (!kind || !this.settings.comfyConnected()) return;
      // Depend on slot list so we re-run after inspect
      const slots =
        kind === 'image'
          ? this.settings.comfyImageImageSlots()
          : this.settings.comfyVideoImageSlots();
      if (!slots.length || !active?.length) return;
      for (const role of active) {
        this.settings.ensureComfyImageBinding(kind, role);
      }
    });
  }

  readonly templateId = computed(() =>
    this.kind === 'image'
      ? this.settings.comfyImageTemplateId()
      : this.settings.comfyVideoTemplateId()
  );

  readonly customWorkflow = computed(() =>
    this.kind === 'image'
      ? this.settings.comfyImageCustomWorkflow()
      : this.settings.comfyVideoCustomWorkflow()
  );

  readonly templates = computed(() =>
    this.kind === 'image'
      ? this.settings.comfyImageTemplates()
      : this.settings.comfyVideoTemplates()
  );

  readonly history = computed(() =>
    this.kind === 'image' ? this.settings.comfyImageHistory() : this.settings.comfyVideoHistory()
  );

  readonly modelSlots = computed(() =>
    this.kind === 'image'
      ? this.settings.comfyImageModelSlots()
      : this.settings.comfyVideoModelSlots()
  );

  readonly imageSlots = computed(() =>
    this.kind === 'image'
      ? this.settings.comfyImageImageSlots()
      : this.settings.comfyVideoImageSlots()
  );

  readonly bindings = computed(() =>
    this.kind === 'image'
      ? this.settings.comfyImageBindings()
      : this.settings.comfyVideoBindings()
  );

  readonly freeBeforeRun = computed(() =>
    this.kind === 'image'
      ? this.settings.comfyImageFreeBeforeRun()
      : this.settings.comfyVideoFreeBeforeRun()
  );

  readonly freeBeforeTitle =
    'POST /free with unload_models + free_memory before queueing this generate';

  readonly roles = computed((): Array<{ key: ComfyImageRole; label: string }> => {
    if (this.kind === 'image') {
      return [
        { key: 'character_reference', label: 'Character reference →' },
        { key: 'style_reference', label: 'Style reference →' },
      ];
    }
    // Separate reference-mode vs keyframe so they don't both default-fight for slot 0
    return [
      { key: 'reference_0', label: 'Reference image →' },
      { key: 'start_frame', label: 'Keyframe start →' },
      { key: 'end_frame', label: 'Keyframe end →' },
    ];
  });

  isRoleActive(role: ComfyImageRole): boolean {
    return this.activeRoles().includes(role);
  }

  /** Binding select value — empty string is None. */
  bindingValue(role: ComfyImageRole): string {
    const b = this.bindings()[role];
    return b == null ? '' : b;
  }

  readonly workflowDesc = computed(() => {
    const id = this.templateId();
    if (!id || id === 'custom') return '';
    if (id.startsWith('history:')) {
      return this.history().find((h) => h.id === id)?.description || '';
    }
    const t = this.templates().find((x) => x.id === id);
    return t?.description || '';
  });

  hasModels(): boolean {
    const s = this.modelSlots();
    return !!(
      s.checkpoints.length ||
      s.unets.length ||
      s.loras.length ||
      s.vaes.length ||
      (s.clips && s.clips.length)
    );
  }

  onTemplateChange(id: string): void {
    if (this.kind === 'image') this.settings.setComfyImageTemplateId(id);
    else this.settings.setComfyVideoTemplateId(id);
  }

  onCustomText(text: string): void {
    if (this.kind === 'image') this.settings.setComfyImageCustomWorkflow(text);
    else this.settings.setComfyVideoCustomWorkflow(text);
    if (!text.trim()) this.workflowFileName.set('');
  }

  onFreeBefore(ev: Event): void {
    const checked = !!(ev.target as HTMLInputElement).checked;
    this.settings.setComfyFreeBeforeRun(this.kind, checked);
  }

  onBinding(role: ComfyImageRole, nodeId: string): void {
    this.settings.updateComfyImageBinding(this.kind, role, nodeId);
  }

  openComfyUi(): void {
    if (!this.settings.openComfyUi()) {
      this.toast.show('Connect to ComfyUI first', 'warning');
    }
  }

  async refresh(): Promise<void> {
    try {
      await this.settings.refreshComfyTemplates();
      this.toast.show('ComfyUI workflow & models refreshed', 'success');
    } catch (err) {
      this.toast.show((err as Error).message || 'Refresh failed', 'error');
    }
  }

  clearCustomFile(): void {
    this.workflowFileName.set('');
    this.onCustomText('');
  }

  onTaDrag(ev: DragEvent, over: boolean): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.taDrag.set(over);
  }

  async onTaDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    ev.stopPropagation();
    this.taDrag.set(false);
    const file = ev.dataTransfer?.files?.[0];
    if (file) await this.loadWorkflowFile(file);
  }

  async onCustomFile(files: FileList): Promise<void> {
    const file = files?.[0];
    if (file) await this.loadWorkflowFile(file);
  }

  private async loadWorkflowFile(file: File): Promise<void> {
    const name = file.name || 'workflow.json';
    if (!/\.json$/i.test(name) && file.type && !file.type.includes('json')) {
      this.toast.show('Please choose a .json workflow file', 'warning');
      return;
    }
    try {
      const text = await file.text();
      JSON.parse(text); // validate
      this.onCustomText(text);
      this.workflowFileName.set(name);
      if (this.templateId() !== 'custom') {
        if (this.kind === 'image') this.settings.setComfyImageTemplateId('custom');
        else this.settings.setComfyVideoTemplateId('custom');
      }
      this.toast.show(`Loaded ${name}`, 'success');
    } catch (err) {
      this.toast.show((err as Error).message || 'Failed to load workflow file', 'error');
    }
  }
}
