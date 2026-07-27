# Retro 80s Pastel Terminal UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle vibe-writer from the current kraft-paper interface into a polished Retro 80s Pastel Terminal UI inspired by the Superdesign draft "Retro 80s Pastel Terminal".

**Architecture:** Keep the existing React component structure and FastAPI integration unchanged. Centralize the new visual language in `frontend/src/index.css`, then replace component inline visual styling with semantic class names in the first-screen workflow and article reader/editor. Preserve all current behavior, state, SSE streaming, routing, and tests.

**Tech Stack:** React 19, TypeScript, Vite 8, CSS custom properties, Vitest, Testing Library, Playwright or browser verification through the running Vite app.

**Design Source Constraint:** `superdesign get-design --draft-id da2fc09a-58ae-4bc4-86e8-f055aeec4a48 --json` currently returns `{"error":"API key does not have access to this draft","code":"forbidden"}`. This plan uses the available design signals: draft name `Retro 80s Pastel Terminal`, selected copy `RECLAIM THE MEMORY. THE PAST IS BUFFERING. SYSTEM CLEARANCE GRANTED...`, and the existing vibe-writer UI.

---

## File Structure

- Modify `frontend/src/index.css`: define the complete theme, layout primitives, terminal cards, form controls, stage rail, activity log, writing preview, article reader, responsive rules, and reduced-motion-safe animations.
- Modify `frontend/src/App.tsx`: replace page-level inline styles and status boxes with semantic classes.
- Modify `frontend/src/components/InputPanel.tsx`: convert the hero/input/preset controls to terminal-styled classes.
- Modify `frontend/src/components/StagePanel.tsx`: convert the progress rail and chapter status UI to terminal-styled classes.
- Modify `frontend/src/components/ActivityPanel.tsx`: convert log rows and status icons to classes.
- Modify `frontend/src/components/ReviewPanel.tsx`: convert outline confirmation UI to terminal classes.
- Modify `frontend/src/components/WritingPreview.tsx`: convert streaming preview to a terminal buffer panel.
- Modify `frontend/src/components/HistoryPanel.tsx`: align history list with the new panel system.
- Modify `frontend/src/pages/ArticlePage.tsx`: align toolbar, table of contents, article prose, edit mode, and history drawer with the new theme.
- Modify tests only if accessible labels or visible text change. The implementation should avoid behavior changes so most existing tests remain valid.

## Visual System

Use a dark terminal base with pastel accents, not a single-hue palette:

```css
:root {
  --bg: #17151f;
  --bg-grid: rgba(255, 255, 255, 0.05);
  --panel: rgba(37, 32, 52, 0.92);
  --panel-strong: #252034;
  --panel-soft: #302945;
  --border: rgba(255, 236, 184, 0.28);
  --border-input: rgba(147, 219, 255, 0.38);
  --text: #f7edd7;
  --text-h: #fff7bf;
  --text-muted: #c4b9d9;
  --text-label: #8ee7ff;
  --accent: #ff8bd1;
  --accent-hover: #ffb1df;
  --accent-active: #7df9d4;
  --accent-done: #fff07a;
  --success: #9cff9c;
  --danger: #ff8f8f;
  --success-bg: rgba(115, 255, 169, 0.12);
  --success-border: rgba(156, 255, 156, 0.35);
  --success-text: #baffe0;
  --danger-bg: rgba(255, 143, 143, 0.12);
  --danger-border: rgba(255, 143, 143, 0.42);
  --input-bg: rgba(12, 10, 18, 0.72);
  --card-bg: rgba(37, 32, 52, 0.9);
  --stage-idle-bg: rgba(255, 255, 255, 0.08);
  --text-on-accent: #17151f;
  --shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
  --sans: 'Space Grotesk', system-ui, sans-serif;
  --mono: 'IBM Plex Mono', 'SF Mono', monospace;
}
```

Add a subtle CRT/grid background using pseudo-elements on `body`, scanline/terminal glow effects on `.card`, and a restrained pastel palette. Avoid decorative orbs and avoid oversized marketing hero composition.

---

## Task 1: Capture Current UI Behavior Before Styling

**Files:**
- Read: `frontend/src/App.tsx`
- Read: `frontend/src/components/InputPanel.tsx`
- Read: `frontend/src/components/StagePanel.tsx`
- Read: `frontend/src/components/ActivityPanel.tsx`
- Read: `frontend/src/components/ReviewPanel.tsx`
- Read: `frontend/src/components/WritingPreview.tsx`
- Read: `frontend/src/components/HistoryPanel.tsx`
- Read: `frontend/src/pages/ArticlePage.tsx`

