#!/bin/bash
# 重新產生工作台「作品」頁的縮圖。
#
# 用法：
#   ./feeder/refresh-works-thumbs.sh            # 全部重跑
#   ./feeder/refresh-works-thumbs.sh zense-home linmei   # 只重跑指定的幾個 id
#
# 讀 ../dashboard-data/works.json 的 url，寫 ../dashboard-data/works-thumbs/<id>.jpg。
# 跑完不會自動 commit——請自己看過縮圖再決定要不要推。
#
# ⛔ 三個踩過的坑，改這支之前先讀：
#   1. zense.tw 有開場動畫，不加 --force-prefers-reduced-motion 會拍到 logo splash。
#      這比「多等幾秒」可靠，因為走的是網站自己寫好的無障礙分支。
#   2. 取值失敗不准當成成功：Chrome 的 exit code 幾乎永遠是 0，網站掛了它照樣
#      「成功」拍下一張「無法連線」的錯誤頁。所以判定要靠內容，不能靠 exit code。
#   3. ⛔ 光靠檔案大小門檻不夠——實測 Chrome 錯誤頁縮完是 6,969 bytes，
#      比原本設的 6,000 門檻還大，於是壞掉的截圖會被判成成功。
#      這個洞是本腳本自己的對照組抓出來的（2026-08-12），⛔ 不要把門檻調回去。
#      現在是兩道關：① curl 先確認網址回 2xx ② 截完再看檔案大小。
#   4. 判準本身也要驗：腳本最後跑兩個一定要失敗的對照組，兩道關各驗一個。
#      任一個對照組「通過」＝ 那道關是壞的 → 整支判定失敗，
#      因為那代表前面那一整排 ✅ 都沒有鑑別力。

set -uo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$(cd "$HERE/../dashboard-data" 2>/dev/null && pwd)"
OUT="$DATA/works-thumbs"
TMP="$(mktemp -d)"
# 門檻用實測數字定的，⛔ 不是猜的（2026-08-12 在 mini 上量）：
#   純白空白頁 3,933 bytes ｜ Chrome 錯誤頁 6,969 bytes ｜ 真網站最小 11,787 bytes（meetcard）
# 8000 夾在錯誤頁與真網站之間，兩邊都留 1.4 倍以上餘裕。
MIN_BYTES=8000
trap 'rm -rf "$TMP"' EXIT

[ -x "$CHROME" ] || { echo "✗ 找不到 Chrome：$CHROME"; exit 2; }
[ -n "$DATA" ] && [ -f "$DATA/works.json" ] || { echo "✗ 找不到 ../dashboard-data/works.json"; exit 2; }
mkdir -p "$OUT"

# ---------- 取出要處理的 id / url ----------
LIST="$TMP/list.tsv"
python3 - "$DATA/works.json" "$@" > "$LIST" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
want = set(sys.argv[2:])
for g in doc.get('groups', []):
    for it in g.get('items', []):
        if want and it['id'] not in want:
            continue
        print(it['id'], it['url'], sep='\t')
PY
[ $? -eq 0 ] || { echo "✗ 讀 works.json 失敗"; exit 2; }

N=$(wc -l < "$LIST" | tr -d ' ')
# 掃描對象數為零不得回報通過——0 筆代表 works.json 空了或 id 打錯，不是「沒事要做」
[ "$N" -gt 0 ] || { echo "✗ 沒有任何符合的作品（works.json 是空的，或指定的 id 不存在）"; exit 2; }
echo "要重拍 $N 張縮圖，輸出到 $OUT"
echo

# ---------- 第一道關：網址活著嗎 ----------
# check_url <url>；回 2xx 才算活著
check_url() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 -L "$1")
  case "$code" in 2??) return 0;; *) return 1;; esac
}

# ---------- 第二道關：拍一張，看畫面有沒有東西 ----------
# capture <id> <url> <目的檔>；成功回 0，失敗回 1
capture() {
  local id="$1" url="$2" dest="$3"
  local raw="$TMP/$id.png" crop="$TMP/$id-crop.png"
  rm -f "$raw" "$crop"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
            --force-prefers-reduced-motion \
            --window-size=1280,800 --virtual-time-budget=15000 \
            --screenshot="$raw" "$url" >/dev/null 2>&1
  [ -s "$raw" ] || return 1
  sips -c 800 1280 "$raw" --out "$crop" >/dev/null 2>&1 || return 1
  sips -Z 560 --setProperty format jpeg --setProperty formatOptions 68 \
       "$crop" --out "$dest" >/dev/null 2>&1 || return 1
  local sz
  sz=$(stat -f %z "$dest" 2>/dev/null || echo 0)
  [ "$sz" -ge "$MIN_BYTES" ] || return 1
  return 0
}

FAIL=0
while IFS=$'\t' read -r id url; do
  if ! check_url "$url"; then
    printf "  ❌ %-24s 網址打不開（舊圖保留沒有覆蓋）\n" "$id"
    FAIL=$((FAIL + 1))
  elif capture "$id" "$url" "$OUT/$id.jpg"; then
    printf "  ✅ %-24s %5s KB\n" "$id" "$(( $(stat -f %z "$OUT/$id.jpg") / 1024 ))"
  else
    printf "  ❌ %-24s 打得開但截出來是空白的（舊圖保留沒有覆蓋）\n" "$id"
    FAIL=$((FAIL + 1))
  fi
done < "$LIST"

# ---------- 對照組：證明上面那排 ✅ 真的有鑑別力 ----------
# 兩道關各驗一個。任一個「通過」都代表那道關是壞的，前面每個 ✅ 都不能採信。
echo
if check_url "http://127.0.0.1:1/definitely-not-a-real-site"; then
  echo "🔴 對照組 A 通過了——連不上的網址被判成活著，網址檢查是壞的"
  exit 2
fi
echo "✓ 對照組 A：連不上的網址正確被擋（網址檢查有在動）"

# 純白空白頁：打得開、但畫面沒東西。專門驗第二道關。
if capture "__control_b__" "data:text/html,<body style='background:%23fff'>" "$TMP/control-b.jpg"; then
  echo "🔴 對照組 B 通過了——純白空白畫面被判成拍成功，大小門檻是壞的"
  exit 2
fi
echo "✓ 對照組 B：純白空白畫面正確被擋（大小門檻有在動）"

echo
if [ "$FAIL" -gt 0 ]; then
  echo "⚠️ $N 張裡有 $FAIL 張沒拍成功，失敗的那幾張維持舊圖。"
  echo "   常見原因：網站掛了、網址改了、或它需要登入。先自己用瀏覽器開開看。"
  exit 1
fi

echo "全部 $N 張都更新好了。接著："
echo "  1. 先看過縮圖：open $OUT"
echo "  2. 沒問題再推："
echo "     cd $DATA && git add works-thumbs && git commit -m '更新作品縮圖' -- works-thumbs && git push"
exit 0
