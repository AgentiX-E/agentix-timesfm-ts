/**
 * TimesFM Web Inference Engine — browser-compatible ONNX inference via
 * onnxruntime-web (WASM / WebGPU / WebGL).
 *
 * Implements the `IInferenceEngine` interface from @agentix-e/timesfm-core
 * so it can be injected into `TimesFMModel.fromPretrained()`.
 *
 * ## Execution Providers
 *
 * | Provider  | Speed   | Availability        |
 * |-----------|---------|---------------------|
 * | `webgpu`  | Fastest | Chrome 113+, Edge   |
 * | `wasm`    | Good    | All modern browsers |
 * | `webgl`   | Legacy  | Older browsers      |
 *
 * The engine tries providers in order: webgpu → wasm → webgl,
 * falling back to the next available one on failure.
 *
 * ## Model Loading
 *
 * `load()` accepts:
 * - A URL string (fetched via `fetch()`)
 * - An `ArrayBuffer` (pre-loaded model data)
 *
 * ## Usage
 *
 * ```typescript
 * import { TimesFMModel, createForecastConfig } from '@agentix-e/timesfm-core';
 * import { TimesFMWebInferenceEngine } from '@agentix-e/timesfm-web';
 *
 * const engine = new TimesFMWebInferenceEngine(config);
 * await engine.load('/models/timesfm-2.5.onnx');
 *
 * const model = await TimesFMModel.fromPretrained({
 *   modelPath: '/models/timesfm-2.5.onnx',
 *   engine,
 * });
 * model.compile(createForecastConfig({ maxContext: 512, maxHorizon: 128 }));
 * const result = await model.forecast(24, [inputData]);
 * ```
 *
 * @module web-engine
 */

import type { ModelConfig, IInferenceEngine, RawModelOutput } from '@agentix-e/timesfm-core';

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Browser-compatible inference engine backed by onnxruntime-web.
 *
 * Supports WASM, WebGPU, and WebGL backends with automatic fallback.
 * Accepts model URLs (fetched) or pre-loaded ArrayBuffers.
 */
export class TimesFMWebInferenceEngine implements IInferenceEngine {
  private _config: ModelConfig;
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  private _ortModule: typeof import('onnxruntime-web') | null = null;
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  private _session: import('onnxruntime-web').InferenceSession | null = null;
  private _loaded = false;

  /** Preferred execution providers in fallback order. */
  private readonly _providers: Array<'webgpu' | 'wasm' | 'webgl'>;

  /** Custom WASM path for onnxruntime-web (used in Node.js testing). */
  private _wasmPath: string | null = null;

  /**
   * @param config          Model architecture configuration.
   * @param executionProviders  Execution providers to try, in order.
   *                            Default: `['webgpu', 'wasm']`
   */
  constructor(
    config: ModelConfig,
    executionProviders: Array<'webgpu' | 'wasm' | 'webgl'> = ['webgpu', 'wasm'],
  ) {
    this._config = config;
    this._providers = executionProviders;
  }

  /**
   * Set a custom WASM binary path for onnxruntime-web.
   *
   * Required when running in Node.js (not a browser) since the default
   * CDN URL won't work. Point this to the `dist/` directory of the
   * onnxruntime-web package.
   *
   * @example
   * ```typescript
   * // In Node.js testing:
   * import { createRequire } from 'node:module';
   * const require = createRequire(import.meta.url);
   * const wasmDir = require.resolve('onnxruntime-web').replace('/lib/index.js', '/dist/');
   * engine.setWasmPath(wasmDir);
   * ```
   */
  setWasmPath(wasmPath: string): void {
    this._wasmPath = wasmPath;
  }

  // -----------------------------------------------------------------------
  // IInferenceEngine — load
  // -----------------------------------------------------------------------

