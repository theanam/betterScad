/**
 * Main-thread client for the render worker.
 *
 * Renders are coalesced: while one is in flight, further requests replace each
 * other rather than queueing, so dragging a Customizer slider produces a steady
 * stream of fresh frames instead of a backlog of stale ones.
 */

import type { Value } from '@betterscad/engine';
import type {
  ExportResponse,
  TranspileResponse,
  FontResponse,
  RenderResponse,
  SetFilesRequest,
  WorkerRequest,
  WorkerResponse,
} from './protocol.js';

export interface RenderInput {
  source: string;
  files: Record<string, string>;
  parameters: Record<string, Value>;
  time: number;
  preview: boolean;
  varyColors: boolean;
}

type Pending = {
  resolve(value: never): void;
  reject(error: Error): void;
};

export class RenderClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private inFlightRender: number | undefined;
  /** The project-directory revision the worker has. See `setProjectFiles`. */
  private sentFilesRevision = -1;
  private queuedRender: { input: RenderInput; resolve(r: RenderResponse): void; reject(e: Error): void } | undefined;

  private readyResolve!: () => void;
  readonly ready: Promise<void>;

  constructor(
    private readonly onRender: (result: RenderResponse) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'betterscad-render',
    });

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      this.onError(`Render worker failed: ${event.message}`);
      // Unblock anyone waiting, or the UI stays stuck on "rendering".
      for (const [, entry] of this.pending) entry.reject(new Error(event.message));
      this.pending.clear();
      this.inFlightRender = undefined;
    };
  }

  private receive(message: WorkerResponse): void {
    if (message.type === 'ready') {
      this.readyResolve();
      return;
    }

    const entry = this.pending.get(message.id);
    this.pending.delete(message.id);

    if (message.type === 'render-result') {
      this.inFlightRender = undefined;
      this.onRender(message);
      entry?.resolve(message as never);
      this.flushQueued();
      return;
    }

    if (message.type === 'error') {
      if (this.inFlightRender === message.id) this.inFlightRender = undefined;
      if (entry) entry.reject(new Error(message.message));
      else this.onError(message.message);
      this.flushQueued();
      return;
    }

    entry?.resolve(message as never);
  }

  private flushQueued(): void {
    if (!this.queuedRender || this.inFlightRender !== undefined) return;
    const queued = this.queuedRender;
    this.queuedRender = undefined;
    this.startRender(queued.input).then(queued.resolve, queued.reject);
  }

  /**
   * Requests a render, superseding any request that has not started yet.
   *
   * The promise of a superseded request resolves with the result of whichever
   * render actually runs, so callers never hang.
   */
  render(input: RenderInput): Promise<RenderResponse> {
    if (this.inFlightRender !== undefined) {
      if (this.queuedRender) {
        // Drop the older queued request; only the newest state matters.
        this.queuedRender.input = input;
        return new Promise((resolve, reject) => {
          const previous = this.queuedRender!;
          this.queuedRender = {
            input,
            resolve: (r) => {
              previous.resolve(r);
              resolve(r);
            },
            reject: (e) => {
              previous.reject(e);
              reject(e);
            },
          };
        });
      }
      return new Promise((resolve, reject) => {
        this.queuedRender = { input, resolve, reject };
      });
    }
    return this.startRender(input);
  }

  private startRender(input: RenderInput): Promise<RenderResponse> {
    const id = this.nextId++;
    this.inFlightRender = id;
    return this.send<RenderResponse>({
      type: 'render',
      id,
      source: input.source,
      files: input.files,
      parameters: input.parameters,
      time: input.time,
      preview: input.preview,
      varyColors: input.varyColors,
    });
  }

  /**
   * Hands the worker the project directory, if it does not already have it.
   *
   * Called before every render, and a no-op for all but the handful that follow
   * a change — which is the point: the worker keeps the bytes, so auto-render
   * ships source and parameters and nothing else.
   *
   * Nothing is transferred and nothing is awaited. The buffers stay usable on
   * this side, and `postMessage` is ordered, so the render queued immediately
   * after this call is guaranteed to see the new directory.
   */
  setProjectFiles(files: Record<string, Uint8Array>, revision: number): void {
    if (revision === this.sentFilesRevision) return;
    this.sentFilesRevision = revision;
    this.worker.postMessage({ type: 'set-files', files } satisfies SetFilesRequest);
  }

  /** Rewrites to stock `.scad` in the worker, where the fonts are. */
  transpile(source: string, file: string): Promise<TranspileResponse> {
    return this.send<TranspileResponse>({ type: 'transpile', id: this.nextId++, source, file });
  }

  exportModel(
    format: string,
    input: Omit<RenderInput, 'preview' | 'varyColors'>,
  ): Promise<ExportResponse> {
    return this.send<ExportResponse>({
      type: 'export',
      id: this.nextId++,
      format: format as never,
      source: input.source,
      files: input.files,
      parameters: input.parameters,
      time: input.time,
    });
  }

  loadFont(data: Uint8Array, makeDefault = false): Promise<FontResponse> {
    // The buffer is transferred, so the caller must not reuse it afterwards.
    const copy = data.slice();
    return this.send<FontResponse>(
      { type: 'load-font', id: this.nextId++, data: copy, makeDefault },
      [copy.buffer],
    );
  }

  /** Every request that expects an answer; `set-files` is posted directly. */
  private send<T>(
    request: Exclude<WorkerRequest, SetFilesRequest>,
    transfer: Transferable[] = [],
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(request.id, {
        resolve: resolve as Pending['resolve'],
        reject,
      });
      this.worker.postMessage(request, transfer);
    });
  }

  get busy(): boolean {
    return this.inFlightRender !== undefined || this.queuedRender !== undefined;
  }

  terminate(): void {
    this.worker.terminate();
  }
}
