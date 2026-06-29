/**
 * Deterministic Inference Engine for algorithmic test coverage.
 *
 * NOT a mock — a real, standalone IInferenceEngine implementation that
 * produces fully deterministic, mathematically predictable outputs.
 *
 * ## Why this exists
 *
 * The real ONNX model is a black box — we cannot spy on internal
 * forward() call counts, AR mask contents, or inject abort signals
 * at precise points during inference. These are algorithmic behaviors
 * of decode() that MUST be verified to ensure correctness, and they
 * are invisible through the public ONNX Runtime API
 * (InferenceSession.run()).
 *
 * ## What uses the real ONNX model
 *
 * - engine.test.ts    — integration: ONNX session creation + inference
 * - model.test.ts     — end-to-end: fromPretrained() → forecast()
 * - benchmark-ci.js   — accuracy + latency + regression detection
 *
 * ## Where this engine is used
 *
 * This engine is ONLY used in `decode-loop.test.ts` to test the pure
 * algorithm logic of the autoregressive decode loop — specifically:
 *
 * - Forward call counting (prefill=1, AR per-step=1)
 * - AR mask correctness (all-zero masks for AR inputs)
 * - Precise abort timing during AR decode
 * - Output shape propagation through the pipeline
 * - Edge cases (sigma < epsilon, horizon=4096, maxContext=1024)
 *
 * ## Deterministic properties
 *
 * Each forward() call returns outputs filled with `scale * (b + 1)` for
 * batch element `b`, ensuring deterministic values that vary per batch
 * element. This allows precise assertions on shape, propagation, and
 * numerical transformation through the decode pipeline.
 */

import { TIMESFM_25_CONFIG } from '@agentix-e/timesfm-core';
import type { IInferenceEngine, RawModelOutput, ModelConfig } from '@agentix-e/timesfm-core';

export interface DeterministicEngineOptions {
  /** Output scale factor (default: 1.0). Higher values = larger outputs. */
  scale?: number;
  /** Number of forward calls to track. */
  callCount?: { value: number };
  /** Force a specific outputTimeSeries shape per batch element. */
  outputShape?: { patches: number; perPatch: number };
}

/**
 * A deterministic, configurable implementation of IInferenceEngine.
 *
 * Each forward() call returns outputs filled with `scale * (b + 1)` for
 * batch element b, ensuring deterministic values that vary per batch element.
 */
export class DeterministicInferenceEngine implements IInferenceEngine {
  private _loaded = false;
  private _scale: number;
  private _callCount: { value: number };
  private _outputShape: { patches: number; perPatch: number };
  private readonly _mc: ModelConfig;

  constructor(options: DeterministicEngineOptions = {}, config: ModelConfig = TIMESFM_25_CONFIG) {
    const mc = config;
    this._mc = mc;
    this._scale = options.scale ?? 1.0;
    this._callCount = options.callCount ?? { value: 0 };
    const patches = options.outputShape?.patches ?? mc.exportedPatches;
    const perPatch = options.outputShape?.perPatch ?? mc.outputPatchLen * mc.numQuantiles;
    this._outputShape = { patches, perPatch };
  }

  async load(_modelPath: string, _options?: { skipWarmup?: boolean }): Promise<void> {
    this._loaded = true;
  }

  isLoaded(): boolean {
    return this._loaded;
  }

  get callCount(): number {
    return this._callCount.value;
  }

  /**
   * Returns deterministic outputs.
   *
   * outputTimeSeries: shape [batchSize, patches * perPatch]
   *   Filled with scale * (b + 1) for batch element b.
   * outputQuantileSpread: shape [batchSize, this._mc.outputQuantileLen * this._mc.numQuantiles]
   *   Filled with scale * (b + 1) * 0.5.
   */
  async forward(inputs: Float32Array[], _masks: Uint8Array[]): Promise<RawModelOutput> {
    this._callCount.value++;

    const batchSize = inputs.length;
    const { patches, perPatch } = this._outputShape;
    const tsl = patches * perPatch;
    const qsLen = this._mc.outputQuantileLen * this._mc.numQuantiles;

    const outputTimeSeries: Float32Array[] = [];
    const outputQuantileSpread: Float32Array[] = [];
    const inputEmbeddings: Float32Array[] = [];
    const outputEmbeddings: Float32Array[] = [];

    for (let b = 0; b < batchSize; b++) {
      const val = this._scale * (b + 1);

      const ts = new Float32Array(tsl);
      ts.fill(val);
      outputTimeSeries.push(ts);

      const qs = new Float32Array(qsLen);
      qs.fill(val * 0.5);
      outputQuantileSpread.push(qs);

      const emb = new Float32Array(patches * this._mc.modelDims);
      emb.fill(val);
      inputEmbeddings.push(emb);
      outputEmbeddings.push(emb);
    }

    return {
      inputEmbeddings,
      outputEmbeddings,
      outputTimeSeries,
      outputQuantileSpread,
    };
  }

  async dispose(): Promise<void> {
    this._loaded = false;
  }
}
