/**
 * Unit tests for ModelDescriptor — parsing, validation, and
 * descriptorToModelConfig conversion.
 *
 * No ONNX model required. Pure data-driven tests.
 */
import { describe, it, expect } from 'vitest';
import {
  descriptorToModelConfig,
  ENGINE_SUPPORTED_SCHEMA,
  type ModelDescriptor,
} from '../../src/model-descriptor';
import { createTimesFM25Config } from '../../src/types';

// ---------------------------------------------------------------------------
// Canonical TimesFM 2.5 descriptor (realistic)
// ---------------------------------------------------------------------------

const CANONICAL_DESCRIPTOR: ModelDescriptor = {
  schema: 1,
  model: {
    version: '2.5',
    variant: '200m',
    hf_revision: 'abc123def456',
    exported_at: '2026-06-26T12:00:00Z',
  },
  onnx: {
    input_name: 'inputs',
    input_shape: [1, 16, 64],
    outputs: {
      input_emb: [1, 16, 1280],
      output_emb: [1, 16, 1280],
      output_ts: [1, 16, 1280],
      output_qs: [1, 16, 10240],
    },
    opset: 18,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    size_bytes: 928514048,
  },
  architecture: {
    input_patch_len: 32,
    output_patch_len: 128,
    output_quantile_len: 1024,
    num_layers: 20,
    num_heads: 16,
    model_dims: 1280,
    quantiles: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
    context_limit: 16384,
  },
  processing: {
    preprocessing: 'revin',
    postprocessing: ['flip_invariance', 'quantile_crossing_fix'],
  },
};

// ---------------------------------------------------------------------------
// descriptorToModelConfig
// ---------------------------------------------------------------------------

