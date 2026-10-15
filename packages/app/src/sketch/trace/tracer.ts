/**
 * The main-thread side of automatic tracing.
 *
 * The worker is made on first use and the weights fetched then, never at
 * start-up: a couple of megabytes is not worth a request from somebody who
 * never traces anything. What the first use costs is said before it happens,
 * and once the service worker has the file it costs nothing again.
 */

import type { TraceProvider } from '../editor.js';
import type { Mask } from './vectorize.js';
import type { TraceRequest, TraceResponse } from './trace-worker.js';

/** The model's input side; it was trained at this size. */
const SIZE = 320;
const MODEL_FILE = 'models/u2netp.onnx';
const MODEL_SIZE = 'about 2.4 MB';
const TIMEOUT_MS = 120_000;

export class SubjectTracer implements TraceProvider {
  private readonly modelUrl: string;
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(mask: Mask): void; reject(error: Error): void; timer: number }>();
  /** Set once a run has succeeded, so the "downloads" note is not repeated. */
  private warm = false;

  constructor(base: string) {
    this.modelUrl = new URL(MODEL_FILE, base).href;
  }

  async describe(): Promise<string> {
    if (this.warm) return '';
    try {
      if (typeof caches !== 'undefined' && (await caches.match(this.modelUrl))) return '';
    } catch {
      // No cache access, as in a private window: assume a download.
    }
    return MODEL_SIZE;
  }

  subject(image: ImageData): Promise<Mask> {
    const rgba = squared(image, SIZE);
    const id = this.nextId++;
    return new Promise<Mask>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        this.reset();
        reject(new Error('the model took too long to answer'));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const request: TraceRequest = { id, modelUrl: this.modelUrl, rgba, size: SIZE };
      this.ensureWorker().postMessage(request, [rgba.buffer]);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./trace-worker.ts', import.meta.url), { type: 'module', name: 'betterscad-trace' });
    worker.onmessage = (event: MessageEvent<TraceResponse>) => {
      const job = this.pending.get(event.data.id);
      if (!job) return;
      this.pending.delete(event.data.id);
      window.clearTimeout(job.timer);
      if (event.data.ok) {
        this.warm = true;
        job.resolve({ data: event.data.mask, width: event.data.size, height: event.data.size });
      } else {
        job.reject(new Error(event.data.error));
      }
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'the tracing worker failed');
      for (const job of this.pending.values()) {
        window.clearTimeout(job.timer);
        job.reject(error);
      }
      this.pending.clear();
      this.reset();
    };
    this.worker = worker;
    return worker;
  }

  private reset(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }
}

/** The picture stretched to a square of `size`, as RGBA bytes. */
function squared(image: ImageData, size: number): Uint8ClampedArray {
  const source = document.createElement('canvas');
  source.width = image.width;
  source.height = image.height;
  source.getContext('2d')!.putImageData(image, 0, 0);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}
