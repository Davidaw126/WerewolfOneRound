# 狼人杀线下法官助手 App —— 需求规格说明书 v1.0

> **本文档的使用方式**：本文档是给 AI 编码助手的完整实现依据。所有规则判定、事件契约、数据结构、UI 交互均已明确定义，**不允许自行发挥或"合理推测"**。遇到本文档未覆盖的情况，按第 17 章「冲突裁定原则」处理，并在代码中以 `// SPEC-GAP:` 注释标出。

---

## 0. 文档约定

| 记号       | 含义                                                  |
| ---------- | ----------------------------------------------------- |
| **MUST**   | 必须实现，缺失视为不合格                              |
| **SHOULD** | 推荐实现，可延后到 v1.1                               |
| **MAY**    | 可选                                                  |
| `座位号`   | 1..N 的整数，全程用座位号标识玩家，不用昵称做业务主键 |

---

## 1. 产品定位与形态

### 1.1 核心场景

线下 6–18 人围坐一桌，**一部房主手机 = 上帝面板 + 语音播报音箱**，其余每人一部手机 = 私人身份卡 + 投票器。

### 1.2 职责划分（MUST 严格遵守）

| 能力                   | 房主端（Judge Console）           | 玩家端（Player Client） |
| ---------------------- | --------------------------------- | ----------------------- |
| 创建/解散房间          | ✅                                | ❌                      |
| 配置板子               | ✅                                | 只读查看                |
| 发牌                   | ✅ 触发                           | ❌                      |
| 查看自己身份           | ✅（房主也是玩家）                | ✅                      |
| 查看他人身份           | ❌ **游戏中房主也不可见全场身份** | ❌                      |
| 夜晚技能点选           | ✅ **全部由房主代点**             | ❌                      |
| 接收私密结果（如验人） | ✅ 同步显示                       | ✅ 推送给本人           |
| 白天投票               | ✅ 自己那一票 + 降级代录          | ✅                      |
| 语音播报               | ✅ 由房主手机外放                 | ❌ 静音                 |
| 强制改判               | ✅                                | ❌                      |

> **关于"房主不可见全场身份"**：房主是玩家之一，若能看到全场身份则游戏失衡。房主端在夜晚**只显示当前环节需要的信息**（例：狼人环节显示狼队座位号高亮，因为房主本来就要指挥狼人睁眼；预言家环节显示验人结果，因为线下法官本来就要给手势）。这与线下真实法官掌握的信息量一致。若房主本人是狼人/预言家，信息不额外泄露。
>
> **例外配置** `ruleConfig.hostIsPlayer = false`：房主纯做法官不参与游戏，此时房主端 MAY 开启"全知视角"开关。

### 1.3 MVP 范围

完成 **发牌 → 首夜特殊环节 → 夜晚循环 → 天亮公布 → 警长竞选 → 发言 → 投票出局 → 胜负判定** 的完整闭环。出局玩家转为观战态。

---

## 2. 技术栈与架构

```
┌──────────────────────────────────────────────────┐
│  SvelteKit (TS)  —— SSR 落地页 + SPA 游戏界面      │
│  ├── /                 首页：创建/加入房间          │
│  ├── /room/[code]      房间（大厅→游戏，同一路由）  │
│  └── /room/[code]/judge  房主面板（权限校验）      │
└──────────────────────────────────────────────────┘
                    │ Socket.IO (WebSocket, fallback polling)
┌──────────────────────────────────────────────────┐
│  Node + Socket.IO Server (TS)                     │
│  ├── GameEngine     纯函数状态机（可单测，无 IO）  │
│  ├── RoomManager    房间生命周期                   │
│  ├── AuthGuard      房主权限 / 座位归属校验        │
│  └── Broadcaster    按玩家过滤下发（核心保密层）   │
└──────────────────────────────────────────────────┘
                    │ ioredis
┌──────────────────────────────────────────────────┐
│  Redis  ── 房间状态 / 会话 / Socket.IO Adapter    │
└──────────────────────────────────────────────────┘
```

### 2.1 架构硬性要求（MUST）

1. **服务端权威**：客户端只发送"意图"，所有判定在服务端。客户端**永远不持有** `GameState` 全量对象。
2. **GameEngine 必须是纯函数**：`(state, action) => { newState, effects[] }`。不做 IO、不读时钟（时间由 action 传入）。这是全部单元测试的基础。
3. **Broadcaster 视图裁剪**：每次状态变更后，对每个连接的 socket 单独计算 `PlayerView`，**禁止**广播同一份 payload 给所有人。裁剪逻辑集中在一个文件 `viewFilter.ts`，便于审计。
4. **不可变更新**：使用 `immer` 或手写 immutable 更新，禁止原地修改 state。
5. **动作日志**：所有 action 以 append-only 形式写入 Redis List，支持从日志重放出任意时刻状态（用于断线重连、纠纷复盘、bug 复现）。

---

## 3. 术语表

| 术语                       | 定义                                                       |
| -------------------------- | ---------------------------------------------------------- |
| **座位（Seat）**           | 1..N，游戏内唯一标识，发牌后不可变                         |
| **板子（Setup）**          | 一局游戏的角色配置，如「12人预女猎白」                     |
| **阵营（Camp）**           | `GOOD`（好人）/ `WEREWOLF`（狼人）/ `LOVERS`（情侣第三方） |
| **神职（God）**            | 有技能的好人：预言家、女巫、猎人、守卫、白痴、骑士等       |
| **平民（Villager）**       | 无技能的好人                                               |
| **环节（Step）**           | 夜晚的一个原子操作单元，如「守卫守人」                     |
| **阶段（Phase）**          | 状态机的一个大状态，如 `NIGHT` / `DAY_VOTE`                |
| **死亡原因（DeathCause）** | 决定后续技能能否触发的关键字段                             |
| **结算（Resolve）**        | 把所有死亡意图与保护效果计算成最终死亡名单                 |
| **殉情**                   | 情侣一方死亡导致另一方死亡                                 |
| **同守同救**               | 守卫守护的目标恰好也被女巫用解药救                         |
| **警徽流**                 | 警长死亡时把警徽移交给某人，或撕毁（无人继承）             |

---

## 4. 角色总表

### 4.1 角色枚举（MUST 全部实现）

| ID             | 名称                     | 阵营      | 夜晚顺序 | 技能摘要                                     |
| -------------- | ------------------------ | --------- | -------- | -------------------------------------------- |
| `VILLAGER`     | 平民                     | GOOD      | —        | 无技能                                       |
| `SEER`         | 预言家                   | GOOD      | 40       | 每夜查验一人的好/坏                          |
| `WITCH`        | 女巫                     | GOOD      | 30       | 解药1瓶、毒药1瓶                             |
| `HUNTER`       | 猎人                     | GOOD      | 50       | 死亡时开枪带走一人（条件见 D16）             |
| `GUARD`        | 守卫                     | GOOD      | 20       | 每夜守护一人，抵挡狼刀                       |
| `IDIOT`        | 白痴                     | GOOD      | —        | 被投出局时翻牌免死，失去投票权               |
| `KNIGHT`       | 骑士                     | GOOD      | —        | 白天决斗，翻对方牌                           |
| `DREAM_WEAVER` | 摄梦人                   | GOOD      | 45       | 每夜摄一人，被摄者当夜免疫狼刀但连摄两夜会死 |
| `CUPID`        | 丘比特                   | GOOD→可变 | 首夜 12  | 首夜连接两人成为情侣                         |
| `THIEF`        | 盗贼                     | 待定      | 首夜 10  | 首夜从2张底牌选1张作为自己身份               |
| `WILD_CHILD`   | 野孩子                   | GOOD→可变 | 首夜 14  | 首夜选榜样，榜样死后变狼                     |
| `WEREWOLF`     | 普通狼人                 | WEREWOLF  | 25       | 参与集体狼刀                                 |
| `WOLF_KING`    | 白狼王                   | WEREWOLF  | 25       | 白天可自爆并带走一人                         |
| `WOLF_BEAUTY`  | 狼美人                   | WEREWOLF  | 25 + 27  | 每夜魅惑一人，自己死亡时魅惑对象殉情         |
| `NIGHTMARE`    | 恶灵骑士/噩梦之influence | WEREWOLF  | 25 + 28  | 每夜恐惧一人，该人次日无法使用技能与投票     |

> **v1.0 优先级**：`VILLAGER / SEER / WITCH / HUNTER / GUARD / IDIOT / WEREWOLF` 为 P0；`CUPID / WOLF_KING / WOLF_BEAUTY / KNIGHT` 为 P1；`THIEF / WILD_CHILD / DREAM_WEAVER / NIGHTMARE` 为 P2。数据结构必须一次性设计到位以容纳全部角色。

### 4.2 角色能力元数据（MUST 数据驱动，禁止 if-else 硬编码角色名）

```typescript
interface RoleMeta {
	id: RoleId;
	name: string;
	camp: Camp; // 初始阵营
	isGod: boolean; // 是否算神职（影响屠边判定）
	nightOrder: number | null; // null = 夜晚无行动
	firstNightOnly: boolean; // 仅首夜行动（丘比特/盗贼/野孩子）
	actsOnFirstNight: boolean; // 首夜是否行动
	targetCount: number; // 需选目标数，丘比特=2
	canTargetSelf: boolean;
	canTargetDead: boolean; // 一律 false，保留扩展
	visibleTeammates: RoleId[]; // 夜晚可互认的队友角色（狼队）
	maxUses: number | null; // null = 无限；女巫特殊处理
}
```

---

## 5. 板子配置与校验

### 5.1 预设板子（MUST 内置）

