# Steam 技術檢查（C9）操作手冊

> 狀態：2026-11-03 在一台 Windows 10 電腦上照這份做過一次（build `0.0.1+abaec66`），結果在第 9 節。Mac 還沒做；第 8 節的 C10 量測這次也沒做。下次照這份做之前，先看第 9.4 節：那次的做法和這份手冊有幾處不一樣。

## 這是什麼

Steam 版會用 Electron 把網頁版包成桌面程式，再透過 steamworks.js 跟 Steam 溝通。這次用 Steam 開放給所有人測試的遊戲 Spacewar（App ID 480）確認四件事：

1. 遊戲連得上 Steam。
2. 成就可以解鎖，也可以清掉。
3. 遊戲中按 Shift+Tab 叫得出 Steam 內嵌介面（overlay）。
4. 存檔放在之後 Steam 雲端能同步的資料夾。

不需要 Steamworks 帳號，不用付錢，也不用安裝 Spacewar。做完只要把一段文字貼回這個對話串（第 5 節）。

- **時間**：第一次 30–45 分鐘，大部分花在安裝和下載。電腦已經有 Node.js 和 Git 的話，約 15–20 分鐘。
- **空間**：約 520 MB（套件約 400 MB，Electron 約 120 MB），做完都可以刪（第 7 節）。
- **不會動到**：你原本的專案資料夾、瀏覽器裡網頁版的存檔、Steam 的設定（第 1 節第 2 步只是確認）。
- 這次遊戲是從終端機啟動，不是從 Steam 的「開始遊戲」。正式版（M3）才會從 Steam 啟動，到時候再測一次。

## 0. 用哪台電腦

- **有裝了 Steam 的 Windows 電腦**：用它。overlay 這一項只有 Windows 能回答，而 Steam 玩家約 93% 用 Windows。
- **只有 Mac**：用 Mac 做。overlay 那幾題預期會是「No」，照實回答就好。請在對話串告訴我「沒有 Windows 電腦」，Windows 的部分我另外安排免費的方法。
- **兩台都有**：先做 Windows。Mac 有空再做，大約多 20–30 分鐘。

## 1. 兩種電腦都要先做

1. 打開 Steam 並登入，確認不是離線模式。整個過程 Steam 都要開著。
2. 確認 overlay 是開的：Steam →「設定」→ 左邊「遊戲中」→ 打開「在遊戲時啟用 Steam 內嵌介面」（英文介面是 Enable the Steam Overlay while in-game；版本不同，字可能略有不同）。快捷鍵維持預設的 Shift+Tab。
   - Windows：Steam 視窗左上角的「Steam」選單。
   - Mac：螢幕最上方選單列的「Steam」→「設定…」（舊版叫「偏好設定…」）。
3. 測試時，好友會看到你「正在玩 Spacewar」，Spacewar 也會出現在最近遊玩。介意的話，先把好友狀態改成「隱身」。

## 2. Windows

### 2.1 安裝工具（已經有的就跳過）

1. 確認電腦是 x64：「設定」→「系統」→「關於」，「系統類型」要寫「x64 型處理器」。如果寫 ARM，先停下來告訴我。
2. 安裝 Node.js：到 https://nodejs.org 下載 **v22（LTS）** 的 Windows Installer（.msi，x64），一路按「Next」。中間有一頁「Tools for Native Modules」的勾選框，**不要勾**。已經有 v22.12 以上的 22 或 24 就不用裝。
   - 不想安裝的話，免安裝版也可以（2026-11-03 那次就是用免安裝版，第 9.4 節）：在同一個網站下載 v22 的 Windows Binary（.zip，x64），解壓縮到一個資料夾。之後在每個要用的 PowerShell 視窗先輸入 `$env:Path = "<裡面有 node.exe 的那個資料夾>;" + $env:Path`。這只改那個視窗，系統的 PATH 不會變；開新的 PowerShell 視窗要再輸入一次。
3. 安裝 Git：到 https://git-scm.com/download/win 下載安裝，選項全部用預設。
4. 打開 PowerShell：開始選單輸入 `PowerShell`，點「Windows PowerShell」。
   - **不要**選「以系統管理員身分執行」。
   - Steam 也不要用系統管理員身分開。兩邊權限不同，遊戲會連不上 Steam。
5. 輸入 `node --version`，按 Enter。要看到 `v22.12.0` 或更新的版本（v24 也可以）。
6. 輸入 `git --version`，按 Enter。有出現版本號就好。

剛裝完 Node.js 或 Git 的話，要關掉 PowerShell 再開一個新的，它才找得到新指令。

**在 PowerShell 裡，npm 一律打成 `npm.cmd`。** 直接打 `npm` 會出現「因為這個系統上已停用指令碼執行」的錯誤。

### 2.2 下載專案並安裝套件

一個步驟一行指令。打完按 Enter，等它跑完、可以再打字了，再做下一步。

