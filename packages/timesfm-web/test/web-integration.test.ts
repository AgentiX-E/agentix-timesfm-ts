/**
 * Web engine integration tests — real TimesFM ONNX model via onnxruntime-web WASM.
 *
 * These tests use the actual 885 MB TimesFM 2.5 ONNX model with the
 * onnxruntime-web WASM backend running in Node.js.
 *
 * Requires: TIMESFM_WEB_TEST_MODEL environment variable pointing to the ONNX file.
 *
 * Skip these tests if no model is available (they won't fail, just skip).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';

import {
  TIMESFM_25_CONFIG,
  TimesFMModel,
  createForecastConfig,
  preprocess,
  postProcess,
} from '@agentix-e/timesfm-core';
import { TimesFMWebInferenceEngine } from '../src/web-engine';

// ---------------------------------------------------------------------------
// Model path resolution
// ---------------------------------------------------------------------------

function getModelPath(): string | null {
  // 1. Explicit env var
  if (process.env.TIMESFM_WEB_TEST_MODEL && fs.existsSync(process.env.TIMESFM_WEB_TEST_MODEL)) {
    return process.env.TIMESFM_WEB_TEST_MODEL;
  }
  // 2. Also check the standard test model var
  if (process.env.TIMESFM_TEST_MODEL && fs.existsSync(process.env.TIMESFM_TEST_MODEL)) {
    return process.env.TIMESFM_TEST_MODEL;
  }
  // 3. Search common paths
  const searchPaths = [
    path.join(process.cwd(), 'models', 'timesfm-2.5.onnx'),
    path.join(process.cwd(), '..', 'models', 'timesfm-2.5.onnx'),
    path.join(os.homedir(), '.cache', 'agentix-timesfm-ts', 'timesfm-2.5.onnx'),
  ];
  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// WASM path resolution (for onnxruntime-web in Node.js)
// ---------------------------------------------------------------------------

function resolveWasmPath(): string {
  try {
    const req = createRequire(import.meta.url);
    const ortPkg = req.resolve('onnxruntime-web');
    // onnxruntime-web exports from lib/index.js, WASM files are in dist/
    const distDir = path.dirname(ortPkg).replace(/\/lib$/, '/dist/');
    if (fs.existsSync(distDir)) {
      return distDir;
    }
  } catch {
    // Fall through
  }
  // Search pnpm store
  const searchDirs = [
    '/workspace/agentix-timesfm-ts/node_modules/.pnpm/onnxruntime-web@1.27.0/node_modules/onnxruntime-web/dist/',
  ];
  for (const d of searchDirs) {
    if (fs.existsSync(d)) return d;
  }
  throw new Error('Cannot find onnxruntime-web WASM files. Install onnxruntime-web first.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a simple synthetic time series for testing. */
function buildTestSeries(length: number): Float32Array {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = 100 + 20 * Math.sin((2 * Math.PI * i) / 12) + (Math.random() - 0.5) * 10;
  }
  return data;
}

