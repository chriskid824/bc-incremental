# 架構文件

> 狀態：草稿 v0.5（2026-10-21）。v0.2（2026-10-12）依 Hoshi 第一輪審查修改；v0.3 把 §4.3、§4.4 換成 v3 引擎 C3 步驟的傷害引擎，§12、§14 加上模擬的行為與效能檢查；v0.4 加上 C5 的無人機與砲台（§4.6）；v0.5 加上 C4 的引擎（§4.7），改寫 §4.3 的 tick 順序與 §12 的效能閘門。

## 1. 技術選型

| 項目 | 選擇 | 備註 |
| --- | --- | --- |
| 語言 | TypeScript（`strict` ＋ `noUncheckedIndexedAccess`） | |
| 打包 | Vite | 網頁版與 Electron renderer 共用 |
| 渲染 | PixiJS v8 | 幾何圖形、粒子、BitmapText 傷害數字 |
| 選單／HUD | DOM 疊在 canvas 上，先不用框架 | 文字清晰、i18n 容易；UI 變複雜再評估 Preact |
| 資料驗證 | zod | 載入時與測試時驗證資料檔與存檔 |
| 測試 | Vitest | 模擬核心、資料驗證、存檔遷移 |
| 程式風格 | ESLint（flat config）＋ Prettier | |
| CLI 執行 | tsx ＋ Node `worker_threads` | 平衡模擬器平行跑 |
| Steam 版 | Electron ＋ steamworks.js | M2 技術驗證 |
| 套件管理 | npm | 單一 package，不用 monorepo |

全部免費、不需要伺服器。唯一雲端服務是 Firebase 免費方案（Spark，沒有綁信用卡，額度用完只會寫入失敗，不會被收費）。

## 2. 目錄結構

```
src/
  core/        Num、數字格式化、seeded RNG、內容摘要、數學工具（純 TS）
  data/        天賦、敵人、波次、昇華的資料檔與 zod schema（純 TS）
    web/       v3 天賦網的內容型別、zod schema、節點 ID 文法、範圍、組網、時鐘佈局、內容驗證、快照與測試 fixture，和 M1 天賦網分開
    fusion/    v3 的融合產生器、覆寫、校準紀錄與係數範圍
    characters/  v3 的四個角色，一個角色一個檔
    outer/     v3 的外盤，一塊外盤一個檔
  sim/         一局的模擬：狀態、系統、固定 timestep（純 TS）
  meta/        局外進度：資源、天賦配點、轉生、昇華（純 TS）
    web/       v3 天賦網的角色進度、價格、購買規則、路徑、外盤揭露與角色局的 build、結算
  save/        存檔序列化、版本遷移（純 TS）
  platform/    平台介面與各平台實作（web、steam、portal）
  render/      PixiJS：實體外觀、粒子、傷害數字、鏡頭、展示模式
  ui/          DOM：主選單、結算、天賦網外框、設定、HUD
  i18n/        en.json、zh-TW.json、型別化的 key
  app/         啟動、場景切換、遊戲主迴圈、平台注入
tools/
  balance/     平衡模擬器 CLI 與 build 策略
  content/     v3 內容的工具：天賦網快照（`npm run snapshots`）
  talent-viewer/  開發用天賦網檢視器（Vite dev 頁面）
electron/      main process、preload、steamworks 橋接
tests/         跨模組測試、存檔 fixture
```

**純度邊界**：`core`、`data`、`sim`、`meta`、`save` 用獨立的 `tsconfig.sim.json` 編譯，`lib` 不含 DOM，所以碰到 `window`、`document` 會直接型別錯誤。ESLint 再加 `no-restricted-imports`（禁止 import `pixi.js`、`src/render`、`src/ui`、`src/platform`、`src/app` 與 Node 內建模組，資料夾本身與裡面的檔案都擋）、`no-restricted-properties`（禁止 `Math.random`、`Date.now`、`performance.now`）與 `no-restricted-syntax`（禁止動態 `import()`、讀取現在時間的 `new Date()`）。`tsc` 有 `skipLibCheck`，擋不住 `pixi.js` 這類套件，所以 `tests/purity-lint.test.ts` 用探針原始碼確認這些規則一直有效。

## 3. 資料流

```mermaid
flowchart LR
  D[data/*.ts<br/>zod 驗證] --> M[meta<br/>天賦配點、資源、轉生]
  M -->|StatBlock + RuleSpec + 起始波次 + seed| S[sim<br/>一局模擬]
  I[InputFrame<br/>滑鼠或機器人] --> S
  S -->|SimEvents| R[render<br/>PixiJS]
  S -->|RunResult| M
  M --> SV[save] --> P[platform.storage]
  S -->|摘要| A[platform.analytics]
  S -.headless.-> B[tools/balance<br/>CSV]
```

- `meta` 把天賦網與昇華編譯成一個 `StatBlock`（屬性的最終值，加上帶標籤、範圍或條件的修正、觸發與轉換，§4.4）和一組 `RuleSpec`（keystone 規則與參數），連同起始波次交給 `sim` 開一局。v3 的角色局另外帶 `RunConfig.character`（`CharacterRun`：角色 ID 與帶來源、係數的規則 `SourcedRule`，§4.8），這時 `RunConfig.rules` 是空的、招牌攻擊是那個角色的；M1 的局不帶。v3 這一側在 `src/meta/web`：`webBuild` 依 `web.nodes` 的順序收集擁有的節點（招牌攻擊節點除外），沒有縮放的修正把階數併成一筆（`flat`、`increased` 乘上階數，`more` 是 (1 + 值)^階數 − 1），有縮放的照階數重複；觸發與轉換照階數重複、發射器只算一次，融合盤的觸發與規則帶那條融合的係數，規則每條只放一次、不照階數重複。`webRunConfig` 把它包成 `RunConfig`，`webStartWave` 讀這輪轉生的最遠波次（`cycleBest`），一局結束走 `settleWebRun`（同一個 `settleRun`，另外更新歷來最遠波次 `bestWave`）。跳波補償由 `meta` 在結算時依期望掉落計算，`sim` 只回報有沒有清掉起始波次。
- v3 的購買規則也在 `src/meta/web`：`canBuy` 依十二列的順序回傳第一個不通過的理由（`BUY_REASONS`），`buy` 把價格從錢包移到 `spent`。要碎片的節點各走三條成長曲線之一（`PRICE_CURVE_OF`；★ 只收核心、昇華節點只收迴響），買幾次的總價是封閉式，和購買順序無關，所以 `refundNode`、`refundPreview` 與 `legalize` 退回的都是兩個封閉式的差（最多退到 `spent`），`refundAll` 整筆退回 `spent`。外盤揭露（`revealedOuters`）由歷來最遠波次算出來，不另外存。角色與帳號的進度（`CharacterProgress`、`AccountProgress`）是不可變的值，C8 之前只放在記憶體，不動存檔格式。
- `sim` 每個 tick 產出 `SimEvents`（擊中、暴擊、點燃、連鎖、死亡、掉落）。`render` 只讀狀態和事件，不改狀態。
- 一局結束時 `sim` 回傳 `RunResult`（最遠波次、各類與各來源的傷害統計、掉落、計數器），`meta` 結算資源後存檔。
- 平衡模擬器直接呼叫 `meta` 與 `sim`，不載入 `render`、`ui`、`platform`。

## 4. 模擬核心

### 4.1 固定 timestep

- 固定 60 tick／秒（`dt = 1/60`）。瀏覽器用累加器迴圈，畫面以兩個 tick 之間插值。
- 遊戲加速（2x）就是每個畫面多跑幾個 tick，不改 `dt`。
- headless 時不等待，直接連續跑 tick。

### 4.2 可決定性

- 保證範圍：**同一個 build、同一個 seed、同一串 `InputFrame`，結果一致**。不保證跨版本或跨 JS 引擎，所以不做重播檔。
- RNG：自寫的 sfc32（約 20 行），每個子系統一條獨立的 stream（`spawn`、`split`、`combat`、`drops`、`trigger`、`effects`），由主 seed 衍生。改掉落邏輯不會讓生怪順序跟著變，調數值時比較曲線才有意義。觸發的機率在派發時從 `trigger` 擲，效果造成的擊中從 `effects` 擲，所以加一個觸發不會改變 `combat` 的序列。分裂子怪的位置走 `split`：分裂的次數與時機取決於戰鬥，如果共用 `spawn`，改傷害就會讓後面每一波的生怪跟著變。
- 實體用遞增整數 ID；只迭代陣列與 `Map`（插入順序固定），不依賴物件 key 的列舉順序。

### 4.3 狀態與系統

- 不用 ECS 框架。實體是物件陣列＋物件池（避免 GC 抖動）。附近目標查詢走均勻空間格（`src/sim/grid.ts`，`docs/v3/implementation-plan-v3.md` §2.3）：格子 128，場地 15 × 9 格外多一圈，更遠的夾到最外圈；每 tick 敵人移動後重建（計數排序寫進 typed array，實際排序延到當 tick 第一次查詢，沒有查詢的 tick 不花成本；敵人少於 128 隻時不排序，查詢直接線性掃描，實測比較快）。投射物選目標、連鎖、瘟疫擴散都查格子，結果和原本的線性掃描完全一樣：同距離取陣列裡較前面（ID 較小）的；同一 tick 後來才加入的敵人（分裂子怪）每次查詢另外線性掃；死掉的留在格子裡、查詢時跳過。`push` 效果推動了敵人時當場再重建一次（`src/sim/effects/execute.ts`），同一 tick 之後的查詢就在新的格子找到它們；排序一樣延到下一次查詢，所以推動之後只有第一個查詢排序，後面的查詢共用那次排序；沒有推動任何敵人的 `push` 不重建。這刻意和 impl §2.15 的「同一 tick 裡被熱浪推開的敵人，下一 tick 才更新格子」不同（C4 設計 D27）：格子的每個查詢都要和線性掃描的結果相同，而從 rebuild 之後的第一個查詢到下一次 rebuild，來源裡的實體不能移動（`src/sim/grid.ts` 開頭的約定）；等到下一 tick 才更新，推動之後的查詢就會在舊的格子找被推過的敵人。重建是延後的，推動之後真的有查詢才多花一次排序。
- 每個 tick 依序跑系統，每個系統一個檔案（`src/sim/systems/`，2026-10 從 `simulation.ts` 拆出，行為不變；順序在 `simulation.ts` 的 `step()`）：`input → spawn（含 waveStart 觸發）→ movement（冰冷減速、凍結、流血的移動計數、地面區域的減速）→ grid（重建空間格）→ contact（荊棘、heroHit、contact 觸發）→ emitters（招牌攻擊與授予的攻擊，之後是規則模組的 tick hook）→ drones（無人機與砲台，§4.6）→ projectiles（命中、連鎖、熔岩彈落地、擊殺當下結算）→ segments（線段）→ zones（地面區域）→ ailments（持續傷害、ailmentTick 觸發）→ effects（到期的 periodic 觸發，再跑佇列裡的效果）→ death（派發待處理的擊殺觸發、壓縮陣列）→ waveControl → runEnd`。emitters 到 effects 只在角色活著時跑。C4 加的細節：
  - contact：處理的敵人數在進入時固定（荊棘殺死的敵人分裂出的子怪下一 tick 才碰到）。每隻依 ID 先吃每個荊棘發射器的一擊；被荊棘殺死的只派發 contact，活著的才扣生命、漏怪、發 heroHit 與 contact。最後寫這個 tick 的 `playerLifeFrac`（§4.7.8）。
  - emitters：依 `ctx.emitters` 的編譯順序，第 0 個是招牌攻擊（volley、lob、fan 或 arc；蜂巢的 swarm 是 `drone` 種類，在 drones 階段跑），之後是授予的 strike、aura、orbit，依 `compileBuild` 去重後的順序，不依種類分組；`EMITTER_STEPS` 是 `null` 的種類（thorns、segment、drone）由自己的階段跑。招牌攻擊每次計數的攻擊之後，接著跑等它的重複攻擊（§4.7.10）。
  - projectiles：M1 齊射的追蹤投射物與投射物池的子彈依 ID 合併成一個順序：直線子彈的碰撞（含冰錐扇一輪的主要命中與連鎖）、追蹤子彈的抵達、熔岩彈落地（擊中 → 主要命中的連鎖 → `explosion` 事件 → explode → 火地）。最後壓縮投射物池；齊射的投射物照舊到 death 才壓縮。
  - segments 與 zones 在 projectiles 之後、ailments 之前，命中都當下結算。`src/sim/systems/segments.test.ts` 用同一個 tick 的熔岩彈落地、線段判定與區域脈衝確認事件順序是 explosion → 線段的 pulse → 區域的 pulse。
  - 擊殺照舊當下結算（§4.4.8），步驟 2 之後多了 2b（toSplitChildren，§4.7.12）；待處理擊殺帶著 detonate 要的剩餘值（§4.7.11）。
  - 各步驟在傷害引擎裡做什麼見 §4.4 與 §4.7，無人機見 §4.6；之後才做的其他系統（敵人 AI）見 `docs/v3/implementation-plan-v3.md` §2.15。
- 傷害引擎在 `src/sim/` 的子資料夾：`build/`（`compileBuild`、ModTable、來源、條件與縮放、`sizeOf`／`countOf`：攻擊、子彈與區域建立的每個半徑與數量都經過它們讀，現在是恆等，倍率跟 B1 一起做，C4 設計 D29）、`rules/`（招牌攻擊與它們的形態、規則模組）、`emitters/`（發射器：`volley`、`lob`、`fan`、`arc`、`strike`、`aura`、`orbit`、`drone`；酬載與共用型別在 `types.ts`）、`combat/`（命中、線性連鎖 `chain.ts`、一般連鎖 `policy.ts`、轉換）、`ailments/`（燃燒記錄、分桶環、流血、感電、冰冷、剩餘值 `remaining.ts`）、`effects/`（觸發派發、目標選擇器 `select.ts`、效果佇列與執行、中心事件、事件旗標 `flags.ts`）、`systems/`（tick 的各階段，加上 `context.ts` 的 `RunContext`、`systemState.ts` 的 `ctx.sys`、投射物池 `shots.ts`）。直接放在 `src/sim/` 的：`caps.ts`（所有規格上限，§4.7.1）、`grid.ts`（空間格）、`targeting.ts`（投射物選目標）、`types.ts`（事件、計數器、`SimState`）、`simulation.ts`、`testing.ts`（測試與工具共用的 fixture）。熱路徑不配置記憶體：每筆傷害最多新增一個 `SimEvent`（區域、線段與光環的擊中每次脈衝合成一個 `pulse` 事件）；分桶環、效果佇列、投射物池、區域池與無人機池是 typed array 物件池，命中、擊殺、中心事件、條件與選擇器的輸入各用一個重複使用的暫存物件。

### 4.4 屬性、修正與傷害引擎

v3 引擎的第一段（`docs/v3/implementation-plan-v3.md` §2.1、§2.5–§2.7，實作步驟 C3）。所有傷害走同一套：屬性與修正（4.4.1）依傷害的標籤（4.4.2）與來源（4.4.4）查 ModTable（4.4.3）；規則模組（4.4.5）在開局時改屬性、加修正與觸發；命中（4.4.6）、異常狀態（4.4.7）、觸發與效果（4.4.8）、轉換（4.4.9）共用同一份 ModTable 與同一套統計。M1 的內容在 C3 的每一步都要讓行為指紋（§12）逐行相同；只有兩個量過的行為修改重新記錄了基準：修掉有上限的燃燒被換掉時重複計算的一段（Hoshi 接受 dot-greedy 到第 20 波的時間 +6.4%），以及無盡烈焰改用分桶環（只動到合成 build）。

#### 4.4.1 修正與 StatBlock

```ts
type Modifier = {
  stat: StatId;                  // 'damage' | 'critChance' | 'chainCount' | ...
  kind: 'flat' | 'increased' | 'more';
  value: number;
  // 下面五個只能用在 SCOPED_STATS
  tags?: DamageTag[];            // 全部都要有（4.4.2）
  notTags?: DamageTag[];         // 一個都不能有
  scope?: SourceSelector;        // 傷害來源（4.4.4）
  when?: TargetCondition[];      // 每筆傷害當下判斷，全部成立才算
  scaling?: ScalingSpec;         // 「每有 X，得到 Y」
};
```

- 最終值 = `(base + Σflat) × (1 + Σincreased) × Π(1 + more)`。
- **scoped stat**（`SCOPED_STATS`）的值隨每筆傷害變：傷害倍率、暴擊率、暴擊倍率、點燃／中毒／流血／感電機率、五個 `*Always`、`frostOnHit`。只有它們的修正可以帶 `tags`、`notTags`、`scope`、`when`、`scaling`；其他屬性（攻速、連鎖數、持續時間…）一局只有一個值。平坦傷害不能帶標籤，留在 `values.damage`。
- `StatBlock = { base, values, scoped, triggers, conversions }`（`src/data/stats.ts`）：`values` 是不帶標籤、範圍與條件的修正合出的最終值（和 M1 一樣）；scoped stat 的所有修正（含不帶標籤的）另外依資料順序放進 `scoped`；`triggers`、`conversions` 也依資料順序收集，各帶節點換算出的來源（`sourceOfNode`）。`meta` 用 `statBlockFor` 產生，測試與工具用 `makeStats`。
- `*Always` 在擲骰**之後**把結果改成成功（例：灼熱暴擊 = `igniteAlways flat 1 [crit]` 加 `damage more −0.5 [hit] notTags [crit]`），所以 RNG 的消耗和改成資料之前一樣。
- 縮放：貢獻 `c = min(cap, value × g(x))`，`g` 是線性、`log10(1 + x)` 或 `x^exponent`，`every` 會先把 x 取整步再套任何一種；flat 與 increased 加上 c，more 乘 `1 + c`。`powFactor` 是倍率，沒有 `1 +`：只能用在 value 1 的 more（`exponent > 0`，`cap` 省略或 ≥ 1），直接乘 `min(cap, max(1, x)^exponent)`。變數：連鎖第幾跳、目標的燃燒／毒／感電層數、目標的冰冷量表、目標和角色的距離、失去的生命比例。
- **能寫成資料的就寫成資料**：M1 的橋接 notable 與灼熱暴擊是修正（帶標籤的機率、`*Always`、縮放、`notTags`），瘟疫是觸發（4.4.8）；只有真的改規則的才寫成規則模組（4.4.5）。

#### 4.4.2 傷害標籤

17 個標籤（`src/data/tags.ts`），M1 的四個 bit 不變：hit 1、crit 2、burn 4、chain 8。

| 組 | 標籤 | 規則 |
| --- | --- | --- |
| 類型 | hit、burn、poison、bleed | 每筆傷害剛好一個 |
| 元素 | cold、lightning | 只跟 hit 一起出現 |
| 修飾 | crit | |
| 擁有者（傳遞） | minion、aura、orbit、zone、strike、thorns、trigger | 誰放的 |
| 幾何（傳遞） | projectile、chain、area | 怎麼送到 |

衍生的傷害這樣組標籤：

- **連鎖跳**（`jumpMask`）：`hit | chain | (主要命中 & (擁有者 | 元素))`，那一跳暴擊時再加 crit。跳躍不帶主要命中的幾何標籤：M1 的主要命中是 `hit|projectile`，跳是 `hit|chain`。
- **異常狀態**（`ailmentMask`）：`種類 | (施加者 & 擁有者) | (暴擊施加 ? crit : 0)`。持續傷害記得「誰放的」，不記得「怎麼送到」，所以連鎖跳點燃的燃燒就是普通的 `burn|crit`，和 M1 一樣。
- **效果造成的擊中**：`hit | trigger | 幾何 | 元素`，所以 `[hit]` 修正（瘟疫的代價、過載）也作用在效果的擊中。唯一的例外是內建的碎裂：`hit|area|cold`，沒有 `trigger`。
- **轉換**（`convertMask`）：轉成持續傷害種類時換掉類型與元素；轉成元素時換掉元素、保留 hit。傳遞標籤與 crit 都留著（4.4.9）。

#### 4.4.3 ModTable：用到才算的修正表

`src/sim/build/modTable.ts`。17 個標籤有 131,072 種組合，再乘上來源，不能像 M1 的 `damageMult` 全部先算。

- 一列（row）的 key 是 `tags | (來源 << 17)`。第一次用到才算，算完快取到這局結束（天賦在局中不變）。一列存每個 scoped stat 的值（structure of arrays）。
- 修正「符合」一列：`tags` 全部在 key 裡、`notTags` 一個都不在、`scope` 選到 key 的來源。
- 固定的累加順序，讓傷害列和 M1 的 `damageMult[mask]`、機率列和 M1 的橋接算式逐位元相同：
  1. `v = base + Σ不帶標籤的 flat`（資料順序），再依資料順序加上符合的帶標籤 flat；
  2. increased：所有符合的依資料順序相加，帶標籤與不帶標籤的交錯；
  3. more：依同樣順序相乘 `(1 + value)`；
  4. 傷害列只存 `(1 + Σinc) × Πmore`（平坦傷害在 `values.damage`，一筆傷害 = `values.damage` × 它的傷害列）；其他屬性 = `v × (1 + inc) × more`，再乘規則模組的 `postScale`、加 `postOffset`（`scaleStat`、`offsetStat`）。傷害列沒有 v，所以這兩個對 `'damage'` 會丟錯，傷害倍率要用 `addModifier`。