1. 輸入 `cd ~`
   - 也可以把專案放在別的地方（例如 D: 槽的資料夾）：`cd` 到那裡再做第 2 步。之後的步驟寫 `~\bc-steam-check` 的地方（第 7 節、第 8.1 節），都換成你放的位置。
2. 輸入 `git clone --branch claude/v3-engine-j4rsx2 https://github.com/chriskid824/bc-incremental.git bc-steam-check`
3. 輸入 `cd bc-steam-check`
4. 輸入 `git checkout abaec66`
   - 會出現一段說明，提到 detached HEAD（中文是「分離開頭指標」）。這是正常的。
5. 輸入 `npm.cmd ci`
   - 要 2–5 分鐘。黃色的 `npm warn` 是正常的。
   - 最後如果提到 vulnerabilities，**不要**執行 `npm audit fix`。
6. 輸入 `npm.cmd run electron:install`
   - 這一步下載 Electron（約 120 MB），要 1–5 分鐘。中間可能有一陣子沒有任何輸出，請等它跑完。

### 2.3 啟動檢查版

1. 確認 Steam 開著、已登入。
2. 輸入 `npm.cmd run steam:check`
   - 會先 build 大約 1 分鐘，然後跳出遊戲視窗。第一次開可能要多等十幾秒（防毒在掃描）。
   - **視窗一出現就開始看螢幕右下角**（第 4 節第 1 步）。
   - 遊戲畫面右上角有一個英文的檢查面板。
   - 遊戲開著的時候，終端機視窗不要關。
   - 跳出 Windows 的安全性視窗的話，看第 6 節。
3. 接著做第 4 節。

## 3. macOS

### 3.1 安裝工具（已經有的就跳過）

1. 確認 macOS 版本：左上角蘋果選單 →「關於這台 Mac」。要 macOS 13（Ventura） 以上（Electron 44.8.0 的要求）。比這個舊的話，先停下來告訴我。
2. 安裝 Node.js：到 https://nodejs.org 下載 **v22（LTS）** 的 macOS Installer（.pkg），一路按「繼續」。已經有 v22.12 以上的 22 或 24 就不用裝。
3. 打開「終端機」：按 ⌘＋空白鍵，輸入「終端機」（或 Terminal），按 Enter。
4. 輸入 `node --version`，按 Enter。要看到 `v22.12.0` 或更新的版本（v24 也可以）。
5. 輸入 `git --version`，按 Enter。
   - 第一次可能跳出「需要安裝命令列開發者工具」：按「安裝」，等它裝完（5–15 分鐘），再輸入一次 `git --version`。

### 3.2 下載專案並安裝套件

一個步驟一行指令。打完按 Enter，等它跑完再做下一步。

1. 輸入 `cd ~`
2. 輸入 `git clone --branch claude/v3-engine-j4rsx2 https://github.com/chriskid824/bc-incremental.git bc-steam-check`
3. 輸入 `cd bc-steam-check`
4. 輸入 `git checkout abaec66`
   - 出現 detached HEAD 的說明是正常的。
5. 輸入 `npm ci`
   - 要 2–5 分鐘。`npm warn` 是正常的。不要執行 `npm audit fix`。
6. 輸入 `npm run electron:install`
   - 下載 Electron（約 120 MB），要 1–5 分鐘。中間可能有一陣子沒有輸出。

### 3.3 啟動檢查版

1. 確認 Steam 開著、已登入。
2. 輸入 `npm run steam:check`
   - build 大約 1 分鐘後跳出遊戲視窗，Dock 會出現 Electron 的圖示。
   - **視窗一出現就開始看螢幕右上角或右下角**（第 4 節第 1 步）。
   - 遊戲開著的時候，終端機視窗不要關。
3. 接著做第 4 節。

**Mac 上預期的結果**：Shift+Tab、成就跳出的通知、overlay 裡的成就頁，很可能都不會出現。這是 Electron 在 Mac 上已知的限制，不是你做錯，照實回答「No」或「Nothing」就好。成就的解鎖、清除和存檔還是要能動。

## 4. 檢查步驟（Windows 和 Mac 一樣）

檢查面板是英文的。下面用「」標出要找的字和按鈕。面板如果縮起來了，點它的標題展開。

1. **視窗剛出現的 10 秒內**，看螢幕角落有沒有 Steam 的小通知，上面提到 Shift+Tab。
   - 在面板的「Steam hint (Shift+Tab) at start?」按「Yes」或「No」。
   - 沒看清楚就不要按，報告會記成 unknown。
2. 看面板第一行：
   - 「Steam: connected (app 480)」：繼續下一步。
   - 「Steam: NOT connected …」：看第 6 節。修好之後關掉遊戲視窗，重新輸入啟動指令。
3. 按 Space（或點畫面上的「開始 · Space」，英文介面是「Start · Space」）開始第一局。
   - 第 4 到第 8 步在戰鬥中做。一局結束後會自動開下一局，不用管它。
