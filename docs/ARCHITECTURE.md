# 架構文件

> 狀態：草稿 v0.4（2026-10-20）。v0.2（2026-10-12）依 Hoshi 第一輪審查修改；v0.3 把 §4.3、§4.4 換成 v3 引擎 C3 步驟的傷害引擎，§12、§14 加上模擬的行為與效能檢查；v0.4 加上 C5 的無人機與砲台（§4.6）。

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
  core/        Num、數字格式化、seeded RNG、數學工具（純 TS）
  data/        天賦、敵人、波次、昇華的資料檔與 zod schema（純 TS）
  sim/         一局的模擬：狀態、系統、固定 timestep（純 TS）
  meta/        局外進度：資源、天賦配點、轉生、昇華（純 TS）
  save/        存檔序列化、版本遷移（純 TS）
  platform/    平台介面與各平台實作（web、steam、portal）
  render/      PixiJS：實體外觀、粒子、傷害數字、鏡頭、展示模式
  ui/          DOM：主選單、結算、天賦網外框、設定、HUD
  i18n/        en.json、zh-TW.json、型別化的 key
  app/         啟動、場景切換、遊戲主迴圈、平台注入
tools/
  balance/     平衡模擬器 CLI 與 build 策略
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

- `meta` 把天賦網與昇華編譯成一個 `StatBlock`（屬性的最終值，加上帶標籤、範圍或條件的修正、觸發與轉換，§4.4）和一組 `RuleSpec`（keystone 規則與參數），連同起始波次交給 `sim` 開一局。跳波補償由 `meta` 在結算時依期望掉落計算，`sim` 只回報有沒有清掉起始波次。
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

- 不用 ECS 框架。實體是物件陣列＋物件池（避免 GC 抖動）。附近目標查詢走均勻空間格（`src/sim/grid.ts`，`docs/v3/implementation-plan-v3.md` §2.3）：格子 128，場地 15 × 9 格外多一圈，更遠的夾到最外圈；每 tick 敵人移動後重建（計數排序寫進 typed array，實際排序延到當 tick 第一次查詢，沒有查詢的 tick 不花成本；敵人少於 128 隻時不排序，查詢直接線性掃描，實測比較快）。投射物選目標、連鎖、瘟疫擴散都查格子，結果和原本的線性掃描完全一樣：同距離取陣列裡較前面（ID 較小）的；同一 tick 後來才加入的敵人（分裂子怪）每次查詢另外線性掃；死掉的留在格子裡、查詢時跳過。`push` 效果推動了敵人時當場再重建一次（`src/sim/effects/execute.ts`），同一 tick 之後的查詢就在新的格子找到它們；排序一樣延到下一次查詢，所以推動之後只有第一個查詢排序，後面的查詢共用那次排序；沒有推動任何敵人的 `push` 不重建。
- 每個 tick 依序跑系統，每個系統一個檔案（`src/sim/systems/`，2026-10 從 `simulation.ts` 拆出，行為不變）：`input → spawn（含 waveStart 觸發）→ movement（冰冷減速、凍結、流血的移動計數）→ grid（重建空間格）→ contact（heroHit、contact 觸發）→ emitters（攻擊，之後是規則模組的 tick hook）→ drones（無人機與砲台，§4.6）→ projectiles（命中、連鎖、擊殺當下結算）→ segments（線段）→ zones（地面區域）→ ailments（持續傷害、ailmentTick 觸發）→ effects（到期的 periodic 觸發，再跑佇列裡的效果）→ death（派發待處理的擊殺觸發、壓縮陣列）→ waveControl → runEnd`。emitters 到 effects 只在角色活著時跑。各步驟在傷害引擎裡做什麼見 §4.4，無人機見 §4.6；之後才做的其他系統（敵人 AI）見 `docs/v3/implementation-plan-v3.md` §2.15。
- 傷害引擎在 `src/sim/` 的子資料夾：`build/`（`compileBuild`、ModTable、來源、條件與縮放）、`rules/`（規則模組）、`emitters/`（發射器與酬載）、`combat/`（命中、連鎖、轉換）、`ailments/`（燃燒記錄、分桶環、流血、感電、冰冷）、`effects/`（觸發派發、效果佇列、中心事件）。熱路徑不配置記憶體：每筆傷害只新增一個 `SimEvent`；分桶環與效果佇列是 typed array 物件池，命中、擊殺、中心事件與條件的輸入各用一個重複使用的暫存物件。

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
- 縮放：貢獻 `c = min(cap, value × g(x))`，`g` 是線性、`log10(1 + x)` 或 `x^exponent`，`every` 會先把 x 取整步再套任何一種；flat 與 increased 加上 c，more 乘 `1 + c`。變數：連鎖第幾跳、目標的燃燒／毒／感電層數、目標的冰冷量表、目標和角色的距離、失去的生命比例。
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
- 異常狀態的跳傷歸屬（`ailmentCredit`）：① 施加者是融合 → 那條融合；② 種類屬於角色自己的流派 → `center`；③ 其他 → 那個種類的外盤（燃燒 fire、毒 poison、流血 bleed、感電 lightning、冰冷 ice）。M1 沒有角色，所有種類都算 `center`；C6 起依角色的流派設定。持續傷害讀歸屬後那個來源的列。
- 連鎖跳：酬載的 `jumpSource`（預設是酬載自己的來源）決定第 1 跳起的列與統計；跳躍施加的異常狀態仍以酬載的來源當施加者。C6 起，非雷角色的中心酬載的跳躍算 `outer.lightning`。
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
  - 已接上的事件（`WIRED_EVENTS`，驗證擋掉其他的）：hit、crit、kill、diedWithAilment、nthAttack、waveStart、periodic、heroHit、contact、ailmentApplied、ailmentTick、freeze、shatter。explode 與 chainJump 在 C4，無人機的事件在 C5。
  - 效果：`applyAilment`、`spreadAilment`、`explode`、`nova`、`push`、`addFrost`、`heal`、`gainShards`；C4 起陸續加。
  - 條件：目標帶著的狀態、種類、血量、層數、機率、冷卻、`hitIs`、`victimHas`、`killedBy`、`ailment`；每個條件能用在哪些事件由 `CONDITION_CONTEXTS` 規定。
  - 每種效果、條件值與縮放變數都和執行它的程式在同一個 commit 加入，並用 mapped type 的登錄表強制，所以資料寫不出模擬還不會跑的東西。
