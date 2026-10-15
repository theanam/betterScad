/// <reference lib="webworker" />
/**
 * Finding the subject of a picture, off the main thread.
 *
 * U²-Netp takes a 320×320 picture and answers with one number per pixel:
 * how much of the subject is there. Small as it is, that is hundreds of
 * milliseconds of arithmetic, and on the main thread every one of them would
 * freeze the board.
 */

import * as ort from 'onnxruntime-web/wasm';

export interface TraceRequest {
  id: number;
  /** Where the weights are, resolved by the page against its own base. */
  modelUrl: string;
  /** The picture, square, laid out as RGBA. */
  rgba: Uint8ClampedArray;
  size: number;
}

export type TraceResponse = { id: number; ok: true; mask: Uint8ClampedArray; size: number } | { id: number; ok: false; error: string };

/** ImageNet statistics, which is what the model was trained against. */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let session: Promise<ort.InferenceSession> | null = null;

function load(modelUrl: string): Promise<ort.InferenceSession> {
  if (!session) {
    // The `onnxruntime-web/wasm` entry references its WebAssembly as a module
    // asset, so the bundler emits it alongside everything else and it comes
    // from our own origin — no CDN, so it works offline and tells nobody.
    // GitHub Pages cannot send the headers SharedArrayBuffer needs, so one
    // thread; asking for more costs a failed probe and a console error.
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    const attempt = ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    // A load that failed must not be remembered as the answer.
    attempt.catch(() => {
      if (session === attempt) session = null;
    });
    session = attempt;
  }
  return session;
}

self.addEventListener('message', async (event: MessageEvent<TraceRequest>) => {
  const { id, modelUrl, rgba, size } = event.data;
  try {
    const model = await load(modelUrl);
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) input[c * plane + i] = (rgba[i * 4 + c] / 255 - MEAN[c]) / STD[c];
    }
    const outputs = await model.run({
      [model.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]),
    });
    // Seven maps come out: the fused prediction first, then one per decoder
    // stage that exists to be supervised during training. The first is the answer.
    const data = outputs[model.outputNames[0]].data as Float32Array;
    if (!data || data.length < plane) throw new Error('the model returned no map');

    // Stretched to the full range, as the paper's own post-processing does:
    // without it an uncertain subject comes back uniformly grey.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < plane; i++) {
      if (data[i] < lo) lo = data[i];
      if (data[i] > hi) hi = data[i];
    }
    const span = hi - lo;
    const mask = new Uint8ClampedArray(plane);
    for (let i = 0; i < plane; i++) mask[i] = span > 1e-6 ? Math.round(((data[i] - lo) / span) * 255) : 0;
    const response: TraceResponse = { id, ok: true, mask, size };
    self.postMessage(response, [mask.buffer]);
  } catch (err) {
    const response: TraceResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(response);
  }
});