4. **Shift+Tab**：先用滑鼠點一下遊戲畫面（不是面板），再按 Shift+Tab。
   - 遊戲畫面上蓋了一層 Steam 的半透明介面，就是 overlay。再按一次 Shift+Tab 關掉它。
   - 在「Shift+Tab opened the overlay?」按「Yes」或「No」。
   - 按完之後，再點一下遊戲畫面。
5. **成就**：面板上有一行 `ACH_WIN_ONE_GAME`，這是 Spacewar 的成就，名稱是「Winner」。
   - 如果它顯示 unlocked（以前測過），先按「Clear」，再按「Re-check」，確認變回 locked。
6. 按「Unlock」，看螢幕角落有沒有跳出 Steam 的成就通知（Winner）。
   - 在「Unlock popup appeared?」按「Yes」或「No」。
   - 如果面板的紀錄寫 `returned=no`，等 5 秒再按一次「Unlock」。
7. 按「Open achievements overlay」，看出現什麼，三個選一個按：
   - 「Overlay」：遊戲畫面上蓋了 Steam 介面，顯示 Spacewar 的成就。看完用 Shift+Tab 關掉。
   - 「Steam window」：打開的是 Steam 主視窗，不在遊戲畫面上。2026-11-03 在 Windows 上就是這個結果（第 9.2 節）。看完可以關掉 Steam 視窗。
   - 「Nothing」：什麼都沒出現。
8. 按「Clear」，再按「Re-check」，要顯示 locked。
   - 清不掉的話，看第 6 節最後一段。清不掉也不影響任何東西，只是 Spacewar 的一個成就。
9. **進天賦網**：按 T。
   - 還在戰鬥中：畫面會出現「本局結束後，結算畫面會帶你到天賦網」。等這局結束，在結算畫面再按一次 T。
   - 已經在結算畫面：按一次 T 就會進天賦網。
   - 想快一點，可以先按 4（四倍速）。
10. **存檔**：進天賦網之後等 30 秒（遊戲在選單裡每 30 秒存一次），然後在面板的「Saves」按「Refresh」。
    - 清單要有 `main.json` 和 `backup.json` 兩個檔案。
    - 只看到 `main.json`：再等 30 秒，按「Refresh」。
11. 按「Show folder」，會打開檔案總管（Windows）或 Finder（Mac），並選中存檔。確認資料夾是：
    - Windows：`C:\Users\<你的使用者名稱>\AppData\Roaming\bc-incremental\saves`
    - Mac：`<你的家目錄>/Library/Application Support/bc-incremental/saves`
    - 也可以自己找。Windows：按 Win＋R，貼上 `%APPDATA%\bc-incremental\saves`，按 Enter。Mac：在 Finder 按 ⇧⌘G，貼上 `~/Library/Application Support/bc-incremental/saves`，按 Enter。
    - 裡面的檔案不要改、不要刪。
12. 按「Copy report」，報告會複製到剪貼簿。先把它貼到對話串的輸入框，還不用送出。
    - 按之前先確認第 1、4、6、7 步的問題都按了答案，沒按的在報告裡是 `unknown`。漏了的話，補按之後再按一次「Copy report」，剪貼簿裡會換成新的報告。
13. 關掉遊戲視窗：Windows 按右上角的 X，Mac 按 ⌘Q。
    - 不要在終端機按 Ctrl+C，那樣最後一次存檔可能沒寫進去。
14. **重開一次**，確認存檔讀得回來：
    - Windows 輸入 `npm.cmd run steam:check`
    - Mac 輸入 `npm run steam:check`
    - 這次應該**直接看到天賦網**，不是「玩法」的說明。記下「是」或「否」，然後關掉視窗。

## 5. 要貼回對話串的內容

複製下面這段，填好，再把第 4 節第 12 步的報告貼在最後面：

```
C9 Steam 檢查結果
電腦：Windows／Mac
重開後直接看到天賦網：是／否
跳出的系統視窗：沒有／（視窗標題，和你按了什麼）
卡住或出錯：沒有／（第幾節第幾步）

（在這裡貼上報告，第一行是 bc-incremental steam check v1）
```

- 報告共 12 行。裡面沒有你的 Steam 名稱或帳號 ID，路徑用 `%APPDATA%` 或 `~` 表示，可以直接貼。
- 剪貼簿是空的：面板最下面的文字框裡有同一份報告，可以手動全選複製。或打開 `%APPDATA%\bc-incremental\steam-check`（Mac 是 `~/Library/Application Support/bc-incremental/steam-check`），裡面最新的 `report-….txt` 也是同一份。
- 遊戲視窗或面板根本沒出現：改貼終端機的最後 30 行。
  - 複製方法：用滑鼠選取，Windows 按 Ctrl+C（舊式的 PowerShell 視窗是選取後按 Enter），Mac 按 ⌘C。
  - 裡面的路徑可能有你的使用者名稱，想遮的話換成 `<me>`。
