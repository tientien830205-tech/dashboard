# Ted 工作台（前端）

跨專案待辦儀表板。**這個 repo 是公開的，裡面一行資料都沒有** —— 待辦內容全部存在私有 repo `dashboard-data`，網頁靠瀏覽器裡的一組 fine-grained token 去讀寫。

網址：https://tientien830205-tech.github.io/dashboard/

## 為什麼要拆兩個 repo

GitHub Pages 在免費方案只能從**公開** repo 發布，而待辦清單裡有客戶名字、報價數字、貸款餘額。所以：

| repo | 可見性 | 內容 |
| --- | --- | --- |
| `dashboard`（本 repo） | 公開 | HTML/CSS/JS，零資料 |
| `dashboard-data` | 私有 | `todos.json`＋`widgets/*.json` |

沒有 token 的人打開網址只會看到一個要你貼授權碼的空殼。

## 檔案

```
index.html              版面骨架
assets/app.css          樣式（深色、手機優先）
assets/app.js           全部邏輯：讀寫 GitHub、渲染、篩選
assets/icon.svg         PWA 圖示
manifest.webmanifest    可「加入主畫面」當 App 用
feeder/push-widgets.mjs 把 Ted 自己的工具資料推成 widgets/*.json（跑在 Mac 或 mini）
```

## 本機開發

```bash
python3 -m http.server 8791 --directory /Users/Shared/Claude-Code
open "http://localhost:8791/dashboard/index.html?local=1"
```

`?local=1` ＝ 直接讀隔壁 `dashboard-data/todos.json`，**不需要授權碼、唯讀不寫回**。
`?f=open` 可指定進來的預設篩選（`focus`／`quick`／`mine`／`open`／`all`），方便截圖驗版面。

截圖驗手機版面要注意：Chrome headless 有最小視窗寬度（約 450px），直接 `--window-size=390` 會拍出「被裁掉」的假象。真要看 390px 要把頁面塞進 iframe 再拍。

## 寫入怎麼不打架

手機跟 Mac 可能同時改。每次存檔的流程是：

1. 使用者操作 → 立刻更新畫面，操作進 `state.ops` 佇列
2. 0.9 秒後 flush：**先抓一份最新的 `todos.json`**
3. 把佇列裡的操作重播到那份最新資料上
4. 帶 `sha` PUT 回去（衝突就整批重試）

所以「Ted 在手機打勾」＋「Claude 在 Mac 加項目」不會互相蓋掉。同步狀態一律顯示在右上角，失敗會顯示紅字原因，不靜默。

## 加一個新工具卡片

1. 在 `dashboard-data/todos.json` 的 `widgets` 陣列加一筆：
   ```json
   { "id": "xxx", "title": "…", "source": "widgets/xxx.json", "status": "pending", "pendingReason": "還沒接上", "icon": "📊" }
   ```
2. 在 `feeder/push-widgets.mjs` 寫一支 `collect` 函式回傳 widget 格式，加進 `FEEDS`
3. widget 格式：
   ```json
   { "title": "…", "updated": "…", "metrics": [{"label":"…","value":"…"}], "lines": ["…"], "link": {"href":"…","text":"…"} }
   ```
4. 資料源還沒好時 `collect` 回 `null`，卡片會維持虛線佔位，不會壞掉