- [ ] **Step 1: Run frontend tests before changes**

Run:

```bash
cd /Users/elemen/Myself/ai/vibe-writer/frontend
npm test -- --run
```

Expected: tests pass, or any existing failures are recorded before styling work begins.

- [ ] **Step 2: Run frontend typecheck/build before changes**

Run:

```bash
cd /Users/elemen/Myself/ai/vibe-writer/frontend
npm run build
```

Expected: `tsc -b && vite build` completes successfully, or existing build errors are recorded.

- [ ] **Step 3: Start the app for visual baseline**

Run backend:

```bash
cd /Users/elemen/Myself/ai/vibe-writer
.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Run frontend in a second terminal:

```bash
cd /Users/elemen/Myself/ai/vibe-writer/frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

Expected: `http://127.0.0.1:5173/` loads and `http://127.0.0.1:5173/api/health` returns `{"status":"ok"}`.

---

## Task 2: Replace Theme Tokens And Global Surfaces

**Files:**
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Replace the Google font import**

Replace the current `@import` with:

```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');
```

- [ ] **Step 2: Replace `:root` tokens**

Replace the current kraft palette with the Visual System token block above. Keep all existing token names used by components so the change is compatible before component cleanup.

- [ ] **Step 3: Add terminal background and base layout**

Add this after `html, body`:

```css
body {
  min-height: 100%;
  background:
    linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px),
    radial-gradient(circle at 20% 0%, rgba(255, 139, 209, 0.16), transparent 34%),
    radial-gradient(circle at 90% 8%, rgba(125, 249, 212, 0.14), transparent 30%),
    var(--bg);
  background-size: 28px 28px, 28px 28px, auto, auto, auto;
  color: var(--text);
}

body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    to bottom,
    rgba(255,255,255,0.045),
    rgba(255,255,255,0.045) 1px,
    transparent 1px,
    transparent 4px
  );
  mix-blend-mode: soft-light;
  opacity: 0.45;
  z-index: 0;
}

#root {
  position: relative;
  z-index: 1;
}
```

- [ ] **Step 4: Restyle `.card`, `.card-label`, `.btn-primary`, form controls, and focus**

Use sharp terminal proportions with maximum `8px` radius:

```css
.card {
  position: relative;
  background: linear-gradient(180deg, rgba(48, 41, 69, 0.96), rgba(28, 24, 40, 0.96));
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow), inset 0 0 0 1px rgba(255,255,255,0.04);
  color: var(--text);
}

.card::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(90deg, rgba(255,139,209,0.18), transparent 30%, rgba(125,249,212,0.16));
  opacity: 0.32;
}

.card-label {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: var(--text-label);
}

.btn-primary {
  background: linear-gradient(90deg, var(--accent), var(--accent-active));
  color: var(--text-on-accent);
  border: 1px solid rgba(255,255,255,0.24);
  border-radius: 5px;
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  box-shadow: 0 0 22px rgba(255, 139, 209, 0.26);
}

.btn-primary:hover {
  background: linear-gradient(90deg, var(--accent-hover), #a6ffe6);
}
```

- [ ] **Step 5: Add reusable classes**

Add classes used by later tasks:

```css
.app-shell { display: flex; flex-direction: column; flex: 1; min-height: 100vh; padding: 18px; box-sizing: border-box; }
.app-body { display: flex; gap: 14px; align-items: flex-start; flex: 1; min-height: 0; }
.hero-zone { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 12px; min-height: 0; }
.hero-zone--idle { justify-content: center; padding-bottom: 60px; }
.hero-zone--active { justify-content: flex-start; padding: 16px 0; overflow-y: auto; }
.terminal-title { font-family: var(--mono); font-size: 32px; font-weight: 700; color: var(--text-h); text-transform: uppercase; letter-spacing: 0; text-shadow: 0 0 18px rgba(255, 240, 122, 0.28); }
.terminal-subtitle { font-family: var(--mono); font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.6px; }
.terminal-field { width: 100%; box-sizing: border-box; border: 1px solid var(--border-input); border-radius: 5px; background: var(--input-bg); color: var(--text); font-family: var(--mono); }
.terminal-field::placeholder { color: rgba(196, 185, 217, 0.72); }
.ghost-button { background: rgba(255,255,255,0.04); border: 1px solid var(--border); border-radius: 5px; color: var(--text-muted); font-family: var(--mono); cursor: pointer; }
.ghost-button:hover { color: var(--text-h); border-color: var(--accent-active); }
.danger-button:hover { color: var(--danger); border-color: var(--danger); }
```