| 板子名         | 人数 | 配置                                             |
| -------------- | ---- | ------------------------------------------------ |
| 6人新手场      | 6    | 2狼 + 预言家 + 女巫 + 2民                        |
| 8人局          | 8    | 2狼 + 预言家 + 女巫 + 猎人 + 3民                 |
| 9人局          | 9    | 3狼 + 预言家 + 女巫 + 猎人 + 3民                 |
| 12人标准场     | 12   | 4狼 + 预言家 + 女巫 + 猎人 + 白痴 + 4民          |
| 12人守卫场     | 12   | 4狼 + 预言家 + 女巫 + 猎人 + 守卫 + 4民          |
| 12人狼王守卫场 | 12   | 3狼 + 白狼王 + 预言家 + 女巫 + 猎人 + 守卫 + 4民 |
| 12人情侣场     | 12   | 4狼 + 预言家 + 女巫 + 猎人 + 丘比特 + 4民        |
| 自定义         | 6–18 | 自由勾选                                         |

### 5.2 校验规则（MUST 在开始游戏前阻断）

```typescript
function validateSetup(setup: Setup, playerCount: number): ValidationResult {
	// E01 角色总数必须等于玩家数
	// E02 狼人阵营人数 >= 1
	// E03 好人阵营人数 >= 1
	// E04 狼人数 < 好人数（否则开局即结束）
	// E05 每种角色数量 >= 0；唯一性角色（预言家/女巫/猎人/守卫/白痴/骑士/
	//     丘比特/盗贼/野孩子/白狼王/狼美人）数量 <= 1
	// E06 若含 THIEF：额外底牌数 = 2，玩家数 = 角色数 - 2（盗贼牌堆多2张）
	// E07 若含 WILD_CHILD：场上存活玩家 >= 4
	// E08 若含 CUPID：场上玩家 >= 6
	// E09 若含 KNIGHT：不与 IDIOT 冲突（可共存，仅提示节奏偏快）
	// E10 警长竞选开启时，玩家数 >= 6
}
```

校验失败时，房主端 **MUST** 显示具体错误码与人话描述，并禁用"开始游戏"按钮。

---

## 6. 规则开关配置（RuleConfig）

**MUST** 全部实现为房主可在开局前调整的开关，并把最终配置快照存入本局记录（用于复盘时说明"当时是按什么规则打的"）。

```typescript
interface RuleConfig {
	// ===== A. 胜负 =====
	winCondition: 'SIDE_KILL' | 'TOTAL_KILL'; // 默认 'SIDE_KILL'（屠边）
	loversWinOverridesCamp: boolean; // 默认 true
	cupidJoinsLoversCamp: boolean; // 默认 true ★本局确认
	cupidWinsIfDead: boolean; // 默认 true（已死仍共享胜利）

	// ===== B. 白天 =====
	sheriffEnabled: boolean; // 默认 true
	sheriffVoteWeight: number; // 默认 1.5
	sheriffDecidesSpeechOrder: boolean; // 默认 true
	sheriffBadgeOnDeath: 'TRANSFER_OR_TEAR' | 'AUTO_TEAR'; // 默认 'TRANSFER_OR_TEAR'
	tieBreak: 'PK_THEN_NO_EXILE' | 'NO_EXILE' | 'RANDOM'; // 默认 'PK_THEN_NO_EXILE'
	allowAbstain: boolean; // 默认 true
	sheriffMustVote: boolean; // 默认 true（警长不可弃票）
	lastWords: {
		firstNightVictim: boolean; // 默认 true
		exiledPlayer: boolean; // 默认 true
		hunterShotVictim: boolean; // 默认 true（白天被带走者有遗言）
		nightVictimAfterFirst: boolean; // 默认 false（第二夜起夜死无遗言）
	};
	announceDeathBeforeSheriff: boolean; // 默认 false（先竞选警长再报死讯）

	// ===== C. 夜晚 =====
	stepTimeoutSec: number; // 默认 30，0 = 不限时
	timeoutBehavior: 'SKIP' | 'PAUSE'; // 默认 'SKIP'

	// ===== D. 角色细则 =====
	wolf: {
		allowEmptyKill: boolean; // 默认 true（允许空刀）
		decisionRule: 'MAJORITY_ELSE_EMPTY' | 'HOST_DECIDES'; // 默认 'HOST_DECIDES'（房主代点）
		allowSelfExplode: boolean; // 默认 true
		selfExplodeEndsDay: boolean; // 默认 true
		selfExplodeHasLastWords: boolean; // 默认 false
		wolfKingExplodeCanShoot: boolean; // 默认 true
	};
	seer: {
		canCheckSelf: boolean; // 默认 false
		allowRecheck: boolean; // 默认 true
		resultGranularity: 'GOOD_BAD' | 'EXACT_ROLE'; // 默认 'GOOD_BAD'
	};
	witch: {
		knowsVictimOnFirstNight: boolean; // 默认 true
		knowsVictimEveryNight: boolean; // 默认 true
		selfRescue: 'FIRST_NIGHT_ONLY' | 'NEVER' | 'ALWAYS'; // 默认 'FIRST_NIGHT_ONLY'
		bothPotionsSameNight: boolean; // 默认 false
		canPoisonSelf: boolean; // 默认 false
		mustOpenEyesWhenEmpty: boolean; // 默认 true（防脚步声推理）
	};
	guard: {
		canGuardSameTargetConsecutively: boolean; // 默认 false
		canGuardSelf: boolean; // 默认 true
		sameGuardSameSave: 'TARGET_DIES' | 'TARGET_LIVES'; // 默认 'TARGET_DIES'
		protectsAgainstPoison: boolean; // 默认 false
	};
	hunter: {
		canShootWhenPoisoned: boolean; // 默认 false
		canShootWhenExiled: boolean; // 默认 true
		canShootWhenWolfKilled: boolean; // 默认 true
		canShootWhenLoverSuicide: boolean; // 默认 false
	};
	idiot: {
		revealOnExile: boolean; // 默认 true
		keepsSpeechRight: boolean; // 默认 true
		losesVoteRight: boolean; // 默认 true
		canRunForSheriffAfterReveal: boolean; // 默认 false
		tearsBadgeIfSheriff: boolean; // 默认 true
		diesNormallyAtNight: boolean; // 默认 true
	};
	knight: {
		duelEndsDayIfWolf: boolean; // 默认 true
		knightDiesIfGood: boolean; // 默认 true
		onceOnly: boolean; // 默认 true
	};
	cupid: {
		canLinkSelf: boolean; // 默认 true
		loversSeeEachOtherRole: boolean; // 默认 true（互相可见身份牌面）
		suicideTriggersHunter: boolean; // 默认 false
	};
	thief: {
		mustTakeWolfIfBothWolf: boolean; // 默认 true
	};
	wildChild: {
		wolvesSeeConvertedChild: boolean; // 默认 true（变狼后狼队夜晚可见）
		childSeesWolvesAfterConvert: boolean; // 默认 true
	};
}
```

---

## 7. 游戏状态机

### 7.1 Phase 枚举

```typescript
type Phase =
	| 'LOBBY' // 大厅，等待玩家加入 / 配置板子
	| 'DEALING' // 发牌中，等待所有人确认已查看身份
	| 'FIRST_NIGHT' // 首夜（含盗贼/丘比特/野孩子等一次性环节）
	| 'NIGHT' // 常规夜晚
	| 'DAWN' // 天亮，结算 + 公布死讯
	| 'SHERIFF_ELECTION' // 警长竞选（仅第1天）
	| 'LAST_WORDS' // 遗言（可能多人排队）
	| 'HUNTER_SHOOT' // 猎人开枪（阻塞式，等待指定目标）
	| 'DISCUSSION' // 自由发言 / 计时
	| 'VOTE' // 投票
	| 'VOTE_PK' // 平票 PK 二次投票
	| 'EXILE' // 公布放逐结果
	| 'GAME_OVER'; // 结束
```

### 7.2 状态流转图

```
LOBBY
  └─(房主开始游戏, 校验通过)→ DEALING
DEALING
  └─(全员确认已看身份 或 房主强制跳过)→ FIRST_NIGHT

FIRST_NIGHT ──(所有首夜环节完成)→ DAWN
NIGHT       ──(所有夜晚环节完成)→ DAWN

DAWN
  ├─(第1天 且 sheriffEnabled)→ SHERIFF_ELECTION
  └─(其他)→ [死讯公布] → 有遗言? LAST_WORDS : 检查猎人

SHERIFF_ELECTION
  └─(警长产生或流局)→ [死讯公布] → LAST_WORDS / DISCUSSION

LAST_WORDS
  └─(遗言队列清空)→ 死者中有猎人且可开枪? HUNTER_SHOOT : DISCUSSION

HUNTER_SHOOT
  └─(开枪或放弃, 递归结算新死亡)→ 新死者遗言? LAST_WORDS : DISCUSSION

DISCUSSION
  ├─(狼人自爆)→ NIGHT           ※跳过投票
  ├─(骑士决斗且翻出狼)→ NIGHT   ※跳过投票
  └─(发言结束/房主推进)→ VOTE

VOTE
  ├─(唯一最高票)→ EXILE
  ├─(平票 且 tieBreak=PK)→ VOTE_PK
  └─(平票 且 tieBreak=NO_EXILE / 全员弃票)→ NIGHT

VOTE_PK
  ├─(唯一最高票)→ EXILE
  └─(再次平票)→ NIGHT   ※无人出局

EXILE
  └─→ 白痴翻牌? [不死, 继续] : [死亡结算] → LAST_WORDS / HUNTER_SHOOT → NIGHT

任意阶段结算后 → checkWinCondition() 命中 → GAME_OVER
```

### 7.3 状态机实现要求（MUST）

- 每次 phase 变更 **MUST** 先调用 `checkWinCondition(state)`，命中则直接跳 `GAME_OVER`，不再执行后续逻辑。
- `HUNTER_SHOOT` 与 `LAST_WORDS` 是**阻塞阶段**，必须记录 `returnPhase`，处理完回到原定流程。
- 死亡结算可能级联（情侣殉情 → 猎人开枪 → 又死一人 → 又触发殉情），**MUST** 用队列循环处理直到稳定，并设最大迭代次数 20 防死循环。

