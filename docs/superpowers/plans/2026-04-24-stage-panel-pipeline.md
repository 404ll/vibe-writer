# StagePanel Pipeline Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 StagePanel 从顶部横向步骤条改造为左侧纵向管道节点栏，每步是独立节点卡片，活跃步骤展开章节子步骤列表。

**Architecture:** 重写 StagePanel 组件为纵向布局；在 App.tsx 的 body 层将 StagePanel 从 hero-zone 内部移到左侧独立列，与 hero-zone 并排；章节子步骤状态文字复用已有 chapterStatus 数据。

**Tech Stack:** React, TypeScript, inline styles（与现有代码库一致，无新依赖）

---

## File Map

| 文件 | 操作 | 说明 |
|------|------|------|
| `frontend/src/components/StagePanel.tsx` | 重写 | 纵向管道节点布局 |
| `frontend/src/App.tsx` | 修改 | body 层插入左侧 StagePanel 列，从 hero-zone 移除 StagePanel |

---

### Task 1: 重写 StagePanel 为纵向管道节点

**Files:**
- Modify: `frontend/src/components/StagePanel.tsx`

- [ ] **Step 1: 读取现有文件，确认 Props 接口**

当前 Props：
```ts
interface Props {
  currentStage: StageStatus | null
  completedChapters: number
  totalChapters: number
  chapterStatus?: Record<string, 'forming_opinion' | 'searching' | 'writing' | 'reviewing' | 'done'>
  outline?: string[]
}
```
Props 不变，只改渲染逻辑。

- [ ] **Step 2: 完整替换 StagePanel.tsx**

