
### v0.3.3：Actor Eligibility Gate

只有两类人物允许进入持久心理数据库：

```text
character_card = 当前角色卡明确设定的主要/核心人物
world_info     = 当前 World Info / lore 中明确设定的具名持续角色
```

临时 NPC 可以参与事件和 knownBy，但不会自动建立 Profile 或 relation edge。

代码硬门控：

```text
observer 必须属于 Actor Registry
target 必须是 user 或 Actor Registry 中的角色
```

每个 PSY_INIT profile 必须提供 eligibility.source 与 eligibility.evidence。
否则该人物不会注册为持久 Actor。

这样既避免店员、路人、卫兵等污染数据库，也降低长期 token 消耗。
Single-pass 与最新回复 Transactional Rollback 保持不变。


### v0.3.2：Card Context ≠ Actor

v0.3.1 的核心身份假设是：

```text
SillyTavern 当前角色卡名称 = 心理角色名称
```

这对普通单人卡成立，但对多人卡会失败。

例如：

```text
角色卡名称：亲吻姐姐
实际角色：住之江亚香、住之江理香
```

旧版会错误创建：

```text
亲吻姐姐 → user
```

v0.3.2 引入两个独立概念：

```text
Card Context
= SillyTavern 当前卡片 / 群组 / 场景上下文名称

Actor
= 故事中真正具有独立心理状态的人物
```

因此卡名不再自动调用 `ensureCharacter(cardName)`。

#### 多人初始化

首次主回复可以返回：

```json
{
  "cardContext": "亲吻姐姐",
  "cardIsContainer": true,
  "profiles": [
    {
      "character": "住之江亚香",
      "personalityControl": {},
      "styleTraits": {},
      "initialRelations": []
    },
    {
      "character": "住之江理香",
      "personalityControl": {},
      "styleTraits": {},
      "initialRelations": []
    }
  ]
}
```

插件分别保存：

```text
住之江亚香 Profile
住之江理香 Profile
```

不会再保存：

```text
亲吻姐姐 Profile
```

#### 多人关系

每个 Profile 支持：

```text
initialRelations[]
```

因此除了：

```text
A → user
B → user
```

还可以在角色卡确实提供既有关系时初始化：

```text
A → B
B → A
```

由于关系有方向，这两个状态仍然独立。

#### 动态多人更新

`PSY_UPDATE` 现在明确要求：

```text
observer / target / knownBy
```

只能使用真实人物名称。

多人同一事件可以得到不同更新：

```text
A → user : Trust +2
B → user : Hurt +3
A → B    : RelationalThreat +1
```

代码层也会拒绝已知 Card Container 作为心理主体。

#### 旧伪角色清理

如果一次 `PSY_INIT` 判断：

```text
cardIsContainer = true
```

插件会清理此前同名的旧伪角色及其关系，例如：

```text
亲吻姐姐 → user
```

这用于迁移 v0.3.0 / v0.3.1 已经产生的错误状态。

#### Single-pass / Rollback 保持不变

v0.3.2 仍然：

```text
无 generateRaw
无 generateQuietPrompt
无第二次模型分析
```

所有心理识别、RP正文和心理更新仍搭乘同一次主 API / 主模型 / 主 Preset。

最新 AI 回复的事务式 rollback 也继续保留。


### v0.3.1：最新 AI 回复事务式 Rollback

本版不增加任何第二次模型请求。仍然完全使用主 API / 主模型 / 主 Preset 的 Single-pass 架构。

每次应用最新 AI 回复的 `PSY_INIT / PSY_UPDATE` 前，插件保存：

```text
beforeState
```

它是 Psychology Engine 在这条回复生效之前的完整状态快照。

因此重新 roll / swipe 最新 AI 回复时：

```text
旧回复已应用状态
↓
恢复 beforeState
↓
主模型生成新 swipe
↓
解析新 PSY_INIT / PSY_UPDATE
↓
从同一个 beforeState 提交新状态
```

这会一起回退：

- Core / Derived 数值
- Character Profile / 首次初始化
- Events
- Knowledge
- Active Threads
- Memories
- Runtime Psychology state

不使用“delta 反向相减”，因此不会被 `[-100,100]` clamp 等非线性操作破坏。

#### Swipe Cache

插件会按当前消息的 `swipe_id` 缓存该 swipe 的已解析控制块。

如果 SillyTavern 保存聊天时已经把隐藏控制块从可见正文中移除，再切回旧 swipe 时仍可以用缓存重新提交对应心理状态。

#### 生成时序保护

SillyTavern 的 `MESSAGE_SWIPED` 可能先于新 swipe 的实际生成触发。

v0.3.1 因此：

```text
MESSAGE_SWIPED
→ 立即 rollback
→ 刷新心理状态注入
→ 如果随后进入 GENERATION_STARTED：等待新主回复
→ 如果只是切换现有 swipe：直接应用该 swipe / swipe cache
```

因此新 roll 的主模型看到的是**旧回复发生之前的心理状态**，而不是已经被旧回复修改过的状态。

#### 当前范围

v0.3.1 只保证：

```text
最新一条 AI 回复
```

的精确 rollback。

历史消息的重新编辑、删除或历史 swipe 仍不做级联重算。为了避免聊天文件膨胀，旧消息的完整 `beforeState` 快照会被清理。


# SillyTavern Psychology Engine

## v0.3.3 — Actor Eligibility Gate

v0.3.0 不再做任何第二次 LLM 请求。

核心结构：