- [ ] **Step 6: Preserve mobile responsiveness**

Keep the existing `@media (max-width: 768px)` behavior, updating only colors and spacing if needed. The mobile first screen must remain a single column with the activity panel full width.

---

## Task 3: Convert App Shell And Status Blocks

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Replace the outer route layout inline shell**

Replace the root page wrapper and `app-body` inline styles with:

```tsx
<div className="app-shell">
  <div className="app-body">
```

- [ ] **Step 2: Replace left column and hero-zone inline styles**

Use:

```tsx
<div className={isScrollable ? 'work-column work-column--active' : 'work-column work-column--idle'}>
  <div className={isScrollable ? 'hero-zone hero-zone--active' : 'hero-zone hero-zone--idle'}>
```

Add this CSS in `frontend/src/index.css`:

```css
.work-column { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.work-column--idle { min-height: calc(100vh - 36px); }
.work-column--active { min-height: 0; }
```

- [ ] **Step 3: Replace cancel button styles**

Use:

```tsx
<button type="button" onClick={handleCancel} className="ghost-button danger-button task-cancel-button">
  中断任务
</button>
```

Add CSS:

```css
.task-cancel-button { padding: 6px 14px; font-size: 12px; }
```

- [ ] **Step 4: Replace done/error status blocks**

Use `className="terminal-status terminal-status--success"` for the done block and `className="terminal-status terminal-status--danger"` or `terminal-status--muted` for errors/cancelled.

Add CSS:

```css
.terminal-status {
  width: 100%;
  max-width: 620px;
  padding: 10px 14px;
  border-radius: 7px;
  font-family: var(--mono);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.terminal-status--success { background: var(--success-bg); border: 1px solid var(--success-border); color: var(--success-text); }
.terminal-status--danger { background: var(--danger-bg); border: 1px solid var(--danger-border); color: var(--danger); }
.terminal-status--muted { background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--text-muted); }
```

---

## Task 4: Restyle InputPanel As Retro Terminal Command Console

**Files:**
- Modify: `frontend/src/components/InputPanel.tsx`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Replace wrapper/title classes**

Use:

```tsx
<div className="input-panel">
  <div className="terminal-title">vibe-writer</div>
  <div className="terminal-subtitle">RECLAIM THE MEMORY. THE PAST IS BUFFERING.</div>
```

Add CSS:

```css
.input-panel { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; max-width: 640px; flex-shrink: 0; }
.input-card { display: flex; flex-direction: column; gap: 12px; flex-shrink: 0; width: 100%; padding: 16px; }
.command-row { display: flex; gap: 8px; align-items: stretch; }
.topic-input { flex: 1; min-width: 0; padding: 10px 12px; font-size: 14px; }
.topic-submit { padding-inline: 18px; }
```

- [ ] **Step 2: Convert the topic input**

Apply:

```tsx
className="terminal-field topic-input"
```

Keep the existing `id`, `name`, `placeholder`, `value`, `onChange`, `onKeyDown`, `autoComplete`, and `disabled` props.

- [ ] **Step 3: Convert option rows and pills**

For each option group, use:

```tsx
<div className="option-row">
  <span className="option-label">大纲介入</span>
```

For buttons:

```tsx
className={active ? 'terminal-pill terminal-pill--active' : 'terminal-pill'}
```

Add CSS:

```css
.option-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.option-label { width: 58px; flex-shrink: 0; font-family: var(--mono); font-size: 10px; color: var(--text-label); text-transform: uppercase; }
.terminal-pill {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-input);
  color: var(--text-muted);
  background: rgba(255,255,255,0.04);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
}
.terminal-pill--active {
  color: var(--text-on-accent);
  border-color: transparent;
  background: linear-gradient(90deg, var(--accent), var(--accent-active));
}
.terminal-pill:disabled { cursor: not-allowed; opacity: 0.55; }
```

- [ ] **Step 4: Convert custom style input**

Apply:

```tsx
className="terminal-field custom-style-input"
```

Add CSS:

```css
.custom-style-input { padding: 8px 12px; font-size: 13px; }
```

