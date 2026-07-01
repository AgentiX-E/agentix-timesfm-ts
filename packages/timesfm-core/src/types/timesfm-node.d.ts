/**
 * Type declaration for the optional @agentix-e/timesfm-node peer dependency.
 *
 * This module is dynamically imported by TimesFMModel.fromPretrained()
 * only when no custom engine is provided.  When timesfm-node is not installed,
 * a descriptive error message guides the user to install it.
 *
 * This declaration eliminates the compile-time dependency while keeping
 * full type safety — consumers who don't need the Node.js engine
 * never install onnxruntime-node.
 */
declare module '@agentix-e/timesfm-node' {
  import type {
    IInferenceEngine,
    ModelConfig,
    ModelLoadOptions,
    RawModelOutput,
  } from '@agentix-e/timesfm-core';

  /**
   * Create the default Node.js ONNX Runtime inference engine.
   *
   * Called internally by TimesFMModel.fromPretrained() when no custom
   * engine is provided.  Requires onnxruntime-node to be installed.
   */
  export function createDefaultEngine(
    config: ModelConfig,
    options: Pick<ModelLoadOptions, 'executionProvider' | 'intraOpNumThreads'>,
  ): IInferenceEngine;

  /** Node.js ONNX Runtime inference engine implementing IInferenceEngine. */
  export class TimesFMNodeEngine implements IInferenceEngine {
    constructor(
      config: ModelConfig,
      options?: Pick<ModelLoadOptions, 'executionProvider' | 'intraOpNumThreads'>,
    );
    load(modelPath: string, options?: { skipWarmup?: boolean }): Promise<void>;
    forward(inputs: Float32Array[], masks: Uint8Array[]): Promise<RawModelOutput>;
    dispose(): Promise<void>;
    isLoaded(): boolean;
  }
}
