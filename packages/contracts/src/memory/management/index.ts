/**
 * 兼容入口：汇总 Memory 管理全部契约。
 *
 * 新代码应按职责选择 `/memory/management/shared`、`/records` 或 `/candidates`，
 * 让导入路径直接表达是在分页、操作活跃记忆还是审核候选。
 */
export * from './shared'
export * from './records'
export * from './candidates'
