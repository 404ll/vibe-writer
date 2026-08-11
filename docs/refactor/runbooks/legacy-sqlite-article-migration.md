# Legacy SQLite Article Migration（历史归档）

> 状态：Retired。根据[ADR-0064](../decisions/0064-retire-python-and-adopt-vercel-web.md)，SQLite import CLI、repository和production integration已经删除。

本文件只保留链接稳定性，说明Iteration 0020曾验证过一次性迁移协议；它不再是可执行runbook，也不代表仓库支持SQLite输入。

当前产品以PostgreSQL为唯一事实来源。若未来出现必须导入的历史数据，应新增ADR并建立独立、一次性、可审计的导入工具，包括source hash、dry-run、备份、幂等与抽样核对；不得恢复FastAPI/SQLite产品fallback。
