# Agent 质量改进设计

**日期**：2026-04-26  
**范围**：三个独立改动，均在 `backend/agent/` 目录内完成

---

## 背景

评测发现三个问题：
1. Reviewer 解析脆弱：regex 匹配失败时所有章节静默 PASSED，审稿形同虚设
2. OpinionAgent 两次串行 LLM 调用：每章节多一次不必要的 LLM 往返
3. 重写无收敛保证：轻审不通过后重写一次，不再验证，重写质量无保障

---

## 改动 A：Reviewer 结构化输出

### 问题
`_parse_chapter_result` 和 `_parse_full_results` 依赖 regex 解析 LLM 文本输出。LLM 偶尔输出"第1章:"或加粗格式时，regex 失败，所有章节默认 PASSED。

### 方案
用 JSON 模式替换文本解析。

**`BaseAgent`** 新增 `_call_llm_json()`：
```python
async def _call_llm_json(self, system: str, user: str, max_tokens: int = 512) -> dict:
    raw = await self._call_llm(system, user, max_tokens)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log.warning("JSON parse failed, raw=%r", raw[:200])
        return {}
```

**`prompts.py`** 修改两个 Review system prompt，要求输出 JSON：

- `CHAPTER_REVIEW_SYSTEM`：输出 `{"passed": bool, "feedback": "string"}`
- `FULL_REVIEW_SYSTEM`：输出 `{"results": [{"passed": bool, "feedback": "string"}, ...]}`

**`ReviewAgent`** 两个方法改为调用 `_call_llm_json`，直接读 dict 字段。解析失败（空 dict）时 fallback PASSED，并 log warning。

### 边界
- `ReviewResult` dataclass 不变
- `_parse_chapter_result` 和 `_parse_full_results` 可删除（逻辑内联到调用处）

---

## 改动 B：OpinionAgent 合并调用

### 问题
`generate()` 内部串行调用两次 LLM：第一次生成论点，第二次把论点转成搜索词。第二次调用完全可以合并。

### 方案
合并为一次 `_call_llm_json` 调用，prompt 要求同时输出论点和搜索词。

**`prompts.py`**：
- 删除 `OPINION_SEARCH_SYSTEM` 和 `OPINION_SEARCH_USER`
- 修改 `OPINION_SYSTEM` / `OPINION_USER`，要求输出：
```json
{
  "opinions": ["论点1（不超过50字）", "论点2", "论点3"],
  "search_queries": ["搜索词1", "搜索词2", "搜索词3"]
}
```

**`OpinionAgent.generate()`**：
- 一次 `_call_llm_json` 调用
- `opinions_text = "\n".join(f"- {o}" for o in data["opinions"])`
- `search_queries = data["search_queries"]`
- 解析失败时 fallback：`opinions_text = ""`, `search_queries = []`
- 签名不变：`-> tuple[str, list[str]]`

---

## 改动 C：重写收敛保证

### 问题
`_write_chapter` 中轻审不通过后重写一次，不再审。重写质量无保障。全文重审后的重写同理。

### 方案
重写后加一次二次审，最多 2 轮，超出后接受当前内容。

**`_write_chapter` 新逻辑**：
```
写作 → review_chapter（第1次）
  ↓ 通过 → 结束
  ↓ 不通过 → 重写（带 feedback）→ review_chapter（第2次）→ 结束（无论通过与否）
```
第2次不通过时 log warning，接受当前内容继续流程。

**`_run_pipeline` 全文重审逻辑**：
```
review_full（第1次）→ 并行重写不通过章节
  → review_full（第2次）→ 并行重写仍不通过章节
  → 结束（无论通过与否，log warning）
```

### 边界
- 最多增加 1 次全文审稿调用（token 消耗可接受）
- 重写后的二次审不再触发第三次重写

---

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `backend/agent/base.py` | 新增 `_call_llm_json()` |
| `backend/agent/prompts.py` | 改 Review prompts 为 JSON 格式；合并 Opinion prompts |
| `backend/agent/reviewer.py` | 改用 `_call_llm_json`，删除 regex 解析方法 |
| `backend/agent/opinion.py` | `generate()` 改为单次调用 |
| `backend/agent/orchestrator.py` | `_write_chapter` 加二次审；`_run_pipeline` 全文重审加二次验证 |

---

## 测试影响

现有测试文件：`tests/test_reviewer.py`、`tests/test_orchestrator.py`、`tests/test_search.py`

- `test_reviewer.py`：mock LLM 返回值需改为 JSON 字符串
- `test_orchestrator.py`：`_write_chapter` 相关 mock 需覆盖二次审场景
- `test_search.py`：不受影响（SearchAgent 不变）