```text
当前心理状态
      ↓
setExtensionPrompt()
      ↓
SillyTavern 正常主生成
（当前主 API + 当前模型 + 当前 Preset + 当前采样）
      ↓
RP 正文 + 隐藏 Psychology 控制块
      ↓
插件本地解析
      ↓
更新 chat_metadata
      ↓
下一轮继续注入
```

## 为什么改成 Single-pass

v0.2.x 使用后台 `generateQuietPrompt()` / `generateRaw()` 做二次分析时，会遇到：

- 不同 API 对后台接口兼容性不同
- 主 RP 可生成，但第二次分析请求被截断/拒绝
- 后台调用未必与主 RP 的 preset 路径完全一致
- 同一剧情被模型处理两次
- JSON 格式和上下文污染问题

v0.3.0 直接取消第二次分析。

心理系统现在“搭乘”正常主回复，所以自然继承用户当前的：

- 主 API
- 主模型
- SillyTavern preset
- sampler
- instruct / context 配置
- provider 行为

插件不会绕过模型/API提供方本身的限制；它只是避免额外的第二次分析请求。

---

## 同一回复如何更新心理状态

模型正常生成 RP，例如：

```text
她把茶盏放回桌上，低声问：“今晚会早些回来么？”
```

然后在末尾附加 HTML comment：

```html
<!--PSY_UPDATE
{
  "events":[
    {
      "id":"e1",
      "summary":"许岩答应今晚早点回来",
      "knownBy":["邱念秋"]
    }
  ],
  "updates":[
    {
      "observer":"邱念秋",
      "target":"许岩",
      "basedOn":["e1"],
      "coreDelta":{"Trust":1,"Security":1},
      "derivedDelta":{"AffectionSeeking":2},
      "reason":"承诺带来轻微关系确认",
      "addThreads":[],
      "resolveThreads":[],
      "memories":[]
    }
  ]
}
/PSY_UPDATE-->
```

HTML comment 正常情况下不会显示在聊天 UI。

插件随后：

1. 读取控制块
2. Knowledge Gate 校验
3. 更新变量
4. 从 `message.mes` 中删除控制块
5. 保存聊天和状态

如果控制块缺失或 JSON 错误：

```text
本轮变量不更新
```

不会猜测数据。

---

## 首次角色初始化

不再有独立的 “AI分析当前角色卡” 后台请求。

如果当前角色尚未初始化，插件会把初始化协议注入下一次正常主回复。

同一个主回复末尾会额外包含：

```html
<!--PSY_INIT
{ ... }
/PSY_INIT-->
```

插件用它建立：

- Personality Control
- Style Traits
- Normal / Absolute Bounds
- Character → user 初始关系

初始关系仍使用 `[-100,100]` 强度量表：

```text
0   = 真正中性
25  = 轻度
50  = 中等
75  = 强烈
90  = 很强
```

`1` 不代表 true。

如果初始化结果出现大规模 `-1/0/1` 布尔化，插件拒绝初始化，并在下一次正常主回复中再次请求初始化。

---

## Knowledge Gate

PSY_UPDATE 中每个事件包含：

```json
"knownBy":["真正知道这个事件的角色"]
```

每个 update 必须引用：

```json
"basedOn":["e1"]
```

代码检查：

```text
observer ∉ event.knownBy
→ update 被拒绝
```

因此 NPC 不在场、没听说、没有证据时，不能仅凭“叙事者知道”更新关系。

---

## Runtime State 对主输出的影响

每次正常生成前，插件通过 `setExtensionPrompt()` 注入：

```text
当前关系状态
当前人格控制
Semantic Band
Active Threads
最近关系记忆
Single-pass 控制协议
```

核心原则：

```text
Character Card = 角色怎样表达
Dynamic State  = 角色现在实际是什么心理状态
```

例如：

```text
Anger = 70
SelfControl = 0.85
```

不意味着角色必须大吼。

它意味着：

```text
真实愤怒存在
+
高自控决定其表达方式
```

---

## 数据保存位置

当前仍保存在：

```text
chat_metadata
```

所以：

- 关闭/重新打开 SillyTavern：状态保留
- 切换聊天：每个聊天有独立状态
- 删除对应聊天：状态随聊天删除

Campaign 独立存档留给后续版本。

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

## 安装

仓库根目录：

```text
manifest.json
index.js
style.css
README.md
LICENSE
PsychologyEngine-WorldInfo-SillyTavern-v1.4.json
schema/
```

GitHub 上传后：

```text
SillyTavern → Extensions → Install Extension
```

粘贴仓库 URL。

已有安装：

```text
Extensions → Psychology Engine → Update
```

---

## 配套 World Info

```text
PsychologyEngine-WorldInfo-SillyTavern-v1.4.json
```

在：

```text
SillyTavern → World Info → Import
```

导入。

分工：

```text
World Info
= 心理变量定义、Knowledge Gate、派生机制、输出规则

Extension
= 当前变量、Single-pass协议、控制块解析、状态持久化
```

---

## v0.3.0 当前限制

- Swipe / 编辑旧消息后的精确 rollback 仍未完成
- 如果模型完全忽略 PSY_UPDATE 协议，本轮变量保持不变
- 如果生成在控制块之前达到 token 上限，本轮变量保持不变
- 目前动态状态仍跟随当前 chat_metadata，而不是独立 Campaign
- 群聊/多 NPC 的完整 Profile 初始化仍需要进一步实测

这些都不会触发第二次 LLM 请求。

## License

MIT