- 有 `when` 或 `scaling` 的修正是動態項：列只記下符合的動態項，`statAt`（`src/sim/build/eval.ts`）在每筆傷害當下，於靜態部分之後加上條件成立的項。輸入是重複使用的 `EvalInput { now, target, chainJump, playerLifeFrac }`。估算（天賦網的說明、平衡工具）用沒有目標的輸入，條件一律不成立。
- `compileBuild`（`src/sim/build/compile.ts`）在開局時把 `StatBlock`、`RuleSpec` 與招牌攻擊編成一局要讀的 `CompiledBuild`：最終屬性、ModTable（節點的修正在前、規則加的在後）、來源表、旗標、hook、發射器、觸發、效果與轉換。來源表與列會在局中長大，所以每局都重新編譯；UI 與工具可以自己編一份做估算，但不能拿去開局。
- 命中不查雜湊表：每個酬載（4.4.6）有 10 個列的快取槽（擊中、連鎖跳、三種持續傷害，各分暴擊與否），第一次用到才查。

#### 4.4.4 傷害來源與歸屬

`src/data/sources.ts`、`src/sim/build/sources.ts`。impl §2.1 的「來源和標籤分開存」。

- 來源 ID 以盤為單位：`center`、`hub`、`asc`、`outer.<外盤>`、`fusion.<角色>.<外盤>`。節點 ID 用 `sourceOfNode` 換算，M1 的節點全部算 `center`。每局一張來源表，第 0 個固定是 `center`，最多 64 個（key 裡的 6 bit）。
- 修正的 `scope` 選來源：一個類別（`center|outer|fusion|hub|asc`）或一個確切的 ID。例：融合精通 `more .04 scope 'fusion.<c>.<o>'`、外盤 ★ 的 `scope 'outer.<o>'`。
- 異常狀態的跳傷歸屬（`ailmentCredit`）：① 施加者是融合 → 那條融合；② 種類屬於角色自己的流派 → `center`；③ 其他 → 那個種類的外盤（燃燒 fire、毒 poison、流血 bleed、感電 lightning、冰冷 ice）。M1 沒有角色，所有種類都算 `center`；角色局依角色的流派設定（`ownAilments`，§4.8）。持續傷害讀歸屬後那個來源的列。
- 連鎖跳：酬載的 `jumpSource`（預設是酬載自己的來源）決定第 1 跳起的列與統計；跳躍施加的異常狀態仍以酬載的來源當施加者。角色局裡，非雷角色（熔核、霜晶、蜂巢）的中心酬載的跳躍算 `outer.lightning`（`jumpCredit`，§4.8）。
- 每筆傷害都依來源累計（`RunResult.damageBySource`，用 `num.ts` 的 `add` 加）。中心主體性、鏡像融合與結算的傷害組成都讀它（C10）。

#### 4.4.5 規則模組

`src/sim/rules/`。**keystone 不寫成腳本**：資料檔只能引用程式裡列舉的 `RuleSpec`（型別化參數，zod 擋掉打錯的 ID），每個 id 對應一個模組（`RULE_MODULES`，mapped type 強制每個 id 都有模組）。修正或觸發寫得出來的，就寫成資料（4.4.1）。

- `compileBuild` 每局對每個 id 呼叫一次模組的 `compile`，帶著這個 id 的所有實例（依節點順序，合併方式照 M1：取最小、相乘或相加）。模組透過 `BuildCompiler` 改 build：`scaleStat`／`offsetStat`（在所有修正之後乘或加，ModTable 的列一起）、`addModifier`（接在節點的修正後面）、`flags`（全局開關）、`signature()`（招牌攻擊的參數）、`addTrigger`／`addEffect`、`hook()`。
- Hook：`tick`（每 tick，發射器之後）、`onAttack`（每次攻擊，只能讓這次攻擊必定暴擊）、`onHit`、`modifyDamage`（命中與持續傷害的每一步，在受傷倍率之後）、`onKill`（擊殺當下，轉移觸發之後、移除之前）、`onCenterEvent`。
- 一個模組實例是一個觸發：第一次 `hook()` 拿到一個觸發編號，所有 hook 共用。Hook 要造成傷害或施加異常狀態，只能把自己編譯的效果排進佇列（`enqueueModuleEffect`，`src/sim/rules/api.ts`），所以深度、第 3 條與每 tick 的預算（4.4.8）對它們一樣有效。
- M1 的四個模組：
  - `steadyAim`：關掉隨機暴擊（含靜電聚焦的每跳暴擊率）；每第 N 發（`counts: 'shot'`）或每第 N 次攻擊的每一發（`'attack'`）必定暴擊；`scaleStat('critMultiplier', …)`。
  - `eternalFlame`：`flags.burnRings`（燃燒改用分桶環，沒有層數上限）；`scaleStat('burnDuration', …)`。
  - `overload`：`scaleStat('chainCount', …)`、`offsetStat('chainRetention', −…)`；有 `chainMore` 時加 `more [chain, hit]`（4.4.10）。
  - `glassCannon`：`addModifier(more +1)`（不帶標籤；×2 是 2 的次方，結果和原本完全一樣）、最大生命 1、碎裂的倍率 `flags.shatterMult` 也 ×2。
- 招牌攻擊也是模組（`SIGNATURES`；M1 只有 `m1Volley`），產生第 0 個發射器。

#### 4.4.6 命中

`src/sim/combat/`、`src/sim/emitters/`。

- 每個發射器（`EmitterSpec`）每局有一個酬載（`Payload`）：基礎傷害（`values.damage × damagePct`）、標籤、來源、`jumpSource`、RNG stream（發射器用 `combat`，效果用 `effects`）、旗標（招牌攻擊帶 `SIGNATURE`）、`canCrit`、傷害模式與列的快取槽。M1 的齊射是第 0 個發射器，主要命中 `hit|projectile`。
- 發射器、連鎖跳與效果都走同一個 `hitWithPayload`，順序固定：
  1. 暴擊：擲暴擊率，或必定暴擊（steadyAim 的節奏、`critAlways`）；`canCrit` 為 false 時整個跳過（碎裂）。
  2. 異常狀態依序擲：點燃、中毒、流血、感電；機率 0 不擲。
  3. 傷害：`基礎 × 暴擊倍率 × 連鎖保留 × 列的傷害倍率`（有轉換時分段，4.4.9）。傷害模式 `prescaled` 不乘列（C4 的引爆），`pctMaxHp` 是碎裂（4.4.7）。
  4. 目標感電或凍結時 × 受傷倍率；有 `modifyDamage` hook 時依序套用。
  5. 扣血、統計、事件。致死的命中：先派發 hit／crit 觸發與 `onHit`（帶 `KILLED`，條件看到的是被打中那一刻的目標），再進擊殺。
  6. 沒死：施加擲中的異常狀態（每次成功施加都派發 `ailmentApplied`）與 `frostOnHit`，最後才派發 hit／crit 觸發與 `onHit`，所以條件看得到剛施加的狀態。
- 派發只排佇列、只擲 `trigger` stream，所以命中不會重入。
- 連鎖（`combat/chain.ts`）是 M1 的迴圈：跳數由 `chainCount` 擲出，從上一個命中點找最近、這次攻擊還沒打過的敵人，每跳保留 `chainRetention`。
- 每筆傷害（含持續傷害的每一步）只新增一個 `SimEvent`；hook、觸發、動態項與轉換的清單是空的時候都走快速路徑。

#### 4.4.7 異常狀態

`src/sim/ailments/`、`src/sim/systems/ailments.ts`。

- 持續傷害每 15 tick（0.25 秒）結算一步，第 k 步涵蓋 tick (15(k−1), 15k]。每隻活著的敵人依 ID 順序：燃燒 → 毒 → 流血，每種一筆傷害（感電或凍結時 × 受傷倍率，再過 `modifyDamage` hook），然後是牠的 `ailmentTick` 觸發。
- **快照與即時 hook**：施加當下就用施加者那一列算好每秒傷害（`基礎 × burnDamage 等 × 異常狀態列的傷害倍率`），列裡的 `when`／`scaling` 也在那時判斷，之後不再變。要每一步重算的寫成 `modifyDamage` hook：它在每一步收到那一步的種類、目標與歸屬來源。異常狀態的列讀第 0 跳（狀態不記得怎麼送到），所以「每跳」的縮放不會影響持續傷害。
- **有上限的燃燒**（M1 與沒有無盡烈焰的 build）：沿用 M1 的每層記錄（`ailments/records.ts`），滿了換掉最弱的一層；被換掉的那層在這個 tick 已經結算過的部分不再計入（C3.7b 的修正）。每層記錄帶深度、來源類別與歸屬。
- **分桶環**（毒，以及無盡烈焰下的燃燒；`ailments/rings.ts`）：
  - 每隻敵人每種狀態、每個來源類別（中心、外盤、融合）最多一個環；融合的環算給第一個施加的融合。
  - 一個環 64 桶，一桶一步：存那一步速率的變化、頭尾不滿一步的傷害、在那一步結束的層數；表頭存目前速率、剩餘傷害、層數與最後一步。施加 O(1)、每一步 O(1)，**和層數無關**。超過 63 步（15.75–16 秒）的持續時間截到那裡。
  - 擴散（瘟疫）搬每一桶的速率與傷害 × 比例；層數搬最晚結束的 floor(比例 × 活著的層數) 層。只有「當下這一步」那一份是近似，誤差最多一步。
  - 環放在 typed array 物件池，取出時清空；最後一步、死亡與漏怪時歸還。
- **流血**：每隻敵人只留最強的一個（剩餘傷害較多的才取代；被取代的已累積部分留到下一步）。移動中的 tick ×3（`flags.bleedMoveMult`），靜止 × `bleedStationaryMult`（基礎 1）。大出血的 8 層模式在 C7。
- **感電**：層數有上限、共用一個計時器，本身不造成傷害。所有讀層數的地方都經過 `activeShockStacks`，過期就是 0。
- **受傷倍率** = `1 + frozenDamageTaken·[凍結中] + shockEffect·感電層數`（相加），命中與持續傷害都乘；沒有感電也沒有凍結時不算。
- **冰冷、凍結、碎裂**（`ailments/frost.ts`）：
  - 每隻敵人一個 0–1 的冰冷量表（命中的 `frostOnHit`、`addFrost` 效果）。量表會減速，上限 `frostSlowCap`（一般 30%，Boss 少 0.15，也就是 15%）。
  - 一般敵人滿了凍結 `freezeDuration`（1.2 秒），之後 180 tick 不再累積；Boss 不凍結，滿了量表歸零、鎖 252 tick（4.2 秒）。兩者都發出 `freeze` 中心事件（任何冰冷來源都算）。融合類的凍結酬載在任何連續 60 tick 內最多 8 次；超過時照樣凍結、其他監聽照跑，只記次數。
  - 凍結中死亡會碎裂：對 `shatterRadius`（90）內的其他敵人造成死者最大生命 × `shatterDamage`（15%），標籤 `hit|area|cold`，不會暴擊，歸屬是凍住牠的那個冰冷的來源。碎裂是固定編號 0 的觸發（`SHATTER_TRIGGER`），所以被碎裂殺死的敵人不會再碎裂。
  - 碎裂只吃有界的加成：中心或融合範圍的 `when`／`scaling` 動態項，加上玻璃大砲的 ×2（`flags.shatterMult`）；不吃不帶標籤的 more（強化∞）、靜態的範圍加成（融合精通），也不吃外盤、樞紐、昇華範圍的加成。這樣「%最大生命」的傷害不會被 build 的幾百倍再放大（game-design-v3 強化∞ 的註腳）。
- **「燒得死嗎」**（`doomed`，找目標用）：`hp ≤ 燃燒記錄剩餘 + Σ環的剩餘 + 流血剩餘`；沒有環與流血時就是 M1 的算式。

#### 4.4.8 觸發與效果

`src/data/triggers.ts`（詞彙）、`src/sim/effects/`。這裡說明 impl §2.6 的安全規則 1–8 落在哪裡，以及三個刻意的例外。

- `TriggerSpec = { on, every?, when?, do }`。
  - 已接上的事件（`WIRED_EVENTS`，驗證擋掉其他的）：hit、crit、kill、diedWithAilment、nthAttack、waveStart、periodic、heroHit、contact、ailmentApplied、ailmentTick、freeze、shatter，C4 的 explode 與 chainJump（§4.7.5），C5 的 droneImpact（§4.6）。
  - 效果：`applyAilment`、`spreadAilment`、`explode`、`nova`、`push`、`addFrost`、`heal`、`gainShards`；C4 加了 `groundZone`、`repeatAttack`、`detonate`、`projectiles`、`slashLine`、`coinHit`、`chainBolt`（§4.7）。
  - 條件：目標帶著的狀態、種類、血量、層數、機率、冷卻、`hitIs`、`victimHas`、`killedBy`、`ailment`；每個條件能用在哪些事件由 `CONDITION_CONTEXTS` 規定。
  - 每種效果、條件值與縮放變數都和執行它的程式在同一個 commit 加入，並用 mapped type 的登錄表強制，所以資料寫不出模擬還不會跑的東西。
- 觸發依編譯順序編號：0 是碎裂，接著是 build 的資料觸發，再來是規則模組（一個實例一個編號）。
- **派發**（`fire`／`fireOne`）依序檢查：深度、自己的傷害（第 3 條）、招牌攻擊（第 8 條）、nthAttack 計數、冷卻、條件、chainJump 每次攻擊的上限與目標選擇器（C4，§4.7.5、§4.7.9），最後在 `trigger` stream 擲機率。通過就把效果排進佇列，深度 +1、origin = 這個觸發。
- **第 1、4 條**（佇列與預算）：先進先出的 typed array 環。效果在 tick 的 effects 階段執行，每 tick 最多 2,000 個，剩下的照順序留到下一 tick，記在 `effectBudgetTicks`、`effectsDeferred` 與 `effectBudgetStreakMax`；執行中新排的接在尾端。
- **第 2 條**（深度）：發射器的命中是深度 0；深度 3 以上的事件不派發觸發（記在 `triggerDepthCapped`），深度 3 的效果照樣執行。
- **第 3 條**：觸發造成的直接傷害帶它的編號（origin），不會再觸發它自己；A→B→A 可以，到深度 3 為止。
- **第 5 條**：觸發的機率只從 `trigger` stream 擲，效果裡的擲骰只從 `effects` 擲；同一個 tick 的待處理擊殺依（死者 ID、觸發編號）排序。
- **第 6 條**：效果造成的傷害帶效果的深度與 origin。持續傷害的規則：每隻敵人記住施加在牠身上的所有狀態裡最小的深度（`ailDepth`，只降不升），持續傷害的事件與擊殺帶這個深度、**不帶 origin**。所以持續傷害造成的擊殺不受第 3 條限制，但受第 2 條限制。後果（設計 §12 Q2，決定保留）：焚屍爆炸點燃（助燃）的燃燒之後燒死目標，會再觸發焚屍，到深度 3 為止；爆炸本身的直接擊殺仍被第 3 條擋住（直到連環焚燒）。因此**助燃一定要掛在焚屍爆炸的同一個酬載上（同一個觸發編號）**，不能寫成另一個觸發。
- **第 7 條**（重複攻擊不計數）：計數與發射分開（`countAttack`、`fireAttack`）；重複攻擊不計數，也不會再觸發重複攻擊（§4.7.10）。
- **第 8 條**：中心事件（`emitCenterEvent`）只有帶 `SIGNATURE`、不帶 `REPEAT` 的才派發（§4.7.5）；凍結例外，任何冰冷都算，但深度照算。`hitIs: 'signature'` 的觸發也只吃招牌攻擊。
- **擊殺的順序**（`killEnemy`，`src/sim/systems/death.ts`）：
  1. 轉移觸發（效果全是 `spreadAilment` 的 kill／diedWithAilment 觸發，例：瘟疫）**當場**執行，然後是 `onKill` hook；死者這時還帶著所有狀態。
  2. 移除、掉落、擊殺事件、分裂子怪。
  3. 其他擊殺觸發記成待處理擊殺，快照死者帶著的狀態、死因與致命一擊的旗標；碎裂另外快照死者的最大生命與冰冷的歸屬。tick 的 death 步驟依（死者 ID、觸發編號）派發，效果下一 tick 執行。
  4. 歸還分桶環。
- **三個刻意的例外**：
  - **轉移觸發當場執行**，是第 1 條的窄例外。轉移不造成傷害、不擲骰、不殺怪，所以不會當場遞迴；當場執行才讀得到死者的狀態（不需要保留屍體），分裂子怪也和 M1 一樣不會被擴散到。驗證擋掉把轉移和其他效果混在一起的擊殺觸發（拆成兩個）。
  - **轉移觸發不受第 2 條的深度上限**（Hoshi 2026-10-14 決定）：任何深度的擊殺都會擴散，和 M1 的瘟疫一樣。擴散出去的層數深度 = 擊殺深度 + 1（最多 3），被它們殺死的敵人對其他觸發照樣受深度限制。轉移鏈靠每次擴散的比例 < 1 收斂（C6 的驗證保證 `effect × coef < 1`）。
  - **佇列硬上限 65,536**：超過時丟掉最新的，記在 `effectsDropped`。這違反第 4 條「不丟」，是為了不讓失控的 build 吃光記憶體；平衡工具與模糊測試把任何一次丟棄當成失敗。
- **驗證**（`src/data/validate.ts`）另外擋掉：
  - 沒接上的事件；事件不適用的條件；`chance`、`cooldownSec` 重複。
  - `every`：nthAttack 要正整數、periodic 要 > 0 秒、ailmentTick 要 0.25 秒的正整數倍，其他事件不能帶。
  - ailmentApplied 與 ailmentTick 要剛好一個 `ailment` 條件（ailmentTick 的要是持續傷害種類），否則會對每次施加、每隻敵人都觸發。
  - `gainShards` 只能用在 kill 與 diedWithAilment（它讀死者的掉落）。
  - 需要事件目標的效果（沒有半徑的 `applyAilment`、`addFrost`，以及 `spreadAilment`）：沒有目標的事件（waveStart、periodic、heroHit）不行；contact 不行（效果執行時那隻敵人已經漏掉或死了）；kill、diedWithAilment、shatter 上 `applyAilment`、`addFrost` 要有半徑，這三個事件裡 `spreadAilment` 只能用在 kill 與 diedWithAilment（它當場執行），shatter 上不能用。

#### 4.4.9 轉換

`src/sim/combat/convert.ts`。impl §2.7「在修正之前套用」的字面讀法。

- 只有擊中（類型是 hit）會轉換。一列有轉換時，命中的基礎傷害分段：沒被轉走的比例留在原本的列；每條轉換的比例用換過標籤的列（`convertMask`，同一個來源），乘那一列自己的傷害倍率。轉換合計超過 1 時依比例縮到 1（驗證另外擋掉單一節點合計超過 1）。
- 轉過去的部分保留傳遞標籤、crit 與來源：蜂巢無人機傷害轉成毒的那一段仍帶 `minion`，中心盤的「無人機傷害 +%」照樣有效。轉成持續傷害種類的那一段不再是 hit，所以過載的 `more [chain, hit]`、瘟疫的 `[hit]` 代價都不影響它。
- 各段是同一次命中：扣一次血、一個擊中事件，統計依各段的類型分開記（轉成毒的算毒）。轉出來的部分是即時傷害，不施加異常狀態；異常狀態仍由命中自己用自己的列擲骰。
- 另一種讀法（轉出來的部分變成一次異常狀態的施加，對致死毒素這種疊層 build 比較好）留給 Hoshi 在 B2 用原型決定（設計 §12 O1）；要換只改 `convert.ts`。
- 待辦：估算值還沒算轉換，延到 C6／B2。天賦頁的 `describeBuild`、決定傷害數字與震動大小的 `typicalHit`，以及平衡模擬器的 `effectiveHit`、`attackDamage`、`crowdDps`，命中只讀招牌攻擊那四列（`signatureRows`：命中、命中暴擊、連鎖跳躍、跳躍暴擊）的倍率，燃燒只讀中心的燃燒列（`describeBuild` 讀燃燒，平衡模擬器讀燃燒與燃燒暴擊），都不照轉換分段。M1 沒有轉換，所以平衡探針不受影響；有轉換的天賦進來時（B2）要一起補上。

#### 4.4.10 過載的決定

一個 `overload` 模組同時給 M1、雷塔中心 ★ 與雷外盤 ★ 用。倍率是型別化參數 `chainMore`，有設定時編成 `{stat: 'damage', kind: 'more', value: chainMore, tags: ['chain', 'hit']}`，兩個標籤都要有。