---

## 8. 夜晚流程（核心）

### 8.1 夜晚环节顺序表（MUST 严格按此顺序，跳过未启用/已死亡的角色）

#### 首夜（FIRST_NIGHT）

| #   | 环节 Key            | 播报                               | 房主操作        | 备注               |
| --- | ------------------- | ---------------------------------- | --------------- | ------------------ |
| 00  | `NIGHT_START`       | "天黑请闭眼"                       | 点击继续        | —                  |
| 10  | `THIEF_CHOOSE`      | "盗贼请睁眼，选择你的身份"         | 从2张底牌选1    | 双狼牌强制选狼     |
| 12  | `CUPID_LINK`        | "丘比特请睁眼，请连接一对情侣"     | 选2人           | 可含自己           |
| 13  | `LOVERS_CONFIRM`    | "玩家们请睁眼，确认是否被连为情侣" | 点击继续（10s） | 见 8.3             |
| 14  | `WILD_CHILD_IDOL`   | "野孩子请睁眼，选择你的榜样"       | 选1人           | 不可选自己         |
| 15  | `WOLF_RECOGNIZE`    | "狼人请睁眼，互相确认身份"         | 点击继续        | 房主端高亮狼队座位 |
| 20  | `GUARD_PROTECT`     | "守卫请睁眼，选择守护对象"         | 选1人或空守     | —                  |
| 25  | `WOLF_KILL`         | "狼人请睁眼，请选择今晚要杀的人"   | 选1人或空刀     | —                  |
| 27  | `WOLF_BEAUTY_CHARM` | "狼美人请睁眼，选择魅惑对象"       | 选1人           | —                  |
| 28  | `NIGHTMARE_FEAR`    | "恶灵骑士请睁眼，选择恐惧对象"     | 选1人           | —                  |
| 30  | `WITCH_ACT`         | "女巫请睁眼"                       | 见 8.4          | —                  |
| 40  | `SEER_CHECK`        | "预言家请睁眼，请查验"             | 选1人           | 结果给手势 + 推送  |
| 45  | `DREAM_WEAVER`      | "摄梦人请睁眼"                     | 选1人           | —                  |
| 50  | `HUNTER_STATUS`     | "猎人请睁眼，确认你的开枪状态"     | 点击继续        | 见 8.5             |
| 99  | `NIGHT_END`         | "天亮了"                           | 自动            | 进入 DAWN          |

#### 常规夜晚（NIGHT）

去掉 `10 / 12 / 13 / 14 / 15`，其余相同。`WOLF_RECOGNIZE` 仅在野孩子变狼当晚重新触发一次（让狼队认识新队友）。

### 8.2 环节通用交互（房主端）

每个环节的房主端 UI **MUST** 包含：

1. **播报条**：大字显示当前播报语，一个「🔊 播放」按钮（TTS 或预录音频），支持重播。
2. **座位选择盘**：圆形/网格排布的座位按钮。
   - 已死亡座位：灰色 + 禁用
   - 不合法目标（如守卫连守、预言家验自己）：禁用 + 长按显示原因
   - 已选中：高亮
3. **上下文提示区**：仅显示当前环节房主需要知道的信息（例：狼人环节显示"狼队：3号、7号、11号"）。
4. **操作按钮**：`确认` / `跳过此环节（该角色空过）` / `该角色已死亡，跳过`
5. **倒计时**：`stepTimeoutSec` 秒，读秒到 0 按 `timeoutBehavior` 处理。倒计时 **MUST** 可暂停（线下常有争议要停下来）。
6. **撤销**：在同一夜晚内，房主 MAY 撤销上一步操作（`judge:undoLastStep`），但**天亮后不可撤销**，只能用强制改判。

### 8.3 情侣确认环节（LOVERS_CONFIRM）详细设计

这是保密性要求最高的环节，**MUST** 按以下流程：

```
1. 房主端播报："丘比特请闭眼。玩家们请睁眼，确认是否被连为情侣。"
2. 服务端向两位情侣的手机推送 `lovers:reveal` 事件。
3. 情侣玩家手机：
   - 屏幕从"天黑请闭眼"遮罩切换为「💗 你的情侣是 N号 · 昵称」
   - 若 loversSeeEachOtherRole = true，额外显示对方角色牌面
   - 若情侣跨阵营，追加醒目提示：
     「⚠️ 你们分属不同阵营，现在你与情侣（及丘比特）组成独立的第三方阵营。
       胜利条件：场上仅剩你们存活。」
   - 底部倒计时 10 秒 + 「我已确认」按钮
4. 非情侣玩家手机：屏幕内容完全不变，保持通用遮罩（禁止任何"当前环节：情侣确认"的字样）。
5. 10 秒后或双方都点确认 → 自动盖回遮罩，进入下一环节。
6. 此后全局：情侣双方的「我的身份」页永久增加一行"情侣：N号"。
```

> **反推理要求（MUST）**：整晚所有玩家端的遮罩画面必须**完全静止且相同**，不显示任何环节名、进度条、剩余环节数、动画节拍。唯一例外是轮到自己接收私密信息时（情侣确认、预言家验人结果）。

### 8.4 女巫环节（WITCH_ACT）详细流程

```
Step 1 —— 是否告知今晚死者
  if (isFirstNight && witch.knowsVictimOnFirstNight) || witch.knowsVictimEveryNight:
      房主端显示："今晚死的是 N号"（若空刀则显示"今晚无人被刀"）
      房主给女巫手势 / 同时推送到女巫手机
  else:
      不显示

Step 2 —— 解药
  可用条件（全部满足）:
    - antidoteUsed == false
    - 今晚有狼刀目标 (wolfKillTarget != null)
    - 若目标是女巫本人:
        selfRescue == 'ALWAYS'  → 可用
        selfRescue == 'FIRST_NIGHT_ONLY' && isFirstNight → 可用
        selfRescue == 'NEVER'   → 不可用（按钮禁用，长按提示"本局女巫不可自救"）
  房主端：[使用解药救 N号] / [不使用]

Step 3 —— 毒药
  可用条件:
    - poisonUsed == false
    - !(bothPotionsSameNight == false && 本晚已用解药)   ← 关键互斥
    - 目标 != 女巫自己（若 canPoisonSelf == false）
  房主端：座位盘选人 [使用毒药] / [不使用]

Step 4 —— 空瓶伪装
  if 两瓶药都已用完 && witch.mustOpenEyesWhenEmpty:
      仍然播报"女巫请睁眼"，房主端显示"女巫无药可用"，走完正常时长后播报"女巫请闭眼"
      ※ 目的：防止其他玩家通过环节时长/是否播报推断女巫状态
```

**UI 强制要求**：当 `bothPotionsSameNight == false` 且女巫本晚已使用解药时，毒药按钮 **MUST** 变灰并显示"本局规则：同一晚不可双药"。**禁止**允许点击后再报错。

### 8.5 猎人状态环节（HUNTER_STATUS）

- 播报"猎人请睁眼"，房主端与猎人手机显示当前是否可开枪：`✅ 可以开枪` / `❌ 无法开枪`。
- 判定：`canShoot = !isPoisonedTonight`。因为毒药在环节 30 已确定，此时可算出。
- **反推理处理（MUST）**：无论能否开枪都要播报此环节且时长一致。猎人只在自己手机上看到状态，房主用手势（拇指向上/向下）同步。
- 若板子无猎人，此环节 **MUST 仍然播报**（假环节），时长与真实环节一致。同理，`GUARD_PROTECT`、`SEER_CHECK` 等 P0 环节在角色不存在时也走假环节。这条对线下防推理至关重要。

### 8.6 夜晚意图收集数据结构

```typescript
interface NightActions {
	guardTarget?: Seat; // 守卫守护
	wolfKillTarget?: Seat | null; // null = 空刀
	wolfBeautyCharmTarget?: Seat;
	nightmareFearTarget?: Seat;
	witchAntidoteTarget?: Seat; // 只能等于 wolfKillTarget
	witchPoisonTarget?: Seat;
	seerCheckTarget?: Seat;
	dreamWeaverTarget?: Seat;
	// 首夜专属
	cupidLinks?: [Seat, Seat];
	wildChildIdol?: Seat;
	thiefPick?: RoleId;
}
```

---

## 9. 白天流程

### 9.1 天亮结算与公布（DAWN）

```
1. 调用 resolveNight(state, nightActions) → deaths[]
2. 公布规则（MUST）:
   - 只公布"死亡座位号"，不公布死因、不公布身份、不公布死亡顺序
   - 播报文案："天亮了。昨晚，{N号、M号} 倒牌。" 或 "天亮了。昨晚是个平安夜。"
   - 多人死亡时按座位号升序公布，禁止暗示因果
3. 若 announceDeathBeforeSheriff == false 且为第1天：先进 SHERIFF_ELECTION，选完再执行第2步
```

### 9.2 警长竞选（SHERIFF_ELECTION，仅第 1 天）

```
Step 1  上警：所有存活玩家在自己手机上选择 [上警] / [不上警]，30s 倒计时
        —— 白痴已翻牌者不可上警（canRunForSheriffAfterReveal）
Step 2  警上发言：候选人依次发言，房主端计时（默认 90s/人），房主手动推进
Step 3  退水：发言完毕，候选人可选择 [退水]（退出竞选）
Step 4  警下投票：非候选人投票选出警长
        —— 候选人不可投票
        —— 允许弃票
Step 5  结果：
        - 唯一最高票 → 当选，服务端设置 sheriffSeat
        - 平票 → 平票者进行 PK 发言，重新投票（仅一轮）
        - 再平票 或 全员退水 或 无人上警 → 流局，本局无警长（警徽沉水）
```

**警长权限（MUST）**：