  /**
   * Load the ONNX model.
   *
   * @param modelPath  URL to the ONNX model file, **or** an ArrayBuffer.
   */
  async load(modelPath: string | ArrayBuffer): Promise<void> {
    const ort = await import('onnxruntime-web');
    this._ortModule = ort;

    // Configure WASM path — onnxruntime-web needs to locate the WASM binary.
    // Priority: 1) custom path set via setWasmPath()
    //           2) auto-detect from onnxruntime-web package (Node.js)
    //           3) jsdelivr CDN (browser default)
    if (this._wasmPath) {
      // Ensure trailing slash — onnxruntime-web concatenates filenames directly
      ort.env.wasm.wasmPaths = this._wasmPath.endsWith('/') ? this._wasmPath : this._wasmPath + '/';
    } else if (!ort.env.wasm.wasmPaths) {
      // Try Node.js detection: resolve onnxruntime-web from node_modules
      try {
        const { createRequire } = await import('node:module');
        const req = createRequire(import.meta.url);
        const pkgDir = req.resolve('onnxruntime-web');
        // onnxruntime-web's main entry is lib/index.js or dist/ort.node.min.js
        // WASM files are in dist/. Ensure trailing slash.
        let distDir = pkgDir.replace(/\/lib\/.+$/, '/dist/');
        if (!distDir.endsWith('/')) distDir += '/';
        ort.env.wasm.wasmPaths = distDir;
      } catch {
        // Browser fallback: use jsdelivr CDN
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
      }
    }

    // Disable multi-threading in browser (not supported in all contexts)
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;

    // Try each provider in order until one succeeds
    let lastError: Error | null = null;

    for (const provider of this._providers) {
      try {
        // eslint-disable-next-line @typescript-eslint/consistent-type-imports
        const sessionOptions: import('onnxruntime-web').InferenceSession.SessionOptions = {
          executionProviders: [provider],
          graphOptimizationLevel: 'all',
          enableCpuMemArena: true,
          enableMemPattern: true,
        };

        // Accept both URL string and ArrayBuffer
        if (typeof modelPath === 'string') {
          this._session = await ort.InferenceSession.create(modelPath, sessionOptions);
        } else {
          this._session = await ort.InferenceSession.create(modelPath, sessionOptions);
        }

        // eslint-disable-next-line no-console
        console.log(`[TimesFM Web] Loaded model with ${provider} provider`);
        this._loaded = true;
        return;
      } catch (err) {
        console.warn(
          `[TimesFM Web] ${provider} provider failed: ${(err as Error).message}. Trying next...`,
        );
        lastError = err as Error;
        // Continue to next provider
      }
    }

    throw new Error(
      `[TimesFM Web] All execution providers failed. Last error: ${lastError?.message}`,
    );
  }

  // -----------------------------------------------------------------------
  // IInferenceEngine — forward
  // -----------------------------------------------------------------------

  async forward(inputs: Float32Array[], masks: Uint8Array[]): Promise<RawModelOutput> {
    if (!this._session || !this._ortModule) {
      throw new Error('[TimesFM Web] Engine not loaded. Call load() first.');
    }

    const ort = this._ortModule;
    const batchSize = inputs.length;
    const patchesPerSeries = inputs[0].length / this._config.tokenizerInputDims;

    // Build the combined input tensor: [batchSize, patches, tokenizerInputDims]
    const combined = new Float32Array(
      batchSize * patchesPerSeries * this._config.tokenizerInputDims,
    );
    const maskTensor = new Float32Array(batchSize * patchesPerSeries);
    for (let b = 0; b < batchSize; b++) {
      const offset = b * patchesPerSeries * this._config.tokenizerInputDims;
      combined.set(inputs[b], offset);
      // Convert Uint8Array mask to Float32Array (0.0 = visible, 1.0 = masked)
      for (let p = 0; p < patchesPerSeries; p++) {
        maskTensor[b * patchesPerSeries + p] = masks[b]?.[p] ?? 0;
      }
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const feeds: Record<string, import('onnxruntime-web').Tensor> = {
      inputs: new ort.Tensor('float32', combined, [
        batchSize,
        patchesPerSeries,
        this._config.tokenizerInputDims,
      ]),
      patched_mask: new ort.Tensor('float32', maskTensor, [batchSize, patchesPerSeries]),
    };

    const results = await this._session.run(feeds);

    // Extract raw model outputs (field names match ONNX export)
    const ie = results['input_embedding']?.data as Float32Array;
    const oe = results['output_embedding']?.data as Float32Array;
    const ts = results['output_time_series']?.data as Float32Array;
    const qs = results['output_quantile_spread']?.data as Float32Array;

    return {
      inputEmbeddings: [ie ?? new Float32Array(0)],
      outputEmbeddings: [oe ?? new Float32Array(0)],
      outputTimeSeries: [ts ?? new Float32Array(0)],
      outputQuantileSpread: [qs ?? new Float32Array(0)],
    };
  }

  // -----------------------------------------------------------------------
  // IInferenceEngine — dispose
  // -----------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this._session) {
      try {
        // onnxruntime-web's release() is available but may throw in some contexts
        if (typeof this._session.release === 'function') {
          this._session.release();
        }
      } catch {
        // GC will handle WASM cleanup eventually
      }
      this._session = null;
    }
    this._ortModule = null;
    this._loaded = false;
  }

  // -----------------------------------------------------------------------
  // IInferenceEngine — status
  // -----------------------------------------------------------------------

  isLoaded(): boolean {
    return this._loaded;
  }
}
