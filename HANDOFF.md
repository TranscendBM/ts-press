# 交接文件 — 新聞稿發送系統（press-center）

這份文件給接手的人與其 AI 助理，讓你不必從頭摸索。技術細節在
[README.md](README.md)，這裡著重「怎麼拿到存取權」「踩過哪些坑」「還有什麼沒做」。

最後更新：2026-07（交接時）

---

## 一、這是什麼

創見資訊內部的新聞稿管理與發送系統。

- 線上網址：**https://ts-press.web.app**
- 程式碼：**GitHub `TranscendBM/ts-press`**（Private）
- Firebase 專案：**`ts-press`**（專案編號 `93639953175`）
- 本機路徑：`~/Desktop/press-center`

功能：管理四份媒體名單（台灣 PR / 台灣 IR / Global PR / 美國 PR）＋
新聞稿三語言版本（tw/www/us）＋ 透過公司 mail2000 SMTP 發送 ＋
媒體關係經營（餐敘、年節禮品）＋ 角色權限。

---

## 二、接手前，原負責人需要幫你開通三項存取權

**這三項只有現任擁有者能操作，AI 無法代勞，交接時務必先完成：**

1. **GitHub**：把你的 GitHub 帳號加為 `TranscendBM/ts-press` 的 collaborator
   （repo → Settings → Collaborators）。你要用自己的 SSH key 或 PAT 才能 clone/push。

