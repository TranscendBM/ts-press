# 新聞稿發送系統 Press Center

創見資訊內部使用的新聞稿管理與發送系統。

- 管理四份媒體名單：台灣 PR、台灣 IR、Global PR、美國 PR
- 每篇新聞稿含 `tw` / `www` / `us` 三個語言版本，內文一張內嵌圖 + 郵件附件
- 發送時手動勾選名單，系統依每位聯絡人的語言配對版本，**一位記者寄出一封獨立信件**
- 記錄每位收件人的送達 / 開信 / 點擊 / 退信狀態

## 技術架構

| 層 | 用途 |
|---|---|
| Firebase Hosting | 前端管理後台（React + Vite + Tailwind） |
| Firebase Auth | Google 登入，限 `@transcend-info.com` 且需在白名單內 |
| Firestore | 媒體名單、新聞稿、發送紀錄 |
| Firebase Storage | 內嵌圖片與郵件附件 |
| Cloud Functions | 發送邏輯、SendGrid 事件 webhook（需 Blaze 方案） |
| SendGrid | 實際寄信、網域驗證、開信與點擊追蹤 |

寄件人固定為 `press_center@transcend-info.com`。

---

## 首次設定

### 1. 建立 Firebase 專案

1. 到 [Firebase Console](https://console.firebase.google.com/) 建立新專案。
2. **升級為 Blaze 方案**（Cloud Functions 必須）。用量很小，實際費用趨近於零。
3. 啟用 **Authentication → Sign-in method → Google**。
4. 建立 **Firestore Database**（正式模式，位置選 `asia-east1`）。
5. 建立 **Storage**。

接著在專案根目錄綁定：

```bash
npx firebase login
npx firebase use --add        # 選剛建立的專案，alias 填 default
```

### 2. 前端環境變數

Firebase Console → 專案設定 → 一般 → 你的應用程式 → 新增網頁應用程式，取得設定值：

```bash
cp .env.example .env.local    # 填入 6 個 VITE_FIREBASE_* 值
```

### 3. 建立第一位管理員

Firestore 安全規則要求使用者必須在 `users` 白名單內，所以**第一位管理員要手動在 Console 建立**：

Firestore → 建立集合 `users` → 文件 ID 填你的公司 email（全小寫），欄位：

| 欄位 | 型別 | 值 |
|---|---|---|
| `email` | string | `你的帳號@transcend-info.com` |
| `displayName` | string | 你的名字 |
| `role` | string | `admin` |
| `active` | boolean | `true` |

之後其他人就能在系統的「使用者管理」頁面新增。

角色權限：

- `admin` 管理員 — 全部功能 + 使用者管理 + 正式發送
- `manager` 主管 — 正式發送
- `editor` 編輯 — 編輯名單與稿件，只能寄測試信

### 4. SendGrid 設定

1. 註冊 [SendGrid](https://sendgrid.com/) 帳號（每月 100 封以內免費；用量更大再升級）。
2. **Settings → Sender Authentication → Authenticate Your Domain**，網域填 `transcend-info.com`。
   SendGrid 會產生數筆 CNAME 紀錄，**請 IT 加到 transcend-info.com 的 DNS**。

   > 這些是 DNS 層的 SPF/DKIM 設定，**不會影響 mail2000 的正常收發信**（收信的 MX 紀錄維持不變）。
   > 驗證通過後，從 `press_center@transcend-info.com` 寄出的信才不會被判定為垃圾信。

3. **Settings → API Keys** 建立一組 Full Access 金鑰，複製起來（只會顯示一次）。
4. **Settings → Mail Settings → Event Webhook**：
   - HTTP POST URL 填 `https://<你的網域>/api/sendgrid-webhook`
   - 勾選事件：`Delivered`、`Opened`、`Clicked`、`Bounced`、`Dropped`、`Spam Reports`
   - 開啟 **Signed Event Webhook**，複製產生的 Verification Key

### 5. 設定密鑰

```bash
npx firebase functions:secrets:set SENDGRID_API_KEY      # 貼上第 3 步的 API Key
npx firebase functions:secrets:set SENDGRID_WEBHOOK_KEY  # 貼上第 4 步的 Verification Key
```

### 6. 部署

```bash
npm install
npm --prefix functions install
npm run deploy
```

---

## 日常開發

```bash
npm run dev                 # 前端開發伺服器
npm run emulators           # Firebase 模擬器
npm run deploy:web          # 只更新前端
npm run deploy:functions    # 只更新 Cloud Functions
npm run deploy:rules        # 只更新安全規則與索引
```

## 資料結構

```
users/{email}                       白名單與角色
mediaContacts/{id}                  媒體聯絡人（lists 複選、language 決定收到哪個版本）
pressReleases/{id}                  新聞稿（versions.tw / .www / .us、attachments 共用）
campaigns/{id}                      每次發送
campaigns/{id}/recipients/{id}      每位收件人的送達與開信狀態
```

`campaigns` 只能由 Cloud Functions 寫入，前端唯讀。

## 注意事項

- **附件總大小上限 10MB**，超過多數郵件伺服器會直接退信；系統會在編輯頁擋下。
- 有收件人要收的語言版本若沒填完，系統會擋住發送，避免寄出空白信。
- 正式發送前請務必先用「寄測試信給我」確認排版、圖片與附件。
- 修改 email 樣板時，`src/lib/emailTemplate.ts` 與 `functions/src/emailTemplate.ts` 兩份內容必須一致
  （前者供前端預覽，後者供實際寄送）。