- 觸發依編譯順序編號：0 是碎裂，接著是 build 的資料觸發，再來是規則模組（一個實例一個編號）。
- **派發**（`fire`／`fireOne`）依序檢查：深度、自己的傷害（第 3 條）、招牌攻擊（第 8 條）、nthAttack 計數、冷卻、條件，最後在 `trigger` stream 擲機率。通過就把效果排進佇列，深度 +1、origin = 這個觸發。
- **第 1、4 條**（佇列與預算）：先進先出的 typed array 環。效果在 tick 的 effects 階段執行，每 tick 最多 2,000 個，剩下的照順序留到下一 tick，記在 `effectBudgetTicks`、`effectsDeferred` 與 `effectBudgetStreakMax`；執行中新排的接在尾端。
- **第 2 條**（深度）：發射器的命中是深度 0；深度 3 以上的事件不派發觸發（記在 `triggerDepthCapped`），深度 3 的效果照樣執行。
- **第 3 條**：觸發造成的直接傷害帶它的編號（origin），不會再觸發它自己；A→B→A 可以，到深度 3 為止。
- **第 5 條**：觸發的機率只從 `trigger` stream 擲，效果裡的擲骰只從 `effects` 擲；同一個 tick 的待處理擊殺依（死者 ID、觸發編號）排序。
- **第 6 條**：效果造成的傷害帶效果的深度與 origin。持續傷害的規則：每隻敵人記住施加在牠身上的所有狀態裡最小的深度（`ailDepth`，只降不升），持續傷害的事件與擊殺帶這個深度、**不帶 origin**。所以持續傷害造成的擊殺不受第 3 條限制，但受第 2 條限制。後果（設計 §12 Q2，決定保留）：焚屍爆炸點燃（助燃）的燃燒之後燒死目標，會再觸發焚屍，到深度 3 為止；爆炸本身的直接擊殺仍被第 3 條擋住（直到連環焚燒）。因此**助燃一定要掛在焚屍爆炸的同一個酬載上（同一個觸發編號）**，不能寫成另一個觸發。
- **第 7 條**（重複攻擊不計數）：C4 的重複攻擊才用到；計數與發射已經分開（`countAttack`、`fireAttack`）。
- **第 8 條**：中心事件（`emitCenterEvent`）只有帶 `SIGNATURE` 的才派發；凍結例外，任何冰冷都算，但深度照算。`hitIs: 'signature'` 的觸發也只吃招牌攻擊。
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
- 天賦節點：`{ id, kind, pos: {x, y}, links: id[], 價格欄位, modifiers, rules, triggers, conversions, archetype, nameKey, descKey? }`（`src/data/types.ts`）。修正、規則、觸發與轉換見 §4.4；節點有規則、觸發、轉換或行為修正（帶標籤的非傷害屬性、`notTags`、`when`、`scaling`、`*Always`）時必須有 `descKey`。
- 驗證（Vitest 裡也跑一次）：ID 唯一、連線雙向、從起點全部可達、keystone 數量在範圍內、每個 i18n key 在 en 與 zh-TW 都存在。
- `tools/talent-viewer`：開發用頁面，畫出天賦網並標示錯誤，存檔後熱更新。不做拖拉編輯。

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
- `npx tsx tools/balance/probe.ts --json <檔案>` 與 `tools/balance/probeDiff.ts <前> <後>`：比兩次平衡探針（各策略的前線 F@10/20/40/60、到第 20／30 波的分鐘在 ±5% 內，T1–T8 通過）。`out/` 不進 git，參考檔放在本機的 `out/balance/`。
- `npm run bench -- --scenario normal|hits|ailments|effects|poisonBoss`：一般一局、擊中路徑、異常狀態壓力（瘟疫＋無盡烈焰，第 30 波）、效果佇列、Boss 身上約 500 層毒（和 5 層比，持續傷害每一步的成本要和層數無關，比值 < 1.3）。
- `npm run bench -- --check`（CI，§14）：照 impl §6，參考是同一個 job 裡這一版的 `normal`。每個場景的計時和 `normal` 交替跑，各自取中位數；場景 ÷ `normal` 的比值超過 `tools/balance/bench.baseline.json` 記錄值的 1.5 倍就失敗。整個模擬一起變慢時比值不會動，所以 `normal` 自己的中位數超過 50 ms 也算失敗（本機在 `--check` 裡約 20–25 ms）。比值在本機記錄；效能特性刻意改變（新場景、取捨）或 CI 的機器穩定地不同時，用 `npm run bench -- --check --write` 重新記錄，PR 寫明原因。`--scenario` 只檢查一個場景。
- 引擎開發期間，每個改到 `src` 的 commit 另外用 `tools/balance/benchAB.ts` 把 `normal` 與 `hits` 和前一個 commit、和 C2 的 532074c 交替計時比較（`git archive` 出來的樹）。

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