- **M1 的內容不變**：節點保留 `moreDmg(3.5, 'hit')` 與 `{id: 'overload', chainCountMultiplier: 2, retentionPenalty: 0.2}`，不帶 `chainMore`。M1 每一次命中（主要命中與連鎖跳，暴擊與否）都 ×4.5，燃燒不受影響，也就是第 3 輪調出來的「只加擊中」。
- 把 M1 的標籤改成 `chain`，主要命中（投射物，不是連鎖）就失去加成，量出來過不了平衡門檻（C3 開始前的 HEAD，seed 1–3 × 12 × 60 分鐘，chain-greedy，兩位審查者重現）：

| 指標 | `'hit'`（現在） | `'chain'` |
| --- | --- | --- |
| F@20 | 24 | 21 |
| F@40 | 34 | 30 |
| F@60 | 38 | 35 |
| 到第 30 波的分鐘 | 27.1 | 36.7（T2 對齊 1.44，FAIL） |
| 前線附近的菁英被擊殺 | 94% | 17%（T7 FAIL） |
| 流派倍率 D | 6.25 | 1.79 |

- **v3 的兩個 ★** 帶 `chainMore: 3.5`、不帶傷害修正。雷塔的三相雷每一下都是 `hit|chain|lightning`（電弧本身就是連鎖，第一個目標也是），所以 ★ 乘整個招牌攻擊，和 M1 同級；熔核、霜晶、蜂巢只有連鎖送到的擊中（導電的跳、chainBolt、雷鳴…）×4.5，熔岩彈、冰錐與無人機不受影響。要求 `hit` 也把燃燒（狀態只保留擁有者標籤）與轉換出來的持續傷害排除在外。B4 用 `keystones.ts` 把 3.5 校到 +4…+6 波。
- C6 的驗證：外盤 ★ 上每個值 > 0 的傷害修正（含規則參數編出來的）都要帶那塊外盤的流派標籤（`ARCHETYPE_TAGS`）或 `scope: 'outer.<o>'`；代價（值 < 0）與中心、樞紐、融合、M1 的節點不受限。規則在 C3 已經寫好並用測試資料驗過，C6 對內容開啟。

### 4.5 輸入

```ts
type InputFrame = { cursor: Vec2 | null; activate: boolean };
type ControlMode = 'auto';
```

- 操作模式定為全自動（GDD 2.3），`sim` 目前不讀 `InputFrame`。介面保留，之後如果要加局中操作，不必改模擬核心的呼叫方式。

### 4.6 無人機與砲台

v3 引擎 C5 步驟的召喚物（`docs/v3/implementation-plan-v3.md` §2.9，C5 設計 D1–D25）：蜂巢的招牌攻擊 `swarm`，以及任何角色從召喚外盤拿到的無人機發射器（`{kind: 'drone'}` 授予，`src/data/emitters.ts` 的 `DroneGrant`）。CLAUDE.md 的限制寫死在模擬裡：召喚物沒有生命、不尋路、不被敵人瞄準、不碰撞；砲台就是不動的無人機。

#### 4.6.1 池、排位與上限

- **池**（`ctx.sys.drones`，`DronePool`，`src/sim/systems/systemState.ts`）：所有無人機與砲台放在同一個 structure-of-arrays 的池，一格（slot）一列：位置與上一 tick 的位置、停靠點（砲台是砲座）、種類、模式、目標、下次能找目標的 tick、這趟剩下的撞擊次數、停靠剩下的時間、砲台的累加器，以及同一隻敵人的冷卻記憶（每格 `DRONE_MEMORY` = 4 筆，敵人 ID 與到期 tick）。每個發射器另有一份數字：`stepBase`、`dockTicks`、`coolTicks`、`impacts`、`splashSq`、`turretPayload`。`createRunContext` 先用 `droneLayout`（`src/sim/emitters/drone.ts`）排好每一列，再用 `createDronePool` 建池，每局都是新的陣列。`SimState.drones` 共用這些陣列、`droneCount` 是格數（和投射物池、地面區域的檢視一樣），所以停靠中的無人機從 tick 0 就看得到。M1 沒有無人機發射器，每個陣列長度都是 0。
- **排位**：依發射器順序，每個發射器先排無人機、再排砲台；ID 從 1 起依列的順序編；局中目前不新增召喚物，所以格的順序就是 ID 順序。第 k 架無人機（共 D 架）停在角色周圍半徑 43、角度 2πk/D，第一次找目標在 tick `1 + (10k mod 30)`，所以起飛錯開。第 j 座砲台（共 T 座）坐在半徑 90 的砲座：同一個發射器有無人機時角度是 π/D + 2πj/T（D 是 T 的倍數時，每座砲台的角度都在兩架無人機正中間，例如 swarm 的 3＋1 與 `hive` 的 20＋4），只有砲台時是 2πj/T（D = 0 時 π/D 是 Infinity，位置會變成 NaN）。位置只在開局算一次，每 tick 不跑三角函數。
- **數字從哪來**：招牌攻擊（第 0 個發射器）的數量、速度、停靠、冷卻、每趟撞擊次數、濺射半徑與砲台的傷害比例全部讀 `SwarmParams`（`CompiledBuild.signature.swarm`，規則模組可以就地改），這些不讀發射器 spec；授予的讀 `DRONE_DEFAULTS` 加上授予自己的數量與傷害比例。撞擊的傷害比例兩者都是發射器 spec 的 `damagePct`，和其他發射器一樣由 `emitterPayload` 讀（swarm 的寫在 `src/sim/rules/swarm.ts`，授予沒寫時用 `DRONE_DEFAULTS` 的）；停靠點與砲座的半徑、砲台的射速（`TURRET_RATE`）兩者都讀 `DRONE_DEFAULTS`。濺射半徑經過 `sizeOf`。
- **上限**：`SUMMON_CAP` = 24（`src/sim/caps.ts`）算所有的格，無人機與砲台都算（之後的臨時召喚物也算）。排位到上限就拒絕之後的列，記在計數器 `summonCapped`。單一授予超過 24 格是資料驗證的錯誤；`compileBuild` 在 swarm 的 drones + turrets < 1 時丟錯（只有規則模組或 TestModule 寫得出來）。唯一能改上限的是測試用的 `TestModule.summonCap`：一局取 24 與各 TestModule 的最大值，所以只能調高；`RunConfig` 沒有這個欄位，內容碰不到。

#### 4.6.2 階段：`stepDrones`

`src/sim/systems/drones.ts`，`step()` 的 6b：`if (ctx.sys.drones.count !== 0) stepDrones(ctx)`，在發射器與 tick hook 之後、投射物之前。無人機看到這個 tick 的空間格與 tick hook 寫的 `em.cadence`；砲台這個 tick 射出的子彈這個 tick 就移動。M1 每 tick 只多一次讀取與比較。每格依 ID 順序走一次；除了擊中本身的傷害事件（§4.3：每筆傷害一個 `SimEvent`），只多配置 `impact` 與 `turretFire` 事件。

- **攻擊頻率** `m = attackSpeed / BASE_ATTACK_SPEED × em.cadence`，每 tick 讀；m 乘移動速度，除停靠時間與冷卻。`!(m > 0)` 時（含 NaN）無人機這一格這個 tick 什麼都不做，所以位置與計時不會變成 NaN；砲台不看 m（§4.6.3）。
- **一趟**：停靠（DOCKED）到停靠時間結束、時鐘允許時找目標（`pickOuter`），找到就衝刺（DASH），同一個 tick 開始移動。每 tick 朝目標中心直線走一步，步長碰到目標邊緣就算抵達（和追蹤子彈同一條規則，任何 m 都不會穿過），貼到目標中心撞擊（`impactAt`）。目標還活著就留在牠身上，冷卻結束再撞；這趟的撞擊用完就飛回停靠點（RETURN）。目標死了或被推出場地就失去目標：時鐘允許時重找，否則原地懸停（HOVER）；找不到目標就回家。進入 DASH 一律經過 `engage`，一次寫好 `target`、`targetId` 與 `mode`。
- **找目標的時鐘**：每格每 `PICK_TICKS`（30 tick）最多找一次，不隨 m 縮放（impl §2.9「每 0.5 秒才重新找一次」）。
- **冷卻記憶**：一筆在 `memUntil > now` 時有效。冷卻是 `clamp(ceil(coolTicks / m), 1, 90)` tick。寫入時覆蓋同一隻敵人的那筆，否則覆蓋到期最早的那筆，不是 FIFO：90 tick 內一格最多撞到 4 隻不同的敵人（目標只在找目標時換，30 tick 才找一次），所以 4 筆一定夠，被覆蓋的那筆一定已經到期，不管 m 中途怎麼變。
- **找目標**（`pickOuter`）：從 `ctx.enemies` 尾端往前掃一次，取離角色最遠（`Enemy.dist`）、中心在場地內、不在自己冷卻記憶裡、沒有其他無人機在追的活敵人，同距離取 ID 小的；距離比目前最好的近就先跳過，其他檢查只在可能更好的候選上做。一個都沒有時，才從其他衝刺中的無人機的目標（最多 `SUMMON_CAP` − 1 個，同樣跳過死的、中心在場地外的與自己冷卻記憶裡的）裡挑最遠的。不看 `doomed`、不讀寫 `Enemy.inbound`，追擊的標記是池自己的 `mode` 與 `target`。
- **和 impl §2.3 的不同**：impl §2.3 把「無人機找目標」列為空間格的使用者，但「離角色最遠」不是格子能回答的半徑查詢，所以 `pickOuter` 是線性掃描，和遠投的 `aimFar` 一樣。砲台找目標、撞擊的濺射仍然查格子。
- **撞擊**（`impactAt`）是一次攻擊，順序照熔岩彈落地：招牌攻擊先 `countAttack` 與 `nextShotSteady` → `beginAttack` → 用 `grid.within` 列出目標中心濺射半徑內的活敵人（先列再打，所以擊殺分裂出來的子怪不在清單裡）→ 依 ID 順序各打一次，目標是主要命中（招牌攻擊才帶 `PRIMARY`）並計入這次攻擊的連鎖預算 → 招牌攻擊的連鎖 → `impact` 事件 → `droneImpact` 中心事件（沒有清單）→ `endAttack` → 招牌攻擊後面等著的重複攻擊。

#### 4.6.3 砲台

C5 設計 D11。砲台是 `DRONE_KIND_TURRET`、模式 FIXED 的格，坐在砲座不動，開火照 M1 的齊射，只是從砲座射（`turretStep`）：

- **累加器**：每 tick 加 `em.cadence`，到 `em.interval`（無人機發射器的 `emitterInterval` 是砲台的週期：每秒 `TURRET_RATE` = 2 次 × 攻速 / 4）就開火。沒有目標時停在「準備好」、不累積（`acc = interval − cadence`），敵人出現的那個 tick 就開火。攻速 ≤ 0 時週期是 Infinity，永遠不開火。
- **目標與數量**：第一個目標用 `pickTargetInGrid`（從砲座找最近值得打的，`focused` 的菁英與 Boss 優先，都沒有就最近的活敵人）。招牌砲台在擲數量之前 `countAttack`。數量照 `rollCount` 擲，但寫在迴圈裡（小數部分是多一發的機率、整數不擲，同一條 stream）：swarm 的 `offsetStat('projectileCount', -1)` 讓招牌砲台基礎是 1 發，授予的砲台在 M1 上是 2 發。
- **之後幾發**用 `turretAccept`（`shootable` 且這次開火還沒選過），**沒有** M1 齊射讓 `focused` 敵人多吃幾發的例外：砲台的子彈不設 `volleyMark`、不加 `inbound`，所以聚焦的菁英每次開火只吃一發，除非沒有別的目標、走最近活敵人的後備。`focused` 量的是敵人到角色的距離，所以離砲台最遠約 890 的菁英也可能算聚焦。
- **子彈**是投射物池的追蹤子彈（`spawnShot`，`MOTION_HOMING`，`owner` = 發射器編號），和 M1 齊射的投射物、其他池子彈一起受 `PROJECTILE_CAP`（512）限制。`turretFire` 事件的 `count` 是這次開火嘗試的發數，被上限拒絕的也算（`projectilesCapped` 另外記）。
- **`turretPayload`**（`src/sim/emitters/types.ts`，在 `emitterPayload` 旁邊）：標籤 `hit|minion|projectile`；傷害比例在第 0 個發射器讀 `SwarmParams.turretDamagePct`（0.8），授予讀它自己的；連鎖策略和 `emitterPayload` 一樣只給第 0 個發射器。來源與 `rollsAilments` 跟著發射器，所以燃燒的歸屬不用另外登記。
- **抵達**（`stepHoming`，`src/sim/systems/shots.ts`）：`owner ≥ 0` 且酬載帶 `SIGNATURE` 時走 `chainAttack`（主要命中加連鎖，和 M1 投射物抵達一樣）；授予的砲台與 `owner` −1 的效果子彈照舊是一般擊中。目標死了就改找子彈附近最近的敵人。

#### 4.6.4 規則與 stream

- **一次攻擊**（C5 設計 D12）：招牌攻擊的每次撞擊是一次攻擊、一發；每次砲台開火是一次攻擊，每顆子彈一發（被上限拒絕的也算）。攻擊序號在第 0 個發射器的無人機與砲台之間共用，所以 `steadyAim` 的節奏、nthAttack 與重複攻擊看到的是同一串攻擊。授予的無人機與砲台不計數。
- **第 7 條**：swarm 的重複攻擊（`REPEAT_STEPS.swarm = swarmRepeat`）是一次沒有無人機的撞擊：從角色找最遠的敵人（`pickOuterFromCenter`，`pickOuter` 少了記憶與追擊的判斷），用重複攻擊的酬載（`REPEAT`）跑 `impactAt`，不計攻擊、不算一發，`impact` 事件的 `droneId` 是 −1。砲台開火後等著的重複攻擊也是這樣的撞擊，不是第二次開火。
- **第 8 條**：`droneImpact` 只在招牌攻擊自己的撞擊派發；授予（旗標 0）與重複攻擊（`REPEAT`）的撞擊在 `emitCenterEvent` 的檢查就擋掉，`impactAt` 不用分支。
- **Stream**：排位、移動、找目標與濺射查詢都不擲骰。擊中照酬載的 stream 擲：撞擊、濺射、連鎖與砲台子彈是 `combat`，重複攻擊是 `effects`；砲台的數量也擲在酬載的 `combat`。

#### 4.6.5 暫存緩衝的擁有者

C4 設計 §4.0 的規則不變，C5 加了這幾列（C5 設計 §4.0）。效果不會巢狀執行，所以 'now' 的重複攻擊只從 `runEffectQueue` 跑，不會在無人機的迴圈裡跑。

| 緩衝 | 唯一的寫入者 | 迭代中 | 迭代中寫得到的 |
| --- | --- | --- | --- |
| `ctx.sys.drones.splash` | `impactAt`（撞擊與重複攻擊）：任何擊中之前先用 `grid.within` 填好 | 撞擊的擊中迴圈 | `spreadTargets`、`centerEvents.freezeTargets`、`centerScratch.list`（C4 的第 2 條）。`chainFrom` 在迴圈之後；重複攻擊的 `impactAt` 只在迴圈結束後寫 `splash`（撞擊結尾的 drain，或 `runEffectQueue` 的 'now'） |
| `ctx.sys.drones.picked`、`pickedCount` | `turretStep`：每次開火歸零，每顆子彈一筆 | `pickTargetInGrid` 裡的 `turretAccept`（這次開火之後幾發的目標） | 沒有。迴圈裡只跑 `nextShotSteady`、`spawnShot`（不打任何東西）與找目標；`countAttack` 在迴圈前，重複攻擊的 drain 在迴圈後 |
| `ctx.centerScratch.list` | 多了 `impactAt`：擊中迴圈之後、`emitCenterEvent` 之前設 `listCount = 0`；不寫 `radius`（只有帶清單時才讀） | 同 C4 | 同 C4 |

冷卻記憶（`memId`、`memUntil`）與追擊標記（`mode`、`target`）不是緩衝，是每格自己的狀態，只有那一格自己的步驟會寫；`pickOuter` 與 `pickOuterFromCenter` 不寫 `ctx.enemies`。

**依賴：敵人物件從不重用。** 一格的 `target[s]` 會跨 tick 留著（衝刺中、坐在冷卻中的目標上，或回程中，回到停靠點才清掉），同一個 tick 前面的格也可能殺死後面那格的目標。這只靠一件事保證安全：`addEnemy`（`src/sim/systems/spawn.ts`）每次生怪（含分裂子怪）都建新物件，`compact`（`src/sim/systems/death.ts`）只依 `alive` 過濾，所以留著的目標不是活的，就是讀到 `alive === false`；投射物池的追蹤子彈也靠同一件事。**之後如果把敵人改成物件池，無人機也要一起改。**

#### 4.6.6 畫面

`src/render/drones.ts`、`src/render/poolShots.ts`，只在 `?hive` 原型的蜂巢構造體（`RendererOptions.construct`）下建立，只讀狀態與事件：

- `DroneLayer`：無人機是同一張烘焙風箏貼圖的 sprite，在最後兩個 tick 的位置之間插值，機頭朝移動方向；每架最近 5 個 tick 的尾跡畫成一個 `ParticleContainer` 的漸淡線段；被衝刺的敵人身上有蜂巢綠的角括號。砲台是砲座上的方形底座加一根砲管：`TurretTracks` 依 ID 記每根砲管的角度與後座，開火時對準 `turretFire` 瞄準的敵人、之後跟著牠轉。
- `PoolShotLayer`：投射物池的追蹤子彈（砲台的，也有效果的）畫成發光的小彈頭加尾跡。池不記上一個位置，所以 `ShotTrails` 依子彈 ID 自己記，陣列依 `PROJECTILE_CAP` 一次配置好；模擬不為了畫面寫速度。
- 撞擊在 `src/render/rings.ts` 有自己的環樣式與上限，滿了換掉最舊的撞擊環，不會擠掉衝擊波或瘟疫的火環。
- 圖層：無人機與砲台在角色之上、投射物之下；池子彈在投射物之上、連鎖閃電之下。

#### 4.6.7 檢查與工具

- **模糊測試**（`src/sim/summonFuzz.test.ts`，在 `npm run check` 裡，約 2 秒）：用專案自己的 seeded RNG 從固定 seed 抽 20 個 build（產生器 `summonFuzzBuilds` 在 `src/sim/testing.ts`，測試與工具共用）：swarm 的數量由 TestModule 設定（只有無人機、只有砲台、兩者都有）；M1 加上無人機授予（含只有砲台與 0 格的授予）；超過上限的總數；TestModule 調高或調低的 `summonCap`；塞滿 `PROJECTILE_CAP` 與 `CHAIN_HIT_CAP` 的 build；以及會走到召喚物路徑的屬性（暴擊、連鎖、投射物數、攻速 0 到 64、異常狀態機率、`droneImpact` 觸發、重複攻擊、變動的 `cadence`、連鎖策略）。每個 build 從第 1 與第 30 波各跑 600 tick、跑兩次，每個 tick 檢查：敵人的血量與位置、每一格（含砲台）的位置沒有 NaN 或 Infinity；`droneCount` 不超過這局的上限；池子彈數、以及池子彈加 M1 齊射投射物的總數都不超過 `PROJECTILE_CAP`（512）；`chainHitsPeak` 不超過 32；開局排了 min(要求的格數, 上限) 格、`summonCapped` 等於被拒絕的格數；兩次的事件與結果雜湊相同。自我測試種下 NaN、Infinity、超過上限、拋出例外與跨局殘留的狀態，同一套檢查一定要抓到，乾淨的一局一定要通過。
- **`npx tsx tools/balance/fuzzSummons.ts --builds 100`**：同一個產生器，100 個 build × 60 秒，兩個起始波次、各跑兩次。報告印出局數、tick、實際耗時、各類失敗的次數、最大的 `droneCount` 與它的上限、`summonCapped` 總數、最多的池子彈與 `projectilesCapped`、最大的 `chainHitsPeak`，以及撞擊、砲台開火與擊殺數（證明 build 沒有閒著）；任何失敗都以非 0 結束，並寫出 build、seed 與起始波次（`summonFuzzBuilds(i + 1)[i]` 重建第 i 個 build）。
- **bench 的 `hive` 場景**：`normal` 的 3 分鐘一局，招牌攻擊換成 swarm，由 TestModule 塞滿 24 格（20 架無人機＋4 座砲台），再加一個計算 `droneImpact` 的 `onCenterEvent` hook，讓監聽的路徑也跑。它不是壓力家族（真實遊戲資料、`normal` 的 build 與起始波次，沒有存活數區間）。`--check` 和其他場景一樣比它對 `normal` 的比值（`tools/balance/bench.baseline.json`），另外印出它的中位數對 impl §6 一局 3 分鐘模擬 50 ms 的預算與這局的召喚物工作量；超過 50 ms 只印出，不算失敗。
- **bench 的 `stress` v4、`stressBase` 與 `--share`**（C5.6）：`stress` 是 v4＝v3 加上 `outer.summon` 的無人機授予，24 架無人機＋8 座砲台，由只帶 `summonCap` 的 TestModule 把上限調到 32；授予刻意不經資料驗證（驗證限每個授予 24 格，有測試確認它會被拒絕）。m = 2（Q3（A））由第 1 tick 設定 `cadence` 的 tick hook 給出；撞擊與砲台的傷害比例 d、t 調到 seed 1 的平均存活數和 v3 差在 ±3 以內。`stressBase` 是原封不動的 v3，放在自己的鍵，由 `tools/balance/` 裡兩個 JSON 快照（seed 1 的設定與工作量）釘住；`--check` 同時計時兩者時印出 `stress − stressBase`。`npm run bench -- --share` 是 STRESS 的閘門：3 個子程序依序各跑 2 輪暖身與 7 輪量測（共 21 輪），每輪 v4、`stressBase`、`normal` 各一次、順序輪換；閘門是每輪 v4 ÷ `normal` 的中位數對 Q4 的上限（`STRESS_TOTAL_LIMIT`），占比（v4 − `stressBase`）÷ `normal` 對 0.5、`stressBase` 對 C4 的 3.5 都只印出；各輪 `normal` 的中位數要 ≤ 25 ms（超過最多重跑 3 次），總和在上限 3 % 以內就再跑兩次、取三次的中位數；少於 3 個程序或 20 輪不算閘門，不會以 0 結束。它也計時只印出的 `hiveStress`（壓力場地上的 swarm 塞滿 24 格、連鎖 2、m = 2，每次撞擊留下螢火那樣 2 秒、半徑 80 的脈衝區；不在 `SCENARIO_IDS` 與 `CHECK_ENTRIES` 裡）。C5.6 之後的 C4 commit 不跑 `--share`，改用 `--check --scenario stress` 與 `--scenario stressBase` 的中位數比值設閘。
- **`npx tsx tools/balance/hiveFrontier.ts`**：從 `?hive` 的預設存檔，swarm 與 M1 各跑 2 個 `balanced` 策略、10 分鐘的平衡 session，印出前線波次、到第 20／30 波的分鐘與兩邊平均前線的差距。Q5（A）的規則：swarm 的前線比 M1 低超過 5 波，就做只調 swarm 數字（撞擊與砲台的傷害比例、速度、停靠）的調整 commit（C5.R）。

