#!/usr/bin/env node
/**
 * TimesFM Web Benchmark Suite — onnxruntime-web (WASM) benchmark.
 *
 * Measures real-world inference performance using onnxruntime-web's
 * WASM backend in Node.js, simulating the browser experience.
 *
 * Usage:
 *   node scripts/web-benchmark-ci.js                         # console output
 *   node scripts/web-benchmark-ci.js --json report.json       # JSON report
 *   node scripts/web-benchmark-ci.js --md report.md           # Markdown report
 *   node scripts/web-benchmark-ci.js --html report.html       # HTML report
 *   node scripts/web-benchmark-ci.js --all                    # All formats
 *
 * Environment:
 *   TIMESFM_MODEL_PATH        — path to ONNX model (required)
 *   WEB_BENCH_ITERATIONS      — warm inference iterations (default 5)
 *   WEB_BENCH_CONTEXTS        — comma-separated context sizes (default "128,256,512")
 */

const { performance } = require('perf_hooks');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

function hasArg(flag) {
  return args.includes(flag);
}

const outJson = getArgValue('--json') || (hasArg('--json') ? 'web-benchmark-report.json' : null);
const outMd = getArgValue('--md') || (hasArg('--md') ? 'web-benchmark-report.md' : null);
const outHtml = getArgValue('--html') || (hasArg('--html') ? 'web-benchmark-report.html' : null);
const outAll = hasArg('--all');
const iterations = parseInt(process.env.WEB_BENCH_ITERATIONS || '5', 10);
const contextSizes = (process.env.WEB_BENCH_CONTEXTS || '128,256,512')
  .split(',')
  .map(Number)
  .filter((n) => n > 0);

// ─── Resolution ─────────────────────────────────────────────────────────────

function resolveModelPath() {
  if (process.env.TIMESFM_MODEL_PATH && fs.existsSync(process.env.TIMESFM_MODEL_PATH)) {
    return process.env.TIMESFM_MODEL_PATH;
  }
  const searchPaths = [
    path.join(__dirname, '..', 'models', 'timesfm-2.5.onnx'),
    path.join(__dirname, '..', '..', 'models', 'timesfm-2.5.onnx'),
    path.join(os.homedir(), '.cache', 'agentix-timesfm-ts', 'timesfm-2.5.onnx'),
  ];
  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveWasmPath() {
  // Search pnpm store for onnxruntime-web WASM files
  const rootDir = path.resolve(__dirname, '..');
  try {
    const found = spawnSync(
      'find',
      [
        rootDir,
        '-path',
        '*/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
        '-type',
        'f',
        '2>/dev/null',
      ],
      { encoding: 'utf-8', shell: true },
    )
      .stdout.trim()
      .split('\n')[0];
    if (found) {
      return path.dirname(found) + '/';
    }
  } catch {
    // fall through
  }
  return null;
}

// ─── System Info ─────────────────────────────────────────────────────────────

function getSystemInfo() {
  const cpus = os.cpus();
  const gitSha = (() => {
    try {
      return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname + '/..', encoding: 'utf-8' })
        .stdout.trim()
        .slice(0, 8);
    } catch {
      return 'unknown';
    }
  })();

  return {
    timestamp: new Date().toISOString(),
    git_sha: gitSha,
    platform: os.platform(),
    arch: os.arch(),
    cpu_model: cpus[0]?.model || 'unknown',
    cpu_cores: cpus.length,
    total_ram_gb: +(os.totalmem() / 1024 ** 3).toFixed(1),
    node_version: process.version,
    runtime: 'onnxruntime-web (WASM)',
  };
}

// ─── HTML Report ─────────────────────────────────────────────────────────────