- 有 overlay 的截圖更好，但不是必要。截圖前先點面板標題把它縮起來（面板上有存檔資料夾的完整路徑，可能有你的使用者名稱）。Windows 按 Win＋Shift＋S，Mac 按 ⇧⌘4。
- 兩台電腦都做的話，各貼一份。

## 6. 出問題時

| 看到什麼 | 怎麼做 |
|---|---|
| 「npm.ps1 無法載入」或「已停用指令碼執行」 | 你打了 `npm`。改打 `npm.cmd`。 |
| 「node」或「git」不是可辨識的指令 | 裝完之後要關掉 PowerShell 或終端機，重開一個。 |
| `destination path 'bc-steam-check' already exists` | 你以前做過。照第 7 節「我請你測新版本時」那幾步做。 |
| `npm.cmd ci` 出現 `EBUSY` 或 `EPERM`（Windows） | 關掉開著這個資料夾的程式（編輯器、檔案總管），再輸入一次 `npm.cmd ci`。還是不行就重開機再試。 |
| Electron 下載失敗或卡很久 | 再做一次下載 Electron 的那一步。還是不行，把終端機最後 30 行貼給我。 |
| 面板寫 `Steam: NOT connected (load)`，錯誤裡有 `could not be found` 或「找不到指定的模組」（Windows） | 安裝微軟免費的 Visual C++ 可轉散發套件（x64）：https://aka.ms/vc14/vc_redist.x64.exe 。裝完關掉遊戲視窗，重新輸入啟動指令。 |
| 面板寫 `Steam: NOT connected (init)` | Steam 沒開、沒登入、在離線模式，或 Steam 和 PowerShell 一個用系統管理員身分、一個沒有。都用一般身分開好、切回線上，關掉遊戲視窗，重新輸入啟動指令。 |
| 其他的 `NOT connected` | 第 4 節能做的照樣做完，按「Copy report」貼回來。 |
| 「Windows 已保護您的電腦」（SmartScreen） | 預期不會出現。先截圖，確認上面寫的是 `electron.exe`，再按「其他資訊」→「仍要執行」。 |
| Windows 防火牆問要不要允許 `electron.exe` | 按「取消」（遊戲不需要網路連入），並記下來。 |
| Mac 跳出要權限的視窗（鑰匙圈、檔案夾、區域網路） | 按「不允許」或「拒絕」，並記下來。 |
| 防毒軟體警告 | 截圖，不要刪檔，告訴我。 |
| 視窗全黑或全白 | 看得到面板的話，照樣按「Copy report」，並在「卡住或出錯」寫下來。 |
| 遊戲有出現，但右上角沒有面板 | 確認輸入的是含 `steam:check` 的那一行。 |

**用 Steam 主控台清掉成就**（只在面板的「Clear」清不掉時才做）：

1. 在瀏覽器網址列貼上 `steam://open/console`，按 Enter。瀏覽器問要不要開啟 Steam 時，按「開啟」。
2. Steam 會打開「主控台」分頁。在最下面的輸入框輸入 `achievement_clear 480 ACH_WIN_ONE_GAME`，按 Enter。

## 7. 做完之後

等我在對話串確認收到報告之後，再做清理。

**我請你測新版本時**（不用重新下載專案）：

專案不在 `~\bc-steam-check`（Mac 是 `~/bc-steam-check`）的話，第 1 步 `cd` 到你放的位置。用免安裝版 Node.js 的話，先照第 2.1 節第 2 步在這個視窗設好 PATH。

Windows：

1. 輸入 `cd ~\bc-steam-check`
2. 輸入 `git fetch`
3. 輸入 `git checkout <我給你的 commit>`
4. 輸入 `npm.cmd ci`
5. 輸入 `npm.cmd run steam:check`

Mac：

1. 輸入 `cd ~/bc-steam-check`
2. 輸入 `git fetch`
3. 輸入 `git checkout <我給你的 commit>`
4. 輸入 `npm ci`
5. 輸入 `npm run steam:check`

**清理**（都可以刪，不影響 Steam 或其他東西）：

- 專案資料夾：Windows 是 `C:\Users\<你的使用者名稱>\bc-steam-check`，Mac 是家目錄裡的 `bc-steam-check`（放在別的地方的話，就是那個資料夾）。
- 免安裝版的 Node.js（有用的話）：解壓縮出來的資料夾。
- 測試存檔和報告：Windows 是 `%APPDATA%\bc-incremental`，Mac 是 `~/Library/Application Support/bc-incremental`。
- Electron 的下載快取（約 120 MB）：Windows 是 `%LOCALAPPDATA%\electron\Cache`，Mac 是 `~/Library/Caches/electron`。
- Node.js 和 Git 可以留著，M3 再測一次時還會用到。

## 8. C10 的量測（同一次做的話）

這一節量兩件事，之後的效能檢查會拿它們當基準：

