# @agentix-e/timesfm-xreg

Exogenous covariates (XReg) extension for TimesFM — Ridge regression + OneHotEncoder.

```bash
npm install @agentix-e/timesfm-xreg
```

## Quick Start

```typescript
import { TimesFMModel, createForecastConfig } from '@agentix-e/timesfm-core';
import { forecastWithCovariates } from '@agentix-e/timesfm-xreg';

const model = await TimesFMModel.fromPretrained({ modelPath: './timesfm-2.5.onnx' });
model.compile(createForecastConfig({ maxContext: 512, maxHorizon: 128 }));

const result = await forecastWithCovariates(model, {
  inputs: [salesData],
  dynamicNumericalCovariates: { temperature: [tempData] },
  dynamicCategoricalCovariates: { dayOfWeek: [[...]] },
  xregMode: 'xreg + timesfm',
  ridge: 0.1,
});
```

## Modes

| Mode             | Description                                      |
| ---------------- | ------------------------------------------------ |
| `xreg + timesfm` | Fit covariates → forecast residuals → combine    |
| `timesfm + xreg` | Forecast → fit covariates on residuals → combine |

## License

Apache 2.0