- [ ] **Step 5: Run InputPanel tests**

Run:

```bash
cd /Users/elemen/Myself/ai/vibe-writer/frontend
npm test -- --run src/components/InputPanel.test.tsx
```

Expected: existing tests pass because labels, buttons, and submit behavior are unchanged.

---

## Task 5: Restyle Progress, Activity, Review, And Writing Preview Panels

**Files:**
- Modify: `frontend/src/components/StagePanel.tsx`
- Modify: `frontend/src/components/ActivityPanel.tsx`
- Modify: `frontend/src/components/ReviewPanel.tsx`
- Modify: `frontend/src/components/WritingPreview.tsx`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Convert StagePanel wrapper**

Use:

```tsx
className="stage-panel card"
```

Add CSS:

```css
.stage-panel { width: 150px; flex-shrink: 0; padding: 14px 12px; display: flex; flex-direction: column; align-self: flex-start; position: sticky; top: 18px; }
.stage-node { display: flex; align-items: center; gap: 8px; padding: 6px 7px; border-radius: 6px; border: 1px solid transparent; transition: border-color 0.2s, background 0.2s; }
.stage-node--active { border-color: var(--accent-active); background: rgba(125, 249, 212, 0.1); }
.stage-node--done { border-color: rgba(255, 240, 122, 0.4); background: rgba(255, 240, 122, 0.08); }
.stage-icon { width: 21px; height: 21px; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-family: var(--mono); font-size: 10px; font-weight: 700; flex-shrink: 0; background: var(--stage-idle-bg); color: var(--text-muted); }
.stage-icon--active { background: var(--accent-active); color: var(--text-on-accent); animation: pulse-ring 2s ease-in-out infinite; }
.stage-icon--done { background: var(--accent-done); color: var(--text-on-accent); }
.stage-label { font-family: var(--mono); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); }
.stage-label--active { color: var(--accent-active); font-weight: 700; }
.stage-label--done { color: var(--accent-done); }
```

- [ ] **Step 2: Convert ActivityPanel rows**

Use `className="activity-panel card"`, `activity-row`, and status modifiers like `activity-row--success`.

Add CSS:

```css
.activity-panel { display: flex; flex-direction: column; min-height: 0; max-height: calc(55vh - 28px); padding: 14px 16px; }
.activity-scroll { flex: 1; overflow-y: auto; }
.activity-empty { font-family: var(--mono); font-size: 12px; color: var(--text-muted); }
.activity-row { display: flex; align-items: flex-start; gap: 7px; padding: 5px 6px; margin-bottom: 2px; border-radius: 5px; font-family: var(--mono); font-size: 11px; line-height: 1.5; animation: slideInRight 0.2s ease-out both; }
.activity-row--success { background: var(--success-bg); }
.activity-row--failed { background: var(--danger-bg); }
.activity-icon { flex-shrink: 0; width: 13px; font-size: 11px; margin-top: 1px; display: inline-block; }
.activity-icon--running { animation: spin 1.2s linear infinite; }
```

- [ ] **Step 3: Convert ReviewPanel**

Use classes `review-card`, `outline-row`, `outline-number`, `outline-input`, `outline-delete`, and `review-feedback`.

Add CSS:

```css
.review-card { width: 100%; max-width: 620px; flex-shrink: 0; padding: 16px; }
.review-meta { font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--text-h); margin: 0 0 10px; }
.outline-list { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
.outline-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: var(--input-bg); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; }
.outline-number { font-family: var(--mono); font-size: 9px; color: var(--text-label); font-weight: 700; width: 18px; flex-shrink: 0; }
.outline-input { flex: 1; border: 0; background: transparent; color: var(--text); font-family: var(--mono); font-size: 12px; outline: none; padding: 2px 0; }
.outline-delete { border: 0; background: transparent; cursor: pointer; color: var(--text-muted); font-size: 14px; line-height: 1; padding: 2px 4px; }
.review-feedback { height: 64px; margin-bottom: 8px; padding: 8px 10px; resize: vertical; }
```

- [ ] **Step 4: Convert WritingPreview**

Use classes `writing-preview`, `writing-preview-header`, `writing-pulse`, `writing-title`, `writing-badge`, `writing-buffer`, `writing-fade`, and `writing-cursor`.

Add CSS:

