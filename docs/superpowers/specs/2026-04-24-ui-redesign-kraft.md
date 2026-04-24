# UI Redesign — Kraft × Two-Column

**Date:** 2026-04-24  
**Scope:** 纯视觉重设计，功能不变（版本对比留到后续迭代）

---

## 目标

将 vibe-writer 从"AI 生成感"的默认样式升级为有设计感的产品界面，面向外部用户。

---

## 设计决策

### 视觉风格：牛皮纸 (Kraft)

| 属性 | 值 |
|------|-----|
| 背景色 | `#f0ece3`（米棕） |
| 卡片背景 | `#fffdf8`（暖白） |
| 边框 | `#ddd8cc` |
| 主色（按钮/强调） | `#5c4a32`（深棕） |
| 完成状态色 | `#7a6248` |
| 成功色 | `#5c7a4a` |
| 错误色 | `#8b3a3a` |
| 静止文字 | `#a09880` |
| 正文文字 | `#5a5040` |
| 标题字体 | Kalam（Google Fonts，手写风） |
| 正文字体 | DM Sans（Google Fonts，圆润无衬线） |

### 布局：左主右侧栏（flex）

```
┌─────────────────────────────┬──────────────┐
│  写作主题（InputPanel）       │              │
├─────────────────────────────┤  实时日志     │
│  写作进度（StagePanel）       │  （右侧栏    │
├─────────────────────────────┤   全高）      │
│  大纲确认（ReviewPanel）      │              │
├─────────────────────────────┤              │
│  历史记录（flex:1，填满剩余）  │              │
└─────────────────────────────┴──────────────┘
```

- 整体用 `display: flex; align-items: stretch` 铺满视口高度
- 左栏 `flex: 1`，内部 `flex-direction: column; gap: 10px`
- 右栏固定宽度 `280px`，日志区域内部可滚动
- 历史记录卡片 `flex: 1` 填满左栏剩余空间

### 卡片系统

- `border-radius: 8px`
- `box-shadow: 0 1px 3px rgba(60,40,10,0.05)`
- `padding: 14px 16px`
- 每张卡片顶部有 `card-label`：10px 大写字母间距标签

---

## 需要修改的文件

### `frontend/src/index.css`
- 更新 CSS 变量：背景色、主色、边框色、字体
- 引入 Google Fonts：Kalam + DM Sans
- 更新 `.card`、`.btn-primary` 样式
- 添加 `html, body { height: 100% }` 和全局 flex 布局基础

### `frontend/src/App.tsx`
- `<body>` / `#root` 改为 `display: flex; flex-direction: column; min-height: 100vh`
- `app-body` 改为 `display: flex; gap: 12px; align-items: stretch; flex: 1`
- 左栏 `.col-main`：`flex: 1; display: flex; flex-direction: column; gap: 10px`
- 右栏 `.col-side`：`width: 280px; flex-shrink: 0; display: flex; flex-direction: column`
- 标题改用 Kalam 字体
- 新增 `HistoryPanel` 占位组件（静态数据，不接后端）

### `frontend/src/components/InputPanel.tsx`
- 修复 `placeholder` 末尾加 `…`
- `input` 加 `name="topic"`
- `autoComplete` 改为 `"search"`

### `frontend/src/components/ReviewPanel.tsx`
- `textarea` 加 `name="feedback"`
- `placeholder` 末尾加 `…`
- `button` 加 `type="button"`

### `frontend/src/components/ActivityPanel.tsx`
- `@keyframes spin` 改为在 `@media (prefers-reduced-motion: no-preference)` 内定义（去掉 `!important` 覆盖）
- 右侧栏改为全高，内部日志区域 `overflow-y: auto`

---

## 新增组件

### `HistoryPanel`（新建，内联在 App.tsx 或独立文件）

静态展示，无后端。每条记录包含：
- 状态点（绿色=成功，红色=失败）
- 主题文字
- 时间戳

数据来源：`localStorage`，每次 `job.stage === 'done'` 时追加一条。

---

## 不在本次范围内

- 版本对比功能
- 历史记录后端持久化
- 移动端响应式适配
- 暗色模式