### 4.7 C4 的引擎：攻擊、投射物、區域與授予

v3 引擎 C4 步驟（`docs/v3/implementation-plan-v3.md` §2.2、§2.4、§2.6、§2.8、§2.10、§2.11、§2.15 的引擎部分，C4 設計 rev 7.15 的 D1–D30）：熔核的熔岩彈、霜晶的冰錐扇、雷塔的三相雷與它們的形態，投射物池、地面區域、線段，授予的荊棘、落雷、光環與環繞，連鎖的上限與一般連鎖，中心事件的清單與 chainJump，觸發的目標選擇器，重複攻擊與引爆。C4 沒有任何 commit 改變 M1 的行為：指紋與 24 個 golden 雜湊從沒重寫，每個新機制有自己的 GOLDEN-C4 案例（§12）。無人機與砲台（C5）見 §4.6。

#### 4.7.1 上限與計數器

所有規格上限都在 `src/sim/caps.ts`（它不 import 任何模組，誰都能讀）。每個上限拒絕的工作記在 `RunResult.counters` 的一個計數器（`COUNTER_IDS`，`src/sim/types.ts`）：新的接在最後、索引不變。計數器不在 `projectResult` 裡，所以指紋看不到；GOLDEN-C4 只雜湊不為 0 的，所以後加的計數器不會動到之前記錄的雜湊。

| 上限 | 值 | 拒絕的記在 |
| --- | --- | --- |
| `CHAIN_HIT_CAP` | 一次攻擊 32 下，主要命中與每一跳都算 | `chainHitCapped`（`chainHitsPeak` 記一次攻擊最多幾下） |
| `EXTRA_JUMP_CAP` | 規則加的跳（跳電與回彈合計）一次攻擊 2 | `extraJumpsCapped`（沒擲的跳電、被拒的回彈） |
| `CHAIN_JUMP_EVENT_CAP` | 一個 chainJump 觸發一次攻擊最多觸發 3 次 | `centerEventsCapped` |
| `PROJECTILE_CAP` | 同時飛行 512：齊射的追蹤投射物加投射物池 | `projectilesCapped` |
| `ZONE_CAP`、`ZONE_SOURCE_CAP`、`SIGNATURE_ZONE_CAP` | 效果區域 64（每個來源 16），另外招牌攻擊的區域 16 | `zonesEvicted` |
| `REPEAT_CHARGE_CAP` | 等下一次攻擊的重複攻擊 8 個 | `repeatChargesDropped` |
| `ORB_MEMORY` | 每顆環繞球記得 64 隻敵人（2 的次方，用遮罩繞回） | `orbMemoryFull` |
| `SUMMON_CAP` | 召喚物 24（§4.6.1） | `summonCapped` |

- 不拒絕任何東西的：`SHOT_MEMORY`（一發子彈記得最近打過的 16 隻）、`SMALL_PROJECTILE_TICKS`（小投射物活 120 tick）、`LIST_MAX`（中心事件的清單最多 5 隻）、`FREEZE_LIST_RADIUS`（90）、`PULSE_TICKS`（15）、`BURN_RINGS_MAX_STACKS`（5：無盡烈焰下 `stacksAtLeast 'max'` 的燃燒層數），以及 C5 的 `DRONE_MEMORY`、`PICK_TICKS`、`DRONE_COOLDOWN_MAX`。
- 計數器現在 17 個：C4 之前的 8 個，C4 加了表裡前 7 列的計數器與 `chainHitsPeak`；其中 `orbMemoryFull`（C4.21）接在 C5 的 `summonCapped`（第 16 個）之後，是第 17 個。32 下的上限在 M1 擋不到：指紋裡一次攻擊最多 8 下，`hits` 場景與平衡探針最多 9 下。

#### 4.7.2 攻擊序號與連鎖

`src/sim/combat/chain.ts`、`combat/policy.ts`。

- **一次攻擊**在 `beginAttack` 與 `endAttack` 之間：`beginAttack` 把 `ctx.attackSerial` 加 1，清空這次攻擊的預算 `ctx.chainBudget`（`hits`、`extraJumps`、`centerEvents`）；`endAttack` 更新 `chainHitsPeak`。被打中的敵人記下 `hitMark = attackSerial`，連鎖跳過這次攻擊打過的。一次攻擊是：齊射一發投射物的抵達、一顆熔岩彈落地、冰錐扇的一輪、三相雷的一次放電、一次落雷、一次 chainBolt、一次無人機撞擊、招牌砲台一顆子彈的抵達（§4.6.3），以及重複攻擊的每一次抵達、落地、一輪、放電或撞擊。這和 `countAttack` 計數的攻擊（onAttack hook、nthAttack、等它的重複攻擊，§4.6.4 的「一次攻擊」）不同：齊射、熔岩彈或砲台的一次發射只計數一次，每一發的抵達或落地各是一次攻擊。效果在攻擊結束後才從佇列執行，所以效果的連鎖各有自己的預算。
- 不屬於任何攻擊的擊中（區域、光環、環繞、荊棘、線段、其他效果）也記下當下的序號。這無害：連鎖只在自己的 `beginAttack` 之後讀 `hitMark`，中間只跑它自己的擊中（觸發只排佇列）。
- **主要命中**（`PRIMARY`，事件旗標的位元 18，`1 << 18`）只來自 `primaryHit` 或 `hitWithPayload` 的 `bits` 參數，只在招牌攻擊與它的重複攻擊上：齊射抵達的目標、熔岩彈爆炸裡離落點最近的、冰錐扇一輪的第一下、三相雷的每個目標、招牌無人機撞擊的目標、招牌砲台子彈抵達的目標（`chainAttack`）。效果、連鎖跳與授予發射器的擊中都不帶；條件 `hitIs: 'primary'` 讀它。預算裡每個主要命中算 1（六線圈的兩個目標各 1），不帶 `PRIMARY` 的落雷目標、chainBolt 的第一下與授予無人機撞擊的目標也各算 1，每一跳算 1；爆炸、冰錐、落雷與撞擊範圍的其他擊中算 0。
- **線性路徑**（`chainFrom`）是 M1 的迴圈加上上限：跳數在酬載的 stream 擲（`rollCount`），每跳找最近、這次攻擊還沒打過的敵人；預算到 `CHAIN_HIT_CAP` 時，剩下的跳數一次記進 `chainHitCapped`。M1 的酬載都走這條。
- **一般路徑**（`chainGeneral`）：建立酬載時就固定 `Payload.general`（有連鎖策略、`raisesChainJump` 或 `shockOnHit`）。它逐層廣度優先：每一層的敵人各跳到 `branch` 個最近的（渦流、分岔），最後一層在遠雷下改找最遠的（`farthestChainTarget`），每層乘 `ChainPolicy.scale` 那一層的比例；第一跳就找不到目標的敵人，在還有回彈時再打自己一次。每一跳在酬載的 stream 擲一次跳電，跳電在最後一層之後從最後打到的敵人接下去。跳電與回彈用 `p.extraJumpPayload`，同時算進兩個上限。沒有策略的酬載用 `ctx.sys.chain.noPolicy`，結果和線性路徑逐下相同（有差異測試）。
- **連鎖策略**（`ChainPolicy`，`systemState.ts`）由 `createRunContext` 每局用 `compilePolicy` 編一次，只給招牌攻擊與它的重複攻擊的酬載；效果的連鎖（chainBolt、落雷）沒有策略。
- **chainJump**：三相雷自己的酬載（`raisesChainJump`；重複攻擊的酬載沒有）的每一跳（分岔、跳電、回彈都算，主要命中不算）在 `raiseChainJump` 發出 chainJump 中心事件，值是這一跳的角度（`slashLine` 的 `toward: 'along'` 讀它），不帶清單。沒有觸發或 hook 在聽時什麼都不寫。

#### 4.7.3 投射物池

`src/sim/systems/shots.ts`。齊射的追蹤投射物照舊是 `ctx.projectiles` 的物件；其他投射物都在投射物池（`ctx.shots`，`ShotPool`，每局配置一次的 typed array，`SimState.shots` 共用同一份）。

- 三種移動：直線（冰錐，`radial` 與 `fan` 的小投射物）、追蹤（`target` 與 `distinct` 的小投射物、砲台的子彈）、拋物（熔岩彈，在 `until` tick 落在固定點，由 `lob.ts` 的 `land` 處理）。
- ID 和齊射的投射物共用一個計數器，projectiles 階段依 ID 把兩個清單合成一個順序（`moveProjectiles`）；池是空的時候就是 C3 的迴圈。結束的子彈留到階段結束才壓縮（`compactShots`），階段中不會產生子彈。`spawnShot` 在 `PROJECTILE_CAP` 時拒絕並記 `projectilesCapped`。
- **直線碰撞**：每 tick 用 `grid.boxIndices` 取掃過範圍的框（加 `ctx.shotPad` 與子彈半徑）裡的敵人，再加框外的大型敵人（`grid.marked`），精確測試後依（路徑參數、ID）排序，依序打到穿透用完；最近 `SHOT_MEMORY` 個打過的直接穿過。碰到場地邊緣時還有反彈次數就反射，否則結束。`shotPad` 是資料裡非大型敵人的最大半徑，所以非大型敵人一定在框內；加一種半徑更大的非大型敵人就會打破這個保證。
- 池子彈的擊中不是攻擊（沒有序號、連鎖與 `PRIMARY`），只有三個例外：熔岩彈落地、冰錐扇一輪的主要命中（`ShotPool.roundTaken`）、招牌砲台子彈的抵達（§4.6.3）。
- 效果的小投射物（`projectiles`）的 `owner` 與 `round` 是 −1，不加 `Enemy.inbound`，所以 M1 分散目標的選法不受影響；追蹤的目標死了就改找最近的敵人，沒有就消失。

#### 4.7.4 熔岩彈、冰錐扇、三相雷

`src/sim/emitters/lob.ts`、`fan.ts`、`arc.ts`。招牌攻擊的模組（`magmaBomb`、`iceFan`、`triphaseArc`）在編譯時調屬性並填 `SignatureParams` 的 `lob`、`fan` 或 `arc`；形態（遠投、火山、連環爆、冰柱、稜鏡、六線圈；`lobForms.ts`、`fanForms.ts`、`sixCoils.ts`）是 RuleSpec，只寫它那一份參數，用在別的招牌攻擊上時丟錯。執行時讀 `ctx.build.signature.lob` 等。三種都和齊射一樣：累加器到 `em.interval` 就發射，沒有目標時停在「準備好」、不累積；每次發射（一輪、一次放電）`countAttack` 一次（onAttack hook、nthAttack），每一發過 `nextShotSteady`（steadyAim），之後立刻跑等它的重複攻擊（`drainRepeatCharges`）。

- **編譯順序與射速**（C4 設計 D4、D5）：招牌攻擊模組的 `compile` 在資料的修正與觸發之後、規則模組之前跑（`compileBuild`），所以規則模組的 `scaleStat` 也會縮放它的偏移（例如熔岩彈的 `projectileCount` −1）；`m1Volley` 沒有 `compile`，M1 的屬性與觸發編號都不動。`em.interval` 由 `emitterInterval`（`emitters/types.ts`）設，是 `periodTicks(每秒次數 × attackSpeed / 4)`：基礎攻速 4 時齊射每秒 4 次（15 tick）、熔岩彈 1.5 次（40 tick）、冰錐扇 2.5 次（24 tick）、三相雷每個線圈 1 次（3 個線圈 20 tick，六線圈的 6 個 10 tick）；火山改成基礎攻速時每 `periodSec` 秒一次，攻速照比例加快。
- **熔岩彈**（`magmaBomb` 的 `offsetStat projectileCount −1`：基礎每次 1 顆，每多 1 投射物多 1 顆）：
  - 瞄準（`aimDense`）：第一顆瞄最密的 3 × 3 格裡、爆炸半徑內敵人最多的那隻（`grid.densest`、`blockItems`、`countWithin`；同數取來源順序在前的）；之後每顆瞄同一塊裡、離這次發射已瞄過的每隻至少 `SALVO_SEPARATION`（2）個半徑的最佳候選，沒有就取還沒被瞄過的最佳候選，都沒有就不丟。每顆都預判敵人落地時的位置。遠投每第 4 顆（`em.shots`）瞄全場最遠的（`aimFar`）；它不算「已瞄」，所以沒有夠遠的候選時密集彈可以再瞄它（Hoshi 的 Q3/F15）。瞄準不擲骰。
  - 落地（`land`，在 projectiles 階段）是一次攻擊：爆炸半徑內的活敵人依 ID 各吃一下，離落點最近的是主要命中；然後是主要命中的連鎖（跳過爆炸打過的）、`explosion` 事件、explode 中心事件、招牌攻擊的火地（`addZone`）。火山的巨彈半徑 × `radiusMult`（瞄準、間隔與火地一起），傷害 × `damageMult` 只乘爆炸的擊中。連環爆：爆炸自己殺死的敵人（每顆最多 `perBomb` 隻）在死亡位置排一個 explode 效果（`enqueueModuleEffect`）；重複攻擊的彈不排。
- **冰錐扇**（`iceFan`）：每輪朝齊射的選目標器找到的目標，在 `spreadDeg`（30°）內平均射出 `rollCount(projectileCount)` 道直線冰錐（基礎 2 + 3 = 5），每道穿透 1。一輪是一次攻擊：冰錐帶同一個輪序號（`ShotPool.round`），處理順序（tick、子彈 ID、路徑參數、敵人 ID）裡的第一下是主要命中，開始這次攻擊並跑這輪唯一的連鎖；其他冰錐的擊中不算預算。冰柱每第 4 輪改射一道 `em.alt` 酬載的冰錐；稜鏡每輪射一道無限穿透、每穿過一隻就加成的冰錐；兩者都不擲數量。
- **三相雷**（`triphaseArc`）：每次放電立刻打選目標器找到的目標（不限距離），主要命中之後走一般連鎖，它的跳發出 chainJump；`discharge` 事件在每個目標的擊中之前。六線圈打兩個不同的目標（兩個都先選好再打，第二個用齊射分散投射物的選法）：兩個主要命中各算 1，然後從兩者出發的一條連鎖（跳數只擲一次），共用 `CHAIN_HIT_CAP`。
- **和 impl §2.2／§2.10 的不同**（C4 設計 D11、F26）：impl 把扇形寫成 volley 的 `fan` 參數，這裡是自己的發射器種類 `'fan'`。它和齊射共用累加器與選目標器，但射的是投射物池的直線冰錐、有自己一輪的主要命中、帶 `em.alt`。分成另一種，`runVolley` 才能一行不改地保持 M1 的程式。

#### 4.7.5 中心事件、清單與分送

`src/sim/effects/centerEvents.ts`、`dispatch.ts`。四個中心事件（`CENTER_EVENTS`）：explode（每顆招牌熔岩彈落地）、freeze（任何冰冷填滿量表，§4.4.7）、chainJump（三相雷的每一跳）、droneImpact（招牌無人機的撞擊，§4.6.2）。

- **第 8 條**在 `emitCenterEvent` 的第一行：除了 freeze，事件要帶 `SIGNATURE` 且不帶 `REPEAT` 才派發，所以效果的爆炸、連環爆、授予的發射器與重複攻擊都不發中心事件。沒有觸發在聽、也沒有 `onCenterEvent` hook 時立刻返回（`ctx.centerEvents` 的 `listeners`、`hooks`）。
- **清單**（`ctx.centerScratch.list`、`listCount`，最多 `LIST_MAX`）由發出事件的程式在 `emitCenterEvent` 之前自己寫，`emitCenterEvent` 從不清它：explode 是爆炸的前 5 隻（依 ID，死的也留），每顆都寫，不管有沒有人在聽；freeze 是被凍結的敵人加上 `FREEZE_LIST_RADIUS` 內最多 4 隻（依 ID），只在有人讀時才建（`listNeeded`）；chainJump 與 droneImpact 設 `listCount = 0`，hook 才不會把上一次 explode 的清單當成自己的。新的中心事件也要自己寫 `listCount`。
- **分送**（`fireOne`）：explode 與 freeze 上沒有選擇器的觸發，只作用在目標本身的狀態效果（`CompiledEffect.fanout`：沒有半徑的 `applyAilment`、`addFrost` 與 `detonate`）對清單裡每隻活著的敵人各排一次（效果在外層迴圈），其他效果排一次；一次觸發還是只擲一次機率、只重設一次冷卻。
- **chainJump 的監聽**：機率在編譯時固定為 `min(1, 0.3 × coef)`（`CHAIN_JUMP_CHANCE`；資料寫機率是驗證錯誤）。每個觸發每次攻擊最多觸發 `CHAIN_JUMP_EVENT_CAP` 次（`ctx.triggerState` 的 `capSerial`、`capCount`，依攻擊序號重算），在選擇器與機率之前檢查，超過的不擲骰、記 `centerEventsCapped`。
- 派發的關卡順序見 §4.4.8。被 chainJump 上限或選擇器擋下的觸發不擲骰、不重設冷卻，但 nthAttack 已經計數，和條件不成立一樣。

#### 4.7.6 地面區域與脈衝

`src/sim/systems/zones.ts`。區域池 `ctx.sys.zones`（`ZonePool`，`SimState.zones` 共用）：`groundZone` 效果加效果區域，熔岩彈加招牌區域（火地）。

- **脈衝的規則（C8）**：ID 為 `id`、在 tick c 建立、共 n 次的區域，在 (c, c + 15n] 裡 `t ≡ id (mod 15)` 的 tick 脈衝，剛好 n 次，不管是哪個階段建立的，所以同時建立的區域在不同 tick 脈衝。`n = max(1, round(durationSec × 4))`；`expiresAt` = c + 15n，到了 `expiresAt` 或之後的第一個 zones 階段（先跑這個 tick 該有的脈衝）才釋放它、發 `zoneEnd`，所以最後一次脈衝之後它最多還在池裡 14 tick，照樣算進上限。
- **上限（K5）**：一個來源已經有 16 個效果區域時，新的擠掉它自己最舊的；否則池裡滿 64 個效果區域時擠掉全場最舊的效果區域；招牌區域滿 16 個時擠掉最舊的招牌區域。每次擠掉記 `zonesEvicted`、發 `zoneEnd`（`evicted: true`）。
- **記錄**：一個區域的參數從建立到結束都留在它的記錄（`ZonePool.record`、`free`），結束時只搬依 ID 排列的槽。沒有任何擊中會新增或結束區域（擊殺與凍結只排佇列），所以脈衝進行中槽不會移動。
- **每次脈衝**：`grid.within` 寫進 `zones.targets`，每隻活著的敵人依 ID 先吃區域的擊中（每秒傷害比例 ÷ 4 不為 0 時），再套區域自己的狀態（異常狀態層數、冰冷、減速），最後是 `inZone` 標記（只有某個 `inZone` 條件指名的來源才寫）。減速與標記維持 16 tick，所以待在區域裡的敵人一直帶著；有區域減速時移動不走快速路徑（`sys.zones.slowApplied`）。只有狀態的區域（`damagePctPerSec` 0）沒有擊中，也不擲骰。
- **擊中**（`hitPulse`）照 `hitWithPayload` 的順序擲骰並施加異常狀態（Hoshi 的 Q4 (B)）：暴擊 → 點燃 → 中毒、流血、感電的擲骰 → 傷害 → 燃燒 → 其他異常狀態 → frostOnHit；效果區域在 `effects` stream，火地在 `combat`。和一般命中不同的三點：
  - 不發 `hit` 事件：擊中加進脈衝的統計（`ctx.sys.pulse`，`PulseAcc`），打到東西的脈衝發一個 `pulse` 事件（`kind: 'zone'`）。施加的異常狀態照樣發它們的事件與觸發。
  - 燃燒記錄滿了時，脈衝擊中的燃燒與區域自己燃燒的每一層，都只在比最弱那層強時才取代它（`applyPulseBurn`，Hoshi 的 Q4/F4）；被拒的燃燒什麼都不改、不發。其他燃燒（命中、`applyAilment`、擴散）照舊規則。
  - 火地的酬載帶 `ALWAYS_IGNITES`（`Payload.flags` 的位元 20，`1 << 20`，不在 `HIT_BITS`）：點燃的骰照擲，結果一律點燃（Hoshi 的 Q4/F1）。
