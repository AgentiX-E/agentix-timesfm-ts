# agentix-timesfm-ts 全面代码审查与改进报告

## 概览

- **审查文件数**: 109 个源文件
- **发现并修复的 Bug**: 12 个
- **架构/设计改进**: 8 个
- **构建验证**: ✅ TypeScript编译通过、ESLint零错误、Prettier格式正确、306个单元测试全部通过
- **修改文件**: 20 个文件 + 1 个新文件

---

## 一、修复的关键 Bug

### 1. `vitest.globalSetup.ts` — 模型路径搜索Bug

**严重程度**: 🔴 Critical

`__dirname/../..` 导航到了错误的目录（`/` 根目录，而非仓库根目录）。导致模型在CI中永远无法被找到。

```diff
- path.resolve(__dirname, '..', '..', 'models')  // → /models (错误!)
- path.resolve(__dirname, '..', '..')              // → / (错误!)
+ path.resolve(__dirname, 'models')                // → 正确: <repo>/models
+ path.resolve(__dirname)                          // → 正确: <repo>/
```

### 2. `model-downloader.ts` — ESM兼容性Bug

**严重程度**: 🔴 Critical

`require('undici')` 在ESM包中会在严格ESM环境下失败。已改为 `await import('undici')` 动态导入，并添加了类型声明文件 `src/types/undici.d.ts`。

### 3. `benchmark-ci.js` — Cold/Warm Ratio计算Bug

**严重程度**: 🔴 Critical

`firstColdStartMs` 变量声明后从未赋值，导致cold/warm ratio始终为 `null`。修复：在首次冷启动测量后正确赋值。

### 4. `benchmark.js` (timesfm-core/scripts) — 包名错误

**严重程度**: 🔴 Critical

导入使用了错误的包名 `@agentix/timesfm-core`（缺少 `-e`）。

```diff
- require('@agentix/timesfm-core')
+ require('@agentix-e/timesfm-core')
```

### 5. `tsconfig.json` — 缺少 `timesfm-web` 引用

**严重程度**: 🔴 Critical

根 `tsconfig.json` 只包含3个包引用，缺少 `timesfm-web`。虽然 `pnpm build` 脚本显式传递了4个包，但 `tsc -b` 只构建项目引用中的包。

### 6. `timesfm-web/package.json` — 重复依赖声明

**严重程度**: 🔴 Critical

`onnxruntime-web` 同时出现在 `dependencies` 和 `peerDependencies` 中，会导致重复安装和版本冲突。

### 7. `timesfm-xreg/package.json` — 缺少 `"type": "module"`

**严重程度**: 🔴 Critical

`exports` 字段使用 `"import"` 条件但缺少 `"type": "module"` 声明，导致ESM消费者无法正确解析。

### 8. `timesfm-cli/cli.ts` — CLI版本号不匹配

**严重程度**: 🔴 High

硬编码版本 `0.1.0` 但 `package.json` 声明为 `0.3.1`。修复为同步至 `0.3.1`。

### 9. `eslint.config.mjs` — Node 20 不兼容

**严重程度**: 🔴 High

`import.meta.dirname` 需要 Node.js ≥ 21.2，但引擎约束是 `>=20.0.0`。添加了 `fileURLToPath` 回退方案。

### 10. `model-release.yml` — 缺少 Python 设置

**严重程度**: 🔴 High

`validate` job 中 `pip install` 之前缺少 `actions/setup-python@v5`。同时优化为使用 `download-artifact` 替代重新导出模型（节省 5-10 分钟）。

### 11. `xreg-engine.ts` — Subsampling 重复索引Bug

**严重程度**: 🔴 High

当 `step < 1` 时，`Math.floor(i * step)` 会产生重复索引，导致训练样本少于预期。使用 `Set` 去重并限制实际行数。

### 12. `onnx-test.js` — 硬编码绝对路径

**严重程度**: 🔴 High

硬编码 `/workspace/agentix-timesfm-ts/models/timesfm-2.5.onnx` 仅能在开发工作区运行。改为使用环境变量或相对路径解析。

---

## 二、架构/设计改进

### 1. Changeset 配置修复

- Schema 版本从 `@3.0.0` 修正为 `@2.31.0`
- 将 `timesfm-web` 添加到 fixed version group（四个包统一版本号）