function generateHtmlReport(report) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const jsonEmbed = JSON.stringify(report);

  const latencyRows = report.latency
    .map(
      (l) => `
    <tr>
      <td>${l.context}</td>
      <td>${l.patches}</td>
      <td><strong>${l.avg_ms}</strong></td>
      <td>${l.p50_ms}</td>
      <td>${l.p99_ms}</td>
      <td>${l.throughput_seq_s}</td>
    </tr>`,
    )
    .join('');

  const regSection = report.regression
    ? `
    <h2>📈 Node vs WASM Comparison</h2>
    <p class="meta">${esc(report.regression.summary)}</p>
    <table>
      <thead><tr><th>Context</th><th>WASM (ms)</th><th>Node Native (ms)</th><th>Ratio</th></tr></thead>
      <tbody>${report.regression.comparisons
        .map(
          (c) => `
        <tr>
          <td>${c.context}</td>
          <td>${c.wasm_ms}</td>
          <td>${c.node_ms}</td>
          <td>${c.ratio}×</td>
        </tr>`,
        )
        .join('')}</tbody>
    </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TimesFM Web (WASM) Benchmark Report</title>
  <style>
    :root {
      --bg: #ffffff; --fg: #1a1a2e; --muted: #6b7280;
      --border: #e5e7eb; --th-bg: #f3f4f6; --hover: #f8fafc;
      --accent: #2563eb; --accent2: #1e40af; --pass: #16a34a;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a; --fg: #e2e8f0; --muted: #94a3b8;
        --border: #334155; --th-bg: #1e293b; --hover: #1e293b;
        --accent: #60a5fa; --accent2: #93c5fd; --pass: #4ade80;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      max-width: 960px;
      margin: 2rem auto;
      padding: 0 1rem;
      line-height: 1.6;
      color: var(--fg);
      background: var(--bg);
    }
    h1 { border-bottom: 3px solid var(--accent); padding-bottom: 0.5rem; }
    h2 { margin-top: 2.5rem; color: var(--accent2); }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9rem; }
    th, td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
    th { background: var(--th-bg); font-weight: 600; }
    tr:hover { background: var(--hover); }
    .pass { color: var(--pass); font-weight: 600; }
    .meta { color: var(--muted); font-size: 0.9rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; text-align: center; }
    @media (max-width: 600px) {
      body { margin: 1rem auto; }
      th, td { padding: 6px 8px; }
    }
  </style>
</head>
<body>
  <h1>🌐 TimesFM Web (WASM) Benchmark Report</h1>
  <p class="meta">Generated: ${esc(report.timestamp)} · Git: <code>${esc(report.git_sha)}</code> · ${esc(report.cpu_model)} × ${report.cpu_cores} · Runtime: ${esc(report.runtime)}</p>

  <h2>💻 System</h2>
  <table>
    <thead><tr><th>Property</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>CPU</td><td>${esc(report.cpu_model)} × ${report.cpu_cores}</td></tr>
      <tr><td>RAM</td><td>${report.total_ram_gb} GB</td></tr>
      <tr><td>Platform</td><td>${esc(report.platform)} / ${esc(report.arch)}</td></tr>
      <tr><td>Node.js</td><td>${esc(report.node_version)}</td></tr>
      <tr><td>Runtime</td><td>${esc(report.runtime)}</td></tr>
    </tbody>
  </table>

  <h2>🧠 Model</h2>
  <table>
    <thead><tr><th>Property</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>Size</td><td>${report.model.size_mb} MB</td></tr>
      <tr><td>Load time</td><td>${report.model.load_time_sec}s</td></tr>
      <tr><td>Cold/Warm Ratio</td><td>${report.cold_warm_ratio != null ? report.cold_warm_ratio.toFixed(2) + '×' : '—'}</td></tr>
    </tbody>
  </table>

  <h2>⚡ Inference Latency (WASM)</h2>
  <table>
    <thead><tr><th>Context</th><th>Patches</th><th>Avg (ms)</th><th>P50 (ms)</th><th>P99 (ms)</th><th>Throughput (seq/s)</th></tr></thead>
    <tbody>${latencyRows}</tbody>
  </table>

  ${regSection}

  <h2>💾 Memory</h2>
  <table>
    <thead><tr><th>Metric</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>RSS</td><td>${report.memory.rss_mb} MB</td></tr>
      <tr><td>Heap Used</td><td>${report.memory.heap_used_mb} MB</td></tr>
    </tbody>
  </table>

  <p>
    <a href="web-benchmark-report.json">📄 Raw JSON data</a> ·
    <a href="web-benchmark-report.md">📝 Markdown version</a>
  </p>

  <footer>Automated Web benchmark by <strong>agentix-timesfm-ts</strong> CI · ${esc(report.timestamp)}</footer>

  <script type="application/json" id="benchmark-data">
${jsonEmbed}
  </script>
</body>
</html>`;
}

