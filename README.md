# SillyTavern Psychology Engine

## v0.2.0 — Character Profile Initializer

一个前端-only 的 SillyTavern 扩展，用于维护任意角色之间的 **有向心理关系状态**：

```text
A → B != B → A
```

---

## v0.2 新增：普通角色卡自动初始化

从网上导入普通角色卡时，它通常没有 Psychology Engine 参数。

现在插件会：

1. 检测当前角色是否已有心理 Profile。
2. 点击 **AI分析当前角色卡**。
3. 使用当前 SillyTavern 连接静默读取：
   - Description
   - Personality
   - Scenario
   - First Message
   - Example Dialogue
   - System Prompt
   - Post History Instructions
   - Creator Notes
   - 内嵌 Character Book（若可读取）
4. AI生成：
   - 7项 Personality Control
   - 18个核心变量的 Normal / Absolute Bounds
   - Sensitivity / Expression / Awareness
   - 9个派生变量参数
   - 角色 → user 初始关系
   - 卡里明确存在的其他角色关系
5. 插件显示 **可编辑 JSON 预览**。
6. 只有点击 **确认初始化** 后才正式写入状态。

### 关键原则：unknown != 0

```text
0 = 明确中性
null / uninitialized = 没有足够信息
```

如果角色卡没有任何依据说明 A 对 B 的态度，插件不会强行写成：

```json
"Love": 0,
"Trust": 0
```

而是保留为 `uninitialized`。

---

## 安装

仓库根目录必须直接包含：

```text
manifest.json
index.js
style.css
README.md
LICENSE
schema/
```

上传 GitHub 后，在 SillyTavern：

```text
Extensions → Install Extension
```

粘贴：

```text
https://github.com/YOUR_GITHUB_USERNAME/sillytavern-psychology-engine
```

---

## 运行时架构

```text
Character Card
      ↓
AI Profile Initializer
      ↓
Confirmed Psychology Profile
      ↓
Per-chat State Database (chat_metadata)
      ↓
Event Analyzer
      ↓
Knowledge Gate
      ↓
Directed Relation Update
      ↓
Runtime Prompt Injection
```

世界书负责心理规则。

插件负责：

- 初始参数
- 动态状态
- Knowledge
- Events
- Relations
- Runtime Injection

---

## 18 Core Variables

- Love
- Trust
- Security
- Intimacy
- Dependency
- Exclusivity
- Resentment
- Respect
- Mood
- Arousal
- Anger
- Fear
- Shyness
- Hurt
- Longing
- RelationalThreat
- Guilt
- Disgust

## 9 Derived Variables

- Jealousy
- AffectionSeeking
- Shame
- Curiosity
- Gratitude
- Attraction
- Pride
- Loneliness
- Admiration

## Personality Control

- SelfControl
- Assertiveness
- VulnerabilityTolerance
- PrivacyBias
- Empathy
- CognitiveFlexibility
- NeedForControl

---

## Knowledge Gate

```text
No Knowledge
=> No Psychological Update
```

插件除了在提示词要求模型遵守外，还会在代码层再次检查。

NPC不在场、没听说、没看到证据：

```text
Delta = 0
```

---

## 当前限制

v0.2 仍然是 MVP：

- 尚未做 Edit/Delete 精确回滚
- 尚未做 Snapshot + Replay
- 群聊角色卡读取兼容性仍需实测
- 不同 SillyTavern 版本的角色对象字段可能有差异，代码已提供多种 fallback
- 暂未自动把世界书里的个体参数同步进 Profile
- 暂未单独选择一个小模型作为 Analyzer

---

## 下一阶段建议

v0.3 优先做：

1. Snapshot / Replay
2. Swipe / Edit / Delete 精确回滚
3. Profile 可视化编辑器（不用直接改 JSON）
4. 关系网络图
5. Knowledge 图谱
6. 独立 Analyzer Connection Profile

## License

MIT