- 投票权重 `sheriffVoteWeight`（默认 1.5），计票时按浮点累加，展示时保留 1 位小数
- 决定发言顺序：当选后房主端出现 `[从警长左边开始] / [从警长右边开始]` 二选一
- 死亡时（任何原因）触发警徽流：房主端弹出 `[移交给 N号] / [撕毁警徽]`
  - 若 `sheriffBadgeOnDeath == 'AUTO_TEAR'` 则直接撕毁
  - 白痴翻牌且 `tearsBadgeIfSheriff == true` → 立即撕毁
  - 警徽撕毁后本局不再产生警长

### 9.3 发言（DISCUSSION）

- 房主端：显示发言顺序队列（按警长指定方向从死者下一位或警长本人开始），当前发言者高亮 + 计时器（默认 120s，可配）。
- 房主可 `[下一位]` / `[暂停]` / `[跳过]`。
- 玩家端：显示当前轮到谁发言 + 剩余时间。
- 此阶段房主端 **MUST** 常驻两个按钮：`[有玩家自爆]`（选择自爆者）、`[骑士决斗]`（若板子含骑士且骑士存活）。

### 9.4 投票（VOTE）

```
1. 房主点击 [开始投票]
2. 所有有投票权的存活玩家手机弹出投票盘（座位按钮 + [弃票]）
   —— 无投票权：已翻牌白痴（losesVoteRight）、被恶灵骑士恐惧者
   —— 不可投给自己
   —— 警长若 sheriffMustVote == true 则无 [弃票] 按钮
3. 倒计时 30s（可配）。超时未投视为弃票。
4. 房主端实时显示"已投 X/Y 人"，但 **MUST NOT** 显示票型直到全部投完
5. 全部投完 → 同时揭晓票型：按座位号列出「A → B」，并显示得票统计
6. 降级模式：房主可切换 [手动录入票型]，用于有人手机没电
```

**计票**：

```typescript
score[target] += voter === sheriffSeat ? ruleConfig.sheriffVoteWeight : 1;
```

**平票处理**（`tieBreak = 'PK_THEN_NO_EXILE'`）：

- 平票者进入 `VOTE_PK`，依次发言（默认 60s/人），其余人重新投票
- **平票者本人不可投票**
- 再次平票 → 本轮无人出局，直接进夜

### 9.5 放逐（EXILE）

```
1. 播报"{N号} 被放逐出局"
2. if 该玩家是白痴 && idiot.revealOnExile:
       → 翻牌，全场公开其身份为白痴
       → 不死亡，标记 isRevealedIdiot = true, hasVoteRight = false
       → 若是警长则按规则撕警徽
       → **不进入死亡结算**，直接进夜（当天已投过票，不再重投）
   else:
       → 死亡，cause = 'VOTE_OUT'，进入死亡结算管线
3. 遗言：if lastWords.exiledPlayer → LAST_WORDS
4. 猎人：if 死者是猎人 && canShootWhenExiled → HUNTER_SHOOT
```

### 9.6 特殊白天事件

**狼人自爆**：

```
房主点 [有玩家自爆] → 选择自爆者（必须是狼阵营，服务端校验）
→ 该玩家死亡，cause = 'SELF_EXPLODE'
→ if selfExplodeHasLastWords → 遗言
→ if 是白狼王 && wolfKingExplodeCanShoot → 弹出开枪目标选择（可放弃）
→ if selfExplodeEndsDay → 立即结束白天，跳过投票，进入 NIGHT
```

**骑士决斗**：

```
房主点 [骑士决斗] → 选择被决斗者
→ 服务端翻开被决斗者身份
→ if 是狼阵营:
     被决斗者死亡（cause = 'KNIGHT_DUEL'），全场公开其身份
     if duelEndsDayIfWolf → 立即进夜，跳过投票
  else:
     骑士死亡（cause = 'KNIGHT_DUEL_FAIL'），公开骑士身份
     白天继续，进入投票
→ 骑士技能标记为已使用（onceOnly）
```

---

## 10. 死亡结算引擎（最核心的算法）

### 10.1 死亡原因枚举

```typescript
type DeathCause =
	| 'WOLF_KILL' // 狼刀
	| 'WITCH_POISON' // 女巫毒
	| 'VOTE_OUT' // 白天放逐
	| 'HUNTER_SHOT' // 猎人开枪
	| 'WOLF_KING_SHOT' // 白狼王自爆带走
	| 'LOVER_SUICIDE' // 情侣殉情
	| 'WOLF_BEAUTY_LINK' // 狼美人魅惑链接死亡
	| 'SELF_EXPLODE' // 自爆
	| 'KNIGHT_DUEL' // 决斗被翻出的狼
	| 'KNIGHT_DUEL_FAIL' // 决斗失败的骑士
	| 'DREAM_WEAVER' // 连摄两夜
	| 'HOST_OVERRIDE'; // 房主强制改判
```

### 10.2 夜晚结算算法（MUST 按此顺序）

```typescript
function resolveNight(state: GameState, a: NightActions): Death[] {
	const pending: Death[] = [];

	// ---- 第1步：狼刀是否成立 ----
	if (a.wolfKillTarget != null) {
		const t = a.wolfKillTarget;
		const guarded = a.guardTarget === t;
		const antidoted = a.witchAntidoteTarget === t;
		const dreamProtected = a.dreamWeaverTarget === t; // 摄梦人当夜免疫狼刀

		let survives: boolean;
		if (guarded && antidoted) {
			// 同守同救
			survives = cfg.guard.sameGuardSameSave === 'TARGET_LIVES';
		} else if (guarded || antidoted || dreamProtected) {
			survives = true;
		} else {
			survives = false;
		}
		if (!survives) pending.push({ seat: t, cause: 'WOLF_KILL' });
	}

	// ---- 第2步：女巫毒 ----
	// 毒药无视守卫与解药（protectsAgainstPoison 默认 false）
	if (a.witchPoisonTarget != null) {
		const t = a.witchPoisonTarget;
		const immune = cfg.guard.protectsAgainstPoison && a.guardTarget === t;
		if (!immune) {
			// 若该人已在 pending 中（狼刀+毒同一人），覆盖死因为 POISON
			// 理由：毒的效果更强（禁止猎人开枪），从严判定
			upsertDeath(pending, { seat: t, cause: 'WITCH_POISON' });
		}
	}

	// ---- 第3步：摄梦人连摄致死 ----
	if (a.dreamWeaverTarget != null && state.lastDreamTarget === a.dreamWeaverTarget) {
		upsertDeath(pending, { seat: a.dreamWeaverTarget, cause: 'DREAM_WEAVER' });
	}

	// ---- 第4步：级联结算 ----
	return cascadeDeaths(state, pending);
}
```

### 10.3 级联结算（所有死亡都要走这里）

```typescript
function cascadeDeaths(state: GameState, initial: Death[]): Death[] {
	const resolved: Death[] = [];
	const queue = [...initial];
	let guard = 0;

	while (queue.length > 0) {
		if (++guard > 20) throw new Error('CASCADE_LOOP');
		const d = queue.shift()!;
		if (state.players[d.seat].isDead) continue; // 已死，去重
		if (isProtectedFrom(state, d)) continue;

		markDead(state, d.seat, d.cause);
		resolved.push(d);

		// --- 触发器按固定优先级 ---

		// T1 情侣殉情
		const partner = getLoverPartner(state, d.seat);
		if (partner != null && !state.players[partner].isDead) {
			queue.push({ seat: partner, cause: 'LOVER_SUICIDE' });
		}

		// T2 狼美人链接
		if (state.players[d.seat].role === 'WOLF_BEAUTY' && state.charmedSeat != null) {
			queue.push({ seat: state.charmedSeat, cause: 'WOLF_BEAUTY_LINK' });
		}

		// T3 野孩子榜样死亡 → 变狼（非死亡，改阵营）
		if (state.wildChildIdol === d.seat && state.wildChildSeat != null) {
			convertWildChildToWolf(state);
		}

		// T4 警徽流
		if (state.sheriffSeat === d.seat) {
			enqueueBadgeTransfer(state, d.seat); // 阻塞式，由房主端处理
		}

		// T5 猎人 / 白狼王开枪 —— 阻塞式，不在此处解决
		if (canTriggerShoot(state, d)) {
			state.pendingShoots.push(d.seat); // 状态机切到 HUNTER_SHOOT
		}
	}
	return resolved;
}
```

### 10.4 猎人开枪资格判定（MUST 精确实现）

```typescript
function canTriggerShoot(state, d: Death): boolean {
	const role = state.players[d.seat].role;
	if (role === 'HUNTER') {
		switch (d.cause) {
			case 'WOLF_KILL':
				return cfg.hunter.canShootWhenWolfKilled; // 默认 true
			case 'VOTE_OUT':
				return cfg.hunter.canShootWhenExiled; // 默认 true
			case 'WITCH_POISON':
				return cfg.hunter.canShootWhenPoisoned; // 默认 false ★
			case 'LOVER_SUICIDE':
				return cfg.hunter.canShootWhenLoverSuicide; // 默认 false
			case 'WOLF_BEAUTY_LINK':
				return false;
			case 'HUNTER_SHOT':
			case 'WOLF_KING_SHOT':
				return true; // 被枪打死仍可反击（连环枪）
			case 'KNIGHT_DUEL_FAIL':
				return false;
			case 'HOST_OVERRIDE':
				return false; // 由房主另行决定
			default:
				return false;
		}
	}
	if (role === 'WOLF_KING' && d.cause === 'SELF_EXPLODE') {
		return cfg.wolf.wolfKingExplodeCanShoot;
	}
	if (role === 'WOLF_KING' && (d.cause === 'VOTE_OUT' || d.cause === 'WOLF_KILL')) {
		return true; // 白狼王被投出/被刀（罕见，被自己人刀）也可开枪
	}
	return false;
}
```

**开枪的时机（MUST）**：

