# Eval 0022：Production Outline Resume 基线

- 日期：2026-08-07
- 结论：Passed for synthetic production pause/resume projection
- 对应迭代：[0026](../iterations/0026-production-outline-resume-projection-gate.md)

## Identity

| 项目 | 值 |
|---|---|
| suite | `production-composition-regression@2026-08-07-v2` |
| dataset | `production-composition-baseline-v2` |
| dataset fingerprint | `sha256:e0fa1d2cae78dfeaf93d8fb641afe9320f7ff4cadd50486bc2946d7399b85b57` |
| target | `typescript-durable-production-composition@v2` |
| metric | `durable_projection_exact_match` |
| cases | happy terminal + edited outline pause/resume |

## 结果

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| unique cases | 2 | 2 | Passed |
| target/evaluator errors | 0 | 0 | Passed |
| exact-match scores | 2 | 2 | Passed |
| pass rate | 1.0 | 1.0 | Passed |

Resume case 的规范化投影为：`runStatuses=[completed,completed]`、`eventTypes=[outline_ready,done]`、两个published outbox、一个revision 0 article、两个trace id、五次provider request；正文命中`edited-outline-confirm` workflow expected。effect/trace仍不保存正文。

## 联合证据

- production Worker实际进入`awaiting_input`；
- command repository写入reply并重排Job；
- dispatcher发布第二条resume outbox，Worker第二次claim并从PostgresSaver恢复；
- durable API列出两条生成article和一条legacy article；
- Server Component使用身份scope渲染恢复文章，并包含编辑后的章节标题；
- PostgreSQL、Redis和Next在结束后停止。

根级门禁另通过TypeScript 345项、Python 50项，共395项测试，以及Web lint/build、全部typecheck、migration check、38-case component gate、3-case workflow shadow gate和87个Markdown链接检查。

## 未证明

- cancel、failure、takeover与uncertain effect；
- HTTP reply route、浏览器SSE和反向代理长连接；
- 真实provider质量、网络分区或托管基础设施。
