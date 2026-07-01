/**
 * Node.js ONNX Runtime inference engine for TimesFM.
 *
 * Production-grade inference engine backed by `onnxruntime-node`.
 * Handles fixed-shape exported models by padding variable-length
 * inputs and running sequential batch elements.
 *
 * @module timesfm-node
 */

import {
  TIMESFM_25_CONFIG,
  type IInferenceEngine,
  type RawModelOutput,
  type ModelConfig,
  type ModelLoadOptions,
  InferenceError,
} from '@agentix-e/timesfm-core';

const PROVIDER_MAP: Record<string, string> = {
  cpu: 'CPUExecutionProvider',
  cuda: 'CUDAExecutionProvider',
  dml: 'DmlExecutionProvider',
};

const CPU = PROVIDER_MAP['cpu'];

// ---------------------------------------------------------------------------
// Engine options (subset of ModelLoadOptions relevant to engine construction)
// ---------------------------------------------------------------------------

interface EngineOptions {
  executionProvider?: string;
  intraOpNumThreads?: number;
}

// ---------------------------------------------------------------------------
// TimesFMNodeEngine
// ---------------------------------------------------------------------------

export class TimesFMNodeEngine implements IInferenceEngine {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  private _session: import('onnxruntime-node').InferenceSession | null = null;
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  private _ortModule: typeof import('onnxruntime-node') | null = null;
  private _loaded = false;
  private readonly _config: ModelConfig;
  private _executionProvider: string;
  private _intraOpNumThreads: number;

  constructor(config: ModelConfig = TIMESFM_25_CONFIG, options: EngineOptions = {}) {
    this._config = config;
    this._executionProvider =
      (PROVIDER_MAP[options.executionProvider ?? 'cpu'] as string) ??
      (PROVIDER_MAP['cpu'] as string);
    this._intraOpNumThreads = options.intraOpNumThreads ?? 0;
  }

  /**
   * Load the ONNX model from disk and create an inference session.
   *
   * @param modelPath   Filesystem path to the `.onnx` model file.
   * @param options     Load-time flags:
   *   - `skipWarmup`:  When `true`, the dummy warmup inference is skipped.
   *     This is intended for **benchmarking** where the caller wants to
   *     measure the true first-inference (cold-start) latency separately.
   *     Production callers should leave this at the default (`false`).
   */
  async load(modelPath: string, options?: { skipWarmup?: boolean }): Promise<void> {
    this._ortModule = await import('onnxruntime-node');

    const commonOpts = {
      intraOpNumThreads: this._intraOpNumThreads,
    };
    if (this._executionProvider !== CPU) {
      /* v8 ignore next 4 — CUDA/DML provider paths require GPU hardware, tested locally */
      this._session = await this._ortModule.InferenceSession.create(modelPath, {
        executionProviders: [this._executionProvider, CPU] as [string, ...string[]],
        ...commonOpts,
      });
    } else {
      this._session = await this._ortModule.InferenceSession.create(modelPath, commonOpts);
    }

    if (!options?.skipWarmup) {
      try {
        await this._warmup();
      } catch (err) {
        console.warn(
          `[TimesFM] Warmup inference failed: ${(err as Error).message}. ` +
            `First forecast() may be slower or fail.`,
        );
      }
    }
    this._loaded = true;
  }

  private async _warmup(): Promise<void> {
    if (!this._session || !this._ortModule) return;
    try {
      const ort = this._ortModule;
      const session = this._session;
      const tokenizerLen = this._config.tokenizerInputDims;

      const inputName = session.inputNames[0];
      if (!inputName) return;

      const dummyInput = new Float32Array(1 * this._config.exportedPatches * tokenizerLen);
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      const feeds: Record<string, import('onnxruntime-node').Tensor> = {
        [inputName]: new ort.Tensor('float32', dummyInput, [
          1,
          this._config.exportedPatches,
          tokenizerLen,
        ]),
      };
      await session.run(feeds);
      /* v8 ignore next 3 — warmup failure only triggers on broken ONNX Runtime installs */
    } catch {
      // Warmup failure is non-fatal — first real inference will handle it
    }
  }

  isLoaded(): boolean {
    return this._loaded;
  }