- **夜晚死亡的猎人**：在天亮公布死讯后开枪（若有遗言则先遗言）。**不在夜里开枪**。
- **白天死亡的猎人**：立即开枪。
- 开枪目标可以是任意存活玩家，**不可**弃权？→ 本文档规定 **可以放弃开枪**（房主端有 `[放弃开枪]` 按钮）。
- 被枪打死的人若也是猎人，触发连环开枪（由 `cascadeDeaths` + `pendingShoots` 队列自然支持）。

### 10.5 房主强制改判（HOST_OVERRIDE）

房主端 **MUST** 提供"上帝之手"面板（藏在二级菜单，需二次确认）：

- `[强制某玩家死亡]`（cause = `HOST_OVERRIDE`，不触发任何被动技能）
- `[强制某玩家复活]`
- `[强制修改某人身份]`（用于发牌出错）
- `[回滚到上一阶段]`
- 所有改判 **MUST** 写入操作日志并在房主端顶部显示"⚠️ 本局已人工干预 N 次"

---

## 11. 胜负判定

### 11.1 阵营归属计算（MUST 动态计算，不用静态字段）

```typescript
function getCamp(state: GameState, seat: Seat): Camp {
	const p = state.players[seat];

	// 1. 情侣第三方优先级最高
	if (state.lovers && state.lovers.includes(seat)) {
		if (isCrossCampLovers(state)) return 'LOVERS';
	}
	// 2. 丘比特：连成跨阵营情侣时加入情侣阵营 ★本局确认规则
	if (p.role === 'CUPID' && cfg.cupidJoinsLoversCamp && isCrossCampLovers(state)) {
		return 'LOVERS';
	}
	// 3. 野孩子变狼
	if (p.role === 'WILD_CHILD' && p.convertedToWolf) return 'WEREWOLF';
	// 4. 盗贼取牌后的实际身份
	return ROLE_META[p.role].camp;
}

function isCrossCampLovers(state): boolean {
	if (!state.lovers) return false;
	const [a, b] = state.lovers;
	return baseCamp(state, a) !== baseCamp(state, b); // 用未受情侣影响的原始阵营比较
}
```

> **注意**：`baseCamp` 必须用**原始阵营**比较（野孩子变狼后算狼），避免循环依赖。

### 11.2 胜负判定函数（每次结算后必调）

```typescript
function checkWinCondition(state: GameState): Camp | null {
	const alive = getAlivePlayers(state);
	const loversCamp = alive.filter((p) => getCamp(state, p.seat) === 'LOVERS');
	const wolves = alive.filter((p) => getCamp(state, p.seat) === 'WEREWOLF');
	const goods = alive.filter((p) => getCamp(state, p.seat) === 'GOOD');

	// --- 优先级 1：情侣阵营 ---
	// 存活者全部属于情侣阵营 → 情侣胜（含丘比特）
	if (loversCamp.length > 0 && loversCamp.length === alive.length) {
		return 'LOVERS';
	}
	// 若情侣阵营成员全灭，游戏继续按原阵营判定（不判负）

	// --- 优先级 2：好人胜 ---
	if (wolves.length === 0) return 'GOOD';

	// --- 优先级 3：狼人胜 ---
	if (cfg.winCondition === 'SIDE_KILL') {
		const aliveGods = goods.filter((p) => ROLE_META[p.role].isGod);
		const aliveVillagers = goods.filter((p) => !ROLE_META[p.role].isGod);
		// 屠边：神全死 或 民全死
		const hadGods = state.setup.godCount > 0;
		const hadVillagers = state.setup.villagerCount > 0;
		if ((hadGods && aliveGods.length === 0) || (hadVillagers && aliveVillagers.length === 0)) {
			return 'WEREWOLF';
		}
	} else {
		if (goods.length === 0) return 'WEREWOLF';
	}

	// --- 优先级 4：狼人数 >= 好人数（无法翻盘）---
	if (cfg.winCondition === 'TOTAL_KILL' && wolves.length >= goods.length) {
		return 'WEREWOLF';
	}

	return null; // 继续游戏
}
```

### 11.3 关键判定说明（MUST 在代码注释中保留）

| 情形                                      | 结果                                                  |
| ----------------------------------------- | ----------------------------------------------------- |
| 跨阵营情侣 + 丘比特，场上只剩这 3 人      | LOVERS 胜                                             |
| 跨阵营情侣，丘比特已死，场上只剩情侣 2 人 | LOVERS 胜，丘比特计为胜利方（`cupidWinsIfDead=true`） |
| 跨阵营情侣，其中狼人一方死亡 → 另一方殉情 | 情侣阵营全灭，游戏继续，按剩余的狼/好人判定           |
| 同阵营情侣（双狼或双好人）                | 不形成第三方，丘比特留在好人阵营，正常判定            |
| 白痴翻牌后存活                            | 仍算好人存活，且算作"神职"（影响屠边判定）            |
| 已翻牌白痴是场上最后一个神                | 神未全灭，狼人不因此获胜                              |
| 平安夜连续 N 次                           | 无特殊规则，正常继续                                  |

### 11.4 结算画面（GAME_OVER）

**MUST** 显示：

- 获胜阵营大字 + 动效
- 全场身份表（座位号 / 昵称 / 角色 / 阵营 / 存活状态 / 死亡原因 / 死亡时间点）
- 情侣连线、警长标记
- 逐夜复盘时间轴（第1夜狼刀谁、女巫做了什么、白天投票票型……）
- `[再来一局（保留玩家与板子）]` / `[返回大厅]` / `[导出复盘为图片]`（SHOULD）

---

## 12. 数据模型

### 12.1 TypeScript 核心类型

```typescript
type Seat = number; // 1..N
type Camp = 'GOOD' | 'WEREWOLF' | 'LOVERS';

interface Player {
	seat: Seat;
	userId: string; // 匿名 UUID，存 localStorage，用于重连
	nickname: string;
	avatarIdx: number;
	isHost: boolean;
	connected: boolean;
	lastSeenAt: number;

	// --- 游戏中字段，MUST NOT 下发给其他玩家 ---
	role: RoleId;
	convertedToWolf: boolean; // 野孩子
	thiefExtraCards?: RoleId[]; // 盗贼底牌，仅盗贼可见

	// --- 公开字段 ---
	isDead: boolean;
	deathCause?: DeathCause;
	deathRound?: number; // 第几天/夜死的
	isRevealedIdiot: boolean;
	revealedRole?: RoleId; // 白痴翻牌/骑士决斗公开的身份
	hasVoteRight: boolean;
	hasViewedIdentity: boolean; // 埋点，房主可见
}

interface GameState {
	roomCode: string;
	phase: Phase;
	round: number; // 第几轮，从 1 开始
	isFirstNight: boolean;
	ruleConfig: RuleConfig;
	setup: Setup;
	players: Record<Seat, Player>;

	// 夜晚
	currentStepKey: string | null;
	stepDeadline: number | null; // epoch ms
	nightActions: NightActions;
	lastGuardTarget: Seat | null; // 用于连守校验
	lastDreamTarget: Seat | null;
	charmedSeat: Seat | null; // 狼美人魅惑
	fearedSeat: Seat | null; // 恶灵骑士恐惧（次日生效）

	// 身份关联
	lovers: [Seat, Seat] | null;
	cupidSeat: Seat | null;
	wildChildSeat: Seat | null;
	wildChildIdol: Seat | null;

	// 白天
	sheriffSeat: Seat | null;
	badgeTorn: boolean;
	speechOrder: Seat[];
	currentSpeaker: Seat | null;
	votes: Record<Seat, Seat | 'ABSTAIN'>;
	pkCandidates: Seat[];

	// 阻塞队列
	pendingShoots: Seat[];
	pendingLastWords: Seat[];
	pendingBadgeTransfer: Seat | null;
	returnPhase: Phase | null;

	// 记录
	witchAntidoteUsed: boolean;
	witchPoisonUsed: boolean;
	knightUsed: boolean;
	hostOverrideCount: number;
	timeline: TimelineEvent[]; // 复盘用
	winner: Camp | null;
}
```

### 12.2 玩家视图（PlayerView）—— 保密层核心

**MUST** 在 `viewFilter.ts` 中实现，是唯一允许构造下发数据的地方。

```typescript
function buildPlayerView(state: GameState, viewerSeat: Seat): PlayerView {
	const viewer = state.players[viewerSeat];
	const isDead = viewer.isDead;
	const spectatorMode = isDead && state.ruleConfig.deadSeeAllRoles; // 默认 true

	return {
		phase: state.phase,
		round: state.round,
		// 座位列表：只含公开字段
		seats: Object.values(state.players).map((p) => ({
			seat: p.seat,
			nickname: p.nickname,
			avatarIdx: p.avatarIdx,
			connected: p.connected,
			isDead: p.isDead,
			isRevealedIdiot: p.isRevealedIdiot,
			revealedRole: p.revealedRole ?? null,
			isSheriff: state.sheriffSeat === p.seat,
			// ★ role 字段的下发条件
			role:
				p.seat === viewerSeat
					? p.role // 自己
					: spectatorMode
						? p.role // 观战态
						: state.phase === 'GAME_OVER'
							? p.role // 游戏结束
							: isVisibleTeammate(state, viewerSeat, p.seat)
								? p.role // 狼队互认 / 情侣
								: (p.revealedRole ?? null) // 其余一律 null
		})),
		myPrivateInfo: buildPrivateInfo(state, viewerSeat), // 验人结果、情侣、药剂状态…
		// ★ 夜晚：非行动者拿到的 currentStepKey 一律为 null
		currentStepKey: null, // 玩家端永远不知道当前是哪个环节
		// 公开信息
		publicLog: state.timeline.filter((e) => e.visibility === 'PUBLIC'),
		voteState: buildVoteView(state, viewerSeat)
	};
}
```

**审计断言（MUST 写成运行时断言 + 单元测试）**：

```
assert(JSON.stringify(playerView).indexOf(otherPlayerSecretRole) === -1)
```