// ─── Markdown Report ─────────────────────────────────────────────────────────

function generateMarkdownReport(report) {
  const latencyTable = report.latency
    .map(
      (l) =>
        `| ${l.context} | ${l.patches} | ${l.avg_ms} | ${l.p50_ms} | ${l.p99_ms} | ${l.throughput_seq_s} |`,
    )
    .join('\n');

  const regSection = report.regression
    ? `\n## Node vs WASM Comparison\n\n> ${report.regression.summary}\n\n| Context | WASM (ms) | Node Native (ms) | Ratio |\n|---------|-----------|-----------------|-------|\n` +
      report.regression.comparisons
        .map((c) => `| ${c.context} | ${c.wasm_ms} | ${c.node_ms} | ${c.ratio}× |`)
        .join('\n')
    : '';

  return `# TimesFM Web (WASM) Benchmark Report

> Generated: ${report.timestamp} · Git: \`${report.git_sha}\` · Runtime: ${report.runtime}

## System

| Property | Value |
|----------|-------|
| CPU | ${report.cpu_model} × ${report.cpu_cores} |
| RAM | ${report.total_ram_gb} GB |
| Node.js | ${report.node_version} |

## Model

| Property | Value |
|----------|-------|
| Size | ${report.model.size_mb} MB |
| Load time | ${report.model.load_time_sec}s |
| Cold/Warm Ratio | ${report.cold_warm_ratio != null ? report.cold_warm_ratio.toFixed(2) + '×' : 'N/A'} |

## Inference Latency (WASM)

| Context | Patches | Avg (ms) | P50 (ms) | P99 (ms) | Throughput (seq/s) |
|---------|---------|----------|----------|----------|---------------------|
${latencyTable}

## Memory

| Metric | Value |
|--------|-------|
| RSS | ${report.memory.rss_mb} MB |
| Heap Used | ${report.memory.heap_used_mb} MB |
${regSection}
---
*Automated Web benchmark by agentix-timesfm-ts CI*
`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const sysInfo = getSystemInfo();
  const report = {
    ...sysInfo,
    model: {},
    latency: [],
    memory: {},
    cold_warm_ratio: null,
    regression: null,
  };

  // ── Model path ─────────────────────────────────────────────────────────────
  const modelPath = resolveModelPath();
  if (!modelPath) {
    console.error('No ONNX model found. Set TIMESFM_MODEL_PATH.');
    process.exit(1);
  }
  const modelStats = fs.statSync(modelPath);
  report.model = {
    path: modelPath,
    size_mb: +(modelStats.size / 1024 ** 2).toFixed(0),
  };

  // ── WASM path ──────────────────────────────────────────────────────────────
  const wasmPath = resolveWasmPath();
  if (!wasmPath) {
    console.error('Cannot find onnxruntime-web WASM files. Install onnxruntime-web first.');
    process.exit(1);
  }

  console.log('TIMESFM WEB (WASM) BENCHMARK SUITE');
  console.log('='.repeat(70));
  console.log(`  Model:   ${modelPath} (${report.model.size_mb} MB)`);
  console.log(`  WASM:    ${wasmPath}`);
  console.log(`  CPU:     ${sysInfo.cpu_model} x ${sysInfo.cpu_cores}`);
  console.log(`  Node:    ${sysInfo.node_version}`);
  console.log('='.repeat(70));

  // ── Load onnxruntime-web with WASM backend ─────────────────────────────────
  const ort = require('onnxruntime-web');
  ort.env.wasm.wasmPaths = wasmPath;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;

  console.log(`\n  ort.env.wasm.wasmPaths = ${wasmPath}`);

  const loadStart = performance.now();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  report.model.load_time_sec = +((performance.now() - loadStart) / 1000).toFixed(2);
  console.log(`  Load time: ${report.model.load_time_sec}s`);

  // ── Latency Benchmark ──────────────────────────────────────────────────────
  const MODEL_PATCHES = 16;
  const inputPatchLen = 32;
  const dim = 64;

  console.log('\n  ── Latency (WASM) ──');

  const contextConfigs = [
    { patches: 4, context: 128 },
    { patches: 8, context: 256 },
    { patches: 16, context: 512 },
  ].filter((c) => contextSizes.includes(c.context));

  let firstColdMs = null;

  for (const cfg of contextConfigs) {
    // Build input: [1, 16, 64]
    const input = new Float32Array(MODEL_PATCHES * dim);
    for (let p = 0; p < cfg.patches; p++) {
      const bp = p * dim;
      for (let i = 0; i < inputPatchLen; i++) {
        input[bp + i] = Math.random();
        input[bp + inputPatchLen + i] = 0;
      }
    }
    for (let p = cfg.patches; p < MODEL_PATCHES; p++) {
      const bp = p * dim;
      for (let i = 0; i < inputPatchLen; i++) {
        input[bp + inputPatchLen + i] = 1;
      }
    }

    const feeds = { inputs: new ort.Tensor('float32', input, [1, MODEL_PATCHES, dim]) };

    // Cold start
    const coldStart = performance.now();
    await session.run(feeds);
    const coldMs = +(performance.now() - coldStart).toFixed(1);
    if (firstColdMs === null) firstColdMs = coldMs;

    // Warmup
    for (let i = 0; i < 2; i++) await session.run(feeds);

    // Measure
    const times = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await session.run(feeds);
      times.push(performance.now() - start);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p50 = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
    const p99 = [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.99)];

    report.latency.push({
      context: cfg.context,
      patches: cfg.patches,
      avg_ms: +avg.toFixed(1),
      p50_ms: +p50.toFixed(1),
      p99_ms: +p99.toFixed(1),
      throughput_seq_s: +(1000 / avg).toFixed(1),
    });

    console.log(
      `  ctx=${String(cfg.context).padStart(3)}  avg=${avg.toFixed(0).padStart(5)}ms  p50=${p50.toFixed(0).padStart(5)}ms  p99=${p99.toFixed(0).padStart(5)}ms  thr=${(1000 / avg).toFixed(1)} seq/s`,
    );
  }

  // Cold/warm ratio
  const warmAvgs = report.latency.map((l) => l.avg_ms);
  if (firstColdMs !== null && warmAvgs.length > 0) {
    const avgWarm = warmAvgs.reduce((a, b) => a + b, 0) / warmAvgs.length;
    report.cold_warm_ratio = +(firstColdMs / avgWarm).toFixed(2);
    console.log(
      `\n  Cold/Warm: ${report.cold_warm_ratio}× (cold=${firstColdMs.toFixed(0)}ms, avg warm=${avgWarm.toFixed(0)}ms)`,
    );
  }

  // ── Memory ─────────────────────────────────────────────────────────────────
  const mem = process.memoryUsage();
  report.memory = {
    rss_mb: +(mem.rss / 1024 / 1024).toFixed(0),
    heap_used_mb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
  };
  console.log(`\n  RSS: ${report.memory.rss_mb} MB  Heap: ${report.memory.heap_used_mb} MB`);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  try {
    session.release();
  } catch {
    // ignored
  }

  // ── Output ─────────────────────────────────────────────────────────────────
  const doJson = outJson || outAll;
  const doMd = outMd || outAll;
  const doHtml = outHtml || outAll;
  const jsonPath = typeof outJson === 'string' ? outJson : 'web-benchmark-report.json';
  const mdPath = typeof outMd === 'string' ? outMd : 'web-benchmark-report.md';
  const htmlPath = typeof outHtml === 'string' ? outHtml : 'web-benchmark-report.html';

  if (doJson && jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    console.log(`\n  ✅ JSON: ${jsonPath}`);
  }
  if (doMd && mdPath) {
    fs.writeFileSync(mdPath, generateMarkdownReport(report));
    console.log(`  ✅ Markdown: ${mdPath}`);
  }
  if (doHtml && htmlPath) {
    fs.writeFileSync(htmlPath, generateHtmlReport(report));
    console.log(`  ✅ HTML: ${htmlPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