- **安靜的派發**：有東西聽擊中，但每個 hit／crit 觸發都只吃招牌攻擊的擊中、而這個酬載不是，又沒有 `onHit` hook 時（`hoistPulseRows` 設 `quiet`），脈衝的擊中只留下派發的計數（`quietDispatch`），不逐一跑觸發。

#### 4.7.7 線段

`src/sim/systems/segments.ts`。線段授予（雷網）的發射器在 segments 階段跑（`ctx.sys.segments.emitters`）：每 `em.interval` tick（`periodSec`，0.25 秒是 15）判定一次，相位 `(3 + 4 × index) % 15`（`em.timer` 從負值起算），所以各發射器在不同 tick 判定。

- 端點是帶感電的活敵人（依 ID）。每個端點用端點自己的空間格（`segments.grid`、`nearestTwo`）連到 `range` 內最近的 1 或 2 個端點，兩邊互連的只算一條。每條線用主空間格的框查詢（加 `ctx.shotPad`）與大型敵人的補查，標記半徑內的敵人（`Enemy.segMark`）；然後依 ID 掃一次，被標記的各吃一下，沒死的加 `shockStacks` 層感電（不擲骰）。端點在自己的線上，所以也會被打。
- 擊中標籤 `hit|lightning|area`（沒有 `chain`：不吃過載、不算預算、不發 chainJump），會暴擊、**不擲異常狀態**（Q4 (B) 只指名區域與光環，線段維持 (A)，Q4/F7），在 `combat` stream；加進脈衝統計，端點有 2 個以上的判定發一個 `pulse` 事件（`kind: 'segment'`），線的端點寫進 `SimState.segments` 給畫面。

#### 4.7.8 授予：荊棘、落雷、光環、環繞

`src/data/emitters.ts`（授予的型別與預設值）、`src/sim/emitters/types.ts`（`grantEmitter`、`emitterPayload`）。天賦節點的 `emitters` 授予發射器：thorns、segment、strike、aura、orbit，C5 加了 drone。

- `compileBuild` 把授予接在招牌攻擊（第 0 個）之後，依資料順序，同一個（種類、來源、key）只留第一個（`grantKey`：segment 的 `endpoints`、strike 的 `name`、drone 的 `name`（沒寫是空字串）、orbit 的 `ring`（沒寫是 `'0'`），thorns 與 aura 是空字串）。
- 授予的 zod schema 在 `src/data/schema.ts`（每種一個，`GRANT_SCHEMAS`，合成 `EmitterGrantSchema`），不在模擬會 import 的 `src/data/emitters.ts`，所以模擬的模組不會載入 zod。
- **Stream（C27）**：授予的發射器（荊棘、光環、環繞、落雷、線段）都在 `combat` 擲，光環與日冕擊中的異常狀態也是；不另開 `grants` stream，`RNG_STREAMS` 與它的測試都不用動。
- **荊棘**（`systems/contact.ts`）：每隻碰到角色的敵人先吃每個荊棘發射器的一擊（`hit|thorns`，預設 `damagePct` 3，會暴擊、擲異常狀態，深度 0，不是攻擊）；被殺死的不扣生命、不漏怪、不發 heroHit，只派發 contact。
- **生命比例的快照**（C4 設計 D20、N10）：`ctx.evalInput.playerLifeFrac` 每 tick 只在 contact 階段最後寫一次，所以荊棘擊中讀到的 `lifeLostPct` 縮放是上一 tick 的值，效果階段的治療也要到下一次快照才看得到。刻意保留：這是最便宜的正確讀法。
- **落雷**（`emitters/strike.ts`）：固定週期（不看攻速），計時從 0 起。每次落雷是一次攻擊：選擇器從角色選目標（`'player'` 是驗證錯誤；選不到這次就沒了），目標吃一下（算預算 1），還活著就加 `shockStacks` 層感電；然後 `radius` 內其他活敵人依 ID 各吃一下（不算預算）；最後在一般路徑跑固定的 `chainJumps` 跳（`em.chainPayload`，每跳感電，沒有連鎖策略）。選擇器由 `createRunContext` 編（`emitters/types.ts` 不能 import `select.ts`，§4.7.15）。
- **光環**（`emitters/aura.ts`）：每 15 tick 在相位 `(3 + 4 × index) % 15` 脈衝，`auraRadius`（160）內的活敵人依 ID 各吃一下，照區域脈衝的規則擲骰並施加異常狀態（`hitPulse`，Q4 (B)），深度 0、沒有 origin；`em.attacks` 數脈衝。`em.interval` 是 `PHASE_TICKS`，執行時不讀。
  - 聚能脈衝（`everyNth`）：只有第 n 次脈衝作用、× `mult`；其他次只計數，不查詢、不擊中、不擲骰、不發事件。
  - 日冕（`corona`）：`em.timer` 數到它的週期，全場每隻活著的敵人吃一下日冕酬載（`em.alt`）；日冕不算脈衝。同一個 tick 先脈衝、再日冕。
  - **脈衝與日冕都只在打到至少一隻敵人時才發 `pulse` 事件**：`kind: 'aura'`、`id` 是發射器編號，日冕的也是 `'aura'`。
- **環繞**（`emitters/orbit.ts`）：`count + floor(orbitCount)` 顆球（開局固定，經過 `countOf`）平均排在環上（ring 0 半徑 110、ring 1 半徑 180），每秒 `revPerSec` 圈，位置每 tick 由公式算、不擲骰。每 tick 每顆球依 ID 打它碰到的活敵人，除非這顆球在 `em.interval` tick（`round(cooldownSec × 60)`，預設 30）內打過牠：**每顆球有自己的冷卻**（Hoshi 的 Q13 (B)），其他球照樣可以打。
  - 記憶是 `em.orbs`（`OrbMemory`，`createRunContext` 用 `createOrbMemory` 建）：每顆球 `ORB_MEMORY` 格的環形緩衝，依擊中順序排，也就是冷卻結束的順序；到期的從頭離開，滿了還要記一隻時丟掉最舊的並記 `orbMemoryFull`（那隻可能在冷卻結束前再被同一顆球打）。擊殺不清記憶：敵人 ID 不會重用。
  - 球數沒有上限常數，也沒有夾住：每圈 8 顆是內容要守的界線（B4 讓內容留在界內，或加上限）。環繞的擊中照一般命中發 `hit` 事件，不是攻擊。

#### 4.7.9 觸發的目標選擇器

`src/sim/effects/select.ts`。`TriggerSpec.target`（`{pick, ailment?, from?, range?, excludeEventTarget?, excludeBoss?}`）讓觸發的效果作用在另選的敵人，而不是事件的敵人。

- 每次觸發選一次，在條件之後（條件照樣讀事件的敵人）、機率之前；選不到就不觸發。選到的放進佇列項目的目標：範圍與狀態效果以它為中心（`CompiledEffect.atTarget`；它在效果執行前死了，就以死亡的位置為中心），`'player'` 以角色為中心、沒有目標；有方向的效果（`projectiles`、`slashLine`、`chainBolt`）從自己的起點朝它。
- 選法，同值都取 ID 小的：`nearest`（`grid.nearest`）；`farthest`、`outermost`、`highestHp`、`mostStacks`（依 ID 掃一次 `ctx.enemies`，嚴格的 `>`）；`densest`（`grid.densest`，再取最靠近格子中心的）；`player`。`from` 預設是事件的位置，沒有位置的事件從角色量。
- 選擇不配置記憶體：格子查詢都用 `createRunContext` 綁好的 `ctx.selAccept`，它讀 `select()` 寫在 `ctx.selection` 的條件。
- explode／freeze 上有選擇器的觸發不分送；當場執行的擊殺觸發不能有選擇器（轉移一律作用在死者，驗證擋掉）。
- 有 `maxTargets` 的範圍效果可以加 `order: 'nearest'`（`orderNearest`）：取最近的幾隻，否則是 ID 順序的前幾隻。

#### 4.7.10 重複攻擊與第 7 條

`src/sim/effects/execute.ts`。`repeatAttack {count, damagePct, timing?}` 把招牌攻擊再做一次，不算一次攻擊。

- 每個 `repeatAttack` 效果在開局有自己的酬載（`ctx.sys.repeat.payloads`，由 `context.ts` 的 `repeatPayload` 建）：招牌攻擊的標籤、來源、連鎖策略與列的快取，`baseDamage × damagePct`，`effects` stream，旗標 `SIGNATURE | REPEAT`。
- `'now'`（回聲）在效果階段當場跑 `count` 次；`'nextAttack'`（多重施法）把 `count` 筆放進先進先出的 `ctx.sys.repeat.charges`（最多 `REPEAT_CHARGE_CAP`，多的記 `repeatChargesDropped`），招牌攻擊下一次自己計數的攻擊之後全部跑完（`drainRepeatCharges`）。
- 每種招牌攻擊的重複攻擊在 `REPEAT_STEPS`：`fireVolleyRepeat`、`fireLobRepeat`、`fireFanRepeat`、`fireArcRepeat`，與 C5 的 `swarmRepeat`（§4.6.4）。一次重複攻擊重新選目標、有自己的攻擊與預算，但不 `countAttack`、不算一發、不是 steady、不推進形態的計數、不發中心事件；數量在重複攻擊酬載的 stream 擲。永久的形態照套（火山、稜鏡、六線圈），跟著計數攻擊的形態不套（冰柱、遠投：重複攻擊不推進它們的計數；連環爆：重複攻擊的彈不排爆炸）。
- **第 7 條**：佇列項目的旗標帶 `REPEAT`（事件來自重複攻擊的擊中）時，`repeatAttack` 什麼都不做。`REPEAT` 在 `HIT_BITS` 裡，所以重複攻擊的擊殺也帶它；重複攻擊的熔岩彈留下的火地帶 `ALWAYS_IGNITES | REPEAT`，它的脈衝擊中也不會再觸發重複攻擊（Hoshi 的 Q5/F1）。

#### 4.7.11 引爆與剩餘值

`src/sim/ailments/remaining.ts`、`execute.ts` 的 `detonate`。

- **剩餘值**（`remainingOf`）是異常狀態在敵人身上還沒造成的傷害：燃燒記錄從上一步起算（`burnLeft`），分桶環讀環的剩餘，流血是已累積的、再加上依敵人現在的速率（移動中或靜止）還會造成的（`bleedRemaining`，Hoshi 的 Q7 (A)）。被燃燒或毒的那一步殺死的敵人沒吃到那一步的流血，所以牠的流血從上一步起算（Q7/F1）。
- **取走**（`consumeAilment`）比例 f：每層照樣繼續、傷害 × (1 − f)，層數不變（分桶環每一桶一起縮放，`RingPool.consume`）；f = 1 整個移除。
- **detonate**：活的目標取 `fraction × 剩餘值`（並從牠身上取走），× `damage`，打目標或半徑內每隻（`maxTargets`、`order`），每隻吃同樣的量。酬載是 `PRESCALED`（不再乘傷害列：剩餘值已經乘過）、不會暴擊、不擲異常狀態，所以不擲任何骰。擊殺類事件（kill、diedWithAilment、shatter）上的 detonate 讀待處理擊殺的值：`recordPendingKills` 在歸還分桶環之前記下死者的剩餘值（只給 `CompiledTrigger.detonateAilment` ≥ 0 的觸發），不取走任何東西；驗證要求半徑與同一種狀態的 `victimHas`。
- `stacksAtLeast` 的 `'max'`（`build/eval.ts` 的 `STACKS_AT_MAX`）讀層數上限：燃燒是 `burnCapOf`（`records.ts`；無盡烈焰下是 `BURN_RINGS_MAX_STACKS` 5，否則 `ctx.burnCap`），感電是 `shockCapOf`（`shock.ts`）。它們放在施加者旁邊、不放 `remaining.ts`，是 import 規則的要求（§4.7.15）；只有 `execute.ts` 與 `dispatch.ts` import `remaining.ts`。

#### 4.7.12 toSplitChildren

`spreadAilment` 的 `toSplitChildren: f`（只用在當場執行的擊殺觸發、只有毒）：死者分裂出的每個子怪拿到死者毒的 f（剩餘傷害與活著的層數，`ailments/apply.ts` 的 `spreadPoisonToChildren`），不管牠在哪，也不管 `effect`、`stacks`、`maxTargets`。`fireInlineKill` 把通過的觸發記在 `ctx.sys.split.passed`；`killEnemy` 在 `split` 之後的步驟 2b（`death.ts` 的 `splitTransfers`）給 `ctx.enemies[first ..]` 的子怪，深度 `min(killDepth + 1, MAX_DEPTH)`，然後清掉記錄。不查格子、不擲骰、不發事件。

#### 4.7.13 其他新效果

`src/sim/effects/execute.ts`（每個欄位的意思在 `src/data/triggers.ts`）。效果的擊中都走 `hitWithPayload`，用效果自己的酬載（`effects` stream），帶佇列項目的深度與 origin。

- `groundZone`：在事件位置（或選擇器選到的敵人）加一個效果區域（§4.7.6）。
- `projectiles`：在投射物池產生小投射物（`spawnShot`，受 `PROJECTILE_CAP` 限制），從事件位置或角色出發；`target`、`distinct` 追蹤，`radial`、`fan` 直線（§4.7.3）。
- `slashLine`：一條線，依 ID 各打一次線寬一半加上自身半徑內的敵人（`grid.inSegmentBox` 加大型敵人的補查）；`'along'` 只用在 chainJump，沿著那一跳的角度。`slash` 事件在擊中之前。
- `coinHit`：對目標一擊，`coin` 事件在前；酬載帶 `bypass` 位元，給 C7 的護盾與堅甲。
- `chainBolt`：自己的一次攻擊，第一下算預算 1，然後正好 `jumps` 跳（一般路徑、沒有策略，整數跳數不擲骰），每一下沒殺死就加 `shockStacks` 層感電；不發 chainJump。

#### 4.7.14 暫存緩衝的擁有者

規則（C4 設計 §4.0）：一個緩衝只有一個擁有者會寫它；擁有者迭代它的時候，迴圈裡走得到的程式不能寫同一個緩衝。一次擊中同步走得到的只有 `applyHitDamage` → `dispatchHit`（觸發只排佇列）→ `killEnemy`（轉移、`onKill`、分裂、toSplitChildren）→ 施加異常狀態 → `addFrost` → `raiseFreeze` → `emitCenterEvent`（觸發與 hook 只排佇列），所以表裡的緩衝，一次擊中只會寫 `ctx.spreadTargets`、`ctx.centerEvents.freezeTargets` 與 `ctx.centerScratch.list`（下表的「擊中」）。表外的：擊中同步派發的觸發有選擇器時（`passes` → `select`），會寫 `ctx.selected` 與 `ctx.selection`（同一個 `fireOne` 馬上讀完，沒有擁有者跨過擊中持有它們）；`densest` 選法還會換掉空間格最後一次 `densest()` 的區塊，所以 `aimDense` 的 `densest` 與 `blockItems` 要緊接著呼叫，中間不能跑任何選擇器（C4 設計 §4.0、N6）。連鎖不會在連鎖裡開始：只從發射器、落地、子彈的步驟與效果開始。C5 的列見 §4.6.5。

| 緩衝 | 唯一的寫入者 | 迭代中寫得到的 |
| --- | --- | --- |
| `ctx.effectTargets` | 佇列裡的效果（效果不會巢狀執行） | 擊中 |
| `ctx.spreadTargets` | 異常狀態的擴散 | 沒有：擴散不打任何東西 |
| `ctx.sys.zones.targets` | `stepZones` 的脈衝 | 擊中 |
| `ctx.sys.pulse` | 脈衝的擁有者（區域脈衝、線段判定、光環與日冕）：歸零、`hoistPulseRows`，再當 `acc` 往下傳 | 沒有：只有 `hitPulse` 會加，擊中走不到另一個脈衝 |
| `ctx.sys.lob.blast` | `land` | 擊中；複製進清單在所有擊中之後 |
| `ctx.sys.lob.block`、`counts`、`aimed`、`picked` | 一次發射的瞄準（`aimDense`、`aimFar`） | 沒有 |
| `ctx.candidates` | `boxIndices` 的呼叫者（直線子彈、線段的標記） | 沒有：精確測試完才打 |
| `ctx.shotHits` | 直線子彈的步驟，精確測試之後 | 擊中；冰錐主要命中的連鎖寫 `ctx.sys.chain` |
| `ctx.centerScratch.list` | 發出事件的程式，緊接在 `emitCenterEvent` 之前 | 沒有：分送只排佇列、hook 只讀 |
| `ctx.sys.chain.frontier`、`next`、`far` | `chainGeneral`、`farthestChainTarget`（`frontier` 的根由呼叫者放：`chainFrom`、三相雷、落雷、chainBolt） | 擊中 |
| `em.targets` | 自己的發射器（落雷的範圍、光環、環繞） | 擊中（別的發射器是另一個陣列） |
| `em.orbs` | 自己的環繞發射器，每顆球擊中之前 | 沒有 |
| `ctx.shots.distinct` | `projectiles` 效果的 `'distinct'` | 沒有：只產生子彈 |
| `ctx.sys.segments` 的 `ends`、`pick1/2`、`a/b`、`nearTwo` | `stepSegments` | 擊中 |

可以長大的陣列（`ctx.candidates`、`shotHits.t`、`segments` 的 `pick1/2`、`a/b`、線的座標）長大後要重新讀；其他成員從不換掉，迴圈前讀進區域變數就一直有效。

#### 4.7.15 物件形狀與 import 規則

**形狀**（C4 設計 §0.7）：

- V8（node 22）只在少於 128 個屬性時，讓同一個物件字面值的每次建立共用 hidden class；超過了，每局的 `createRunContext` 都有自己的 map，系統裡的 `ctx.x` 幾局之後就變成 megamorphic（C4.4 在 130 個屬性量到 `normal` 慢 24%）。所以 `RunContext` 要留在 128 以下、至少空一格：現在 125，`src/sim/simulation.perf.test.ts` 到 128 就失敗。**不要再加頂層成員**：
  - 系統自己的狀態放進 `ctx.sys`（`SystemState`）的成員，一個系統一個：`pulse`、`zones`、`lob`、`repeat`、`split`、`segments`、`chain`、`drones`。
  - 每個發射器的緩衝放 `EmitterRuntime`（`em.targets`、`em.orbs`：每種發射器都在 `createEmitterRuntime` 的字面值裡，用不到的是 `null`），投射物系統的放 `ShotPool`。
  - 一組相關的暫存放一個子物件：`ctx.selection`（選擇器）、`ctx.centerEvents`（誰聽中心事件、freeze 清單的查詢緩衝）。
- **一個形狀一個字面值**：熱路徑讀的物件（`Enemy` 57 個屬性、`Payload` 19、`EmitterRuntime` 17、`ShotPool` 28、`CompiledTrigger` 18、`CompiledBuild` 15、`ctx.triggerState`、`ctx.centerScratch`）都由一個字面值（或成員與順序都相同的幾個）建立，每個成員都初始化，之後不再加成員；新成員加在擁有者的字面值裡。`createPayload` 依固定順序寫每個成員、不展開 `PayloadSpec`（選用的鍵會讓酬載有不同的 map）；`extraJumpPayload` 先放型別化的佔位，建好之後再指向酬載自己。
- `ctx.counters` 是在迴圈裡逐鍵寫進 `{}` 的，到 19 個鍵還是快速模式；現在 17 個，`simulation.perf.test.ts` 擋在 20 以下，加第 20 個之前要改成一個字面值。
- 熱路徑的區域變數：每次擊中、每發子彈、每個區域或每隻敵人跑一次的迴圈，把用到的子物件（`ctx.sys.zones`、`ctx.shots`、`ctx.chainBudget`…）在迴圈前讀進區域變數，一次呼叫最多讀一次 `ctx.sys`；脈衝的統計由擁有者讀一次，當參數 `acc` 往下傳。
- `createRunContext` 的建立順序：`chainRetention` 與連鎖策略在發射器的酬載之前；發射器（落雷的選擇器、冰柱與日冕的酬載、環繞的 `OrbMemory` 在這裡建好傳進去）；`zones`、`segments` 與 `shots` 在 `SimState` 的字面值之前；重複攻擊的酬載在效果酬載旁邊；最後是 ctx 的字面值，`sys` 在裡面一次建好。工廠函式都不讀 `ctx`。