在 dev 环境每次下发前执行一次全量扫描，发现泄漏立即抛错。

### 12.3 Redis 键设计

| Key                   | 类型          | TTL | 内容                                                   |
| --------------------- | ------------- | --- | ------------------------------------------------------ |
| `room:{code}`         | Hash          | 6h  | 房间元信息：hostUserId, createdAt, status, playerCount |
| `room:{code}:state`   | String (JSON) | 6h  | 序列化的 `GameState`                                   |
| `room:{code}:actions` | List          | 6h  | append-only 动作日志（重放/复盘）                      |
| `room:{code}:seats`   | Hash          | 6h  | `userId -> seat` 映射                                  |
| `session:{userId}`    | Hash          | 24h | `roomCode`, `seat`, `nickname`，用于断线重连           |
| `code:index`          | Set           | —   | 已占用房号，防冲突                                     |
| `socket.io#*`         | —             | —   | Socket.IO Redis Adapter（多实例必需）                  |

**并发控制（MUST）**：所有对 `room:{code}:state` 的写操作 **MUST** 通过 Redis 分布式锁（`SET key val NX PX 3000`）或 Lua 脚本保证原子性。房主快速连点、多人同时投票都会触发竞态。

**房号生成**：4 位大写字母+数字（去掉易混淆的 0/O/1/I/L），冲突则重试，最多 5 次。

---

## 13. Socket.IO 事件契约

### 13.1 客户端 → 服务端

| 事件                                     | 权限       | Payload                                | 说明                         |
| ---------------------------------------- | ---------- | -------------------------------------- | ---------------------------- |
| `room:create`                            | 任意       | `{ nickname, avatarIdx }`              | 返回房号，创建者成为房主     |
| `room:join`                              | 任意       | `{ code, nickname, avatarIdx }`        | 加入房间                     |
| `room:reconnect`                         | 任意       | `{ userId, code }`                     | 断线重连                     |
| `room:leave`                             | 玩家       | `{}`                                   | 离开（游戏中禁止，只能观战） |
| `room:kick`                              | 房主       | `{ seat }`                             | 踢人（仅 LOBBY）             |
| `room:updateSetup`                       | 房主       | `{ setup, ruleConfig }`                | 修改板子/规则                |
| `game:start`                             | 房主       | `{}`                                   | 校验后发牌                   |
| `identity:viewed`                        | 玩家       | `{}`                                   | 标记已查看身份（埋点）       |
| `game:confirmReady`                      | 玩家       | `{}`                                   | 确认已看牌，进入首夜         |
| `judge:nightAction`                      | 房主       | `{ stepKey, targets: Seat[], extra? }` | 夜晚代点                     |
| `judge:skipStep`                         | 房主       | `{ stepKey }`                          | 跳过环节                     |
| `judge:undoLastStep`                     | 房主       | `{}`                                   | 撤销（仅当夜有效）           |
| `judge:nextPhase`                        | 房主       | `{}`                                   | 推进阶段                     |
| `judge:pauseTimer` / `judge:resumeTimer` | 房主       | `{}`                                   | 暂停/恢复计时                |
| `judge:override`                         | 房主       | `{ type, seat, value? }`               | 上帝之手                     |
| `judge:selfExplode`                      | 房主       | `{ seat }`                             | 记录自爆                     |
| `judge:knightDuel`                       | 房主       | `{ targetSeat }`                       | 骑士决斗                     |
| `judge:hunterShoot`                      | 房主       | `{ shooterSeat, targetSeat \| null }`  | 开枪/放弃                    |
| `judge:badgeTransfer`                    | 房主       | `{ toSeat \| 'TEAR' }`                 | 警徽流                       |
| `judge:manualVote`                       | 房主       | `{ votes }`                            | 降级：手动录票               |
| `sheriff:run`                            | 玩家       | `{ join: boolean }`                    | 上警/不上警                  |
| `sheriff:withdraw`                       | 玩家       | `{}`                                   | 退水                         |
| `sheriff:vote`                           | 玩家       | `{ target \| 'ABSTAIN' }`              | 警下投票                     |
| `sheriff:setOrder`                       | 玩家(警长) | `{ direction: 'LEFT'\|'RIGHT' }`       | 定发言顺序                   |
| `vote:cast`                              | 玩家       | `{ target \| 'ABSTAIN' }`              | 白天投票                     |

### 13.2 服务端 → 客户端

| 事件             | 目标       | Payload                                                      | 说明                                                 |
| ---------------- | ---------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| `state:sync`     | 单播       | `PlayerView`                                                 | **唯一的状态下发通道**，每次变更全量推送该玩家的视图 |
| `judge:sync`     | 房主单播   | `JudgeView`                                                  | 房主专属视图（当前环节、可选目标、上下文提示）       |
| `identity:deal`  | 单播       | `{ role, camp, description }`                                | 发牌，仅发给本人                                     |
| `lovers:reveal`  | 情侣单播   | `{ partnerSeat, partnerRole?, isCrossCamp }`                 | 情侣确认                                             |
| `seer:result`    | 预言家单播 | `{ targetSeat, isWerewolf }`                                 | 验人结果                                             |
| `witch:info`     | 女巫单播   | `{ victimSeat \| null, antidoteAvailable, poisonAvailable }` | 女巫信息                                             |
| `hunter:status`  | 猎人单播   | `{ canShoot: boolean }`                                      | 开枪状态                                             |
| `wolf:teammates` | 狼队单播   | `{ seats: Seat[] }`                                          | 狼队互认                                             |
| `announce`       | 广播       | `{ type, text, seats? }`                                     | 公开播报（天亮死讯、放逐结果…）                      |
| `voice:play`     | 房主单播   | `{ audioKey, text }`                                         | 触发 TTS/音频播放                                    |
| `timer:tick`     | 广播       | `{ deadline }`                                               | 计时同步（用 deadline 而非剩余秒数，避免漂移）       |
| `vote:result`    | 广播       | `{ votes, tally, exiled }`                                   | 票型揭晓                                             |
| `game:over`      | 广播       | `{ winner, allRoles, timeline }`                             | 结算                                                 |
| `error`          | 单播       | `{ code, message }`                                          | 错误                                                 |

### 13.3 事件处理硬性要求（MUST）

1. **每个 `judge:*` 事件必须校验 `socket.userId === room.hostUserId`**，失败返回 `E_NOT_HOST`。
2. **每个玩家事件必须校验座位归属**（不能替别人投票）。
3. **幂等性**：所有事件带 `requestId`，服务端去重，防止网络重发导致重复投票/重复开枪。
4. **禁止在任何广播事件中携带未死亡玩家的 `role` 字段**，包括 `error` 的 message 里。
5. 计时同步 **MUST** 传 `deadline` 绝对时间戳，客户端自行算剩余秒数。

---

## 14. 页面清单与 UI 流程

### 14.1 页面列表

| 路由                      | 页面     | 说明                                   |
| ------------------------- | -------- | -------------------------------------- |
| `/`                       | 首页     | 创建房间 / 输入房号加入 / 昵称头像设置 |
| `/room/[code]`            | 房间     | 单页应用，内部按 phase 切换视图        |
| `/room/[code]?view=judge` | 房主面板 | 房主专属，权限校验失败跳回             |
| `/rules`                  | 规则说明 | 静态页，各角色技能说明                 |
| `/replay/[id]`            | 复盘     | SHOULD，v1.1                           |

### 14.2 玩家端视图矩阵

| Phase                   | 玩家端主视图                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| LOBBY                   | 玩家列表 + 板子预览 + "等待房主开始"                              |
| DEALING                 | **身份卡（长按揭开）** + `[我已确认]`                             |
| FIRST_NIGHT / NIGHT     | **全屏静止遮罩**「🌙 天黑请闭眼」（唯一例外：轮到自己收私密信息） |
| DAWN                    | 死讯公布动画 + 座位盘（死者置灰）                                 |
| SHERIFF_ELECTION        | 上警/退水/投票交互                                                |
| LAST_WORDS / DISCUSSION | 当前发言者 + 计时器                                               |
| VOTE / VOTE_PK          | 投票盘                                                            |
| EXILE                   | 结果公布                                                          |
| GAME_OVER               | 全场身份表 + 复盘                                                 |

### 14.3 身份卡交互设计（重点，MUST 严格实现）

**位置规则**：

- 身份卡 **MUST NOT** 常驻在任何主界面上。
- 入口为屏幕右下角一个固定的小按钮「🎭 我的身份」，点击后从底部弹出抽屉。

**揭开机制（MUST）**：

```
┌─────────────────────────────┐
│                             │
│      ┌───────────────┐      │
│      │               │      │
│      │   🎴 卡背图案  │      │   ← 默认状态：完全盖住
│      │               │      │
│      │  按住查看身份  │      │
│      └───────────────┘      │
│                             │
│   ⚠️ 注意遮挡屏幕，防止偷看   │
└─────────────────────────────┘
```

- **交互方式：长按（`pointerdown` 揭开 / `pointerup`、`pointercancel`、`pointerleave`、`visibilitychange` 立刻盖回）**
- **MUST NOT** 使用点击切换（tap toggle），防止误留在屏幕上被邻座看到
- 揭开动画：卡片 3D 翻转 300ms；盖回动画 **MUST 立即完成（<100ms）**，不做缓动
- 手指必须持续接触；离开屏幕、切后台、锁屏 → 立即盖回
- 揭开时屏幕四周加深色暗角，提示"用手遮挡"
- 第一次揭开后触发 `identity:viewed` 埋点

**身份卡内容**：

```
┌───────────────────────┐
│   预言家   🔮          │
│   阵营：好人           │
│ ───────────────────── │
│ 技能：每晚可以查验一名  │
│ 玩家的身份，得知其是好  │
│ 人还是狼人。           │
│ ───────────────────── │
│ 本局规则提示：         │
│ · 不可查验自己         │
│ · 可以重复查验同一人    │
│ ───────────────────── │
│ 💗 情侣：7号 小明      │  ← 仅情侣可见
│ 🐺 狼队友：3、7、11号   │  ← 仅狼人可见
└───────────────────────┘
```

