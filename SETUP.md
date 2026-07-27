# 新電腦環境設定

在一台全新的電腦上把這個專案跑起來的步驟。搭配 [HANDOFF.md](HANDOFF.md) 一起看。

> 換 Claude 帳號 / 換電腦時，**記憶不會跟過去** —— 所有脈絡都寫在 repo 裡的
> `HANDOFF.md`、`README.md` 與 `shared/` 目錄。新的 AI 助理讀這幾個就能接上。

---

## 1. 安裝基本工具

- [Node.js](https://nodejs.org) LTS 版
- Git
- （選配）Java：**只有**要部署 Cloud Functions 或跑安全規則測試才需要
  `brew install openjdk`

## 2. 取得程式碼

用 SSH（需先把本機 SSH 公鑰加到 GitHub）：

```bash
cd ~/Desktop
git clone git@github.com:TranscendBM/ts-press.git press-center
cd press-center
```

或用 HTTPS（較簡單，裝 gh CLI 登入即可）：

```bash
gh auth login
git clone https://github.com/TranscendBM/ts-press.git press-center
cd press-center
```

## 3. 安裝套件

```bash
npm install
npm --prefix functions install
```

## 4. 建立 `.env.local`

這個檔不進版控，需手動建立。內容是 Firebase 前端設定值（公開值、非機密），
**照抄 [HANDOFF.md](HANDOFF.md) 第三節**即可。

## 5. 登入 Firebase

```bash
npx firebase login      # 用有 ts-press 專案權限的 Google 帳號
```

`.firebaserc` 已在 repo 裡，會自動指向 `ts-press`，不必再 `firebase use`。

## 6. 驗證環境

```bash
npm run dev             # 本機開發伺服器
npm run build           # 確認建置通過
npm test                # 單元測試（規則測試需模擬器，見 HANDOFF 第六節）
```

看到 `npm run dev` 起得來、`npm run build` 通過，環境就 OK 了。

---

## 給接手的 AI 助理

新的 Claude session 沒有先前的對話記憶。開好專案後，把這段貼給它：

> 這是一個已上線的專案，我從另一台電腦接手。
> 請先讀 HANDOFF.md 和 README.md 了解全貌，再看 shared/ 目錄的共用邏輯，
> 然後等我指示。不要自行部署或寄信。

---

## 存取權（換電腦不需重新申請，本來就是你的）

- **GitHub**：`TranscendBM/ts-press`，用你的帳號 SSH/HTTPS 存取
- **Firebase**：`ts-press` 專案，用你的 Google 帳號 `firebase login`
- **系統後台**：https://ts-press.web.app，用白名單內的 Google 帳號登入

三者都不需要重新開通，只是在新電腦上重新連上。
