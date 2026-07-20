/**
 * Minimal WebGPU typings so the exporter builds without @webgpu/types.
 * Only the surface used by chroma-webgpu.ts is declared.
 */

interface GPU {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): GPUTextureFormat;
}

interface GPURequestAdapterOptions {
  powerPreference?: 'low-power' | 'high-performance';
  forceFallbackAdapter?: boolean;
}

interface GPUAdapterInfo {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
}

interface GPUAdapter {
  requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>;
  readonly limits: GPUSupportedLimits;
  /** Chromium: static adapter info (preferred over requestAdapterInfo). */
  readonly info?: GPUAdapterInfo;
  requestAdapterInfo?(): Promise<GPUAdapterInfo>;
}

interface GPUSupportedLimits {
  readonly maxStorageBufferBindingSize: number;
  readonly maxComputeWorkgroupSizeX: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
}

interface GPUDeviceDescriptor {
  requiredLimits?: Record<string, number>;
  label?: string;
}

interface GPUDevice extends EventTarget {
  readonly queue: GPUQueue;
  readonly lost: Promise<GPUDeviceLostInfo>;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline;
  createComputePipelineAsync?(
    descriptor: GPUComputePipelineDescriptor
  ): Promise<GPUComputePipeline>;
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout;
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
  createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor): GPUCommandEncoder;
  destroy(): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
}

interface GPUDeviceLostInfo {
  readonly reason: string;
  readonly message: string;
}

interface GPUQueue {
  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: BufferSource | SharedArrayBuffer,
    dataOffset?: number,
    size?: number
  ): void;
  submit(commandBuffers: GPUCommandBuffer[]): void;
}

interface GPUShaderModuleDescriptor {
  code: string;
  label?: string;
}

interface GPUShaderModule {
  getCompilationInfo?(): Promise<GPUCompilationInfo>;
}

interface GPUCompilationInfo {
  readonly messages: ReadonlyArray<GPUCompilationMessage>;
}

interface GPUCompilationMessage {
  readonly message: string;
  readonly type: 'error' | 'warning' | 'info';
  readonly lineNum: number;
  readonly linePos: number;
}

type GPUBufferUsageFlags = number;
type GPUMapModeFlags = number;
type GPUShaderStageFlags = number;
type GPUTextureFormat = string;

interface GPUBufferDescriptor {
  size: number;
  usage: GPUBufferUsageFlags;
  mappedAtCreation?: boolean;
  label?: string;
}

interface GPUBuffer {
  readonly size: number;
  mapAsync(mode: GPUMapModeFlags, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

interface GPUBindGroupLayoutDescriptor {
  entries: GPUBindGroupLayoutEntry[];
  label?: string;
}

interface GPUBindGroupLayoutEntry {
  binding: number;
  visibility: GPUShaderStageFlags;
  buffer?: GPUBufferBindingLayout;
}

interface GPUBufferBindingLayout {
  type?: 'uniform' | 'storage' | 'read-only-storage';
  hasDynamicOffset?: boolean;
  minBindingSize?: number;
}

interface GPUBindGroupLayout {}

interface GPUPipelineLayoutDescriptor {
  bindGroupLayouts: GPUBindGroupLayout[];
  label?: string;
}

interface GPUPipelineLayout {}

interface GPUComputePipelineDescriptor {
  layout: GPUPipelineLayout | 'auto';
  compute: { module: GPUShaderModule; entryPoint: string };
  label?: string;
}

interface GPUComputePipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}

interface GPUBindGroupDescriptor {
  layout: GPUBindGroupLayout;
  entries: GPUBindGroupEntry[];
  label?: string;
}

interface GPUBindGroupEntry {
  binding: number;
  resource: GPUBufferBinding;
}

interface GPUBufferBinding {
  buffer: GPUBuffer;
  offset?: number;
  size?: number;
}

interface GPUBindGroup {}

interface GPUCommandEncoderDescriptor {
  label?: string;
}

interface GPUCommandEncoder {
  beginComputePass(descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder;
  copyBufferToBuffer(
    source: GPUBuffer,
    sourceOffset: number,
    destination: GPUBuffer,
    destinationOffset: number,
    size: number
  ): void;
  finish(descriptor?: GPUCommandBufferDescriptor): GPUCommandBuffer;
}

interface GPUComputePassDescriptor {
  label?: string;
}

interface GPUComputePassEncoder {
  setPipeline(pipeline: GPUComputePipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}

interface GPUCommandBufferDescriptor {
  label?: string;
}

interface GPUCommandBuffer {}

interface GPU {
  // duplicate ok
}

interface Navigator {
  readonly gpu?: GPU;
}

declare const GPUBufferUsage: {
  readonly MAP_READ: number;
  readonly MAP_WRITE: number;
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly INDEX: number;
  readonly VERTEX: number;
  readonly UNIFORM: number;
  readonly STORAGE: number;
  readonly INDIRECT: number;
  readonly QUERY_RESOLVE: number;
};

declare const GPUMapMode: {
  readonly READ: number;
  readonly WRITE: number;
};

declare const GPUShaderStage: {
  readonly VERTEX: number;
  readonly FRAGMENT: number;
  readonly COMPUTE: number;
};