**Import 規則**（C4 設計 §0.7、LD2）：

- **在模組頂層求值的登錄表或常數，只能引用會提升的函式宣告，不然就要放在任何循環之外的模組。** 從循環外的模組讀的值（core、`caps.ts`、`effects/types.ts`、資料模組）一定已經求值，所以只有讀同一個循環的值受限：從循環的另一邊進來時，同一個循環裡的 `const` 還在 TDZ，Node 會丟 ReferenceError，Vitest 會讀到 `undefined`。所以 `EMITTER_STEPS`（`systems/emitters.ts`）與 `REPEAT_STEPS`（`execute.ts`）的每個值都要是函式宣告，不能是箭頭函式的 `const`。
- **依工具鏈的根據**：「函式宣告一開始就有定義」對載入 `src/sim` 的三個工具鏈各自成立。Vitest 5.0.4 用 Vite 7.3.7 的 ssrTransform，在模組最上面、它的 import 之前，把每個 export 定義成 getter（`try { return local } catch {}`，所以 TDZ 裡的 `const` 讀到 `undefined`）；`tools/` 用的 tsx 4.23.15 走 Node 的 ESM 連結（`"type": "module"`），任何模組本體執行之前就初始化函式宣告；網頁 build 的 Rollup 每個 chunk 一個 scope，函式宣告會提升。換一個到模組結尾才定義 export 的執行器或打包器，連函式宣告也會壞。
- **葉模組**：每個 `ctx.sys` 工廠與它的型別都在 `src/sim/systems/systemState.ts`，系統從這裡 import 狀態的型別。它的 value import 只能是 `core/num.ts`、`sim/caps.ts`、`sim/build/sources.ts`、`sim/build/eval.ts`、`sim/systems/grid.ts`（與 `grid.ts` import 的 `sim/grid.ts`、`sim/types.ts`），其他都是 `import type`。守門測試 `src/sim/systems/systemState.test.ts` 用 `node:fs` 讀它與它遞移 value-import 的每個模組，檢查（1）直接的 value import 都在清單（`LEAF_IMPORTS`）裡、（2）走不到 `systems/context.ts`，也走不到自己、（3）沒有循環；也檢查 `remaining.ts` 的 value import（`REMAINING_IMPORTS`），以及只有 `execute.ts`、`dispatch.ts` import 它。整個宣告是 `import type …` 或 `export type … from` 才算只有型別：在 `verbatimModuleSyntax` 下，`import { type X } from './m'` 仍然載入 `./m`。
- **葉模組怎麼保持是葉**：它的閉包經過 `build/eval.ts` → `effects/flags.ts` → `emitters/types.ts`（`flags.ts` 在頂層讀 `SIGNATURE`），還有 `eval.ts` import 的異常狀態模組與資料模組；其中任何一個 value-import 會回頭 import 它的模組，就形成循環。所以 `emitters/types.ts` 只用型別 import `ChainPolicy`，連鎖策略由 `createRunContext` 編好、當值傳給酬載；`emitters/types.ts` 不 import `select.ts`，落雷的選擇器也由 `createRunContext` 編；重複攻擊的酬載在 `context.ts` 建（`repeatPayload`）；層數上限的讀取放在 `records.ts`（`burnCapOf`）與 `shock.ts`（`shockCapOf`），不放 `remaining.ts`（C4.10）。閉包外的模組可以 value-import 葉模組：`context.ts` 拿工廠、`build/compile.ts` 拿 `NO_POLICY_SPEC`，還有各系統模組。
- **`REPEAT_STEPS`，不是 `SignatureModule` 的成員**：招牌攻擊與規則模組是編譯時的程式（hook 透過 `rules/api.ts` 作用），不 value-import 任何走得到 `systems/context.ts` 的模組，所以讀它們 `const` 模組物件的 `rules/index.ts`（`SIGNATURES`、`RULE_MODULES`）也在循環外。重複攻擊如果是模組的成員，每個招牌攻擊模組都要 import `volley.ts`、`lob.ts`…，`rules/index.ts` 就會經過 `context.ts` → `build/compile.ts` 被拉進循環。`src/sim/rules/importOrder.test.ts` 守這件事：每個規則模組在新的模組登錄表裡第一個被 import，接著 import `rules/index.ts` 與 `systems/context.ts`，兩個登錄表的每一項都要有定義；執行器在 TDZ 丟錯或回傳 `undefined`，它都會失敗。
- **C4.5b 的修正**：刪掉 `context.ts` 對 `systems/emitters.ts` 的 import（原本是 `context.ts` → `systems/emitters.ts` → `volley.ts` → `context.ts`），現在只有 `simulation.ts` import `systems/emitters.ts`；之後的 `ctx.sys` 工廠都在葉模組，`createRunContext` 不為了工廠 import 任何系統模組。它沒有讓 `context.ts` 離開循環：`context.ts` 還 import `shots.ts` 的 `createShotPool`，其他回到 `context.ts` 的路徑（例如 `shots.ts` → `lob.ts` → `volley.ts` → `context.ts`）也還在，靠上面的頂層規則與 import 順序測試守住。
- **剩下的循環**，在 fa8a663 量的（一段腳本讀 `src/` 所有非測試模組的非型別 import 與 re-export，用和 `systemState.test.ts` 相同的規則判斷只有型別，再求強連通分量）：只有一個，15 個模組：
  - `systems/`：`context.ts`、`shots.ts`、`death.ts`、`zones.ts`、`drones.ts`
  - `combat/`：`hit.ts`、`chain.ts`、`policy.ts`
  - `effects/`：`centerEvents.ts`、`dispatch.ts`、`execute.ts`
  - `emitters/`：`volley.ts`、`lob.ts`、`fan.ts`、`arc.ts`
- 成員之間只靠呼叫連起來（例：`shots.ts` 呼叫 `land`；`REPEAT_STEPS` 指向 `fireVolleyRepeat`、`fireLobRepeat`、`fireFanRepeat`、`fireArcRepeat` 與 `drones.ts` 的 `swarmRepeat`），除了 `REPEAT_STEPS` 在 `execute.ts` 頂層引用的這五個函式宣告，沒有一個在頂層讀同一個循環的值。從外面走到它、沒有被成員 import 回去的，`src/` 有 25 個：`sim/` 的 `simulation.ts`、`index.ts`、`testing.ts`，`systems/` 的 `ailments.ts`、`contact.ts`、`emitters.ts`、`projectiles.ts`、`segments.ts`、`waves.ts`，`emitters/` 的 `strike.ts`、`aura.ts`、`orbit.ts`，`app/` 的 `input.ts`、`loop.ts`、`main.ts`、`playtest.ts`、`session.ts`，`meta/index.ts`、`meta/startWave.ts`，`render/` 的 `backdrop.ts`、`damageNumbers.ts`、`drones.ts`、`index.ts`、`player.ts`、`renderer.ts`；`tools/balance/` 另有 15 個。
- `src/sim` 在每個循環之外、也走不到它的有 43 個：葉模組與它的閉包、`emitters/types.ts`、`emitters/drone.ts`、`effects/` 的 `types.ts`、`select.ts`、`flags.ts`、`queue.ts`，所有 `build/` 與 `ailments/` 模組（含 `remaining.ts`），`rules/` 的 15 個模組（招牌攻擊、形態、規則模組、`index.ts`、`api.ts`、`module.ts`），以及 `movement.ts`、`spawn.ts`、`runEnd.ts`、`targeting.ts` 等。其中幾個在頂層讀彼此的 `const`（`modTable.ts` 的 `ESTIMATE = staticInput()`、`apply.ts` 的 `DAMAGE = SCOPED_INDEX.damage`、`records.ts` 的 `BURN_TICK_INTERVAL = DOT_STEP_TICKS`），只因為它們在循環之外才合規；C4.10 把層數上限的讀取放在 `records.ts` 與 `shock.ts`，就是為了不讓它們進入循環。

### 4.8 C6 的角色局

`src/sim/types.ts`、`src/sim/simulation.ts`、`src/sim/build/compile.ts`、`src/sim/build/sources.ts`（C6 設計 D7–D10、§3.7、§4.2、§5.2）。一局有 `RunConfig.character`（`CharacterRun`：角色 ID 與擁有節點的 `SourcedRule`）就是 v3 角色局，沒有就是 M1 的局：編譯與執行都和 C6 之前完全一樣（`jumpSource` 是 −1、`jumpCredit` 原樣傳回、同一個規則迴圈），所以指紋、golden、既有的 GOLDEN-C4 案例、T6 與平衡探針都不變。角色從不由招牌攻擊推回來：那樣會改掉每個不帶角色、用 v3 招牌攻擊的 GOLDEN-C4 案例與 `hive` 場景的歸屬。M1 的工作階段、平衡模擬器的 CLI 與 `?hive` 仍是 M1 的局。

- **設定檢查**（`validateConfig`）：角色局的 `RunConfig.rules` 要是空的（規則在 `character.rules`），招牌攻擊要是 `CHARACTER_SIGNATURE[id]`；每條規則的係數在 [`COEF_MIN`, `COEF_MAX`]（0.1–10）裡，同一個規則 ID 只能有一個來源、一個係數。帶係數的觸發（不分是不是角色局）係數也要在這個範圍裡，其中每個轉移效果（`spreadAilment`）的 `(effect ?? 1) × coef` 要小於 1。沒有係數的觸發（所有 M1 的觸發）不檢查。
- **歸屬**（`AttributionPolicy`）：角色自己流派的異常狀態算 `center`（`ownAilments`：熔核燃燒、霜晶冰冷、雷塔感電、蜂巢沒有），其他種類照 §4.4.4 算各自的外盤，融合施加的算那條融合；M1 用 `M1_CENTER_AILMENTS`，全部算 `center`。
- **中心的跳躍**：熔核、霜晶、蜂巢的局在資料觸發編譯完、招牌攻擊與規則之前，立刻替 `outer.lightning` 編號（F37），所以它的編號只看資料觸發；沒有東西連鎖時它是一列 0。`AttributionPolicy.jumpSource` 存這個編號（雷塔與 M1 是 −1），`jumpCredit(policy, source)` 對 `center` 的酬載傳回它、其他來源原樣傳回。`emitterPayload`、`turretPayload` 與 chainBolt 效果的酬載（`effectPayload`）在開局建酬載時各算一次 `jumpSource`，之後每次擊中不多做事；衍生的酬載（落雷的連鎖、冰柱、日冕、重複攻擊）照抄，熔岩彈的火地酬載不連鎖，不設 `jumpSource`（它的重複攻擊版本靠 `rowsOf` 共用它的列）。`signatureRows` 的跳躍列也用它，所以估計讀到的就是一局用的列。雷塔的跳躍留在 `center`，昇華模組加的跳躍也是（gd:575）。
- **帶來源的規則**（D9）：`character.rules` 依規則 ID 第一次出現的順序分組，每組編譯一次，在那塊盤的來源（組裡第一條的 `source`）：模組的 `compile` 收到那個來源的編號，`BuildCompiler.credit()`（`RuleCredit`：編號與來源 ID）讓模組把自己加的觸發、效果與發射器記到自己的盤。M1 的局維持原本的迴圈，全部在 `center`。
- **係數**（D10）：融合盤的觸發帶 `SourcedTrigger.coef`，編譯時用 `coef ?? 1`：效果的 `COEF_FIELDS` 乘上係數（沒寫的欄位當 1），觸發的機率也乘上係數、上限 1（chainJump 固定的 0.3 也算）。融合盤的規則從 `scaleRuleSpec` 縮放過的 spec 編譯，只動 `RULE_COEF_FIELDS` 列出的欄位（`pct`、`mult` 乘上係數，`chance` 乘完上限 1），所以模組看不到係數，不會忘了乘，也不會乘兩次。`RULE_COEF_FIELDS` 目前是空的，每個手寫模組落地時加上自己的那一項。
- **連鎖策略的檢查**：`chainPolicy()` 寫的連鎖策略加的跳躍與反彈，是招牌攻擊酬載的 `extraJumpPayload`（就是酬載自己）打的，算中心的跳躍。所以角色局裡，只有編譯位置等於中心跳躍歸屬的實例能呼叫它（熔核、霜晶、蜂巢是 `outer.lightning`，雷塔是 `center`），雷塔的昇華節點（`asc`）例外：那些跳躍也是中心的（C-1、F38）。其他位置呼叫時編譯就丟錯，內容不會悄悄把跳躍記到別處。連鎖策略只能由規則模組透過這個呼叫寫，所以八個連鎖策略 ◆（跳電、電荷、遠雷、分岔、回彈、蓄電、渦流、導雷）都是規則模組；資料驗證（V6）在 ◆ 上除了中心的形態，只接受 `POLICY_RULES`（`src/data/rules.ts`）列出的規則 ID。`POLICY_RULES` 目前是空的，每個連鎖策略模組落地時在同一個 commit 加上自己的 ID（D8、F50）。
- 物件形狀不變（§4.7.15）：`RunContext` 仍是 125 個屬性、`ctx.sys` 沒有新成員、`COUNTER_IDS` 不變、`CompiledBuild` 仍是 15 個成員（`AttributionPolicy` 多一個數字）。`src/sim/build/sources.ts` 仍是葉模組的允許 import（只 import `src/data`）。
- GOLDEN-C4 的 `v3fire`、`v3ice`、`v3lightning`、`v3summon`（每個角色一局）一起釘住歸屬、跳躍列、帶來源的規則與係數；`npm run bench` 的 `v3fire` 場景讓 CI 計時一局角色局（§12）。

## 5. 大數字

- 設計天花板 ≤ 1e300，所以 `Num` 是加上品牌的 `number`：`type Num = number & { readonly __num: unique symbol }`。
- 所有大數的建立、運算、比較、序列化都走 `src/core/num.ts`，格式化在 `src/core/format.ts`（只透過 `toNumber()` 讀值）。換成 break_eternity.js 時只改這個模組與用到原生運算子的地方。這是有意識的取捨：換實作會需要重構，但 1e300 的上限讓這件事大概不會發生。
- 開發 build 與平衡模擬器會檢查 `Infinity`／`NaN`，一出現就報錯並印出當下 build。
- 格式化可設定：
  - `short`：1.23K、4.56M、7.89B，1e15 以上改科學記號
  - `scientific`：1.23e15
  - `engineering`：123.4e12
  - `cjk`：1.2萬、3.4億、5.6兆（繁中預設）

## 6. 資料檔

