# SillyTavern Psychology Engine v0.4.2

这是一次**规则层重构版**，不是在 v0.3.3 上继续堆补丁。

核心目标：

```text
State evolves.
Personality persists.
Expression adapts.
```

也就是：心理状态会随剧情变化，但长期关系发展不得自动把角色卡中的鲜明人格“治愈”、平均化或磨平；角色的表达方式可以随着熟悉、信任和关系阶段发生变化。



## v0.4.2 — Regenerate Rollback Fix

修复显式“重新生成 / Regenerate”不会回滚上一条 AI 回复心理状态的问题。

SillyTavern 的原生 **Swipe** 与 **Regenerate** 是两条不同事件路径：右滑生成新 swipe 会先触发 `MESSAGE_SWIPED`，而菜单/快捷键的显式 Regenerate 会直接进入 `Generate('regenerate')`，之后删除上一条 AI 消息，并不会先触发 `MESSAGE_SWIPED`。v0.4.1 只监听了前者，因此显式 Regenerate 时旧回复造成的心理变化可能残留并进入新一轮生成。

v0.4.2 在 `GENERATION_STARTED(type='regenerate')` 阶段、旧消息尚未被 SillyTavern 删除之前，恢复该消息保存的完整 `beforeState`，刷新 runtime injection，然后才允许主生成继续。这样新回复会从与旧回复相同的心理基线重新生成。

同时保护一种原生行为：如果聊天最后一条是**用户消息**，SillyTavern 的 Regenerate 实际上只是生成新的助手回复，此时不会错误回滚更早的 AI 回复。

> 状态 schema 没有变化，仍为 `0.4.1`；这是纯运行时 rollback 修复，不需要清空已有 Psychology Engine 状态，也不需要更新 World Info v2.1。

## v0.4.1 — Unresolved Thread Gate

修复 `Threads` 把已经结束的普通互动当成“未解决事项”长期保存的问题。

现在 `Thread` 被严格定义为 **Unresolved Open Loop**：只有剧情停止在当前时点后，仍然存在明确的未回答问题、未兑现承诺、未解决冲突、待定决定/意图、持续不确定性或未完成任务，并且未来仍需要某个条件来关闭它时，才允许进入 `activeThreads`。

例如：

```text
在车里打情骂俏，互动已经结束且没有留下悬念
→ Event ✓
→ Thread ✗
```

而：

```text
她在车里追问“你是不是喜欢我”，对方没有回答
→ Event ✓
→ Thread ✓（问题仍未回答）
```

新 Thread 必须由主模型在同一次正常生成里输出结构化判断：`isUnresolved=true`、`futureResolutionRequired=true`、`whyOpen` 和 `resolutionCriterion`。插件会拒绝裸字符串或缺少这些判断依据的 Thread。`resolveThreads` 使用 Thread id 关闭已解决开放环。

为了避免旧错误继续污染状态，从 v0.4.0 升级到 v0.4.1 时，旧版自由文本 `activeThreads` 会被清除；真正仍未解决的事项可以在后续剧情相关时由模型重新建立。

同时收紧 Memory 语义：普通已完成互动默认只作为 Event，不因为“值得一提”就自动进入长期 Memory。

## 主要变化

### 1. 27 个动态状态重新分层

角色自身状态 6 项：

```text
Mood [-100,100]
Activation [0,100]
Fear [0,100]
Shame [0,100]
Pride [0,100]
Loneliness [0,100]
```

有向长期关系 8 项：

```text
Love [0,100]
Trust [-100,100]
Security [0,100]
Intimacy [0,100]
Dependency [0,100]
Exclusivity [0,100]
Resentment [0,100]
Respect [-100,100]
```

有向动态关系 13 项：

```text
Anger
Shyness
Hurt
Longing
RelationalThreat
Guilt
Disgust
Jealousy
AffectionSeeking
Curiosity
Gratitude
Attraction
Admiration
```

除 Trust / Respect / Mood 外，其余变量全部使用 `[0,100]`。不再存在“负愤怒”“负嫉妒”等语义。

`Arousal` 已改名为 `Activation`，表示整体心理/生理激活，不与性兴奋绑定。

### 2. 删除 normal_min / normal_max 人格硬上限

v0.3.x 中类似：

```text
angerProneness 较低
→ Anger.normal_max 较低
```

的机制已经移除。

人格不再规定“一个人最多能多生气、多爱、多害羞”。
人格主要影响：

```text
Trigger threshold
Reactivity
Persistence
Expression / appraisal style
```

极端剧情下，平时温和的人依然允许达到很高 Anger。

### 3. 22 个人格轴

保留原有 18 个轴，并新增：

```text
autonomy
composure
directness
flirtatiousness
```

