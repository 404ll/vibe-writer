# ADR-0001：采用 TypeScript 统一主要应用栈

- 状态：Accepted
- 日期：2026-08-07

## 背景

当前前端使用 TypeScript，后端使用 Python/FastAPI/LangGraph。双语言增加契约重复、环境维护和迁移评测成本；后续 memory、eval、管理 UI 和共享 tool schema 会进一步扩大这种摩擦。

## 决定

目标系统的 Web、API、Worker、Agent、memory 和 eval 使用 TypeScript。现有 Python 实现作为迁移期参考，不进行长期双栈维护。

## 结果

- API/SSE/tool schema 可以通过 Zod 和推导类型共享；
- Node Worker 必须替代 Python 长任务运行时；
- Python prompt 和逻辑不能机械翻译，必须通过 fixture/eval 验证行为；
- 数据迁移和 Python retirement 成为正式阶段。

## 未选择

- 长期保留 Next.js + Python Agent：短期成本低，但不满足统一技术栈目标。
- 不使用编排框架、完全自研状态机：会重新实现 checkpoint、interrupt 和恢复能力。
