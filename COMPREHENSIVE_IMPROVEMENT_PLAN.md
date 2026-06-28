# 🚀 agentix-timesfm-ts 全方位改进计划

> **评估日期**: 2026-06-28
> **评估基准**: [google-research/timesfm](https://github.com/google-research/timesfm) v2.5 200M
> **审查范围**: 109+ 源文件 · 349 单元测试 · 4 个 CI Workflow · 4 个 Packages
> **标准**: 极致完美工程零妥协

---

## 📊 执行摘要

| #   | 维度                        | 当前评分   | 状态                   | 关键发现                                                     |
| --- | --------------------------- | ---------- | ---------------------- | ------------------------------------------------------------ |
| 1   | 架构设计与代码实现          | ⭐⭐⭐⭐   | ⚠️ 3个可优化点         | 逆向归一化公式不一致、并发安全性未验证、硬编码排除导致CI破裂 |
| 2   | 性能优化与Benchmark CI      | ⭐⭐⭐⭐   | 🔴 CI部署失败          | **deploy-pages job shell转义错误导致CI失败**                 |
| 3   | API设计与文档发布           | ⭐⭐⭐⭐⭐ | ✅ 4个包README均有链接 | TypeDoc + GitHub Pages完整覆盖                               |
| 4   | 测试覆盖率                  | ⭐⭐⭐⭐   | ⚠️ 指标未达标          | 覆盖率需要真实模型(@timesfm-web排除、localcov依赖模型)       |
| 5   | 优于google-research/timesfm | ⭐⭐⭐⭐   | ✅ 8项优势已验证       | 缺多变量+微调API(已标注Roadmap)                              |
| 6   | Proxy支持                   | ⭐⭐⭐⭐⭐ | ✅ 三层级联+环境变量   | 密码安全(仅env var)                                          |
| 7   | 文档同步质量                | ⭐⭐⭐⭐   | ✅ 文档真实准确        | 少量边缘案例需补充                                           |
| 8   | 本地/CI一致性               | ⭐⭐⭐     | 🔴 原生不一致          | CI独有coverage; pnpm ci:local≠CI unit-test                   |
| 9   | Standalone Web Benchmark    | ✅ N/A     | 已排除                 | 不适用此需求                                                 |
| 10  | 所有GitHub Actions          | ⭐⭐       | 🔴 master分支CI失败    | **deploy-pages shell转义错误**                               |

**综合结论**: 代码质量优秀(架构清晰、类型安全、测试完善)，但存在1个紧急阻塞项(CI deploy-pages失败)和5个关键改进点需要修复才能达到"极致完美"标准。

---

## 🔴 P0 — 紧急修复(阻塞CI)

### P0-1: CI `deploy-pages` Prepare pages步骤Shell转义错误(CI失败)

**严重程度**: 🔴 Critical — **当前master分支CI全部失败**

**位置**: `.github/workflows/ci.yml` L322-L387, `Prepare pages`步骤

**问题**: 内联`node -e '...'`脚本中使用JavaScript模板字符串(反引号`` ` ``)，bash将反引号解释为命令替换:

```yaml
# ci.yml L327 — shell 将反引号解释为命令执行
run: |
  node -e '
  const fs = require("fs");
  // ...
  coverageHtml = `<!DOCTYPE html>     ← bash将其作为命令替换执行
  <html lang="en">
  ...
  ${pct("lines")}%                      ← bash将${}作为变量展开
  ...`
  '
```

**CI错误日志**:

```
/home/runner/work/_temp/xxx.sh: line 1: a: No such file or directory
Error: Process completed with exit code 1.
```

bash尝试将HTML内容作为命令执行(`<a href=...>`被解释为输入重定向),导致"a: No such file or directory"。

**修复方案**: 将HTML生成逻辑提取为独立Node.js脚本文件,避免shell转义问题:

```yaml
# ci.yml — 替换内联node -e为独立脚本
- name: Prepare pages
  run: node scripts/prepare-pages.js
```

创建`scripts/prepare-pages.js`:

```javascript
const fs = require('fs');
const path = require('path');

// Web benchmark redirect
fs.mkdirSync('docs/web-benchmark', { recursive: true });
fs.writeFileSync(
  'docs/web-benchmark/index.html',
  `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0;url=web-benchmark-report.html"><title>Web Benchmark</title></head><body><p>Redirecting to <a href="web-benchmark-report.html">web benchmark report</a>…</p></body></html>`,
);

// Coverage index
let coverageHtml;
try {
  const summary = require('./docs/coverage/coverage-summary.json').total;
  const pct = (k) => summary[k].pct.toFixed(1);
  const hasLcov = fs.existsSync('docs/coverage/lcov-report/index.html');
  coverageHtml = generateCoverageHtml(pct, hasLcov);
} catch (e) {
  coverageHtml = '<!DOCTYPE html>...<p>Report pending</p>...';
}
fs.writeFileSync('docs/coverage/index.html', coverageHtml);

// Root landing page
fs.writeFileSync('docs/index.html', generateRootHtml());
fs.writeFileSync('docs/web-benchmark/index.html', generateWebBenchmarkRedirect());
```

**验收标准**:

- [ ] `deploy-pages` job在master push时返回success
- [ ] GitHub Pages包含所有4个板块(API/Benchmark/Coverage/Web Benchmark)
- [ ] 覆盖率仪表盘显示正确的百分比数值

---

## 🟡 P1 — 关键改进(达标必需)

### P1-1: `xreg-engine.ts`逆向归一化数值不稳定性

**严重程度**: 🔴 High — 协变量预测精度

**位置**: `packages/timesfm-xreg/src/xreg-engine.ts` L298-300

```typescript
// 当前实现 — 单遍方差公式,大数值下灾难性抵消
const sigma = n > 0 ? Math.sqrt(Math.max(0, sumSq / n - mu * mu)) : 1;
//                                   ^^^^^^^^^^^^^^^^^^^^^
//                                   单遍 E[X²] - E[X]² 公式
```

`stats.ts`中`computeStats`已正确使用两遍算法(Σ(v-μ)²/N),但xreg-engine退化到不稳定的单遍公式。

**修复**: 统一使用`computeStats`:

```typescript
import { computeStats } from '@agentix-e/timesfm-core';

const stats = computeStats(targets[i]);
const mu = stats.mean;
const sigma = stats.std < 1e-6 ? 1 : stats.std;
```

**验收标准**:

- [ ] `normalizeXregTargets`使用两遍方差算法
- [ ] 数值测试: 大均值数据(1e9级别)的sigma计算精度≥1e-6

### P1-2: 本地CI与远程CI coverage报告不一致

**严重程度**: 🔴 High — 违反需求#8(本地/CI一致性)

**当前状态**:

```
本地 pnpm test:unit  → 无覆盖率报告(需模型)  ❌
CI unit-test         → 无覆盖率              ⚠️
CI integration-test  → 有覆盖率(需模型)      ✅
CI deploy-pages      → 发布覆盖率到Pages     ⚠️(当前失败)
```

`vitest.unit.config.ts`不包含任何coverage配置,用户本地运行`pnpm test:unit`无法获取覆盖率数据。

**修复**: 在`vitest.unit.config.ts`中添加coverage配置(与主配置一致的thresholds):

```typescript
// vitest.unit.config.ts — 添加
coverage: {
  provider: 'v8',
  reporter: ['text', 'json', 'html', 'lcov'],
  include: [
    'packages/timesfm-core/src/**/*.ts',
    'packages/timesfm-xreg/src/**/*.ts',
    'packages/timesfm-cli/src/**/*.ts',
  ],
  exclude: [
    'packages/*/src/index.ts',
    'packages/timesfm-cli/src/cli.ts',
    'packages/timesfm-core/src/model-downloader.ts',
    'packages/timesfm-web/src/**',
  ],
  thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 }
}
```

**验收标准**:

- [ ] `pnpm test:unit --coverage`本地生成覆盖率报告
- [ ] 本地`npx vitest run --config vitest.unit.config.ts --coverage`返回相同的覆盖率数值
- [ ] CI中`unit-test` job也生成coverage artifact

### P1-3: 覆盖率报告在README和GitHub Pages中的一致性

**严重程度**: 🟡 Medium — 用户体验混淆

**当前**: CI deploy-pages生成的`docs/coverage/index.html`(dashboard格式)和`docs/coverage/lcov-report/index.html`(lcov详细格式)共存,导航路径混乱。

**修复**: 统一入口 — `docs/coverage/index.html`作为dashboard(显示4个指标百分比),内嵌链接到`lcov-report/index.html`查看详细行级覆盖。

当前已在代码中实现(`hasLcov ? '<a class="btn" href="lcov-report/index.html">' : ''`),但需确保CI publish后实际生效。

**验收标准**:

- [ ] GitHub Pages coverage页面显示dashboard(4个百分比卡片)
- [ ] Dashboard包含"View Detailed Report"链接指向lcov-report
- [ ] 所有4个覆盖率指标≥95%

### P1-4: 补充CLI README中Proxy文档

**严重程度**: 🟡 Medium — 文档完整性

`packages/timesfm-cli/README.md`缺少:

1. `setup`命令的`--proxy-url`/`--proxy-username`选项文档
2. `forecast`命令的model path resolution提到代理自动检测(通过环境变量)

主README已有完整proxy文档(三层级联),但CLI README应同步。

**验收标准**:

- [ ] `timesfm-cli/README.md`包含完整的proxy setup示例
- [ ] 与主README中的Proxy文档一致

### P1-5: CI Benchmark使用Synthetic数据(违反需求#4)

**严重程度**: 🟡 Medium — 需求#4"不使用Synthetic数据"

`benchmark-ci.js` L810-818的accuracy部分使用`Math.random()`风格的合成数据:

```javascript
data[i] =
  base + trend * i + seasonAmp * Math.sin((2 * Math.PI * i) / 12) + (rand() - 0.5) * noiseAmp * 2;
```

应将benchmark的accuracy测试改为使用benchmarks/data/目录中的真实CSV数据文件(benchmark_daily.csv有500行50个series,benchmark_hourly.csv有1000行,benchmark_monthly.csv有200行)。

**修复**: 在benchmark-ci.js中添加readCsvData()函数,从`benchmarks/data/`加载真实数据用于accuracy评估。

**验收标准**:

- [ ] Benchmark accuracy section使用benchmarks/data/中的CSV数据
- [ ] Accuracy Gate验证: `scaled_mae < 1.0`(已有实现)

---

## 🟢 P2 — 优化建议(极致完美)

### P2-1: ONNX Runtime并发安全性验证(需求#1)

**位置**: `onnx-engine.ts` L162-209, `model.ts` L298

当前代码假设ONNX Runtime `InferenceSession.run()`是线程安全的(使用`Promise.all`并发调用)。这是未验证的假设。

**建议**:

1. 查阅onnxruntime-node≥1.22.0的线程安全文档
2. 如果没有明确文档,添加session互斥锁:

```typescript
private _sessionMutex = new Mutex(); // 使用 async-mutex 包

async forward(inputs, masks) {
  return this._sessionMutex.runExclusive(async () => {
    // 原有forward逻辑
  });
}
```

3. 编写并发压力测试: 同时发起10个`model.forecast()`调用,验证无崩溃/数据竞争

**验收标准**:

- [ ] 有明确文档证明ONNX Runtime session.run()线程安全,或添加了互斥锁
- [ ] 并发测试(同时10个forecast)不崩溃且结果正确

### P2-2: 统一ONNX Runtime Warmup策略

**位置**: `onnx-engine.ts` L96-108 (engine warmup) vs `benchmark-ci.js` (benchmark warmup)

`onnx-engine.ts::load()`中有\_warmup()调用,benchmark-ci.js中又做了2次额外的warmup迭代。这意味着benchmark实际测量的是第3次推理而非第1次warm推理。

**建议**: 在benchmark中跳过engine的warmup,仅依赖benchmark自身的warmup迭代(可控且可测量):

```typescript
// onnx-engine.ts — 添加skipWarmup选项
async load(modelPath: string, options?: { skipWarmup?: boolean }) {
  // ...
  if (!options?.skipWarmup) {
    await this._warmup();
  }
}
```

**验收标准**:

- [ ] Benchmark报告中的cold/warm ratio准确反映真实用户首调延迟

### P2-3: Memory Leak长时间稳定性测试

**位置**: 新增 `packages/timesfm-core/test/stability.test.ts`

当前缺少长时间运行的内存稳定性测试。ONNX Runtime的原生内存泄漏可能在数千次推理后显现。

**建议**:

```typescript
describe('Memory Stability (1000 iterations)', () => {
  it('heap stays within 5% after 1000 forecasts', async () => {
    const initial = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1000; i++) {
      await model.forecast(24, inputs);
    }
    if (global.gc) global.gc();
    const final = process.memoryUsage().heapUsed;
    expect(final).toBeLessThan(initial * 1.05);
  }, 300000); // 5分钟超时
});
```

**验收标准**:

- [ ] 1000次推理后heap增长≤5%
- [ ] 测试排除在`pnpm test:unit`之外(仅CI完整运行)

### P2-4: 测试文件自动发现取代硬编码glob

**位置**: `vitest.unit.config.ts`

当前使用正向列举的15个glob模式,新增测试文件需手动更新列表。

**修复**: 使用否定排除:

```typescript
include: ['packages/*/test/**/*.test.ts'],
exclude: [
  '**/model.test.ts',           // 需ONNX模型
  '**/engine.test.ts',          // 需ONNX模型
  '**/web-integration.test.ts', // 需WASM模型
  '**/xreg-engine.test.ts',     // 需ONNX模型
]
```

**验收标准**:

- [ ] 新增测试文件自动被unit-test发现
- [ ] 模型依赖的测试文件正确排除

### P2-5: 添加完整的CHANGELOG.md

**位置**: 根目录 `CHANGELOG.md`

项目使用Changesets但根目录无CHANGELOG.md。应生成并维护。

**实现**: `npx changeset log` 或手动维护基于git tag的changelog。

### P2-6: TypeScript严格模式覆盖率提升

**位置**: 各package的tsconfig.json

当前仅root tsconfig设置严格模式,部分子包可能有遗漏(lib配置不一致)。

**检查**:

- [x] `timesfm-core`: strict ✅
- [ ] `timesfm-cli`: 编译时缺少`console`/`process`类型(tsconfig缺少`types: ["node"]`)
- [ ] `timesfm-web`: 编译时需要`onnxruntime-web`可用且tsconfig包含DOM lib

**验收标准**:

- [ ] 所有4个package严格模式编译通过
- [ ] 零`@ts-ignore`(改用`@ts-expect-error`或正确类型声明)

---

## 📋 改进任务优先级矩阵

| 优先级 | #   | 问题                      | 改动量 | 影响       | 预计工时 |
| ------ | --- | ------------------------- | ------ | ---------- | -------- |
| 🔴 P0  | 1   | CI deploy-pages shell转义 | 中     | CI全部通过 | 2h       |
| 🔴 P0  | 2   | xreg方差数值不稳定        | 小     | 协变量精度 | 1h       |
| 🔴 P0  | 3   | 本地CI coverage不一致     | 中     | 开发者体验 | 2h       |
| 🟡 P1  | 4   | Coverage入口统一          | 小     | 用户体验   | 30m      |
| 🟡 P1  | 5   | CLI README proxy文档      | 小     | 文档完整性 | 30m      |
| 🟡 P1  | 6   | Benchmark synthetic数据   | 中     | 需求合规   | 3h       |
| 🟢 P2  | 7   | ONNX并发安全性            | 大     | 生产稳定性 | 4h       |
| 🟢 P2  | 8   | Warmup策略统一            | 小     | 指标准确性 | 1h       |
| 🟢 P2  | 9   | Memory stability测试      | 中     | 生产可靠性 | 2h       |
| 🟢 P2  | 10  | 自动测试发现              | 小     | 可维护性   | 30m      |
| 🟢 P2  | 11  | CHANGELOG.md              | 小     | 项目规范   | 30m      |
| 🟢 P2  | 12  | strict模式一致性          | 小     | 类型安全   | 1h       |

---

## ✅ 已验证的达标项

### 需求#3: API文档自动发布 ✅

- 4个package的README均有API文档链接
  - `timesfm-core/README.md` → `api/modules/timesfm_core.html`
  - `timesfm-xreg/README.md` → `api/modules/timesfm_xreg.html`
  - `timesfm-cli/README.md` → `api/modules/timesfm_cli.html`
  - `timesfm-web/README.md` → `api/modules/timesfm_web.html`
- CI deploy-pages自动运行`pnpm docs:generate`发布TypeDoc
- Root README包含API Docs badge和链接

### 需求#6: Proxy支持(环境变量+参数) ✅

- 三层级联优先级: `DownloadOptions.proxy` → `TIMESFM_PROXY_*` env vars → `HTTPS_PROXY`/`HTTP_PROXY`
- 支持用户名+密码认证(密码仅通过环境变量,不在CLI参数中)
- `NO_PROXY`排除github.com域名
- undici ProxyAgent优先(避免全局环境变量污染)
- CLI命令完整: `timesfm setup --proxy-url/--proxy-username`
- HTTP 407特殊错误处理(`ProxyAuthError`)

### 需求#7: 文档同步 ✅

- README完整覆盖:架构图、Quick Start(3种方式)、Config Reference、Output Shape、Project Structure
- Architecture文档详细(组件设计+数据流)
- 每个package README有独立的Quick Start和API doc链接
- License兼容性表格清晰

### 需求#5: 优于google-research/timesfm ✅

- 8项已验证优势(多运行时、浏览器支持、TypeScript类型安全、按需下载、proxy支持、Flip Invariance并行、SHA-256校验、完整CI/CD)
- 已知差距已在README中标注(Known Limitations: 单变量、无微调、模型版本有限)

---

## 📊 当前本地验证状态

```
✅ pnpm build          — TypeScript 编译通过(4个包)
✅ pnpm lint           — ESLint 零错误
✅ pnpm format:check   — Prettier 格式检查通过
✅ pnpm test:unit      — 349个单元测试全部通过(15个测试文件,2.57秒)
❌ pnpm test           — 需要885MB ONNX模型
❌ pnpm test:coverage  — 需要885MB ONNX模型
```

---

## 🔧 本地运行CI完整验证

```bash
# 本地CI模拟(使用预下载的ONNX模型或从HuggingFace导出)
export TIMESFM_TEST_MODEL=models/timesfm-2.5.onnx

# 快速验证(无模型)
NODE_OPTIONS= pnpm ci:local

# 完整验证(需模型)
NODE_OPTIONS= pnpm ci
```

---

**报告完成时间**: 2026-06-28T09:28:00Z
**审查方法**: 逐文件代码审查 + 静态分析 + CI日志分析 + google-research/timesfm对照
