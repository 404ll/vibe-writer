# vibe-writer 架构设计

## 项目目标

用户输入一个写作主题（如「Agent入门-必知必会」），agent 自动完成：
- 规划文章大纲
- 搜索相关知识
- 撰写各章节内容
- AI 生成配图
- 导出 Markdown 文件

---

## 整体流程

```
用户输入主题
    ↓
Plan：拆解文章大纲（章节列表 + 每节要点）
    ↓
并行执行每个章节：
    ├── Tavily 搜索相关内容
    ├── 撰写章节正文
    └── DALL-E 生成配图
    ↓
汇总 → 调整格式 → 导出 Markdown
```

---

## Agent 架构设计

### 核心机制（来自 learn-claude-code）

| 需求 | 采用机制 | 说明 |
|---|---|---|
| 拆解大纲 | TodoWrite + 任务图（DAG） | 章节间有顺序依赖，用 blockedBy 管理 |
| 每章节独立撰写 | Subagent | 每章节上下文隔离，避免互相干扰 |
| 搜索+配图耗时操作 | 后台任务并行 | 多章节同时搜索，不阻塞主流程 |
| 写作风格/格式规范 | Skill 按需加载 | 不同风格的写作指南按需注入 |
| 长文写作不丢进度 | 持久化任务图 | 任务状态写入磁盘，中断可恢复 |

### 工具列表（TOOLS）

| 工具名 | 用途 |
|---|---|
| `search` | 调用 Tavily API 搜索相关内容 |
| `generate_image` | 调用 DALL-E 生成配图 |
| `write_file` | 写入文件 |
| `read_file` | 读取文件 |
| `task_create` | 创建章节任务 |
| `task_update` | 更新任务状态 |
| `task_list` | 查看任务进度 |

---

## MVP 开发顺序

**第一阶段：跑通核心流程**
- 输入主题 → 生成大纲 → 逐章节写作 → 输出 Markdown
- 不含搜索和配图

**第二阶段：接入搜索**
- 集成 Tavily API
- 每个章节写作前先搜索相关资料

**第三阶段：接入配图**
- 集成 DALL-E API
- 根据章节内容自动生成配图

**第四阶段：体验优化**
- 写作风格 skill 支持
- 任务进度可视化
- 断点续写

---

## 目录结构

```
vibe-writer/
  agents/
    writer.py        ← 主 agent
  skills/
    tech-blog/
      SKILL.md       ← 技术博客写作风格指南
  docs/
    architecture.md  ← 本文档
  output/            ← 生成的文章
  .tasks/            ← 任务状态持久化
  requirements.txt
  .env.example
```

---

## 工具链 & 依赖

| 工具/服务 | 用途 | 文档 |
|---|---|---|
| Anthropic API | 核心 LLM | https://docs.anthropic.com |
| Tavily API | 搜索引擎 | https://docs.tavily.com |
| DALL-E API (OpenAI) | AI 配图 | https://platform.openai.com/docs |
| brainstorming skill | 方案头脑风暴 | https://github.com/obra/superpowers |

### 安装的 Skills

| Skill | 来源 | 用途 |
|---|---|---|
| brainstorming | `obra/superpowers@brainstorming` | 架构方案头脑风暴 |

### 使用的 MCP

暂无，后续按需添加。

---

*持续更新中...*