/** Check that a Float32Array contains finite values. */
function allFinite(arr: Float32Array): boolean {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Skip marker
// ---------------------------------------------------------------------------

const modelPath = getModelPath();
const describeOrSkip = modelPath ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeOrSkip('TimesFMWebInferenceEngine (real model)', () => {
  let engine: TimesFMWebInferenceEngine;
  let model: TimesFMModel;
  const wasmPath = resolveWasmPath();

  beforeAll(async () => {
    if (!modelPath) throw new Error('No model available');

    // Create web engine with WASM-only backend (Node.js)
    engine = new TimesFMWebInferenceEngine(TIMESFM_25_CONFIG, ['wasm']);
    engine.setWasmPath(wasmPath);

    // Load the real ONNX model
    console.log(`[Web Test] Loading model from: ${modelPath}`);
    console.log(`[Web Test] WASM path: ${wasmPath}`);
    const loadStart = performance.now();
    await engine.load(modelPath);
    const loadTime = ((performance.now() - loadStart) / 1000).toFixed(1);
    console.log(`[Web Test] Model loaded in ${loadTime}s via WASM backend`);

    // Create TimesFMModel with injected engine
    model = await TimesFMModel.fromPretrained({
      modelPath: modelPath!,
      engine,
    });

    model.compile(
      createForecastConfig({
        maxContext: 256,
        maxHorizon: 64,
        normalizeInputs: true,
        useContinuousQuantileHead: true,
        forceFlipInvariance: true,
        inferIsPositive: false,
        fixQuantileCrossing: true,
      }),
    );
  }, 120000);

  afterAll(async () => {
    if (model) {
      try {
        await model.dispose();
      } catch {
        // Ignore
      }
    }
  });

  // -----------------------------------------------------------------------
  // Raw forward pass
  // -----------------------------------------------------------------------

  it('forward() returns valid output tensors', async () => {
    // Build a minimal input: 1 patch of 32 values + 32 zeros = 64 dims
    const input = new Float32Array(64);
    for (let i = 0; i < 32; i++) {
      input[i] = Math.random();
      input[32 + i] = 0; // padding flag
    }

    const masks = new Uint8Array(1);
    masks[0] = 0; // visible

    const result = await engine.forward([input], [masks]);

    expect(result).toBeDefined();
    expect(result.inputEmbeddings).toBeDefined();
    expect(result.outputEmbeddings).toBeDefined();
    expect(result.outputTimeSeries).toBeDefined();
    expect(result.outputQuantileSpread).toBeDefined();

    // All tensors should contain finite values
    expect(result.inputEmbeddings.length).toBeGreaterThan(0);
    expect(allFinite(result.inputEmbeddings[0])).toBe(true);

    expect(result.outputEmbeddings.length).toBeGreaterThan(0);
    expect(allFinite(result.outputEmbeddings[0])).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Full pipeline: preprocess → decode → postprocess
  // -----------------------------------------------------------------------

  it('full pipeline produces valid forecast', async () => {
    const series = buildTestSeries(200);
    const horizon = 24;

    // Preprocess
    const fc = createForecastConfig({
      maxContext: 256,
      maxHorizon: 64,
      normalizeInputs: true,
      forceFlipInvariance: true,
    });
    const mc = TIMESFM_25_CONFIG;
    const prepResult = preprocess([series], fc, mc);
    expect(prepResult.patchedInputs.length).toBe(1);

    // Forward + decode
    const rawOutput = await engine.forward(prepResult.patchedInputs, prepResult.patchMasks);
    const decodeLoop = await import('@agentix-e/timesfm-core/src/inference/decode-loop');
    const decodeResult = await decodeLoop.decode(
      engine,
      rawOutput,
      prepResult,
      fc,
      mc,
      {} as AbortSignal,
    );

    // Postprocess
    const postResult = postProcess(
      decodeResult.outputTimeSeries,
      decodeResult.outputQuantileSpread,
      fc,
      mc,
      prepResult.contextMu,
      prepResult.contextSigma,
      decodeResult.flipOutputTimeSeries,
      decodeResult.flipOutputQuantileSpread,
    );

    // Verify point forecast
    expect(postResult.pointForecast.length).toBe(1);
    const pointForecast = postResult.pointForecast[0];
    expect(pointForecast.length).toBe(horizon);
    expect(allFinite(pointForecast)).toBe(true);

    // Values should be reasonable (not zero, not NaN, not absurd)
    const mean = pointForecast.reduce((a, b) => a + b, 0) / pointForecast.length;
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan(10000);
  });

  // -----------------------------------------------------------------------
  // TimesFMModel.forecast() — high-level API
  // -----------------------------------------------------------------------

  it('model.forecast() returns point and quantile forecasts', async () => {
    const series = buildTestSeries(200);

    const result = await model.forecast(24, [series]);

    expect(result.pointForecast).toBeDefined();
    expect(result.quantileForecast).toBeDefined();
    expect(result.pointForecast.length).toBe(1);

    const pf = result.pointForecast[0];
    expect(pf.length).toBe(24);
    expect(allFinite(pf)).toBe(true);

    // Quantile forecast should have 10 bands
    const qf = result.quantileForecast[0];
    expect(qf.length).toBe(10); // mean + 9 quantiles
    for (let q = 0; q < 10; q++) {
      expect(qf[q].length).toBe(24);
      expect(allFinite(qf[q])).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // Multiple series forecasting
  // -----------------------------------------------------------------------

  it('handles multiple series in one forecast call', async () => {
    const series1 = buildTestSeries(180);
    const series2 = buildTestSeries(150);
    const series3 = buildTestSeries(220);

    const result = await model.forecast(12, [series1, series2, series3]);

    expect(result.pointForecast.length).toBe(3);
    for (let s = 0; s < 3; s++) {
      expect(result.pointForecast[s].length).toBe(12);
      expect(allFinite(result.pointForecast[s])).toBe(true);
      expect(result.quantileForecast[s].length).toBe(10);
    }
  });

  // -----------------------------------------------------------------------
  // AbortSignal support
  // -----------------------------------------------------------------------

  it('supports AbortSignal for cancellation', async () => {
    const series = buildTestSeries(100);
    const controller = new AbortController();

    // Don't actually abort — just verify it accepts the signal
    const result = await model.forecast(4, [series], { signal: controller.signal });

    expect(result.pointForecast.length).toBe(1);
    expect(result.pointForecast[0].length).toBe(4);
  });

  // -----------------------------------------------------------------------
  // isLoaded()
  // -----------------------------------------------------------------------

  it('isLoaded() returns true after successful load', () => {
    expect(engine.isLoaded()).toBe(true);
  });
});