- 每類資料一個 TS 檔，用 `satisfies` 拿到編輯器型別提示，載入時再過 zod schema。
- M1 天賦節點：`{ id, kind, pos: {x, y}, links: id[], 價格欄位, modifiers, rules, triggers, conversions, archetype, nameKey, descKey? }`（`src/data/types.ts`）。修正、規則、觸發與轉換見 §4.4；節點有規則、觸發、轉換或行為修正（帶標籤的非傷害屬性、`notTags`、`when`、`scaling`、`*Always`）時必須有 `descKey`。
- 驗證（Vitest 裡也跑一次）：ID 唯一、連線雙向、從起點全部可達、keystone 數量在範圍內、每個 i18n key 在 en 與 zh-TW 都存在。節點效果的合法性（`nodeEffectIssues`）、外盤 ★ 的流派規則（`starArchetypeIssues`）與發射器授予的衝突（`grantConflicts`）是 `src/data/validate.ts` 匯出的函式，訊息開頭由呼叫的人給（M1 是 `talent '<id>'` 與 `talents`），v3 的內容驗證也用同一份；M1 的訊息一字不變。
- `tools/talent-viewer`：開發用頁面，畫出天賦網並標示錯誤，存檔後熱更新。不做拖拉編輯。
- v3 天賦網（C6）是另一份內容：M1 天賦網照舊是 `loadGameData().talents`；v3 天賦網的型別、schema 與 ID 文法在 `src/data/web/`，`src/data/index.ts` 不 re-export 這個資料夾。`src/data/web/isolation.test.ts` 讀各檔自己寫的 import，確認 M1 天賦網的使用者（`src/meta/talents.ts`、`src/meta/stats.ts`、`src/app/session.ts` 與 `tools/balance/` 的每個檔）和 `src/data/index.ts` 都不 import v3 天賦網的模組（`src/data/web/`、`src/data/templates.ts`、`src/data/hub.ts`、`src/data/characters/`、`src/data/outer/`、`src/data/fusion/`），這些模組也不 import M1 天賦網與 `src/data/index.ts`，`src/sim` 不讀 `.talents`。
- v3 的內容型別在 `src/data/web/types.ts`：節點 `WebNode { id, kind, board, slot, ranks, effects, answers }` 沒有座標也沒有連線（邊記在盤 `BoardDef` 上，位置由排版從 `slot` 與盤的鐘點算出），`kind` 有 11 種（`WEB_NODE_KINDS`），`effects` 就是 M1 節點的五個陣列（修正、觸發、轉換、發射器、規則）；另外有角色 `CharacterDef`（`center`、`ascendancies` 在該批內容做好前是 `null`）、外盤 `OuterDef` 與它的融合酬載 `OuterPayload`、融合覆寫 `FusionOverride`、校準紀錄 `CalibrationEntry` 與範圍 `WebScope`。構造體的 ID（`CONSTRUCT_IDS`）也定義在這裡，`src/render/constructs` re-export。
- `src/data/web/schema.ts` 的 zod schema 由 M1 的 schema 組成，全部是 strict（多一個欄位就報錯），輸出型別用 `exact` 檢查和介面相同。酬載效果（`PayloadEffectSchema`）不能寫中心事件決定的落點欄位：slashLine 的 `from`、`toward`，projectiles 的 `from`，nova 的 `at`。
- 節點 ID（`src/data/web/ids.ts`）：中心盤 `<角色>.center.<分支>.<名稱>`、樞紐環 `hub.<群組>.<名稱>`、外盤 `outer.<外盤>.<分支>.<名稱>`、融合 `fusion.<角色>.<外盤>.<槽>`、昇華 `<角色>.asc.<slug>.<槽>`。分支外的節點放在假分支 `main`；◆ 與 ★ 用 slug（kebab-case 英文，不能是 `main`、`signature`、`threshold`、`entry`、`mastery`、`core`、`final`、`might` 或 `r<n>`、`c<n>`、`n<n>`），其他節點用固定的槽名（中心盤分支上 `r1`–`r6`、`mastery`，`main` 上 `signature`、`threshold`、`c1`–`c6`；外盤分支上 `r1`–`r4`、`mastery`，`main` 上 `entry`、`threshold`；樞紐環 `r1`–`r5`，強化∞ 是 `hub.might.might`；融合 `core`、`r1`–`r3`、`mastery`；昇華 `n1`、`n2`、`final`）。`parseNodeId` 不收的 ID 就是寫錯了；收下的 ID，`sourceOfNode` 一定等於它所在盤的來源，打錯字不會再默默算成 `center`。`nearestName` 找編輯距離 2 以內最近的名稱（相鄰兩個字母對調算一次編輯），給驗證訊息的「是不是要寫…」用。
- 招牌攻擊與規則的表在 `src/data/rules.ts`：`CHARACTER_SIGNATURE`（角色 → 招牌攻擊）、`SIGNATURE_EVENT`（招牌攻擊 → 中心事件）、`SIGNATURE_FORMS`（每種招牌攻擊能接的形態規則）；`RULE_COEF_FIELDS` 列出融合係數要縮放的規則欄位，`scaleRuleSpec` 照這張表縮放一個 spec（`pct`、`mult` 乘上係數，`chance` 乘完夾到 1）；`POLICY_RULES` 是 ◆ 可以帶的連鎖政策規則。這兩張表都從空的開始，每個規則模組上線時加上自己那一筆。
- v3 的內容檔：每個角色一個檔，放在 `src/data/characters/`，四個角色從 C6.3 起都登記在 `CHARACTERS`（`src/data/characters/index.ts`，選角畫面的「第一次玩推薦」是 `FIRST_PICK = 'fire'`），各帶 `docs/v3/game-design-v3.md` 的選角卡資料（主色、難度、構造體、推薦外盤、第 15 波揭露的外盤、敵人對照列）；`center` 與 `ascendancies` 在該批內容寫好前是 `null`，選角畫面顯示「製作中」。外盤一塊一個檔，登記在 `OUTERS`（`src/data/outer/index.ts`）；樞紐環是 `src/data/hub.ts` 的 `HUB`。兩者在 B1 前都是空的。內容檔只 import `src/data/templates.ts` 與型別。
- `src/data/templates.ts` 是寫內容用的函式：修正（`flat`、`inc`、`more`）、節點模板（`ranked`、`rankedMods`、`notable`、`keystone`、`threshold`、`entry`、`mastery`、`might`、`signatureNode`、`ascNode`、`ascFinal`、`answers`、`fusionRank`）與建盤函式（`centerBranch`、`outerBranch`、`ascendancy`、`defineCharacter`、`defineOuter`、`defineHub`）。作者只填槽，替 ◆、★ 與分支取 slug；建盤函式照 ID 文法替每個節點命名、放進它的槽，再加上盤的固定連線：中心盤 40 個節點、45 條邊，接口 c1–c6 在 1、3、5、7、9、11 點鐘；外盤 18 個節點、20 條邊；樞紐環 24 個節點照固定表放：12 個連成一圈，每個再向內接出一個；昇華 3 個節點。作者不寫 ID、連線或座標。`defineCharacter` 從角色 ID 推出 `archetype`、`arena`、名稱與介紹的 i18n key、招牌攻擊和它的中心事件。沒寫目標的精通由建盤函式依盤補上：中心盤是 `scope 'center'`，外盤是該流派的標籤（連擊、彈幕、貪婪沒有標籤，改成 `scope 'outer.<外盤>'`），融合是 `scope 'fusion.<角色>.<外盤>'`。`rankedMods` 的發射器只在第 1 級給一次，不會每級重複。建盤函式不丟例外：槽裡放錯模板就照寫的記下來，漏寫的槽就少那個節點，都留給驗證回報。
- 融合盤由產生器生成，作者不寫：`src/data/fusion/generate.ts` 的 `generate(角色, 外盤, 覆寫, coef)` 產生一條融合的 5 個節點，核心（1 級）、`r1`–`r3` 與精通，ID 是 `fusion.<角色>.<外盤>.<槽>`，連成核心–r1–r2–r3–精通一直線。角色接另一個流派角色的外盤是手工融合（`HAND_PAIRS`，12 條），核心是覆寫給的規則；其他 32 條是模板融合，核心是外盤酬載放到角色中心事件上的一個觸發，加上酬載的加成。產生器不看酬載是哪一種，只補中心事件決定的落點（`place`）：斬擊線在爆炸時從爆炸點朝最近的敵人，在凍結與無人機撞擊時從目標往外，在連鎖跳躍時順著跳的方向；子彈從事件點出發；新星以事件點為中心；上狀態的效果不帶半徑，爆炸與凍結時由引擎分給事件名單上的每隻敵人。加成（`bonusModifiers`）都是 `scope 'center'` 的傷害修正：`status` 是目標帶著該狀態時、`inZone` 是目標站在這條融合自己的區域裡時增加傷害，`scaling` 是縮放的修正；`inPayload` 與 `null` 不加修正。`r1`–`r3` 用覆寫的等級，沒有就用手工融合的預設 `HAND_RANKS`（3 個節點，各 3 級、每級 +10% 增加傷害）或酬載的等級；寫成 `scope 'fusion'` 的修正收窄成這條融合，所以一個外盤檔可以給它的 3–4 條融合共用。精通每級 `more 0.04` 傷害，只算這條融合。產生器不丟例外：缺覆寫的手工融合拿到空核心與 `HAND_RANKS`，沒有酬載的模板融合拿到空核心與 `EMPTY_RANKS`，都留給驗證回報。
- 覆寫在 `src/data/fusion/overrides.ts`，B1 前是空的。`OVERRIDES` 依融合逐條覆寫，套用順序是：`triggers` 取代模板的觸發，`addTriggers` 接在後面（火毒的瘟疫爆彈就是一條），`bonus` 取代酬載的加成（`null` 是拿掉），`modifiers` 接在加成的修正後面，手工融合的 `rule` 或模板融合的 `addRules` 放進規則，`ranks` 取代預設的等級，`skin` 蓋在外盤的外觀上。只有冰光與雷光（`TEMPLATE_RULE_OVERRIDES`）可以加規則。`ACCEPTED_FAILS` 記校準 FAIL 但接受的融合與理由。
- 融合係數 `coef` 在產生器裡不縮放觸發與規則（那是編譯時的事），只在模板融合的酬載標了 `coefScalesBonus`（沒有可縮放傷害的連擊、不造成傷害的光環）時乘上加成與 `r3`，`FusionDef.coefScalesBonus` 記下這件事；`r1`、`r2` 與精通從不縮放。係數的範圍是 `COEF_MIN` 0.1 到 `COEF_MAX` 10（`src/data/triggers.ts`）。`coefRange(fusion)`（`src/data/fusion/sensitivity.ts`）從核心的觸發與規則算出校準與 fuzz 用的區間：有值大於 0 的 COEF 欄位（沒寫的算 1；地面區域的 `ailmentDamagePct` 要有 `ailment` 才算）或 `pct`、`mult` 規則欄位時是 [0.1, 10]，每個效果 e 的轉移把上限壓到 0.99 / e（瘟疫爆彈的 0.5 → 1.98）；不然有機率 p < 1（機率條件、chainJump 的 0.3）或規則的 `chance` 欄位時是 [0.1, 1 / p]，p 取最大的；再不然有 `coefScalesBonus` 時是 [0.1, 10]；都沒有就是 `null`，係數什麼都不動，校準記為 insensitive。區間不會超出 [`COEF_MIN`, `COEF_MAX`]。
- 校準結果是 `src/data/fusion/calibrated.ts` 的 `CALIBRATED`，由校準工具寫入（檔頭註明是產生的檔案，不要手改），B1 前是空的。每條融合帶一個摘要（`fusionDigest`），涵蓋中心事件、模板、覆寫、照寫的等級與 `coefScalesBonus`，不含 coef，所以看得出哪條校準紀錄過期；中心、外盤的其他節點與引擎改變強度時摘要不動，留給 C10 的夜間檢查。摘要用 `src/core/digest.ts` 的 `digest(value)`：鍵排序後的標準 JSON，兩條 32 位元 FNV-1a，16 個十六進位數字；不用 `node:crypto`，維持純 TS。
- 範圍（`src/data/web/scope.ts`）決定一張網顯示哪些角色與外盤：`FULL_SCOPE` 是全部已登記的內容；`DEMO_SCOPE_A` 是 Demo（熔核＋蜂巢，外盤火、冰、毒、暴擊、召喚，第 40 波上限）；`DEMO_SCOPE_B` 是 10/28 的備案（熔核＋霜晶，外盤火、冰、毒、暴擊、雷，第 40 波上限）。範圍外的外盤是鎖住的「完整版」。`SCOPES` 是組網與驗證用到的這三個範圍。`BATCH_COUNTS` 是每一批做完後組起來的節點總數，含生成的融合節點：156、246、405、632、644。`BATCH_PLANS` 記每一批登記哪些中心盤、外盤與昇華，原計畫與 10/28 備案各一份（兩份的總數相同）；`batchOf` 從已登記的內容認出是哪一批做完的樣子，認不出來就是 `null`。
- 測試用的內容 `fixtureContent(variant?)`（`src/data/web/testing.ts`，只有測試與工具 import）用真的角色與外盤 ID 寫滿整張網的每個槽：4 × 40 個中心盤、24 個樞紐環、12 × 18 個外盤與 8 × 3 個昇華節點，共 424 個；組網時再生成 220 個融合節點，合計 644 個。它也有 12 條手工融合的覆寫與冰光、雷光 2 條規則覆寫，借用 M1 的四個規則模組（冷靜狙擊、無盡烈焰、過載、玻璃大砲），每張網的每個規則只在一塊盤上；火毒另有瘟疫爆彈的覆寫（`addTriggers` 加一個擊殺觸發），所以 32 條模板融合裡有 3 條帶覆寫。`variant` 是批次 B1–B5，只登記那一批與之前各批的內容。fixture 的數值是設計給的預設值，不是平衡過的數值。
- 組網：`assembleWeb(content, 角色, 範圍)`（`src/data/web/assemble.ts`）把一個角色看得到的盤組成一張網：中心盤、樞紐環、照 `OUTER_IDS` 的順序一個鐘點一塊的外盤（自己流派的鐘點放兩條昇華，所以外盤是 11 塊）、每塊開放外盤上由產生器生成的融合。盤的狀態是 `open`、`locked`（範圍外的「完整版」，或範圍延後的融合）或 `absent`（範圍內但還沒登記）；後兩種不放節點。節點照盤的順序排：中心盤、樞紐環、外盤、融合、昇華，盤內照寫的順序。盤與盤之間的邊照固定表補上：中心盤接口 c1–c6 接同一個鐘點的樞紐環節點，每個鐘點的樞紐環節點接那塊外盤的入口與那條融合的核心，自己鐘點的樞紐環節點接兩條昇華的 n1；接到空槽的邊不算。融合的係數依序取 `options.coefs`、校準紀錄、1。`center` 是 `null` 的角色沒有網，硬要組會丟例外。組網不快取，一次不到 1 毫秒。
- 時鐘佈局：`layoutWeb(web)`（`src/data/web/layout.ts`）算出每個節點的座標。鐘點 k 的角度 β = 30° × k，徑向單位 u = (sin β, −cos β)，順時針單位 v = (cos β, sin β)；深度 d、側移 l 的槽在 S × (d·u + l·v)，S = 100（`LAYOUT_UNIT`）。0 點鐘朝上，y 往下增加，和 PixiJS 一樣。中心盤的三條分支在 0、4、8 點鐘，深度 8.2 的圈上有奇數鐘點的接口、2 與 10 點鐘的 ★、6 點鐘的門檻；樞紐環在深度 9.6 的圈上，每個環節點向內接出的節點在深度 8.75、往順時針偏 12°；融合沿著自己外盤的輻條排在深度 10.8–14.8、側移 −0.6；昇華在自己的鐘點，深度 11–13，兩條各在左右 0.8；外盤從深度 17 的入口往外，檔案裡第一條分支在順時針那一側。節點的位置只看自己的槽和盤的鐘點，不看別的盤、內容或陣列順序，所以後面的批次不會移動前面批次的節點。每塊盤另有標籤位置，外盤有收合時的小圓（半徑 200），每條開放的輻條有「中心 8/8・毒 3/6」的位置。完整的 fixture 每個角色 323 個節點、367 條邊，節點間距至少 100，邊和不相干的節點至少相距約 53.5，邊不交叉，全部在 ±2,380 內。這些常數都是初始值。
- 內容驗證：`loadContent()`（`src/data/web/index.ts`）第一次呼叫時驗證登記的內容（每個寫好中心盤的角色在每個列出它的範圍各組一次網），之後回傳同一個 `Content`；`center` 是 `null` 的角色只跑 V1 與 V4，不組網。有問題就丟一個 `ContentError`，列出全部問題，依檔案排序。檢查在 `src/data/web/validate.ts` 的 `contentIssues`：schema 與 M1 抽出的節點檢查（V1）；ID 文法與 slug（V2）；每個槽放對模板、盤的形狀與固定連線（V3，樞紐環照固定表）；登記表、`FIRST_PICK` 與角色的推導欄位（V4）；形態規則只放在招牌攻擊接得上的中心 ◆ 或 ★（V5）；規則只放在 ★、融合核心、昇華終點，或 `POLICY_RULES` 列出的 ◆，每張網的同一個規則只在一塊盤上（V6）；外盤 ★ 的流派規則（V7）；轉移效果乘上係數後小於 1（V8）；沒有範圍組得到的融合不能有覆寫或校準紀錄（V10）；手工融合的覆寫要有規則，不能有觸發、加成或額外規則；模板融合的覆寫不能有規則（V11）；酬載與加成對得上，放到每個中心事件上都合法（V12）；從招牌攻擊走得到每個節點，外盤入口不能只經過融合節點連到（V13）；節點總數符合 gd §2.1 的公式，登記的內容是某一批做完的樣子時也符合 `BATCH_COUNTS`（V14）；敵人對照列標 ✗ 的敵人有節點回應（V18）；範圍裡的 ID 都存在（V24）。訊息寫成 `<對象> '<id>' (<檔案>): <問題>; <怎麼改>`，拼錯的名稱附上最接近的正確名稱（`zodIssueText` 把 zod 的問題也寫成這個樣子），M1 抽出的檢查保留 M1 的文字；訊息給內容作者看，不走 i18n。
- 快照：`src/data/web/snapshots/ids.txt` 是登記的每個節點 ID（排序，一行一個），`layout-<角色>.txt` 是那個角色在 `FULL_SCOPE` 的佈局（節點座標、盤的標籤與收合小圓、邊數與外框，取整數）；fixture 的一份在 `snapshots/fixture/`。兩份都由 `npm run snapshots -- --write`（`tools/content/snapshots.ts`）產生，不要手改；B1 之前登記的內容是空的，檔案也是空的。`idSnapshotIssues`（V21）確認快照裡的每個 ID 都還在，或在 `ID_RENAMES`（`src/data/web/renames.ts`，B1 前是空的）裡改名或退點（`null`），因為存檔用 ID 記配點；`layoutIssues`（V22）確認節點間距至少 90、邊和不相干的節點至少相距 40、邊不交叉，而且快照裡的節點與盤都沒有移動，新增的不算。這兩個函式吃快照的文字，不讀檔，所以模擬核心照樣是純 TS；讀檔的是工具。`npm run snapshots` 檢查兩份快照，有問題就失敗，只是過期時列出 `--write` 會改哪些檔；`--write` 只寫有變的檔，有 ID 從內容消失又不在 `ID_RENAMES` 時整份拒寫。`src/data/web/content.test.ts` 在 Vitest 裡對登記的內容跑 V21 與 V22。
- 匯入順序（L8）：內容的登記表、`templates.ts` 建盤函式讀的模組常數，和 `src/data/fusion/generate.ts` 在模組層算好的 `HAND_PAIRS`、`HAND_RANKS`、`EMPTY_RANKS`，都要在任何值匯入的循環之外，不然內容檔可能在 `templates.ts` 跑完前就呼叫建盤函式。`src/data/web/importOrder.test.ts` 每次清掉模組快取，先 import v3 天賦網的一個模組，再呼叫 `loadContent()`、驗證 fixture，確認每個登記表的每一項都有定義。

## 7. 平台抽象層

```ts
interface Platform {
  readonly id: 'web' | 'steam' | 'crazygames' | 'poki';
  storage: SaveStorage;        // read(slot) / write(slot, data) / list()
  achievements: Achievements;  // unlock(id) / isUnlocked(id)
  analytics: Analytics;        // track(event) / flush() / exportLocal()
  ads: Ads;                    // showRewarded() / showInterstitial()，非 portal 為 no-op
}
```

| 平台 | storage | achievements | analytics | ads |
| --- | --- | --- | --- | --- |
| web（itch.io、試玩） | localStorage | 本機記錄＋提示 | Firebase＋本機 | no-op |
| steam demo（Electron） | 檔案（透過 preload IPC） | steamworks.js | Firebase＋本機（預設開，可在設定關閉） | no-op |
| steam 正式版（Electron） | 檔案（透過 preload IPC） | steamworks.js | 本機（送雲端預設關閉，可在設定開啟） | no-op |
| crazygames／poki | 平台 SDK 存檔 | 本機 | 平台 SDK | 平台 SDK |

- 用 Vite 的 `mode` 在建置時選平台（`vite build --mode steam`），其他平台的實作會被 tree-shake 掉。
- 另一個建置參數 `VITE_FLAVOR=demo|full` 決定 demo 或正式版：demo 內容上限、analytics 預設值、結束畫面的願望清單按鈕都看它。
- portal 實作在有需要時才寫（不在 MVP 必做）。

## 8. 存檔格式

```json
{ "v": 3, "savedAt": "2026-11-01T12:00:00Z", "game": "bc-incremental", "data": { } }
```

- JSON，不壓縮、不加密（單機遊戲，改存檔不是問題）。
- 讀檔流程：解析 → 依 `v` 依序跑 `migrations[v]` 直到最新版 → zod 驗證 → 載入。驗證失敗就載入備份並記錄錯誤。
- 兩個輪替槽位（`main`、`backup`），每局結束與選單中每 30 秒自動存檔。關分頁或重新整理（`pagehide`）時也存檔；當時如果在局中，先把這局到目前為止的碎片、核心與最遠波次計入（`Session.abandonRun`，沒有跳波補償），局數 +1，下次開啟回到天賦網。
- 設定頁提供匯出／匯入存檔字串（Base64），方便玩家回報問題。
- 每個舊版本保留一份 fixture 存檔，測試確保它能遷移到最新版並通過驗證。
- Steam 雲端存檔用 Steamworks 的 Auto-Cloud 同步存檔資料夾，不需要額外程式碼。

## 9. 試玩數據

- 匿名安裝 ID（隨機 UUID，存在本機），每次開頁面另有一個 session ID，不收任何個資。每批事件帶 build（`版本+git sha`，`vite.config.ts` 注入）與語言。
- 事件（`src/app/playtest.ts`）：
  - `session_start`：局數、最遠波次、累計遊玩時間、視窗大小、目前配置。
  - `run_end`：第幾局、起始與最遠波次、時長、結束原因與死因、擊殺、漏怪、平均 DPS、最高一擊、碎片與跳波補償、累計遊玩時間、目前配置。
  - `talent_allocate`（節點、等級、流派）、`respec`（洗掉前的配置）、`feedback_open`（從哪個畫面開問卷）、`session_end`（最後停留的畫面 = 退出點、當時的局與波次）。
  - 「目前配置」= 各流派投入點數（力量的等級另計）、keystone 清單。`prestige` 等轉生做了再加。
- M1 閘門看每位玩家的總遊玩時間中位數（GDD 2.3：只有模式 A）。
- 實作：`src/platform/analytics.ts`。不用 Firebase SDK，直接打 Firestore REST API（bundle 不變大、沒有新相依）。所有事件都進本機記錄（上限 3,000 筆），開著傳送時另外排隊、批次寫入 Firestore：
  - 一批一份文件，ID 是 `{sessionId}-{序號}`。安全規則只允許新增，所以不能往同一份文件追加；寫入次數和「一個 session 一份文件」一樣是每次送出算一次。
  - 網頁試玩版：每局結束（結算畫面）、每 5 分鐘、頁面隱藏或關閉時寫入。關閉時用 `fetch` 的 `keepalive`，一次最多 40 筆事件（瀏覽器限制 64 KiB）。送失敗的批次放回佇列，下次再送。
  - 開發伺服器（`npm run dev`）不送，免得污染試玩數據。
  - Steam demo：每 10 分鐘與關閉遊戲時寫入（Electron main process 可以在結束前確實送出）。
- 各 build 的預設值：

| build | 送雲端 | 說明位置 |
| --- | --- | --- |
| 網頁試玩版（itch.io） | 預設開，可關閉 | 設定頁、itch.io 頁面 |
| Steam demo | 預設開，可關閉 | 設定頁、商店頁 demo 說明 |
| Steam 正式版 | 預設關，可開啟 | 設定頁 |

- 免費額度是每天 2 萬次寫入，超過只會寫入失敗、不會收費。估算公式：`每日寫入 ≈ 每日玩家數 × 每人 session 數 × 每 session 寫入次數`。M1 每局結束都寫一次（一局 1–3 分鐘），一個 30 分鐘的 session 約 15–25 次；陌生試玩幾十人沒問題，Next Fest 規模要先改。例：Next Fest 每天 5,000 名玩家 × 1.2 session × 約 4 次 = 2.4 萬，會超過。M3 要依實際 demo 的 session 長度重算，必要時改成抽樣（例如只送一半的安裝 ID）或拉長寫入間隔。這項列在 `MILESTONES.md` M3。
- Firestore 安全規則（`firestore.rules`，貼到 Firebase 主控台）：`playtest` 集合只允許新增，欄位固定、字串長度與每批事件數（≤ 200）有上限；不允許讀取、修改、刪除。Firebase 網頁 API key 與專案 ID 本來就公開，寫在 `src/app/playtest.ts` 的 `FIREBASE`。
- 第一局前的說明寫明會送匿名數據、可在天賦網關閉。M1 沒有設定頁，所以「傳送匿名試玩數據」開關與「匯出數據」（本機記錄的 JSON，備案）放在天賦網右側卡片；之後搬到設定頁。
- 回饋問卷：Google 表單的預先填入連結（`FEEDBACK_URL`，裡面的 `INSTALL_ID` 換成安裝 ID，問卷答案就能和事件對起來）。天賦網一直有連結；結算畫面在累計遊玩 15 分鐘後才出現。

## 10. 渲染與展示模式

- 敵人與角色都是 `Graphics` 幾何形狀；粒子用 `ParticleContainer`；傷害數字用物件池的 `BitmapText`。
- `render` 只讀 `SimState` 與 `SimEvents`；所有特效用畫面時間（wall-clock）計時，不跟模擬 tick 走，所以加速與 hit-stop 不會讓特效跟著快轉或凍結。單一畫面的特效時間上限 100 ms，切分頁回來不會一口氣播完。
- 原則：**擠的畫面少畫細節，不掉幀**。每個特效池都有硬上限，超過就丟掉新的（或換掉最舊的），不會讓畫面變慢。
- 展示模式（M2）：隱藏 UI、固定 seed、載入預設 build、腳本化鏡頭，給截圖與預告片錄影用。
- 畫面縮放：邏輯解析度固定 1920×1080（arena 單位），等比縮放加黑邊；UI 字級可以在設定中調整。

### 10.1 圖層（由下往上）