```tsx
import type { StageStatus } from '../types'

const STAGES: { key: StageStatus; label: string; icon: string }[] = [
  { key: 'plan',   label: '规划大纲', icon: '◎' },
  { key: 'write',  label: '撰写章节', icon: '✦' },
  { key: 'review', label: '审稿',     icon: '◈' },
  { key: 'export', label: '导出文章', icon: '⬡' },
]

const STAGE_ORDER: StageStatus[] = ['plan', 'write', 'review', 'export', 'done']

const CH_STATUS_LABEL: Record<string, string> = {
  forming_opinion: '论点中',
  searching:       '搜索中',
  writing:         '写作中',
  reviewing:       '审稿中',
  done:            '✓',
}

interface Props {
  currentStage: StageStatus | null
  completedChapters: number
  totalChapters: number
  chapterStatus?: Record<string, 'forming_opinion' | 'searching' | 'writing' | 'reviewing' | 'done'>
  outline?: string[]
}

export function StagePanel({
  currentStage,
  completedChapters,
  totalChapters,
  chapterStatus = {},
  outline = [],
}: Props) {
  const currentIndex = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="写作进度"
      style={{
        width: '140px',
        flexShrink: 0,
        background: 'var(--card-bg)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        boxShadow: 'var(--shadow)',
        padding: '14px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        alignSelf: 'flex-start',
        position: 'sticky',
        top: '14px',
      }}
    >
      <div className="card-label" style={{ marginBottom: '12px' }}>写作进度</div>

      {STAGES.map(({ key, label, icon }, i) => {
        const stageIdx = STAGE_ORDER.indexOf(key)
        const done   = currentIndex > stageIdx || currentStage === 'done'
        const active = STAGE_ORDER[currentIndex] === key
        const isWrite = key === 'write'

        return (
          <div key={key}>
            {/* 节点行 */}
            <div
              aria-current={active ? 'step' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '5px 7px',
                borderRadius: '6px',
                border: `1.5px solid ${active ? 'var(--accent-active)' : done ? 'var(--accent-done)' : 'transparent'}`,
                background: active ? '#fff3e8' : done ? '#f5f0e8' : 'transparent',
                transition: 'all 0.2s',
              }}
            >
              {/* 图标 */}
              <div style={{
                width: '20px',
                height: '20px',
                borderRadius: '5px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '10px',
                fontWeight: 700,
                flexShrink: 0,
                background: done ? 'var(--accent-done)' : active ? 'var(--accent-active)' : 'var(--stage-idle-bg)',
                color: done || active ? 'var(--text-on-accent)' : 'var(--text-muted)',
                animationName: active ? 'pulse-ring' : 'none',
                animationDuration: '2s',
                animationTimingFunction: 'ease-in-out',
                animationIterationCount: 'infinite',
              }}>
                {done ? '✓' : icon}
              </div>

              {/* 名称 */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '11px',
                  fontWeight: active ? 600 : 400,
                  color: done ? 'var(--accent-done)' : active ? 'var(--accent-active)' : 'var(--text-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {label}
                  {isWrite && totalChapters > 0 && (
                    <span style={{ opacity: 0.7, marginLeft: '3px' }}>
                      {completedChapters}/{totalChapters}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* 章节子步骤（仅 write 阶段 active 时展开） */}
            {isWrite && active && outline.length > 0 && (
              <div style={{
                borderLeft: '2px solid var(--accent-active)',
                marginLeft: '17px',
                paddingLeft: '8px',
                marginTop: '3px',
                marginBottom: '3px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
              }}>
                {outline.map((title) => {
                  const status = chapterStatus[title]
                  const isDone = status === 'done'
                  const isActive = !!status && !isDone
                  return (
                    <div key={title} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      fontSize: '10px',
                      padding: '2px 4px',
                      borderRadius: '4px',
                      background: isActive ? 'rgba(249,115,22,0.06)' : 'transparent',
                    }}>
                      <div style={{
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: isDone
                          ? 'var(--accent-done)'
                          : isActive
                          ? 'var(--accent-active)'
                          : 'var(--stage-idle-bg)',
                      }} />
                      <span style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: isDone ? 'var(--accent-done)' : isActive ? 'var(--accent-active)' : 'var(--text-muted)',
                        fontWeight: isActive ? 600 : 400,
                      }}>
                        {title}
                      </span>
                      {status && (
                        <span style={{
                          flexShrink: 0,
                          color: isDone ? 'var(--accent-done)' : 'var(--text-muted)',
                          fontSize: '9px',
                        }}>
                          {CH_STATUS_LABEL[status] ?? status}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* 节点间连接线 */}
            {i < STAGES.length - 1 && (
              <div style={{
                width: '2px',
                height: '8px',
                background: done ? 'var(--accent-done)' : 'var(--stage-idle-bg)',
                margin: '1px 0 1px 16px',
                borderRadius: '1px',
                transition: 'background 0.3s',
              }} />
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: 在浏览器里验证组件渲染无报错**

启动前端 `npm run dev`，打开 http://localhost:5173，确认页面无 TypeScript/React 报错。

---

### Task 2: 调整 App.tsx 布局，将 StagePanel 移到左侧列

**Files:**
- Modify: `frontend/src/App.tsx:188-220`

- [ ] **Step 1: 在 app-body div 内插入左侧 StagePanel 列**

找到 App.tsx 中的 body 区域：

```tsx
{/* Body: left + right */}
<div className="app-body" style={{ display: 'flex', gap: '12px', alignItems: 'stretch', flex: 1, minHeight: 0 }}>
```

在 `{/* Left column */}` 之前插入 StagePanel 列：

```tsx
{/* Body: left + right */}
<div className="app-body" style={{ display: 'flex', gap: '12px', alignItems: 'stretch', flex: 1, minHeight: 0 }}>

  {/* Pipeline 左侧纵向栏 */}
  {job && (
    <StagePanel
      currentStage={job.stage}
      completedChapters={completedChapters}
      totalChapters={job.outline?.length ?? 0}
      chapterStatus={chapterStatus}
      outline={job.outline ?? []}
    />
  )}

  {/* Left column */}
  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
    ...
  </div>
```

- [ ] **Step 2: 从 hero-zone 内部删除原有 StagePanel**

找到 hero-zone 内的 StagePanel 调用并删除：

```tsx
// 删除这段：
{job && (
  <StagePanel
    currentStage={job.stage}
    completedChapters={completedChapters}
    totalChapters={job.outline?.length ?? 0}
    chapterStatus={chapterStatus}
    outline={job.outline ?? []}
  />
)}
```

- [ ] **Step 3: 验证布局**

1. 无 job 时：左侧无 StagePanel，页面居中显示输入框
2. 有 job 时：左侧出现 140px 纵向管道栏，右侧内容区正常
3. write 阶段：章节子步骤展开，左侧橙色竖线可见

- [ ] **Step 4: 检查移动端响应式**

`index.css` 中已有 `.app-body { flex-direction: column }` 的移动端规则，StagePanel 在移动端会自动变为全宽顶部块，无需额外处理。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/StagePanel.tsx frontend/src/App.tsx
git commit -m "feat: redesign StagePanel as left-side pipeline node column"
```