分别用于表达：自主独立、压力下从容、表达直接程度、主动调情倾向。

这四个轴不替代角色卡，只补充 Dynamic State → Behavior 之间原有的通用缺口。

### 4. Trait Preservation

高人格倾向不再只被压缩成轻微 `0.75~1.25` 的风味乘数。

对于以下具有强角色辨识度的倾向：

```text
jealousyProneness
angerProneness
shameProneness
dependencyProneness
curiosityProneness
disgustSensitivity
```

引擎会允许更明显的触发阈值和持续性差异。

特别是：

```text
Security 高 ≠ 不再善妒
Familiarity 高 ≠ 害羞角色被治好
Security 高 ≠ 黏人角色自动变独立
```

### 5. Optional Invariants

每个角色允许 `0~2` 条可选 invariant。

它不是 archetype tag，也不参与数值计算，只用于防止心理动力学误伤角色卡中少数无法被人格轴完整表达的核心结构。

例如：

```text
高度亲密和安全感不会自动使她坦率承认脆弱的恋爱需求。
```

绝大多数角色可以没有 invariant。

### 6. Familiarity

每条关系边增加轻量机械历史：

```text
interactionCount
familiarityBase
```

Familiarity 不是第 28 个心理变量，也不等于 Intimacy。

用途主要包括：

```text
重复日常互动逐渐降低普通 Shyness
降低“因为陌生而产生”的 Curiosity
```

但新的私人层级、脆弱暴露和真正的新信息仍可重新触发高反应。

### 7. Shyness 动态软上限

不再使用固定 `Shyness.normal_max`。

普通熟悉互动的 Shyness 可随 Familiarity 明显下降；新的高 novelty / vulnerability 事件可以重新打开较高的 Shyness 空间。

高 `shameProneness` 会保留 trait floor，防止害羞人设在长期 RP 中被磨平。

### 8. Jealousy 双来源逻辑

Security 主要压制 abandonment / panic 型嫉妒，不再把 trait jealousy 一起清零。

因此允许：

```text
Security = 90
RelationalThreat = 10
Jealousy = 40
```

含义可以是：

```text
“我知道你不会离开我，但我就是不喜欢你把特殊注意力给别人。”
```

### 9. Passive Decay

短期状态支持半衰期回落，但只有在：

```text
角色本轮实际活跃 / 知道事件
且该状态未被更新
且未被 maintain
```

时才衰减。

离场角色不会因为别人的聊天轮次随机漂移。

长期关系状态默认没有被动衰减。

### 10. 更新格式变化

v0.4.1 的 `PSY_UPDATE` 使用：

```json
{
  "events": [
    {
      "id": "e1",
      "summary": "...",
      "participants": ["角色", "用户"],
      "knownBy": ["角色"]
    }
  ],
  "updates": [
    {
      "observer": "角色",
      "target": "用户",
      "basedOn": ["e1"],
      "severity": "ordinary",
      "characterDelta": {"Activation": 8},
      "relationshipDelta": {"Trust": 1, "Shyness": 8},
      "context": {"novelty": 0.5, "vulnerability": 0.7},
      "maintainCharacter": [],
      "maintainRelationship": [],
      "reason": "..."
    }
  ]
}
```

AI 输出的是**语义基础变化量**；插件随后应用人格反应、context、saturation、单轮安全上限和 domain clamp。

### 11. Single-pass / Rollback / Actor Eligibility 保持

仍然没有：

```text
generateRaw
generateQuietPrompt
第二次后台 LLM 心理分析
```

心理分析与 RP 正文继续走同一次主 API / 主模型 / 主 Preset。

保留：

```text
Card Context != Actor
Actor Eligibility Gate
Knowledge Gate
最新 AI 回复 Transactional Rollback
Swipe Cache
```

## v0.3.3 升级注意

插件包含 v0.3.x / v0.4.0 → v0.4.1 的 best-effort 状态迁移：

- Arousal → Activation
- Mood / Fear / Shame / Pride / Loneliness 移到 Character State
- 旧 Core / Derived 关系状态迁移到新 longTerm / dynamic 结构
- 不合法的负单极变量会按新 domain 截断到 0

由于 v0.3.x Profile 没有新增四个人格轴，升级后会保留旧关系状态，但把旧 Profile 标记为需要重新初始化，让下一次主回复根据当前角色卡重新生成 22 轴。

如果是专门测试 v0.4.1 的新规则，**建议在测试聊天中清空一次 Psychology Engine 状态**，避免旧版数据影响判断。

## World Info

本包附带：

```text
PsychologyEngine-WorldInfo-SillyTavern-v2.1.json
```

它已经与 v0.4.1 的变量 domain、22 人格轴、Trait Preservation、Familiarity、Shyness、Jealousy、Thread Gate 和表达规则同步。