  async forward(inputs: Float32Array[], masks: Uint8Array[]): Promise<RawModelOutput> {
    if (!this._session || !this._ortModule) {
      throw new Error('ONNX engine not loaded. Call load() first.');
    }

    const ort = this._ortModule;
    const session = this._session;

    try {
      return await this._forwardUnsafe(ort, session, inputs, masks);
    } catch (err) {
      throw new InferenceError(
        `ONNX Runtime inference failed: ${(err as Error).message}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  private async _forwardUnsafe(
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    ort: typeof import('onnxruntime-node'),
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    session: import('onnxruntime-node').InferenceSession,
    inputs: Float32Array[],
    masks: Uint8Array[],
  ): Promise<RawModelOutput> {
    const batchSize = inputs.length;
    const inputPatchLen = this._config.inputPatchLen;
    const tokenizerLen = this._config.tokenizerInputDims;

    const inputName = session.inputNames[0];
    const outputNames = session.outputNames;
    if (!inputName) {
      throw new Error('Model session has no input names defined.');
    }

    const resolveOutputName = (preferred: string): string => {
      if (outputNames.includes(preferred)) return preferred;
      const canonicalOrder = ['input_emb', 'output_emb', 'output_ts', 'output_qs'];
      const idx = canonicalOrder.indexOf(preferred);
      if (idx >= 0 && idx < outputNames.length) return outputNames[idx]!;
      return preferred;
    };

    const results = await Promise.all(
      Array.from({ length: batchSize }, async (_, b) => {
        const input = inputs[b]!;
        const mask = masks[b]!;
        const numInputPatches = Math.floor(input.length / inputPatchLen);

        const flatInputs = new Float32Array(1 * this._config.exportedPatches * tokenizerLen);
        const copyPatches = Math.min(numInputPatches, this._config.exportedPatches);

        for (let p = 0; p < this._config.exportedPatches; p++) {
          const basePatch = p * tokenizerLen;
          if (p < copyPatches) {
            for (let i = 0; i < inputPatchLen; i++) {
              flatInputs[basePatch + i] = input![p * inputPatchLen + i]!;
              flatInputs[basePatch + inputPatchLen + i] = mask![p * inputPatchLen + i]!;
            }
          } else {
            for (let i = 0; i < inputPatchLen; i++) {
              flatInputs[basePatch + i] = 0;
              flatInputs[basePatch + inputPatchLen + i] = 1;
            }
          }
        }

        // eslint-disable-next-line @typescript-eslint/consistent-type-imports
        const feeds: Record<string, import('onnxruntime-node').Tensor> = {
          [inputName]: new ort.Tensor('float32', flatInputs, [
            1,
            this._config.exportedPatches,
            tokenizerLen,
          ]),
        };

        const sessionResults = await session.run(feeds);

        // eslint-disable-next-line @typescript-eslint/consistent-type-imports
        const extract = (t: import('onnxruntime-node').Tensor) => {
          /* v8 ignore next 2 — TimesFM ONNX models always output float32 tensors */
          if (t.type !== 'float32') {
            throw new Error(`Expected float32 tensor, got ${t.type}`);
          }
          return new Float32Array(t.data as Float32Array);
        };

        return {
          inputEmb: extract(sessionResults[resolveOutputName('input_emb')]!),
          outputEmb: extract(sessionResults[resolveOutputName('output_emb')]!),
          outputTS: extract(sessionResults[resolveOutputName('output_ts')]!),
          outputQS: extract(sessionResults[resolveOutputName('output_qs')]!),
        };
      }),
    );

    const inputEmbs = results.map((r) => r.inputEmb);
    const outputEmbs = results.map((r) => r.outputEmb);
    const outputTSs = results.map((r) => r.outputTS);
    const outputQSs = results.map((r) => r.outputQS);

    return {
      inputEmbeddings: inputEmbs,
      outputEmbeddings: outputEmbs,
      outputTimeSeries: outputTSs,
      outputQuantileSpread: outputQSs,
    };
  }

  get executionProvider(): string {
    return this._executionProvider;
  }

  async dispose(): Promise<void> {
    if (this._session) {
      try {
        const s = this._session as unknown as Record<string, unknown>;
        if (typeof s.release === 'function') {
          await (s.release as () => Promise<void>)();
        }
      } catch {
        // Best-effort cleanup
      }
    }
    this._session = null;
    this._ortModule = null;
    this._loaded = false;
  }
}

// ---------------------------------------------------------------------------
// Factory function for dynamic import in timesfm-core
// ---------------------------------------------------------------------------

/**
 * Create the default Node.js ONNX Runtime inference engine.
 *
 * Used by `TimesFMModel.fromPretrained()` when no custom engine is provided.
 * The factory pattern avoids a static import of `onnxruntime-node` from
 * `timesfm-core`, enabling pure-browser consumption without native addon bloat.
 */
export function createDefaultEngine(
  config: ModelConfig,
  options: Pick<ModelLoadOptions, 'executionProvider' | 'intraOpNumThreads'> = {},
): IInferenceEngine {
  return new TimesFMNodeEngine(config, options);
}
