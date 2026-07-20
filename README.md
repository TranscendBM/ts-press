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
| Firebase Auth | Google 登入，不限網域，但需在 `users` 白名單內 |
| Firestore | 媒體名單、新聞稿、發送紀錄 |
| Firebase Storage | 內嵌圖片與郵件附件 |
| Cloud Functions | 發送邏輯（需 Blaze 方案） |
| mail2000 SMTP | 實際寄信 |

寄件人固定為 `press_center@transcend-info.com`。

> **關於追蹤**：本系統透過公司既有的 mail2000 郵件伺服器寄送，好處是不需要第三方服務、
> 不必改 DNS、零成本；代價是**沒有開信率、點擊率與退信回報**，只能知道 SMTP 伺服器
> 是否成功收下每一封信。退信會以一般郵件的形式回到 `press_center@transcend-info.com` 信箱。

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

公司信箱使用 mail2000、沒有 Google Workspace 帳號，因此**登入不限網域**，個人 Google 帳號也可以，
由 `users` 白名單決定誰進得來。也因為安全規則要求白名單，**第一位管理員必須手動在 Console 建立**：

Firestore → 建立集合 `users` → 文件 ID 填**你登入用的那個 Google 帳號 email**（全小寫），欄位：

| 欄位 | 型別 | 值 |
|---|---|---|
| `email` | string | 同文件 ID |
| `displayName` | string | 你的名字 |
| `role` | string | `admin` |
| `active` | boolean | `true` |

> 文件 ID 必須與登入的 Google 帳號完全一致，打錯就進不去。

之後其他人就能在系統的「使用者管理」頁面新增。

角色權限：

- `admin` 管理員 — 全部功能 + 使用者管理 + 正式發送
- `manager` 主管 — 正式發送
- `editor` 編輯 — 編輯名單與稿件，只能寄測試信

### 4. mail2000 SMTP

向 IT 取得 `press_center@transcend-info.com` 的 SMTP 連線資訊，並確認兩件事：

- **mail2000 允許從外部 IP 以 SMTP 認證寄信**。Cloud Functions 跑在 Google 機房，
  對 mail2000 而言是外部連線；若伺服器只開放內網轉寄，這套方案無法運作。
- **不需要 IP 白名單**。Cloud Functions 的對外 IP 是浮動的，若 IT 堅持要鎖 IP，
  必須另外架設 VPC 連接器與 Cloud NAT 取得固定 IP（會產生額外費用）。

### 5. 設定密鑰

```bash
npx firebase functions:secrets:set SMTP_HOST   # 例如 mail.transcend-info.com
npx firebase functions:secrets:set SMTP_PORT   # 587（STARTTLS）或 465（SSL）
npx firebase functions:secrets:set SMTP_USER   # press_center@transcend-info.com
npx firebase functions:secrets:set SMTP_PASS   # 該信箱的密碼
```

> 密碼只存在 Google Secret Manager，不會進版控。發送前程式會先 `verify()` 連線，
> 連不上會直接回報錯誤而不會送出半套。

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
campaigns/{id}/recipients/{id}      每位收件人的送出結果（queued / sent / failed）
```

`campaigns` 只能由 Cloud Functions 寫入，前端唯讀。

## 注意事項

- **附件總大小上限 10MB**，超過多數郵件伺服器會直接退信；系統會在編輯頁擋下。
- 有收件人要收的語言版本若沒填完，系統會擋住發送，避免寄出空白信。
- 正式發送前請務必先用「寄測試信給我」確認排版、圖片與附件。
- 寄送是**逐封循序送出並間隔 0.4 秒**，避免 mail2000 判定為濫發而阻擋。
  50 封大約需要 30 秒，Function 逾時設定為 540 秒。
- 修改 email 樣板時，`src/lib/emailTemplate.ts` 與 `functions/src/emailTemplate.ts` 兩份內容必須一致
  （前者供前端預覽，後者供實際寄送）。
- Storage 安全規則讀不到 Firestore，改看 token 的 `pressCenter` custom claim。這個 claim 由
  `syncUserClaims`（白名單異動時）與 `onUserCreated`（首次登入時）兩個 function 自動同步，
  前端在登入後會強制刷新一次 token 取得它。**若這兩個 function 沒部署，上傳圖片與附件會失敗。**
