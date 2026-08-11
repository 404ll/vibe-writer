# @vibe-writer/eval-core

供应商、数据库和队列无关的离线评测协议。它固定 dataset、target、prompt/model/graph/tool/code 版本，执行一个或多个 trial，并把 target/grader 错误显式记录为失败。

默认报告只保留输出指纹，不携带输入、expected 或输出正文。需要保存输出时必须显式启用 `captureOutput`，由调用方负责 consent、脱敏、访问控制和 retention。

`summarizeEvalReport`、`baselineFromReport`、`parseEvalBaseline` 和 `compareEvalBaseline` 提供供应商无关的版本化回归门禁。baseline 固定 suite/target、dataset fingerprint、case inventory 和 metric gate；code revision 保留在每次 run snapshot，不进入 dataset baseline。失败或含 target/evaluator error 的 report 不能生成候选 baseline。