### 2. Proxy 支持增强

- `applyProxyToFetch()` 改为异步方法，使用动态 `import('undici')` 替代 `require()`
- 创建了 `src/types/undici.d.ts` 类型声明文件
- TIMESFM_PROXY_URL/USERNAME/PASSWORD 环境变量完整支持

### 3. Web Engine 可配置 CDN 版本

- 添加 `cdnVersion` 构造函数参数，默认 `'1.22.0'`（匹配 peerDependency）
- CDN URL 现在使用可配置版本而非硬编码 `'1.27.0'`

### 4. CI/CD Workflow 修复

- Benchmark 脚本参数修复：`--json/--md/--html` 替代错误的 `--all` 位置参数
- `deploy-pages` job 现在依赖全部前置 jobs（`lint, unit-test, build, integration-test, benchmark, web-benchmark`）
- Web integration test 路径解析使用动态搜索替代硬编码绝对路径

### 5. XReg 引擎输入验证

添加了完整的协变量数组长度验证：

- `dynamicNumericalCovariates` — 每个协变量的入口数必须等于输入序列数
- `dynamicCategoricalCovariates` — 同上
- `staticNumericalCovariates` — 同上
- `staticCategoricalCovariates` — 同上
- 空输入数组检查

### 6. TypeDoc 配置增强

- 添加 `packages/timesfm-web/src/index.ts` 入口点（之前只覆盖3个包）

### 7. CONTRIBUTING.md 补充

添加了 Changesets 版本管理和发布流程文档。

### 8. Pipeline.js 脚本修复

Benchmark 调用使用显式标志替代错误的 `--all` 用法。

---

## 三、性能基准测试与 CI 发布

### 已完成的改进：

1. ✅ **Benchmark 脚本修复**: `benchmark-ci.js` 的 cold/warm ratio 计算已修复
2. ✅ **CI Benchmark Job**: 独立的 Node.js benchmark job，使用真实 ONNX 模型
3. ✅ **GitHub Pages 发布**: `deploy-pages` job 自动将 benchmark 报告发布到 GitHub Pages
4. ✅ **README 中的 Benchmark 链接**: `https://agentix-e.github.io/agentix-timesfm-ts/benchmark/`
5. ✅ **综合报告生成器**: `generate-combined-report.js` 合并 Node + WASM benchmark 结果

### Benchmark CI 流程：

```
CI Push to master:
  integration-test (model export + cache)
    ↓
  benchmark (Node.js ONNX Runtime, 10 iterations)
    ↓
  web-benchmark (WASM, 10 iterations)
    ↓
  deploy-pages (TypeDoc + benchmark + coverage → GitHub Pages)
```

---

## 四、API 文档自动发布

### 已完成的改进：

1. ✅ **TypeDoc 配置**: 4个包入口点（core, xreg, cli, web）
2. ✅ **CI 自动生成**: `deploy-pages` job 运行 `pnpm docs:generate`
3. ✅ **GitHub Pages 发布**: API 文档自动部署到 `https://agentix-e.github.io/agentix-timesfm-ts/api/`
4. ✅ **各包 README 链接**:
   - `timesfm-core/README.md`: → `api/modules/timesfm_core.html`
   - `timesfm-xreg/README.md`: → `api/modules/timesfm_xreg.html`
   - `timesfm-cli/README.md`: → `api/modules/timesfm_cli.html`
   - `timesfm-web/README.md`: → `api/modules/timesfm_web.html`

---

## 五、测试覆盖率

### 当前状态：

| 指标       | 阈值  | 状态              |
| ---------- | ----- | ----------------- |
| Lines      | ≥ 95% | ✅ 配置中强制执行 |
| Branches   | ≥ 95% | ✅ 配置中强制执行 |
| Functions  | ≥ 95% | ✅ 配置中强制执行 |
| Statements | ≥ 95% | ✅ 配置中强制执行 |

### 测试架构：

- **Unit Tests (306个)**: 使用 `vitest.unit.config.ts`，独立于模型运行（CI快速反馈，<10分钟）
- **Integration Tests**: 使用真实 TimesFM 2.5 ONNX 模型（885 MB），覆盖完整的模型生命周期
- **Benchmark Tests**: 10次迭代，覆盖 3 种上下文大小 × 4 种 batch 大小
- **测试数据**: test-fixtures.ts 提供 11 种真实场景生成器（business metric, seasonal temp, stock price, spikes等）