1. **模擬速度**：同一段戰鬥模擬在你的電腦上跑多快。CI 的效能門檻會參考這個數字。
2. **畫面順不順**：一個比平常遊戲更擠的畫面（約 270 隻怪同時在場，加上 32 個召喚物、8 顆環繞球、光環和 Boss 身上約 500 層毒），在你的螢幕上能不能維持每秒 60 格。網頁版和 Steam 版各量一次。召喚物、環繞球和光環現在只在模擬裡計算，要等 B1 接上角色外觀才會畫在畫面上，所以這次量到的畫面比最後的遊戲輕一些。

- **時間**：每台電腦約 15 分鐘，兩台都做約 30 分鐘。
- **不用另外安裝東西**：用第 2 節或第 3 節已經下載好的 `bc-steam-check` 資料夾。
- **不會動到**：瀏覽器裡網頁版的存檔、Steam 的設定。量測畫面不存任何東西，也不送出任何資料。
- 做完把三段文字貼回這個對話串（第 8.4 節）。
- 數字不好看沒有關係，照實貼回來就好。這一節沒有「做錯」的結果。
- 兩台電腦都有的話，兩台都做；只做一台的話，用做第 4 節的那台。

### 8.0 開始之前

1. 第 4 節已經做完，遊戲視窗已經關掉。Steam 繼續開著（第 8.3 節會用到）。
2. 筆電插上電源。
3. 關掉用不到的程式：影片、視訊會議、大型下載、其他遊戲。這個對話串開著沒關係。
4. 關掉省電設定（做完可以改回來）：
   - Mac：「系統設定」→「電池」→「低耗電模式」選「永不」。桌上型 Mac 在「能源」裡。找不到這個選項就跳過。
   - Windows 11：「設定」→「系統」→「電源與電池」→「電源模式」選「最佳效能」。
   - Windows 10：點工作列右下角的電池圖示，把滑桿拉到最右邊。
   - 桌上型電腦沒有這些選項的話，跳過。
5. 打開終端機：Windows 是 PowerShell（第 2.1 節第 4 步），Mac 是「終端機」（第 3.1 節第 3 步）。第 4 節用的視窗還開著的話，直接用它。

### 8.1 模擬速度（約 3 分鐘）

一個步驟一行指令。打完按 Enter，等它跑完、可以再打字了，再做下一步。專案不在 `~\bc-steam-check`（Mac 是 `~/bc-steam-check`）的話，第 1 步 `cd` 到你放的位置。

**Windows：**

1. 輸入 `cd ~\bc-steam-check`
2. 輸入 `npm.cmd run readings`
   - 大約 1 分鐘，中間可能有一陣子沒有新的輸出。風扇變大聲是正常的。
   - **跑的時候不要用電腦**：不要打字、不要開別的程式，滑鼠放著就好。
   - 跑完會出現一段以 `bc-incremental readings v1` 開頭、`end readings` 結尾的文字。
3. 輸入 `notepad out\readings\readings.txt`
   - 記事本會打開同一段文字。按 Ctrl+A 全選、Ctrl+C 複製，貼到對話串的輸入框（還不用送出），再關掉記事本。

**Mac：**

1. 輸入 `cd ~/bc-steam-check`
2. 輸入 `npm run readings`
   - 大約 1 分鐘，中間可能有一陣子沒有新的輸出。風扇變大聲是正常的。
   - **跑的時候不要用電腦**：不要打字、不要開別的程式，滑鼠放著就好。
   - 跑完會出現一段以 `bc-incremental readings v1` 開頭、`end readings` 結尾的文字。
3. 輸入 `open -e out/readings/readings.txt`
   - 「文字編輯」會打開同一段文字。按 ⌘A 全選、⌘C 複製，貼到對話串的輸入框（還不用送出），再按 ⌘Q 關掉「文字編輯」。

**要不要重跑**：看那段文字倒數第二行。

- `rerun: no`：不用重跑，做第 8.2 節。
- `rerun: yes`：電腦當時比較忙，數字可能偏慢。先照樣貼上，把其他程式都關掉，再做一次第 2、3 步，兩次的結果都貼。只重跑一次就好，第二次還是 `yes` 也沒關係。

### 8.2 網頁版畫面（約 4 分鐘）

1. 啟動網頁版：
   - Windows 輸入 `npm.cmd run fps:web`
   - Mac 輸入 `npm run fps:web`
   - 會先 build 一下（大約半分鐘以內），然後出現 `Local:   http://localhost:4173/` 這一行，它下面還有一行 `Network: use --host to expose`。
   - 中間出現黃色的 `(!) Some chunks are larger than 500 kB`，和兩則提到 `annotation` 的警告，是正常的，不用理會。
   - 這個終端機視窗要一直開著，量完才停（第 8 步）。
2. 打開瀏覽器：Windows 用 Chrome 或 Edge。Mac 有 Chrome 就用 Chrome，沒有就用 Safari（不用另外安裝）。
3. 在網址列輸入 `http://localhost:4173/?replay=renderStress`，按 Enter。
   - 會看到一大群怪物的戰鬥畫面，角落有一個英文的量測面板。