**夜晚私密信息推送（MUST）**：

- 预言家收到验人结果时，**不弹通知、不震动、不发声**（会暴露），只在身份抽屉内新增一条记录：`第1夜 验 5号 → 🐺 狼人`
- 房主端同时显示结果供其打手势
- 验人历史 **MUST** 累积保存，全局可查

### 14.4 房主端（Judge Console）布局

```
┌──────────────────────────────────────┐
│ 第 2 夜  ·  环节 3/7          ⏸ 暂停  │  ← 顶栏
├──────────────────────────────────────┤
│  🔊 "狼人请睁眼，请选择今晚要杀的人"  │  ← 播报条（大字）
│     [▶ 播放]  [🔁 重播]      ⏱ 00:23 │
├──────────────────────────────────────┤
│  上下文：狼队 3号、7号、11号（存活）  │  ← 上下文提示
├──────────────────────────────────────┤
│         ①  ②  ③  ④                  │
│      ⑫              ⑤                │  ← 圆形座位盘
│      ⑪              ⑥                │     死亡置灰，非法目标禁用
│         ⑩  ⑨  ⑧  ⑦                  │
├──────────────────────────────────────┤
│  [空刀]  [撤销]  [确认并继续 →]       │
├──────────────────────────────────────┤
│  ⚙️ 上帝之手   📋 日志   ⚠️ 干预 0次  │
└──────────────────────────────────────┘
```

**房主端 MUST 具备**：

- 屏幕常亮（Wake Lock API），夜晚流程期间不熄屏
- 音量提示：进入游戏前检查并提示"请把音量调大，外放播报"
- 误触保护：`[确认并继续]` 在倒计时最后 3 秒内需二次点击
- 一屏内完成一个环节，**MUST NOT** 需要滚动

### 14.5 语音播报（MUST）

- 实现方式：优先使用**预录 mp3**（音质稳定、无网络依赖），fallback 到 Web Speech API `speechSynthesis`（zh-CN）
- 音频文件 **MUST** 预加载并缓存（Service Worker），避免夜里卡顿
- 每段播报前后各留 0.5s 静音，防止吞字
- **MUST 提供"假环节"音频**：即使板子里没有该角色，也播报同样的词（见 8.5）
- 房主可调节播报语速与音量

### 14.6 播报文案表（MUST 内置，可编辑）

| Key               | 文案                                       |
| ----------------- | ------------------------------------------ |
| `night.start`     | 天黑请闭眼。                               |
| `thief.open`      | 盗贼请睁眼，请选择你的身份牌。             |
| `thief.close`     | 盗贼请闭眼。                               |
| `cupid.open`      | 丘比特请睁眼，请连接一对情侣。             |
| `cupid.close`     | 丘比特请闭眼。                             |
| `lovers.open`     | 玩家们请睁眼，确认是否被连为情侣。         |
| `lovers.close`    | 情侣请闭眼。                               |
| `wildchild.open`  | 野孩子请睁眼，请选择你的榜样。             |
| `wildchild.close` | 野孩子请闭眼。                             |
| `wolf.recognize`  | 狼人请睁眼，互相确认身份。                 |
| `guard.open`      | 守卫请睁眼，请选择你要守护的人。           |
| `guard.close`     | 守卫请闭眼。                               |
| `wolf.open`       | 狼人请睁眼，请选择今晚要杀的人。           |
| `wolf.close`      | 狼人请闭眼。                               |
| `witch.open`      | 女巫请睁眼。今晚死的是他，你要使用解药吗？ |
| `witch.poison`    | 你要使用毒药吗？                           |
| `witch.close`     | 女巫请闭眼。                               |
| `seer.open`       | 预言家请睁眼，请选择你要查验的人。         |
| `seer.close`      | 预言家请闭眼。                             |
| `hunter.open`     | 猎人请睁眼，请确认你的开枪状态。           |
| `hunter.close`    | 猎人请闭眼。                               |
| `day.start`       | 天亮了。                                   |
| `day.peaceful`    | 昨晚是个平安夜。                           |
| `day.death`       | 昨晚，{seats} 倒牌。                       |
| `sheriff.start`   | 现在开始警长竞选，请要上警的玩家举手。     |
| `vote.start`      | 现在开始投票。                             |
| `exile.result`    | {seat} 被放逐出局。                        |

---

## 15. 保密与安全要求（MUST，逐条验收）

| #   | 要求                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------- |
| S1  | 客户端**永远**收不到其他存活玩家的 `role` 字段。用 Chrome DevTools 监听 WebSocket 全程流量，不得出现任何他人身份 |
| S2  | 身份只在服务端内存/Redis 中，客户端 localStorage **MUST NOT** 存储 role                                          |
| S3  | 玩家端 `currentStepKey` 恒为 `null`，玩家无法从状态推断当前夜晚环节                                              |
| S4  | 夜晚遮罩画面对所有非行动玩家**像素级一致**，无进度条、无环节名、无剩余时间、无呼吸动画差异                       |
| S5  | 假环节：缺失角色仍播报，时长一致                                                                                 |
| S6  | 私密信息推送**无声、无震动、无系统通知**                                                                         |
| S7  | 身份卡长按才显示，松手立即盖回，切后台立即盖回                                                                   |
| S8  | 房主权限校验在服务端，前端隐藏按钮不算数                                                                         |
| S9  | 观战玩家（已出局）**MUST NOT** 能向存活玩家发送任何信息；若有聊天功能则观战区与存活区物理隔离                    |
| S10 | 房号仅 4 位，**MUST** 加入"房间锁定"功能：游戏开始后拒绝新加入                                                   |
| S11 | 投票期间票型不实时公开，全部投完才揭晓                                                                           |
| S12 | 所有服务端错误信息 **MUST NOT** 泄露身份（如不能返回"你不能验狼队友"）                                           |
| S13 | 截屏无法拦截，但 **SHOULD** 在身份卡上叠加半透明的座位号水印，便于事后追责                                       |

---

## 16. 边界情况与冲突裁定清单（MUST 全部实现并写测试）

| #   | 情形                                           | 裁定                                                                                                              |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| B01 | 守卫守 A + 女巫救 A（同守同救）                | `sameGuardSameSave` 决定，默认 **A 死亡**，死因 `WOLF_KILL`                                                       |
| B02 | 守卫守 A + 女巫毒 A                            | **A 死亡**（守卫不防毒），死因 `WITCH_POISON`                                                                     |
| B03 | 狼刀 A + 女巫毒 A                              | A 死亡，死因记为 `WITCH_POISON`（从严，猎人不可开枪）                                                             |
| B04 | 女巫救 A + 女巫毒 A                            | 非法，UI 禁止；服务端二次校验拒绝                                                                                 |
| B05 | 女巫首夜被刀且规则允许自救                     | 可自救；第二夜起不可（默认配置）                                                                                  |
| B06 | 女巫同晚想用双药                               | 默认禁止，毒药按钮变灰                                                                                            |
| B07 | 守卫连续两晚守同一人                           | 默认禁止，该座位按钮禁用并提示"昨晚已守护"                                                                        |
| B08 | 守卫昨晚守 A，A 昨晚死了，今晚想守 A           | A 已死，不可选（`canTargetDead=false`）                                                                           |
| B09 | 守卫昨晚空守，今晚可守任意人（含昨晚守的人？） | 空守不记录 `lastGuardTarget`，今晚可守任意存活者                                                                  |
| B10 | 狼人空刀                                       | 允许（默认），当晚无狼刀死亡，女巫解药无对象                                                                      |
| B11 | 狼人刀自己人                                   | 允许，服务端不阻止（战术行为）                                                                                    |
| B12 | 猎人被毒死                                     | 不可开枪；猎人手机显示 ❌，房主给手势                                                                             |
| B13 | 猎人被狼刀死，同时被守卫守住                   | 未死，不触发开枪                                                                                                  |
| B14 | 猎人开枪打死另一个猎人                         | 触发连环枪                                                                                                        |
| B15 | 猎人开枪打死情侣一方                           | 另一方殉情，殉情不触发其猎人技能（默认）                                                                          |
| B16 | 白痴被投出局                                   | 翻牌不死，失去投票权，保留发言权；**当天不再重投**                                                                |
| B17 | 白痴被狼刀 / 被毒                              | 正常死亡                                                                                                          |
| B18 | 白痴是警长且翻牌                               | 立即撕警徽，本局无警长                                                                                            |
| B19 | 已翻牌白痴再次被投票                           | 仍不死（技能无使用次数限制），但 **SHOULD** 在房主端提示                                                          |
| B20 | 情侣一狼一好人                                 | 三方阵营：情侣 2 人 + 丘比特（`cupidJoinsLoversCamp=true`）                                                       |
| B21 | 丘比特把自己连进去                             | 允许；此时情侣阵营只有 2 人                                                                                       |
| B22 | 跨阵营情侣中的狼人被狼队自己刀死               | 另一方殉情，情侣阵营全灭，游戏按剩余阵营继续                                                                      |
| B23 | 情侣同为好人                                   | 不形成第三方，丘比特留好人阵营，殉情仍生效                                                                        |
| B24 | 场上只剩跨阵营情侣 2 人 + 丘比特               | LOVERS 胜                                                                                                         |
| B25 | 场上只剩跨阵营情侣 2 人，丘比特已死            | LOVERS 胜，丘比特计入胜方                                                                                         |
| B26 | 白狼王自爆带走一个情侣                         | 另一方殉情；若殉情者是最后一个神，狼人可能立即获胜                                                                |
| B27 | 白狼王被女巫毒死                               | 不可开枪（与猎人同规则）                                                                                          |
| B28 | 狼美人被投出局                                 | 魅惑对象殉情，`WOLF_BEAUTY_LINK` 不触发猎人技能                                                                   |
| B29 | 骑士决斗翻出狼                                 | 狼死，当天不投票直接进夜                                                                                          |
| B30 | 骑士决斗翻出好人                               | 骑士死，白天继续正常投票                                                                                          |
| B31 | 骑士决斗对象是跨阵营情侣中的狼                 | 狼死 → 另一方殉情 → 立即进夜                                                                                      |
| B32 | 野孩子的榜样是狼                               | 榜样死后野孩子仍变狼（榜样阵营不影响）                                                                            |
| B33 | 野孩子变狼后，狼队夜晚能否看到他               | 默认能（`wolvesSeeConvertedChild=true`），下一夜触发一次 `WOLF_RECOGNIZE`                                         |
| B34 | 野孩子变狼后，屠边计数                         | 从好人计数移到狼人计数，立即重新判定胜负                                                                          |
| B35 | 盗贼抽到两张狼牌                               | 强制选狼（`mustTakeWolfIfBothWolf`）                                                                              |
| B36 | 全员弃票                                       | 无人出局，直接进夜                                                                                                |
| B37 | 平票 → PK → 再平票                             | 无人出局，直接进夜                                                                                                |
| B38 | 警长在 PK 中投票                               | 权重仍为 1.5；若警长本人是 PK 对象则不可投票                                                                      |
| B39 | 警长在夜里死亡                                 | 天亮公布死讯后处理警徽流（遗言前还是遗言后？→ **遗言中一并交代，房主在遗言结束后操作**）                          |
| B40 | 警长自爆                                       | 立即撕警徽（自爆无遗言，无法移交），除非规则允许自爆遗言                                                          |
| B41 | 首夜死者的遗言                                 | 默认有；第二夜起夜里死亡无遗言                                                                                    |
| B42 | 首夜死两人（狼刀+毒）                          | 两人都有遗言，按座位号升序依次发言                                                                                |
| B43 | 玩家断线                                       | 保留座位，房主端显示 🔌 断线标记；房主可代其投票；30s 内重连恢复全部私密信息                                      |
| B44 | 房主断线                                       | 游戏暂停，其他人看到"等待房主重连"；超过 3 分钟 **SHOULD** 允许转移房主权（需多数玩家同意）                       |
| B45 | 房主误点                                       | 同一夜内可 `judge:undoLastStep` 撤销；天亮后只能用上帝之手                                                        |
| B46 | 发牌错误（有人拿错牌）                         | 上帝之手 → 强制修改身份，重新推送 `identity:deal`                                                                 |
| B47 | 开局即满足胜利条件（配置错误）                 | `validateSetup` 应已拦截；若仍发生则直接 GAME_OVER 并提示配置问题                                                 |
| B48 | 死亡玩家能看到全场身份吗                       | 默认能（`deadSeeAllRoles=true`），但 **MUST** 强提示"请勿以任何方式暗示存活玩家"                                  |
| B49 | 恶灵骑士恐惧了预言家                           | 预言家次日无法验人（当夜环节直接跳过）且无法投票                                                                  |
| B50 | 同一目标被多个来源致死                         | `upsertDeath` 去重，死因取"限制最强"的那个（优先级：`WITCH_POISON` > `LOVER_SUICIDE` > `WOLF_KILL` > `VOTE_OUT`） |

