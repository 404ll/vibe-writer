# vibe-writer

输入一个主题，自动生成一篇技术博客文章。

## 功能

- 自动规划文章大纲
- 搜索相关知识（Tavily API）
- 撰写各章节内容
- AI 生成配图（DALL-E）
- 导出 Markdown

## 快速开始

```bash
# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 填入 ANTHROPIC_API_KEY、TAVILY_API_KEY、OPENAI_API_KEY

# 运行
python agents/writer.py
```

## 文档

- [架构设计](docs/architecture.md)