4. 按 Ctrl+0（Mac 按 ⌘0），把網頁縮放還原成 100%。
5. 切到全螢幕：Windows 按 F11；Mac 按 ⌃⌘F（Control＋Command＋F）。
   - 之後不要再改視窗大小。改了的話，量測會從頭開始。
6. 等大約 40 秒。這段時間**不要切換視窗或分頁**，也不要打字，滑鼠放著就好。
   - 面板一開始顯示 `measuring 0 / 30 s (warm-up)`，大約 5 秒後秒數開始往上數。量完會出現以 `bc-incremental fps v1` 開頭、`end fps` 結尾的一段文字。
7. 在面板上按「Copy」。再按一次 F11（Mac 按 ⌃⌘F）離開全螢幕，把內容貼到對話串的輸入框（還不用送出）。
   - 順便記下畫面看起來順不順（順／偶爾卡一下／一直卡），第 8.4 節會問。
8. 回到終端機，按 Ctrl+C 停掉網頁版。Mac 也是按 Control＋C，不是 ⌘C。
   - Windows 問「終止批次工作 (Y/N)?」：輸入 `Y`，按 Enter。

### 8.3 Steam 版畫面（約 4 分鐘）

1. 確認 Steam 開著、已登入。
2. 啟動：
   - Windows 輸入 `npm.cmd run fps:steam`
   - Mac 輸入 `npm run fps:steam`
   - 會先 build 一下（大約半分鐘以內），然後跳出遊戲視窗。這次不是一般的遊戲畫面，而是跟第 8.2 節一樣的戰鬥畫面和量測面板。
   - 好友一樣會看到你「正在玩 Spacewar」。
3. 把視窗放到最大：Windows 按視窗右上角中間的「□」；Mac 按視窗左上角的綠色按鈕（會變成全螢幕）。
   - 之後不要再改視窗大小。
4. 等大約 40 秒，不要切換視窗，滑鼠放著就好，等面板出現 `end fps`。
5. 在面板上按「Copy」，把內容貼到對話串的輸入框（還不用送出）。順便記下順不順。
6. 關掉遊戲視窗：Windows 按右上角的 X，Mac 按 ⌘Q。

### 8.4 要貼回對話串的內容

複製下面這段，填好，再把三段結果照順序貼在後面。可以接在第 5 節的報告後面一起送出，也可以分開送。

```
C10 量測結果
電腦：Windows／Mac（知道型號的話寫上，例如 MacBook Air M2）
插著電源：是／否
省電設定關掉了：是／否／找不到
瀏覽器：Chrome／Edge／Safari
螢幕：筆電內建／外接（知道的話寫更新率，例如 60 Hz、120 Hz）
網頁版看起來：順／偶爾卡一下／一直卡
Steam 版看起來：順／偶爾卡一下／一直卡／沒做
卡住或出錯：沒有／（第幾節第幾步，看到什麼）

（貼上第 8.1 節的結果，第一行是 bc-incremental readings v1；重跑過就兩份都貼）
（貼上第 8.2 節的結果，第一行是 bc-incremental fps v1，下一行有 page: web）
（貼上第 8.3 節的結果，第一行是 bc-incremental fps v1，下一行有 page: steam）
```

- 三段結果裡沒有你的名字、帳號或檔案路徑，只有作業系統、處理器、螢幕大小和瀏覽器版本，可以直接貼。
- 結果寫 `FAIL` 也照樣貼，不用重做（第 8.1 節的重跑規則除外）。
- 兩台電腦都做的話，各貼一份。
- 做完可以把省電設定改回原本的樣子。清理跟第 7 節一樣：這一節留下的檔案（`out` 和 `dist` 開頭的資料夾）都在專案資料夾裡，Steam 版的快取在第 7 節列的測試存檔資料夾裡，沒有放到別的地方。

### 8.5 出問題時

| 看到什麼 | 怎麼做 |
|---|---|
| `Missing script`，後面接著第 8 節的指令名稱 | 專案版本太舊。先照第 7 節「我請你測新版本時」更新到我給你的 commit，再做這一節。 |
| 第 8.1 節出現紅色的 `Error`，或 10 分鐘以上都沒有動靜 | 按 Ctrl+C 停掉，把終端機最後 30 行貼給我（複製方法見第 5 節），然後繼續做第 8.2 節。 |
| `Port 4173 is already in use` | 另一個終端機視窗還在跑網頁版。到那個視窗按 Ctrl+C，或直接關掉它，再做一次第 8.2 節第 1 步。 |
| 瀏覽器顯示「無法連上這個網站」 | 終端機還沒出現 `Local:` 那一行，或已經被停掉。等它出現，再重新整理網頁。 |
| 畫面全黑、全白，或沒有量測面板 | 先確認網址跟第 8.2 節第 3 步一樣。還是不行：Chrome 到「設定」→「系統」，Edge 到「設定」→「系統與效能」，打開「可用時使用圖形加速」，重開瀏覽器再試一次。仍然不行就截圖貼回來，跳過這一步。 |
| 按「Copy」沒有反應 | 面板最下面的文字框裡有同一段文字：點一下文字框，按 Ctrl+A（Mac 是 ⌘A）全選，再按 Ctrl+C（⌘C）。還是不行就把面板截圖：Windows 按 Win＋Shift＋S，Mac 按 ⇧⌘4。 |
| 面板寫 `median interval` 大約是 33 | 瀏覽器在省電，每秒只畫 30 格。確認插著電源、省電設定已關，重做一次第 8.2 節，兩份都貼。 |
| Windows 防火牆問要不要允許 Node.js | 按「取消」，並記下來。量測網頁只在這台電腦上開，不需要網路連入。 |
| Mac 問要不要讓 node 接受連入的網路連線 | 按「拒絕」，並記下來。 |
| 第 8.3 節跳出的是一般的遊戲畫面，沒有量測面板 | 關掉視窗，在「卡住或出錯」寫下來，跳過第 8.3 節。 |

