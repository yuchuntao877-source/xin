# 交易手记

一个只给自己用的手机网页应用：**记录每天的心得，和每一笔买卖的心得**（配 K 线截图 + 盈亏）。

不联网、不上传、没有账号。所有数据（含截图）存在手机浏览器的 IndexedDB 里，可以「添加到主屏幕」当 App 用，离线也能打开。

## 功能

- **今日**：今日盈亏、今日每笔操作（大图 + 心得）、今日心得、每天轮换一条大佬语录
- **交易**：流水（按天分组）、持仓（按买卖单推算摊薄成本）、个股档案（同一只票的全部买卖和心得串起来）
- **心得**：月历（有记录打点、按当日盈亏着色）、全文搜索、`我的心得 / 大佬语录` 双栏
- **备份**：文字 + 截图打包成一个 zip 导出；导入时整体恢复

## 数据在哪

- 文字和截图都在本机 `IndexedDB`（库名 `trade-diary`）里
- 每张截图存两份：
  - **原图**：长边 1800px、质量 0.86（约 300–700KB），看大图和裁剪用它，画质损失很小
  - **缩略图**：宽 ≤720、高 ≤1600、质量 0.74（约 150–300KB），列表和表单用它，滚动才不卡、铺满屏也不糊
- **换手机 / 清浏览器数据会丢**，所以「我的 → 导出备份」要定期做

## 本地预览

```
# 在项目目录起一个静态服务器（随便哪个都行）
python -m http.server 8177
```

打开 `http://127.0.0.1:8177/`。手机同一 WiFi 下可用 `http://电脑IP:8177/` 访问（Windows 防火墙可能要放行一次）。

> 注意：Service Worker 需要 `http://` 或 `https://`，双击 `index.html` 用 `file://` 打开时离线能力不可用，但其它功能正常。

## 发布到 GitHub Pages

### 方式一：网页上传（不用装任何东西）

1. 登录 GitHub，右上角 **+ → New repository**
   - 名字随意，例如 `trade-diary`
   - 可见性选 **Public**（免费账户的 Pages 只支持公开仓库）
   - 不要勾选 README / .gitignore，直接 **Create repository**
2. 在仓库页点 **uploading an existing file**，把本项目这些文件拖进去：
   `index.html`、`style.css`、`app.js`、`db.js`、`zip.js`、`sw.js`、`manifest.webmanifest`、`README.md`、`icons/` 整个文件夹
   —— **不要**上传 `.git/`、`_shots/`
3. 提交（Commit changes）
4. 仓库 **Settings → Pages**：
   - Source 选 **Deploy from a branch**
   - Branch 选 **main**，目录选 **/(root)**，Save
5. 等 1 分钟左右，访问 `https://你的用户名.github.io/trade-diary/`

### 方式二：命令行（本机已 git 提交好，只需加远程并推送）

```bash
cd stock-diary
git remote add origin https://github.com/你的用户名/trade-diary.git
git branch -M main
git push -u origin main
```

然后在 Settings → Pages 里按上面第 4 步开启即可。

### 装到手机主屏

- **iPhone（Safari）**：打开链接 → 分享 → 添加到主屏幕
- **Android（Chrome）**：打开链接 → 右上角菜单 → 添加到主屏幕

## 升级自己改的代码时

`sw.js` 里有缓存版本号 `trade-diary-v1`。如果你改了 `index.html / app.js / style.css` 之后发现手机上还是旧版：

1. 把 `sw.js` 里的 `trade-diary-v1` 改成 `trade-diary-v2`
2. 手机上强制刷新一次（Safari：长按刷新；Chrome：下拉刷新两次）

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面结构（4 个 tab + 5 个弹层） |
| `style.css` | 全部样式，深色/浅色、字号、红绿配色都靠 CSS 变量 |
| `app.js` | 界面逻辑、计算、导入导出流程 |
| `db.js` | IndexedDB 封装 + 图片压缩 |
| `zip.js` | 极简 zip 打包/解包（只支持 stored，双向都用得上） |
| `sw.js` | 离线缓存 |
| `manifest.webmanifest` | 加到主屏幕用的图标和名称 |
| `icons/` | 图标 |

## 隐私

代码是公开的，但**你的数据从来不离开这台设备**：没有接口请求、没有埋点、没有第三方脚本。只要不导出备份发给别人，就没有第二个人看得到。