```css
.writing-preview { width: 100%; max-width: 620px; flex-shrink: 0; padding: 12px 14px; overflow: hidden; border-top: 2px solid var(--accent-active); }
.writing-preview-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.writing-pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-active); flex-shrink: 0; animation: pulse-dot 1s ease-in-out infinite; }
.writing-title { font-family: var(--mono); font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.writing-badge { font-family: var(--mono); font-size: 9px; font-weight: 700; text-transform: uppercase; background: rgba(125,249,212,0.12); color: var(--accent-active); border: 1px solid rgba(125,249,212,0.34); border-radius: 999px; padding: 2px 7px; }
.writing-buffer { height: 58px; overflow: hidden; position: relative; }
.writing-fade { position: absolute; top: 0; left: 0; right: 0; height: 20px; background: linear-gradient(to bottom, var(--panel), transparent); z-index: 1; pointer-events: none; }
.writing-cursor { display: inline-block; width: 7px; height: 13px; background: var(--accent-active); margin-left: 2px; vertical-align: text-bottom; animation: blink 0.8s step-end infinite; }
```

- [ ] **Step 5: Run focused component tests**

Run:

```bash
cd /Users/elemen/Myself/ai/vibe-writer/frontend
npm test -- --run src/components/InputPanel.test.tsx src/hooks/useJobStream.test.ts
```

Expected: tests pass.

---

## Task 6: Restyle HistoryPanel And Article Reader

**Files:**
- Modify: `frontend/src/components/HistoryPanel.tsx`
- Modify: `frontend/src/pages/ArticlePage.tsx`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Read HistoryPanel before editing**

Run:

```bash
sed -n '1,260p' /Users/elemen/Myself/ai/vibe-writer/frontend/src/components/HistoryPanel.tsx
```

Expected: identify class conversion points while preserving current API calls and navigation behavior.

- [ ] **Step 2: Add article layout classes**

Add:

```css
.article-page { min-height: 100vh; background: transparent; }
.article-toolbar { position: sticky; top: 0; z-index: 20; height: 54px; padding: 0 32px; display: flex; align-items: center; gap: 20px; background: rgba(23, 21, 31, 0.84); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border); }
.article-title { flex: 1; font-family: var(--mono); font-size: 15px; color: var(--text-h); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.article-grid { display: grid; grid-template-columns: 1fr min(720px, 100%) 1fr; max-width: 1240px; margin: 0 auto; padding: 0 24px; box-sizing: border-box; gap: 0 32px; }
.toc-nav { position: sticky; top: 70px; max-height: calc(100vh - 84px); overflow-y: auto; padding-top: 40px; padding-right: 8px; }
.toc-link { display: block; padding: 4px 0; font-family: var(--mono); font-size: 12px; line-height: 1.5; color: var(--text-muted); text-decoration: none; border-left: 2px solid transparent; }
.toc-link--active { color: var(--accent-active); font-weight: 700; border-left-color: var(--accent-active); }
.article-main { padding: 48px 0 100px; min-width: 0; }
```

- [ ] **Step 3: Restyle `.prose` for terminal reading**

Update existing `.prose` rules:

```css
.prose {
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.82;
  color: var(--text);
}
.prose h1, .prose h2, .prose h3 {
  font-family: var(--mono);
  color: var(--text-h);
  font-weight: 700;
  letter-spacing: 0;
}
.prose code, .prose pre {
  font-family: var(--mono);
  background: var(--input-bg);
  border: 1px solid var(--border-input);
}
.prose blockquote {
  border-left: 3px solid var(--accent);
  color: var(--text-muted);
  background: rgba(255,255,255,0.035);
  padding: 8px 12px;
}
```

- [ ] **Step 4: Convert ArticlePage inline styles to classes**

Replace major wrappers with `article-page`, `article-toolbar`, `article-grid`, `toc-nav`, `toc-link`, and `article-main`. Keep current event handlers and conditional rendering unchanged.

- [ ] **Step 5: Convert edit mode**

Add:

```css
.article-editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; height: calc(100vh - 120px); }
.article-preview-pane { overflow-y: auto; padding-right: 16px; border-right: 1px solid var(--border); }
.article-editor-pane { display: flex; flex-direction: column; }
.article-editor-textarea { flex: 1; padding: 16px; font-size: 13px; font-family: var(--mono); line-height: 1.7; resize: none; outline: none; }
```

Apply `terminal-field article-editor-textarea` to the Markdown textarea.

- [ ] **Step 6: Run article-related tests**

Run:

