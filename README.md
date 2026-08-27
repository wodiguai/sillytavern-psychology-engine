# SillyTavern Psychology Engine

## v0.3.0 — Single-pass Architecture

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