### 覆盖范围排除策略：

| 文件                       | 排除原因                           |
| -------------------------- | ---------------------------------- |
| `index.ts` (barrel files)  | 仅再导出的文件                     |
| `cli.ts` (Commander entry) | IO-only，无逻辑                    |
| `model-downloader.ts`      | 网络IO（通过cache helper测试覆盖） |
| `timesfm-web/src/**`       | 需要浏览器/WASM环境                |

---

## 六、相对于 google-research/timesfm 的优势

| 方面       | agentix-timesfm-ts            | google-research/timesfm    |
| ---------- | ----------------------------- | -------------------------- |
| 运行时     | Node.js / TypeScript          | Python (JAX)               |
| 推理引擎   | ONNX Runtime (C++ 原生)       | PyTorch                    |
| 部署模型   | 无需 Python 环境              | 需要 PyTorch + JAX         |
| 浏览器支持 | ✅ WASM/WebGPU                | ❌                         |
| API 设计   | 类型安全 TypeScript API       | Python API                 |
| 包管理     | 按需下载模型（npm包仅~150KB） | 完整repo clone             |
| 生产部署   | 直接可用（Docker/Serverless） | 需要Python环境             |
| 并发推理   | Promise.all 并行 batch 处理   | 取决于框架                 |
| 数据预处理 | RevIN + NaN自动处理           | 相同                       |
| 协变量支持 | Ridge回归 + OneHot            | BatchedInContextXRegLinear |
| 测试覆盖率 | ≥95% 强制阈值                 | 未明确                     |
| CI/CD      | 完整自动化 + GitHub Pages     | GitHub Actions             |

---

## 七、修改文件清单

```
修改的文件 (20个):
 .changeset/config.json               — Schema版本 + fixed group
 .github/workflows/ci.yml             — Benchmark参数 + deploy-pages依赖
 .github/workflows/model-release.yml   — validate job修复
 CONTRIBUTING.md                       — 添加Changesets文档
 eslint.config.mjs                     — Node20兼容性
 package.json                          — benchmark脚本修复
 packages/timesfm-cli/src/cli.ts      — 版本号修复
 packages/timesfm-core/scripts/benchmark.js      — 包名修复
 packages/timesfm-core/scripts/onnx-test.js      — 路径修复
 packages/timesfm-core/src/model-downloader.ts   — ESM兼容性
 packages/timesfm-web/package.json               — 依赖修复
 packages/timesfm-web/src/web-engine.ts           — CDN版本可配置
 packages/timesfm-web/test/web-integration.test.ts — 路径修复
 packages/timesfm-xreg/package.json              — 添加type:module
 packages/timesfm-xreg/src/xreg-engine.ts        — 输入验证 + subsampling修复
 scripts/benchmark-ci.js                          — cold/warm ratio修复
 scripts/pipeline.js                              — benchmark参数修复
 tsconfig.json                                    — 添加web引用
 typedoc.json                                     — 添加web入口
 vitest.globalSetup.ts                            — 路径bug修复

新增文件 (1个):
 packages/timesfm-core/src/types/undici.d.ts      — undici类型声明
```

---

## 八、验证结果

| 检查项             | 结果             |
| ------------------ | ---------------- |
| TypeScript 编译    | ✅ 全部通过      |
| ESLint             | ✅ 零错误        |
| Prettier 格式检查  | ✅ 全部通过      |
| Unit Tests (306个) | ✅ 全部通过      |
| 修改统计           | +168 行 / -47 行 |

---

## 九、后续建议

1. **补充 Preprocessor 测试**: 当前仅7个测试用例，建议增加 RevIN 统计验证、全NaN输入、infinity处理等边缘场景
2. **添加后处理器 AR 路径测试**: `postProcess` 的 `arOutputs` 非null分支未被覆盖
3. **添加 Model Downloader 代理测试**: 使用 nock 模拟代理HTTP响应
4. **添加并发预测测试**: 验证 `Promise.all([model.forecast(...), model.forecast(...)])` 的线程安全性
5. **统一 PRNG**: 测试套件中存在两个不同的伪随机数生成器（`mulberry32` 和 `seededRand`）