## 9. 結果

### 9.1 2026-11-03，Windows

- **電腦**：Windows 10（版本 19045）x64。Steam 用戶端開著、已登入。
- **build**：`0.0.1+abaec66`，也就是第 2.2 節第 4 步的 commit `abaec66`（C7b）。它包含 Steam 檢查模式（C9.2b，`c626f3e`）和存檔讀取失敗的修正（`1302e1d`）。從它到記下這份結果時（2026-11-03），殼（`electron/`）、`src/platform/`、`package.json` 和 CI 都沒有再改過，所以結果也適用於現在的程式。
- **版本**：Electron 44.8.0（Chrome 152.0.7977.167），steamworks.js 0.4.0，App ID 480（Spacewar）。報告裡的 `node 24.22.0` 是 Electron 內建的 Node，不是跑 npm 的那個（第 9.4 節）。
- **做了**：第 1、2、4、5 節。第 8 節（C10 量測）這次沒做。
- **Hoshi 在對話串的回答**（第 5 節要的四項，分幾則訊息回答）：電腦是 Windows；重開後直接看到天賦網：是；跳出的系統視窗：沒有（SmartScreen、Defender、防火牆都沒有）；卡住或出錯：沒有。第 4 節第 7 步看到的是「Steam window」。
- **截圖**：Hoshi 傳了兩張，沒有放進 git（上面有 Steam 帳號名稱和含 Windows 使用者名稱的路徑）：一張是 overlay 裡的成就頁，Winner 已解鎖；一張是用 Shift+Tab 叫出來、蓋在遊戲畫面上的 overlay，旁邊是面板的紀錄和存檔清單。

**報告**（Hoshi 貼回的原文，2026-11-03 04:39:55 UTC 貼上，一個字都沒改）：

```text
bc-incremental steam check v1
when: 2026-11-03T04:39:50.679Z   build: 0.0.1+abaec66
os: win32 x64 10.0.19045 translated=no
versions: electron 44.8.0 chrome 152.0.7977.167 node 24.22.0 steamworks.js 0.4.0
steam: ok app=480 language=english deck=no init_ms=1004
overlay_switches: in-process-gpu, disable-direct-composition
gpu: 2d_canvas=enabled direct_rendering_display_compositor=disabled_off_ok gpu_compositing=enabled multiple_raster_threads=enabled_on opengl=enabled_on rasterization=enabled raw_draw=disabled_off_ok skia_graphite=disabled_off trees_in_viz=disabled_off video_decode=enabled video_encode=enabled webgl=enabled webgpu=enabled webnn=disabled_off
saves: %APPDATA%\bc-incremental\saves   autocloud: WinAppDataRoaming bc-incremental/saves *.json
save_files: backup.json 583 B 2026-11-03T04:39:41.446Z; main.json 583 B 2026-11-03T04:39:41.456Z
ach: before=locked | unlock returned=yes now=unlocked | unlock returned=yes now=unlocked | unlock returned=yes now=unlocked | clear returned=yes now=locked | recheck now=locked | clear returned=yes now=locked | recheck now=locked
answers: hint_at_start=yes unlock_popup=yes shift_tab=yes overlay_page=unknown
errors: 0
```

`overlay_page=unknown` 是因為報告在回答第 4 節第 7 步之前就複製了。Hoshi 之後在對話串回答「Steam window」（04:43 UTC），所以這一項的結果是 `steam-window`。