2. **Firebase**：到 [Firebase Console → 專案設定 → 使用者與權限](https://console.firebase.google.com/project/ts-press/settings/iam)
   把你的 Google 帳號加為 **Editor**（部署）或 **Owner**（含計費）。

3. **系統後台**：請一位現任 admin 到系統的「系統設定 → 使用者」把你的
   Google 帳號加進白名單、角色設 `admin`。否則你登入 https://ts-press.web.app 會被擋。

---

## 三、本機環境設定（clone 之後）

```bash
git clone git@github.com:TranscendBM/ts-press.git
cd ts-press
npm install
npm --prefix functions install
```

**建立 `.env.local`**（Firebase 前端設定值，這些是公開值、非機密）：

```
VITE_FIREBASE_API_KEY=AIzaSyCyhr6mNZoXZUgUe9TiIkWBXHkWQ_c8OZA
VITE_FIREBASE_AUTH_DOMAIN=ts-press.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=ts-press
VITE_FIREBASE_STORAGE_BUCKET=ts-press.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=93639953175
VITE_FIREBASE_APP_ID=1:93639953175:web:b8e3f6a34611d4990b4552
```

> 這組值本來就內嵌在前端、公開可見，不是機密。真正的機密（SMTP 密碼）
> 在 Google Secret Manager，見第五節。

```bash
npx firebase login          # 用有專案權限的 Google 帳號
npx firebase use ts-press
npm run dev                 # 本機開發
```

常用指令：

```bash
npm run build               # 前端建置
npm test                    # 單元測試（規則測試需模擬器，見第六節）
npm run deploy:web          # 只部署前端
npm run deploy:functions    # 只部署 Cloud Functions
npm run deploy:rules        # 只部署 Firestore/Storage 規則
```

---

## 四、機密資訊都在哪裡（沒有明文寫在任何檔案）

| 項目 | 位置 | 取得方式 |
|---|---|---|
| SMTP 密碼（寄信帳號） | Google Secret Manager `SMTP_PASS` | 由 admin 在「系統設定 → 寄信設定」更新，不經程式碼 |
| SMTP 主機/埠/帳號 | Firestore `settings/smtp` | 後台「寄信設定」可看可改 |
| Firebase 前端 config | `.env.local` | 見第三節（公開值） |

**沒有任何密碼寫在 git 裡。** SMTP 密碼永遠只在 Secret Manager，
前端只能寫入不能讀取。

寄信目前用 `email.transcend-info.com` 的 **587 埠 + STARTTLS**，
認證帳號 `elvis_cheng@transcend-info.com`、寄件顯示 `press_center@transcend-info.com`
（代理寄件）。**交接後若換寄件人，到後台「寄信設定」改帳號密碼即可，不必動程式。**

---

## 五、務必知道的踩坑紀錄（這些花了最多時間）

1. **mail2000 用 587 不能用 25** — Google Cloud 封鎖對外 port 25。

2. **split-horizon DNS** — 公司內網查 `email.transcend-info.com` 得到內網 IP
   `10.0.0.150`，外部查是 `59.124.102.36`。在公司內 debug 別誤判成連不到。

3. **TLS 中介憑證** — mail2000 交握時不送中介憑證，Node 拼不出信任鏈。
   已把 Sectigo 中介憑證內建在 `functions/src/smtpCa.ts`。
   **憑證 2026-08-22 到期**，換發後若又出現 `unable to verify the first certificate`，
   需更新這張憑證（README 第七節有指令）。

4. **共用範本的單一來源** — email 樣板與權限邏輯放在 `shared/`，
   Cloud Functions 無法直接引用上層目錄，所以 build 前會由
   `functions/scripts/sync-shared.mjs` 複製成 `*.generated.ts`（已 gitignore）。
   **改範本或權限只改 `shared/`，不要改 generated 檔。**

5. **custom claim** — Storage 規則看 token 裡的 `pressCenter` / `role` claim，
   由 `syncUserClaims` / `onUserCreated` 依 users 白名單寫入。
   新增 claim 後既有使用者需重新登入（前端有 `refreshMyClaims` 自動補發）。

6. **沒有開信/點擊追蹤** — 為了走公司 mail2000、不依賴第三方而放棄。
   退信會以一般郵件回到 press_center 信箱，要人工查看。

---

## 六、測試

```bash
npm test          # 純邏輯測試（授權、附件路徑、範本、圖片、分批…）
```

**規則測試需要 Firebase 模擬器（需 Java）**：

```bash
brew install openjdk
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
npx firebase emulators:start --only firestore,storage   # 另開一個終端
npm test          # 這時規則測試才會實際執行
```

模擬器沒開時規則測試會自動 skip（不會算成 passed）。全開時約 155 passed。

---

## 七、已知風險 / 待辦（交接時的狀態）

- **完整發送流程尚未實機驗證** — 正式發稿前務必先用「寄測試信給我」確認。
- **functions 有 8 個 moderate 漏洞** — 全來自 firebase-admin 的傳遞相依 `uuid`，
  修正需 major 升級。**不要跑 `npm audit fix --force`。** 等上游更新。
- **表格功能** — 使用者要求營收稿能放財務表格（表格編輯器 + 信件/Word/PDF 三處渲染），
  尚未動工，設計方向見對話紀錄。
- 憑證 2026-08-22 到期（見第五節第 3 點）。

---

## 八、資料結構速查

```
users/{email}                       白名單與角色（admin/manager/specialist）
mediaContacts/{id}                  媒體聯絡人
pressReleases/{id}                  新聞稿（versions.tw/.www/.us、attachments）
campaigns/{id}                      每次發送
campaigns/{id}/recipients/{id}      每位收件人送出結果（queued/sent/failed）
mediaEvents/{id}                    媒體關係活動
mediaEvents/{id}/participants/{id}  每位媒體的出席/收禮紀錄
settings/smtp                       寄信主機設定（僅 admin 可讀）
settings/email                      信件頁首 logo、新聞聯絡人、公司簡介
settings/permissions                角色權限矩陣覆寫
settings/branding                   介面 logo（公開可讀，勿放機密）
```

Cloud Functions（asia-east1）：`sendCampaign`、`updateSmtpSettings`、
`testSmtpConnection`、`deleteMediaEvent`、`refreshMyClaims`、
`syncUserClaims`、`onUserCreated`。