| 圖層 | 內容 | 上限 |
| --- | --- | --- |
| 背景 | 格線、地面光、暗角，快取成一張貼圖 | — |
| 燃燒光暈（add） | 每隻燃燒中的敵人一個深橘色光暈，隨層數放大 | 跟著燃燒中的敵人數 |
| 敵人火焰（add） | 燃燒中的敵人冒出的火舌、瘟疫餘燼落地的火團，畫在怪群**下面** | 火舌 520、火團光暈 110；全場每秒最多 650 個新火舌，超過時每隻敵人按比例少噴 |
| 敵人 | 每隻一個 `Graphics`：暗色底＋半透明填色＋實心外框，用 tint 上色；菁英與 Boss 在小怪下面 | 每種敵人一個物件池 |
| 環（add） | 擊殺衝擊波、瘟疫火環 | 衝擊波 40；完整火環 3，再多只畫外圈（10） |
| 角色、投射物 | | — |
| 連鎖閃電（add） | 鋸齒狀青色閃電，白色核心，每 42 ms 重抖一次，壽命 180 ms | 80 條，滿了換掉最舊的 |
| 特效粒子（add） | 擊殺碎片、火花、閃光、瘟疫擴散的火焰與餘燼 | 碎片 420、火花 360、閃光 110、火焰 520、餘燼 64 |
| 掉落碎片 | 飛向角色的碎片 | — |
| 傷害數字 | 一般數字池在下，大暴擊池在最上層 | 見 10.2 |

畫布之上是 DOM 的 HUD（`src/ui`）。燃燒的敵人：火焰與光暈在下、敵人的外框與原本的顏色在上（燃燒只讓 tint 偏橘 6–20%），暗色底讓形狀在亮的特效上仍是清楚的剪影；火焰的強度在 4 層封頂（`eternalFlame` 沒有層數上限，畫面不跟著無限放大）。同一個畫面死掉的敵人越多，每一隻的白色爆心越暗、碎片越少，怪群一起死時不會變成一團白光。瘟疫火環的火舌從同一點出發會疊加，所以用半透明的橘色起頭，火環中心不會是一片白。

### 10.2 傷害數字

- **字級**：依「這筆傷害 ÷ 本局一般擊中」的 `log10` 放大（本局一般擊中 = 招牌攻擊的基礎傷害 × 擊中類傷害倍率，由 `src/app/session.ts` 傳進來；基礎傷害和招牌攻擊的酬載算得一樣，是 `values.damage` × 第 0 個發射器的 `damagePct`，雷塔的三相雷再乘 `ArcParams.damageMult`），每種數字都有低上限（arena 單位，一般擊中的基準是 22）：

| 數字 | 基準字高 | 每 10 倍 | 上限 |
| --- | --- | --- | --- |
| 一般擊中 | 22 | +30% | 約 29（1.3 倍） |
| 連鎖 | 20 | +30% | 約 26 |
| 燃燒 | 16 | +25% | 22 |
| 大暴擊（發光字型、彈出） | 30 | +12% | 約 35（1.6 倍；彈出最高點 ×1.12，約 1.8 倍） |
| 小暴擊（一般字型、暴擊黃） | 24 | +10% | 約 28 |

- **大暴擊的預算**：同時最多 6 個大暴擊彈出；超過的暴擊改用一般大小、暴擊顏色的小暴擊。暴擊閃光也跟著分級：大暴擊有星芒、光暈、衝擊環，小暴擊只有小星芒與火花；閃光大小在超過一般擊中 10^1.5 倍後不再變大。
- **上限**：一般數字池 80 個，其中一般擊中 40、連鎖 30、燃燒 30、小暴擊 18；超過就不顯示新的。
- **合併**：同一隻敵人、同一種數字，在 220 ms 內的新傷害加到原本的數字上（數字跳一下），不再疊出「84.384.3」。燃燒另外先在 `BurnTally` 依敵人累計 380 ms 才顯示一次，敵人死亡時立刻顯示。
- **錯開**：新數字先試原位，再試上方、下方、上方兩格、左右各一格，找不到不會蓋住其他數字的位置就不顯示（暴擊也一樣，閃光照放）。上下相鄰的數字最多重疊 5%（只有外框碰到）；左右相鄰的數字之間一定要留約字高五分之一的空隙，不然兩個數字會黏成一個（「84.384.3」）。
- **壽命**：一般擊中與連鎖 650 ms、燃燒 600 ms、大暴擊 760 ms、小暴擊 560 ms；數字池越滿，新數字的壽命越短，滿載時少 45%。
- **避開 HUD**：HUD 的範圍以螢幕像素定義（對照 `src/ui/style.ts`：左上波次區 280×136、上方 84 高的生命條與資源列、右下 240×92 的速度按鈕），每次縮放時換算成 arena 單位。數字整段上飄的路徑都不能進入這些區域：靠上緣的往下推、右下角的往上推，左右不超出 arena。
- 實作：`src/render/damageNumbers.ts`（物件池與動畫）、`src/render/numberLayout.ts`（字級、壽命、HUD 區域、錯開，純函式，有測試）。

### 10.3 畫面震動與 hit-stop 的預算

- **畫面震動**（`src/render/shake.ts`）：trauma 模型，位移 = 14 × trauma²（arena 單位），每秒衰減 3.2。每次震動指定一個天花板，小的震動不能把 trauma 推過它：
  - 暴擊：至少是一般擊中的 2 倍才震，0.24 + 每 10 倍 0.2，天花板 0.55，兩次之間至少 300 ms。
  - 菁英擊殺 0.55（天花板 0.75）；Boss 擊殺 1.0。
- **hit-stop**（`src/app/loop.ts` 的 `HitStop`）：停頓期間模擬時間只走 10%，特效照常播放。單次最長 80 ms（重疊的請求取長的、不疊加），少於 15 ms 不理；停完 200 ms 內不接受新的（除非比剛結束的那次長）；總量有預算：存量 160 ms，每 1 ms 畫面時間回補 0.08 ms，所以不管請求多頻繁，停頓不會超過遊玩時間的 8%。
- **誰會請求 hit-stop**：
  - 菁英擊殺 55 ms、Boss 擊殺 80 ms。
  - 暴擊（`src/render/critStop.ts`）：要同時符合三個條件——至少是一般擊中的 20 倍；至少是本局「平常暴擊」的 2 倍（平常暴擊是對數空間的移動平均，每次暴擊權重 0.25，開局從一般擊中算起）；距離上次暴擊 hit-stop 至少 2.5 秒。長度 30 ms，每多 10 倍加 30 ms，最多 60 ms。
- **為什麼這麼少**：GDD §3.2 原本寫「暴擊帶短暫 hit-stop」（已改成和這裡一致）。冷靜狙擊每第 3 次攻擊整波必定暴擊，試玩用的暴擊 build（冷靜狙擊＋刺客等）每發暴擊約是一般擊中的 25 倍，原本的門檻（約 4 倍、冷卻 0.7 秒）讓每波暴擊都停一下，任何速度下每 0.7 秒卡一次。現在暴擊 hit-stop 是稀有的強調：同一局的暴擊大小幾乎固定，實際上只有開局第一個夠大的暴擊會停一下，之後只有遠大於平常的暴擊才會；暴擊的手感改由數字彈出、閃光與震動負責。
- 減少動態（`reducedMotion`）會同時關掉震動與 hit-stop；目前是 `src/app/main.ts` 的常數，設定頁之後再接。

## 11. Electron 與 Steam（M2 技術驗證）

- `contextIsolation: true`，preload 只暴露最小 API（`storage`、`achievements`、`steamInfo`）。
- steamworks.js 在 main process 初始化；技術驗證先用測試 App ID 480（Spacewar），不必等 Steam 上架費。
- Steam overlay 需要 steamworks.js 的 `electronEnableSteamOverlay()` 加上 Chromium 參數，這是 M2 最大的技術風險，第一週先驗證。

## 12. 平衡模擬器

```
npm run balance -- --strategy crit-greedy --sessions 20 --minutes 60 --seed 1 --out out/crit
```

- **策略** = 配點策略（依優先順序貪婪購買，例：`crit-greedy`、`dot-greedy`、`chain-greedy`、`hybrid-crit-dot`）＋ 起始波次策略 ＋ 何時轉生。
- 起始波次策略（`--start-wave`）：`max`（預設，每局選允許的最高波次）、`ratio:<x>`（選最遠波次的 x 倍）、`1`（永遠從頭打，用來和跳波比較收入）。`startWaveRatio`、`skipRewardRate` 也可以用參數覆寫。
- 模擬完整進度：開局 → 結算 → 配點 → 下一局 → 轉生 …，直到時間上限或目標波次。局間停留時間是可設定的假設值（預設 20 秒），用來換算玩家實際遊玩時間。
- 輸出 CSV：
  - `runs.csv`：每局一列（累計時間、局數、起始波次、最遠波次、該波標準怪血量、有效單發傷害 `D`、前線擊殺次數、溢傷 10 倍以上波次的時間比例、各類 DPS、資源收入（含跳波補償）、已點節點數）
  - `milestones.csv`：到達第 N 波、第一個 keystone、第一次轉生的累計時間
  - `curve_check.csv`：每個驗收時間點的實際值與 GDD 第 7 節主曲線目標並列，標出超出容許範圍的列
  - `dps_probe.csv`：固定 build 對木樁的 DPS 曲線
- 驗收標準就是 GDD 第 7.5 節；主曲線（血量分段、擊殺次數倍率）放在 `src/data/curve.ts`，遊戲與模擬器共用同一份。
- `worker_threads` 平行跑。效能預算照 impl §6：`npm run bench` 的一般一局（`normal`，3 分鐘）平均 ≤ 50 ms；`bench.ts` 刻意用比較嚴的 p95 比。

**行為與效能的守門**（引擎重構靠這些證明「行為沒變」）：

- `npm run fingerprint`（`tools/balance/fingerprint.ts`）：1,032 個案例（972 個合成 build＋60 個真實天賦 build）跑完，把每個 tick 的事件（投影到 M1 的欄位）與結果做雜湊，一個案例一行。`-- --check` 和 `tools/balance/fingerprint.baseline.txt` 逐行比對，重構必須完全相同；`-- --compare-results` 列出每個變動案例的波次、擊殺、漏怪、傷害與燃燒差多少；`-- --write` 重寫基準，只有量過、說明過的行為修改可以用。
- `src/sim/golden.test.ts`：24 個案例 × 1,200 tick 的事件雜湊，跟著 `npm test` 跑。
- `src/sim/goldenC4.test.ts`（GOLDEN-C4，也跟著 `npm test` 跑）：C4、C5 機制與 C6 角色局的 31 個 fixture（C4 的 21 個、C5 的 6 個、C6 的 4 個），每個在 seed 1 與 2 各跑 1,200 tick。雜湊是 sha256 的前 16 個十六進位數字，算的是每個 tick 原樣的事件（不投影到 M1 的欄位），再加上 `projectResult`、`damageBySource` 與不為 0 的計數器（依 `COUNTER_IDS` 順序）；每個案例跑兩次，兩次要相同。落地一個機制的 commit 附上它的 fixture 與當時的雜湊；之後的 commit 不動已記錄的雜湊，除非 commit message 寫明重記哪些、為什麼。到 fa8a663 為止重記過：C4.7 的 `burst` 事件重記了用到 explode 或 nova 的 `thorns`、`selector`、`freezeList`、`zones`；`zones` 另外在 C4.6c、C4.6d、C4.7b 依 Q4 重記；C5.R 調 swarm 的數字時重記了 `swarm`、`swarmRepeat`、`swarmTurret`。後加的計數器在之前的 fixture 都是 0，不會動到雜湊。
- `npx tsx tools/balance/probe.ts --json <檔案>` 與 `tools/balance/probeDiff.ts <前> <後>`：比兩次平衡探針（各策略的前線 F@10/20/40/60、到第 20／30 波的分鐘在 ±5% 內，T1–T8 通過）。`out/` 不進 git，參考檔放在本機的 `out/balance/`。
- `npm run bench -- --scenario normal|hits|ailments|effects|poisonBoss|v3fire`：一般一局、擊中路徑、異常狀態壓力（瘟疫＋無盡烈焰，第 30 波）、效果佇列、Boss 身上約 500 層毒（和 5 層比，持續傷害每一步的成本要和層數無關，比值 < 1.3）、熔核的角色局（C6.6：GOLDEN-C4 的 `v3fire`，測試資料從第 12 波跑 20 秒，不看 `--start-wave`；不是壓力家族，沒有存活數區間，§4.8）。
- C4 加的場景（`--scenario` 也接受這些 id）都是**壓力家族**，C5 的 `stressBase` 也是（`hive` 不是，見 §4.6.7）：用壓力 fixture（`src/sim/testing.ts` 的 `stressData`、`stressStats`）從第 30 波跑 30 秒（3 次暖身、20 次計時），tick 300 起約 300 隻活著，不看 `--start-wave`。`--check` 另外要求 seed 1 那一局在 tick 301–1800 的平均存活數在 280–320（釘住工作量），並印出一行壓力報告：中位數、比值、一起計時的 `normal` 的中位數與工作量（存活數、峰值與計數器；`stress` 另有區域、熔岩彈與線段的工作量）。閘門欄的 CI 是下一點的 `--check`（比值與存活數區間）。

  | 場景 | 內容 | 閘門 |
  | --- | --- | --- |
  | `stressM1` | C4.0：只有 M1 的攻擊，其他壓力場景的起點 | CI |
  | `stress` | v1（C4.6）：四個在 M1 擊中時產生地面區域的觸發，效果區域維持在約 64 個；v2（C4.7）：最重的合理熔核，每秒 6 次、每次 2 顆熔岩彈，熔核自己的區域來源掛在自己的事件上；v3（C4.14，C4 的最後版本）：再加雷網全開（感電機率 .3、`outer.lightning` 的線段授予）；v4（C5.6）：再加 32 個召喚物，見 §4.6.7 | STRESS ≤ 4.5、CI |
  | `stressBase` | 原封不動的 v3（C5.6，§4.6.7） | STRESS ≤ 3.5、CI |
  | `shots` | C4.12：M1 的攻擊加上射小投射物的觸發，角色每秒 5 次射 12 發、每次擊殺射 4 發；本機報告（不是 `--check`）另外用塞滿投射物池的探針量 `PROJECTILE_CAP` 時的成本 | CI |
  | `fan` | C4.19：霜晶的冰錐扇，每秒 7.5 輪、每輪 9 道冰錐 | CI |
  | `arc` | C4.20：雷塔的三相雷加六線圈，每秒 6 次放電、每次兩個目標，測試用的連鎖策略每跳分岔 2，讓攻擊打到 `CHAIN_HIT_CAP` | CI |
  | `grants` | C4.21：M1 的攻擊加上光環（`auraRadius` 160，聚能脈衝每第 4 次 × 4）、兩圈各 4 顆的環繞球（半徑 110 與 180）與荊棘 | CI |

- `npm run bench -- --check`（CI，§14）：照 impl §6，參考是同一個 job 裡這一版的 `normal`。每個場景的計時和 `normal` 交替跑，各自取中位數；場景 ÷ `normal` 的比值超過 `tools/balance/bench.baseline.json` 記錄值的 1.5 倍就失敗。整個模擬一起變慢時比值不會動，所以 `normal` 自己的中位數超過 50 ms 也算失敗（本機在 `--check` 裡約 20–25 ms）。比值在本機記錄；效能特性刻意改變（新場景、取捨）或 CI 的機器穩定地不同時，用 `npm run bench -- --check --write` 重新記錄，PR 寫明原因。`--scenario` 只檢查一個場景。
- **BENCH**（引擎開發期間，C4 設計 §0.4）：每個改到 `src/sim`、`src/data` 或 `src/meta` 的 commit，用 `npx tsx tools/balance/benchAB.ts --inproc <treeA> <treeB> <normal|hits>` 比 `normal` 與 `hits`。treeA 是參考（前一個 commit，累計時是 0f9dcc5），用 `git archive` 匯出、`node_modules` 用 symlink（`git worktree add` 會寫進 repo 自己的 `.git`）；treeB 是候選。預設 7 個子程序依序跑：每個 import 兩棵樹的 `src/data`、`src/sim`、`src/sim/testing`，各暖身 5 次，再交替各跑 40 次（每輪換先後），印出 treeB 的中位數 ÷ treeA 的中位數；偶數程序先 import treeA、奇數先 import treeB（固定順序時，同一個 commit 的兩份拷貝量到差約 2%）。父程序印出每個程序的比值、兩種 import 順序各自的中位數與全部的中位數。
  - 每個 session 第一次 BENCH 之前先跑 A/A：treeA 對同一個 commit 的另一份 `git archive`（7 個程序、兩個場景），記下中位數。
  - 上限：對前一個 commit 的中位數 ≤ **1.03**；對 0f9dcc5（C4 開始前）的累計中位數 ≤ **1.05**，在每一層的結尾（C4.15、C4.19、C4.21）與最後一個改程式的 commit 量。中位數超過上限**而且**超過這個 session 的 A/A 中位數 + 0.02 才算失敗。
  - 雜訊規則：中位數在門檻的 1.5% 以內時再跑 7 個程序，取 14 個的中位數；之後還失敗就停下，把兩個中位數、各 import 順序的中位數與 A/A 交給 lead。上限從不在 commit 裡改。
  - C4.15 的累計 `normal` 在兩個 session 量到 1.0427 與 1.05085，28 個程序合併是 1.0463；Hoshi 選「先過」（2026-10-19）：以合併的 28 個程序通過，C4.1–C4.14 累積的變慢（設計預期約 1%）在 C5 之後、M2 之前追查。C4.21 的累計是 `normal` 1.0406、`hits` 1.03745（14 個程序的中位數）。
  - C3 對 C2 的 532074c 的 ≤ 1.25 已經退休。不帶 `--inproc` 的成對模式還在，但同一份程式在兩個程序量到的比值是 0.64–1.57，看不出幾個百分點的差別。
- **STRESS**（C4 設計 §0.5）：impl §6 在它的參考機器上量到 `normal` 約 25 ms、要求壓力場景 ≤ 50 ms，也就是比值 ≤ 2.0；這裡的閘門就是比值，在同一個程序裡和 `normal` 交替計時：`npm run bench -- --check --scenario stressBase` 與 `--scenario stress` 的壓力報告。上限：`stressBase`（v3，C4 的壓力）≤ **3.5**（Hoshi 2026-10-15 對 Q1 重問選 (A)「放寬到 3.5 倍」）；`stress` v4（加上 C5 的召喚物）≤ **4.5**（`STRESS_TOTAL_LIMIT`，Hoshi 2026-10-21「放寬到 4.5」）。
  - 同一次的 `normal` 中位數要 ≤ 25 ms。這不是預算（`normal` 的預算是 CI 的 50 ms），只用來發現機器跑在慢的模式：超過就重跑，最多 3 次，然後停下回報數字。
  - 比值在上限的 3% 以內時再跑兩次，取三次的中位數。重跑之後還超過，這個 commit 就停下（不提交），由 Hoshi 決定；沒有 commit 會改上限，或改場景的組成來壓到上限以下。
  - C5.6 用 `--share`（3 個程序的閘門）量 v4，見 §4.6.7；之後的 C4 commit 用上面兩個 `--check` 的比值。C4.21 量到 `stressBase` 3.265、`stress` v4 4.246。

## 13. i18n

- `en.json` 是 key 的來源，`zh-TW.json` 由測試檢查是否缺漏；key 的型別從 `en.json` 產生，打錯 key 會編譯失敗。
- 插值用 `{name}` 語法，數字一律先經過 `num.ts` 格式化。
- 語系依瀏覽器語言選擇（繁中標籤 `zh-TW`、`zh-Hant`、`zh-HK`、`zh-MO` 用 `zh-TW`，其他用英文）；網址加 `?lang=zh-TW` 或 `?lang=en` 可以直接切換，方便測試。
- 天賦名稱走 `nameKey`；`descKey` 目前沒有畫面用到，M1 做天賦網 UI 時再補文字與檢查。
- 中文字型用 Noto Sans TC（OFL 授權），建置時依實際用到的字做子集化（M3）。

## 14. CI 與發布

- GitHub Actions：`format:check` → `lint` → `typecheck` → `test` → `bench -- --check`（模擬的效能，§12）→ `vite build`，build 結果存成 artifact。
- 試玩版發布到 itch.io（免費，可以設成限制存取的頁面）：`.github/workflows/itch.yml`，推 `playtest-v*` tag（或在 Actions 頁手動執行）時跑 `npm run check`、`npm run build`、刪掉 source map，再用 butler 推到 `ITCH_TARGET` 的 `html5` channel，userversion 是 `tag+sha`。需要 repo secret `BUTLER_API_KEY`（itch API key，只放 GitHub，不貼在任何地方）。第一次上傳後要在 itch 編輯頁勾「This file will be played in the browser」。
- 試玩版從 tag 之後只修 bug：修好的 commit 打下一個 tag（`playtest-v2`…），CI 自動上傳。
- Steam 版在本機用 `npm run build:steam` 產出，用 SteamPipe 上傳（M3）。