| 檢查 | 結果 | 依據 |
| --- | --- | --- |
| 原生模組載入（win32-x64） | 成功 | `steam: ok`，沒有出現 `NOT connected (load)` |
| `init(480)` | 成功，1,004 ms | `steam: ok app=480 language=english deck=no init_ms=1004` |
| x64 原生執行（不是轉譯） | 是 | `os: win32 x64 10.0.19045 translated=no` |
| overlay 的兩個 Chromium 參數 | 都加上了 | `overlay_switches: in-process-gpu, disable-direct-composition` |
| 真的 GPU | GPU 合成、WebGL、WebGPU 都開著 | `gpu:` 的 `gpu_compositing=enabled`、`webgl=enabled`、`webgpu=enabled` |
| 視窗出現時的 Shift+Tab 提示（第 4 節第 1 步） | 有 | `hint_at_start=yes` |
| Shift+Tab 叫出 overlay（第 4 步） | 有 | `shift_tab=yes`，截圖 |
| 解鎖時跳出的 Winner 通知（第 6 步） | 有 | `unlock_popup=yes` |
| Unlock、Clear、Re-check（第 5、6、8 步） | Unlock 與 Clear 每次都回 `yes`；每次讀回來的狀態（Re-check 也是）都對：locked → unlocked → locked | `ach:` 那一行（Unlock 3 次、Clear 2 次、Re-check 2 次） |
| 「Open achievements overlay」（第 7 步） | 打開的是 **Steam 主視窗**，不是遊戲畫面上的 overlay | Hoshi 的回答（第 9.2 節） |
| 存檔（第 10 步） | 進天賦網之後，`main.json`、`backup.json` 各 583 B，在 `%APPDATA%\bc-incremental\saves` | `saves:`、`save_files:` |
| Auto-Cloud 的路徑 | `WinAppDataRoaming`、`bc-incremental/saves`、`*.json` | `autocloud:`（只是殼算出來、M3 要設定的路徑，480 上沒有同步） |
| 「Show folder」（第 11 步） | 沒有明確確認 | 面板列出的兩個檔案就在 `%APPDATA%\bc-incremental\saves` |
| 重開後讀回存檔（第 14 步） | 直接看到天賦網 | Hoshi 的回答 |
| 系統視窗（第 6 節） | 沒有 | Hoshi 的回答 |
| 卡住或出錯 | 沒有 | Hoshi 的回答，`errors: 0` |

### 9.2 「Open achievements overlay」打開的是 Steam 主視窗

- 這個按鈕呼叫 steamworks.js 的 `overlay.activateDialog(6)`（`Dialog.Achievements`；`electron/steam.ts` 的 `OVERLAY_DIALOGS.achievements`）。
- **overlay 本身能用**：視窗出現時的提示、Shift+Tab 叫出的介面和解鎖通知都是 overlay 畫的，三項都出現了，overlay 裡的成就頁也看得到 Winner 已解鎖。只有「程式主動叫 overlay 開某一頁」這個呼叫，被 Steam 開到 Steam 主視窗。
- 原因還沒查。steamworks.js 0.4.0 沒有查詢 overlay 能不能用的函式，也沒有 overlay 開關時的回呼，所以殼看不出 Steam 開了哪一個，只能靠眼睛看。
- **現在玩家看得到的介面都不呼叫它**：整個程式只有檢查面板的「Open achievements overlay」（`src/platform/steam/checkPanel.ts`）會呼叫，它走 `bc:check:overlay`，main process 只在 `--steam-check` 時回應。`friends`（0）有對應的值，但沒有任何地方呼叫。所以這個結果現在不影響玩家。
- M3 在遊戲自己的 App ID 上、從 Steam 啟動時再測一次。要在遊戲裡加開 overlay 的按鈕（例如成就頁）之前，先過這一項（`docs/ARCHITECTURE.md` §11.8）。

### 9.3 這次沒做的

- **macOS**：這次沒有 Mac，第 3 節還沒做。還沒有答案的是：Mac 的存檔位置（`~/Library/Application Support/bc-incremental/saves`）、Gatekeeper 與鑰匙圈的視窗、Apple 晶片上的原生模組。Mac 上的 overlay 本來就預期不會出現，Windows 的結果不靠它。
- **Auto-Cloud（Steam 雲端同步）**：App ID 480 測不到。要在自己的 App 的 Steamworks 後台設定路徑、用 `testappcloudpaths`、從 Steam 啟動（同步在啟動和結束時跑），所以 M3 在 Hoshi 的 App ID 上測。報告的 `autocloud:` 只是殼算出來的路徑。
- **第 8 節（C10 量測）**：這次沒做。要不要做、什麼時候做，另外決定。
- **從 Steam 啟動**（不是從終端機）：M3。
- 「Show folder」打開的資料夾：沒有明確確認（上表）。

### 9.4 和這份手冊不一樣的地方

- 那台電腦沒有 Node.js：用的是 Node.js v22 的免安裝版（.zip，v22.23.4），放在專案資料夾裡，系統的 PATH 沒改。第 2.1 節第 2 步加了這個做法。
- 專案放在 D: 槽的一個資料夾，不是 `~\bc-steam-check`。第 2.2 節第 1 步、第 7 節和第 8.1 節加了「放在別的地方」的說明。
- 終端機的指令由那台電腦上的 Claude 打，Hoshi 做遊戲裡的步驟（第 4 節）並回答問題。
- 報告在回答第 4 節第 7 步之前就複製了，所以 `overlay_page=unknown`。第 4 節第 12 步加了「先確認問題都答了」。
