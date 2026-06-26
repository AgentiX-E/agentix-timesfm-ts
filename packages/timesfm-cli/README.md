# @agentix-e/timesfm-cli

Command-line interface for TimesFM — zero-shot time-series forecasting from CSV files.

```bash
npm install -g @agentix-e/timesfm-cli
```

## Usage

```bash
# Download the model (~885 MB, first time only)
timesfm setup

# Forecast from CSV
timesfm forecast --horizon 24 input.csv

# Custom options
timesfm forecast -m ./custom.onnx -H 52 -o forecasts.json --output-format json data.csv
```

## CSV Input

```csv
date,value
2024-01-01,100
2024-01-02,102
2024-01-03,105
```

## License

Apache 2.0