```bash
cd /Users/elemen/Myself/ai/vibe-writer/frontend
npm test -- --run
```

Expected: all frontend tests pass.

---

## Task 7: Responsive And Accessibility Verification

**Files:**
- Modify: `frontend/src/index.css` only if verification finds layout issues.

- [ ] **Step 1: Build production assets**

Run:

```bash
cd /Users/elemen/Myself/ai/vibe-writer/frontend
npm run build
```

Expected: TypeScript and Vite build pass.

- [ ] **Step 2: Verify desktop viewport**

With both backend and frontend running, open:

```text
http://127.0.0.1:5173/
```

Check:

- Title and input card are centered in idle state.
- The stage rail appears only when a job exists.
- The activity/history column does not overlap the input card.
- Long Chinese labels fit inside pills without clipping.
- Focus ring is visible on input, pills, and buttons.

- [ ] **Step 3: Verify mobile viewport**

Use browser devtools or Playwright at `390x844`.

Check:

- Main layout becomes one column.
- Stage panel wraps or stacks without horizontal scrolling.
- Input row does not clip the submit button; if it clips, add:

```css
@media (max-width: 520px) {
  .command-row { flex-direction: column; }
  .topic-submit { width: 100%; }
}
```

- [ ] **Step 4: Verify reduced motion**

Enable reduced motion in the browser or emulate it. Confirm animations do not create essential meaning. If necessary, add:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
```

- [ ] **Step 5: Verify color contrast**

Run a Lighthouse accessibility snapshot or manual contrast checks on:

- `--text` on `--panel`
- `--text-muted` on `--panel`
- `--text-on-accent` on `--accent-active`
- `--danger` on `--danger-bg`

Expected: normal text contrast is readable; if `--text-muted` is weak, change it to `#d4c8e8`.

---

## Task 8: Final Review And Commit

**Files:**
- Verify: `frontend/src/index.css`
- Verify: `frontend/src/App.tsx`
- Verify: `frontend/src/components/InputPanel.tsx`
- Verify: `frontend/src/components/StagePanel.tsx`
- Verify: `frontend/src/components/ActivityPanel.tsx`
- Verify: `frontend/src/components/ReviewPanel.tsx`
- Verify: `frontend/src/components/WritingPreview.tsx`
- Verify: `frontend/src/components/HistoryPanel.tsx`
- Verify: `frontend/src/pages/ArticlePage.tsx`

- [ ] **Step 1: Scan for one-off inline visual styles**

Run:

```bash
cd /Users/elemen/Myself/ai/vibe-writer
rg "style=\\{\\{" frontend/src
```

Expected: only dynamic layout styles remain, such as conditional colors or widths that are easier to keep local. Static color, border, radius, typography, and padding should be in CSS classes.

- [ ] **Step 2: Run full frontend verification**

Run:

```bash
cd /Users/elemen/Myself/ai/vibe-writer/frontend
npm test -- --run
npm run build
```

Expected: tests and build pass.

- [ ] **Step 3: Run backend smoke test**

Run:

```bash
cd /Users/elemen/Myself/ai/vibe-writer
.venv/bin/python -m pytest tests/test_articles_router.py tests/test_jobs_router.py
```

Expected: router tests pass, confirming UI-only work did not require API changes.

- [ ] **Step 4: Commit**

Run:

```bash
cd /Users/elemen/Myself/ai/vibe-writer
git add frontend/src/index.css frontend/src/App.tsx frontend/src/components/InputPanel.tsx frontend/src/components/StagePanel.tsx frontend/src/components/ActivityPanel.tsx frontend/src/components/ReviewPanel.tsx frontend/src/components/WritingPreview.tsx frontend/src/components/HistoryPanel.tsx frontend/src/pages/ArticlePage.tsx
git commit -m "style: apply retro pastel terminal ui"
```

Expected: commit succeeds with only UI styling changes.

---

## Self-Review

- Spec coverage: The plan covers the inaccessible Superdesign draft constraint, the retro pastel terminal theme, first-screen app workflow, progress panels, activity log, review panel, writing preview, history, article reading/editing, responsiveness, accessibility, and verification.
- Placeholder scan: No `TBD`, `TODO`, or unspecified "add appropriate" steps remain. Each task names exact files, commands, expected outcomes, and concrete CSS/class patterns.
- Type consistency: No TypeScript data shapes or API signatures change. Existing component props and state remain intact. Class names introduced in tasks are defined in the CSS snippets before use.
