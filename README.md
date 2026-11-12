# jyut6din2-apk

粵典（words.hk）詞典的**純靜態版本**：把原本需要 Node 後端的搜尋與詞條功能，改成預先產生資料 + 瀏覽器端搜尋，可直接部署到 GitHub Pages。

頁面預設以**简体**顯示，右上角可切換繁體；選擇會存在 `localStorage`，下次開啟沿用。

這個資料夾是自包含的：前端、建置腳本、資料源、部署設定都在裡面，不依賴外層的 Rust 專案。

## 目錄

```
jyut6din2-apk/
├── public/                 # 部署的網站本體
│   ├── index.html
│   ├── app.js              # 前端（含瀏覽器端搜尋）
│   ├── style.css
│   ├── favicon.svg
│   └── data/               # 建置產物（gitignore，部署時才產生）
├── source-data/            # 資料源（字典 + 粵拼 + 繁簡表）
│   ├── dict.json
│   ├── wordshk.csv
│   ├── trad_to_simp.tsv
│   └── simp_to_trad.tsv
├── src/
│   ├── build-static.mjs    # 產生 public/data
│   └── dev-server.mjs      # 本地預覽（零依賴）
├── .github/workflows/pages.yml
├── package.json
└── README.md
```

## 本地預覽

需要 Node.js ≥ 18。

**Windows 一鍵啟動**：雙擊 `start-local.cmd`。首次會自動產生 `public/data`，完成後自動開啟瀏覽器；之後每次啟動都直接開。

命令列方式：

```bash
cd jyut6din2-apk
npm run build     # 首次或更新 source-data 後執行
npm start         # 或 npm run dev，預覽 http://127.0.0.1:8790
```

模擬 GitHub Pages 的子路徑（`https://<user>.github.io/<repo>/`）：

```bash
# PowerShell
$env:BASE = '/jyut6din2-apk'; npm run dev
```

然後開 `http://127.0.0.1:8790/jyut6din2-apk/`。也可以改用任何靜態伺服器，但**不能直接雙擊 `index.html`**（`fetch` 需要 http）。

## 部署到 GitHub Pages

最簡單的方式：**把這個資料夾的內容當成 repo 根目錄**上傳。

1. 建立 repo，上傳本資料夾內的所有檔案（`public/data/` 不用上傳，CI 會產生）。
2. Repo → Settings → Pages → Build and deployment → Source 選 **GitHub Actions**。
3. push 到 `main`，workflow 會自動 `node src/build-static.mjs` 並發布 `public/`。

如果你的 repo 根目錄是外層（`jyut6din2-apk` 只是子資料夾），把 workflow 移到根目錄的 `.github/`，並改成：

```yaml
- run: node src/build-static.mjs
  working-directory: jyut6din2-apk
- uses: actions/upload-pages-artifact@v3
  with:
    path: jyut6din2-apk/public
```

## 資料更新

替換 `source-data/` 內的檔案後重新 `npm run build`，再 commit/push 即可。前端會用 `meta.json` 的 `version` 替索引與分片加上快取參數。

## 體積與限制

以目前 51,899 條詞條計（實測）：

- 搜尋索引：約 19.9 MB（gzip 約 7.3 MB），首次搜尋時下載，之後由瀏覽器快取。
- 詞條分片：128 片，每片約 237 KB（gzip 約 75 KB），點開詞條時才載入。
- 全部詞條分片合計約 29.7 MB（gzip 約 9.4 MB），一般瀏覽只會載入看過的分片。
- 首頁外殼：幾 KB。

GitHub Pages 的限制是站點 1 GB、每月約 100 GB 流量；以上體積遠低於上限，但流量會隨訪問量累積（每次冷訪問約 8 MB）。

## 已知取捨

- **首次搜尋較慢**：需要下載索引（約 7.3 MB gzip）；首頁會在閒置時預先抓取（省流量模式會跳過）。瀏覽器若支援 `DecompressionStream` 會用 gzip 索引，否則退回 19.9 MB 未壓縮版本（Safari 16.4 以前）。
- **詞條詳情要按需載入**：每個分片首次約 0.1–0.3 秒。
- **沒有 Service Worker**：預設不支援離線；重新整理後靠瀏覽器 HTTP 快取。
- **更新有延遲**：GitHub Pages 的 CDN 快取約 10 分鐘，重新部署後可能短暫看到舊版。
- 所有搜尋與繁簡轉換都在瀏覽器完成，沒有後端日誌或統計。

## 授權

程式碼沿用原專案的 MIT 授權。字典資料來自 words.hk，公開部署前請先確認其資料使用條款（公開網站等於再分發詞典資料）。