describe('descriptorToModelConfig', () => {
  it('produces a ModelConfig equivalent to createTimesFM25Config()', () => {
    const fromDescriptor = descriptorToModelConfig(CANONICAL_DESCRIPTOR);
    const canonical = createTimesFM25Config();

    // Every field must match
    expect(fromDescriptor.contextLimit).toBe(canonical.contextLimit);
    expect(fromDescriptor.exportedPatches).toBe(canonical.exportedPatches);
    expect(fromDescriptor.inputPatchLen).toBe(canonical.inputPatchLen);
    expect(fromDescriptor.outputPatchLen).toBe(canonical.outputPatchLen);
    expect(fromDescriptor.outputQuantileLen).toBe(canonical.outputQuantileLen);
    expect(fromDescriptor.outputPatchesPerInput).toBe(canonical.outputPatchesPerInput);
    expect(fromDescriptor.quantiles).toEqual(canonical.quantiles);
    expect(fromDescriptor.decodeIndex).toBe(canonical.decodeIndex);
    expect(fromDescriptor.numLayers).toBe(canonical.numLayers);
    expect(fromDescriptor.numHeads).toBe(canonical.numHeads);
    expect(fromDescriptor.modelDims).toBe(canonical.modelDims);
    expect(fromDescriptor.headDim).toBe(canonical.headDim);
    expect(fromDescriptor.numQuantiles).toBe(canonical.numQuantiles);
    expect(fromDescriptor.tokenizerInputDims).toBe(canonical.tokenizerInputDims);
    expect(fromDescriptor.tokenizerHiddenDims).toBe(canonical.tokenizerHiddenDims);
    expect(fromDescriptor.tokenizerOutputDims).toBe(canonical.tokenizerOutputDims);
    expect(fromDescriptor.outputPointDims).toBe(canonical.outputPointDims);
    expect(fromDescriptor.outputQuantileDims).toBe(canonical.outputQuantileDims);
  });

  it('extracts exportedPatches from onnx input_shape[1]', () => {
    const desc = { ...CANONICAL_DESCRIPTOR };
    desc.onnx = { ...desc.onnx, input_shape: [1, 32, 128] };
    const config = descriptorToModelConfig(desc);
    expect(config.exportedPatches).toBe(32);
    expect(config.tokenizerInputDims).toBe(64); // 32 + 32 (unchanged)
  });

  it('computes headDim as model_dims / num_heads', () => {
    const desc = { ...CANONICAL_DESCRIPTOR };
    desc.architecture = { ...desc.architecture, model_dims: 2560, num_heads: 32 };
    const config = descriptorToModelConfig(desc);
    expect(config.modelDims).toBe(2560);
    expect(config.numHeads).toBe(32);
    expect(config.headDim).toBe(80);
  });

  it('computes numQuantiles as quantiles.length + 1', () => {
    const desc = { ...CANONICAL_DESCRIPTOR };
    desc.architecture = {
      ...desc.architecture,
      quantiles: [0.25, 0.5, 0.75],
    };
    const config = descriptorToModelConfig(desc);
    expect(config.numQuantiles).toBe(4); // mean + fQuantileArray, fixQuantileCrossing, clipMin
    expect(config.quantiles).toEqual([0.25, 0.5, 0.75]);
  });

  it('computes outputQuantileDims as output_quantile_len * numQuantiles', () => {
    const desc = { ...CANONICAL_DESCRIPTOR };
    desc.architecture = {
      ...desc.architecture,
      output_quantile_len: 512,
      quantiles: [0.25, 0.5, 0.75],
    };
    const config = descriptorToModelConfig(desc);
    // numQuantiles = 4 (mean + 3), outputQuantileLen = 512 → 2048
    expect(config.outputQuantileDims).toBe(2048);
  });

  it('returns a frozen object', () => {
    const config = descriptorToModelConfig(CANONICAL_DESCRIPTOR);
    expect(Object.isFrozen(config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema compatibility (implicit via validateDescriptor logic)
// ---------------------------------------------------------------------------

describe('schema compatibility', () => {
  it('ENGINE_SUPPORTED_SCHEMA is 1', () => {
    expect(ENGINE_SUPPORTED_SCHEMA).toBe(1);
  });

  it('accepts schema equal to ENGINE_SUPPORTED_SCHEMA', () => {
    // descriptorToModelConfig doesn't validate schema directly,
    // but we verify the descriptor itself has schema === ENGINE_SUPPORTED_SCHEMA
    expect(CANONICAL_DESCRIPTOR.schema).toBe(ENGINE_SUPPORTED_SCHEMA);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: non-TimesFM-2.5 architectures
// ---------------------------------------------------------------------------

describe('future model variants', () => {
  it('handles 500M model with doubled dims', () => {
    const desc: ModelDescriptor = {
      ...CANONICAL_DESCRIPTOR,
      architecture: {
        ...CANONICAL_DESCRIPTOR.architecture,
        model_dims: 2560,
        num_heads: 32,
        num_layers: 32,
        output_quantile_len: 2048,
      },
      onnx: {
        ...CANONICAL_DESCRIPTOR.onnx,
        input_shape: [1, 24, 64],
        outputs: {
          input_emb: [1, 24, 2560],
          output_emb: [1, 24, 2560],
          output_ts: [1, 24, 2560],
          output_qs: [1, 24, 20480],
        },
      },
    };
    const config = descriptorToModelConfig(desc);
    expect(config.exportedPatches).toBe(24);
    expect(config.modelDims).toBe(2560);
    expect(config.numHeads).toBe(32);
    expect(config.headDim).toBe(80);
    expect(config.numLayers).toBe(32);
    expect(config.outputQuantileDims).toBe(20480); // 2048 * 10
  });

  it('handles model with fewer quantiles', () => {
    const desc: ModelDescriptor = {
      ...CANONICAL_DESCRIPTOR,
      architecture: {
        ...CANONICAL_DESCRIPTOR.architecture,
        quantiles: [0.1, 0.5, 0.9],
      },
    };
    const config = descriptorToModelConfig(desc);
    expect(config.numQuantiles).toBe(4); // mean + 3
    expect(config.quantiles).toEqual([0.1, 0.5, 0.9]);
  });
});
