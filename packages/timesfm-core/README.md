# @agentix-e/timesfm-core

Core inference engine for **TimesFM 2.5** (200M parameters) — zero-shot time-series forecasting in Node.js.

```bash
npm install @agentix-e/timesfm-core
```

## Quick Start

```typescript
import { TimesFMModel, createForecastConfig } from '@agentix-e/timesfm-core';

const model = await TimesFMModel.fromPretrained({
  modelPath: './timesfm-2.5.onnx',
});
model.compile(createForecastConfig({ maxContext: 1024, maxHorizon: 256 }));

const { pointForecast, quantileForecast } = await model.forecast(24, [
  new Float32Array([1, 2, 3 /* ... */]),
]);
```

## Features

- Zero-shot forecasting — no training needed
- Point forecasts + 10 quantile bands (q10–q90)
- Variable-length inputs with automatic NaN handling
- Built on ONNX Runtime (CPU / CUDA / DirectML)
- AbortSignal cancellation + progress callbacks
- Built-in evaluation metrics (MAE, RMSE, MAPE, SMAPE, MASE, R²)

## License

Apache 2.0