---

## 17. 冲突裁定原则（遇到本文档未覆盖的情况时）

按以下优先级决策，并在代码中标注 `// SPEC-GAP:`：

1. **保密优先**：任何两难情况下，选择泄露信息更少的方案。
2. **从严判定**：死亡/技能限制存在争议时，选择更严格的（如 B03 取毒药死因）。
3. **可撤销优先**：宁可让房主多点一次确认，也不要产生不可逆的错误状态。
4. **与线下体验一致**：以"如果是真人法官会怎么做"为准。
5. **可配置化**：如果两种做法都常见，实现为 `RuleConfig` 开关，默认取更主流的那个。

---

## 18. 验收测试用例（MUST 全部通过）

### 18.1 单元测试（GameEngine 纯函数）

```
UT-01  同守同救 → 目标死亡（默认配置）
UT-02  同守同救 + TARGET_LIVES → 目标存活
UT-03  守卫守住的人被毒 → 死亡，cause=WITCH_POISON
UT-04  女巫首夜自救成功；第二夜自救按钮不可用
UT-05  女巫同晚用解药后毒药不可用
UT-06  守卫连守同一人被拒绝（返回 E_GUARD_CONSECUTIVE）
UT-07  狼刀+毒同一人 → cause=WITCH_POISON，猎人不可开枪
UT-08  猎人被投出局 → 可开枪；被毒 → 不可开枪
UT-09  猎人开枪打死猎人 → 连环开枪
UT-10  白痴被投 → 不死、失投票权、保留发言权
UT-11  白痴翻牌后仍算存活的神（屠边不成立）
UT-12  跨阵营情侣 + 丘比特 = LOVERS 阵营（3人）
UT-13  场上仅剩情侣2人+丘比特 → LOVERS 胜
UT-14  场上仅剩情侣2人、丘比特已死 → LOVERS 胜且丘比特计入胜方
UT-15  同阵营情侣不形成第三方，丘比特仍为 GOOD
UT-16  情侣一方死亡 → 另一方殉情，且殉情不触发猎人枪
UT-17  屠边：所有神死亡 → 狼胜（民还活着）
UT-18  屠边：所有民死亡 → 狼胜（神还活着）
UT-19  所有狼死亡 → 好人胜
UT-20  狼美人死亡 → 魅惑对象殉情
UT-21  白狼王自爆带走一人 → 立即进夜
UT-22  骑士决斗翻出狼 → 狼死+进夜；翻出好人 → 骑士死+继续
UT-23  野孩子榜样死亡 → 变狼 → 重新计算胜负
UT-24  盗贼双狼牌 → 强制选狼
UT-25  警长票权 1.5：3票 vs 2票+警长 → 后者胜（3 vs 3.5）
UT-26  平票 → PK → 再平票 → 无人出局
UT-27  级联死亡 20 次以上 → 抛 CASCADE_LOOP（防死循环）
UT-28  validateSetup 各错误码 E01–E10 全覆盖
```

### 18.2 集成/端到端测试

```
IT-01  12人守卫场完整跑通一局（脚本化操作，断言最终胜负正确）
IT-02  玩家 A 的 WebSocket 流量中不出现玩家 B 的 role（全程录制断言）
IT-03  夜晚所有非行动玩家的 PlayerView JSON 完全相同（除 seat 字段）
IT-04  身份卡长按揭开、松手盖回、切后台盖回（Playwright 模拟）
IT-05  断线重连恢复：预言家断线 → 重连后验人历史完整
IT-06  房主快速连点确认 → 不产生重复动作（幂等性）
IT-07  两人同时投票 → Redis 锁保证票数正确
IT-08  房主断线 3 分钟 → 转移房主流程
```

### 18.3 保密性人工验收（线下实测）

```
MT-01  找一位玩家全程观察邻座手机，不得推断出任何人身份
MT-02  故意在夜里偷瞄其他人手机屏幕 → 全部是相同的遮罩
MT-03  统计每个环节耗时 → 有角色与无角色（假环节）时长无显著差异
MT-04  女巫两瓶药用完后，环节仍正常播报，其他玩家无法察觉
```

---

## 19. 开发里程碑

| 阶段                       | 内容                                                                      | 交付标准                                         |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| **M1 骨架**                | SvelteKit + Socket.IO + Redis 打通；创建/加入房间；大厅玩家列表；断线重连 | 6 台手机能同时进同一个房间并看到彼此             |
| **M2 发牌与保密层**        | 板子配置 + 校验 + 发牌 + `viewFilter` + 身份卡长按交互                    | IT-02、IT-04 通过                                |
| **M3 夜晚引擎（P0 角色）** | 状态机 + 夜晚环节 + 房主面板 + 语音播报 + 结算引擎                        | 平民/狼/预/女/猎/守/白痴 跑通，UT-01～UT-11 通过 |
| **M4 白天流程**            | 天亮公布 + 警长竞选 + 发言计时 + 投票 + 放逐 + 遗言 + 开枪                | 12人守卫场完整一局（IT-01）                      |
| **M5 P1 角色**             | 丘比特/情侣/白狼王/狼美人/骑士                                            | UT-12～UT-22 通过                                |
| **M6 打磨**                | 上帝之手、撤销、复盘时间轴、结算画面、音效、动效、PWA 离线                | MT-01～MT-04 线下实测通过                        |
| **M7（可选）P2 角色**      | 盗贼/野孩子/摄梦人/恶灵骑士                                               | UT-23、UT-24 通过                                |

---

## 附录 A：给 AI 编码助手的执行提示

1. **先写 `GameEngine` 的类型与纯函数，再写网络层**。类型定义在 `src/lib/game/types.ts`，引擎在 `src/lib/game/engine.ts`，两者不 import 任何 Svelte/Socket.IO 代码。
2. **`ROLE_META` 表驱动一切**。看到 `if (role === 'WITCH')` 这样的分支散落在多个文件，说明设计错了。
3. **`viewFilter.ts` 是安全边界**，只有它能构造下发对象。在该文件顶部写明"修改此文件需要 review"。
4. **每实现一个规则开关，同步写一条单元测试**，测试文件与第 18 章的编号对应。
5. **UI 先做房主端**，房主端能跑通全流程后再做玩家端（玩家端逻辑简单得多）。
6. **不要为了"更好玩"擅自增加规则**（如自动提示、AI 建议、推理辅助）。这类功能会破坏线下游戏体验，且未在需求内。
7. 遇到本文档没写清楚的地方，**按第 17 章原则决策并加 `// SPEC-GAP:` 注释**，不要静默发挥。
