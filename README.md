# YouTube Obsidian Clipper

Chrome 扩展：在你**手动打开**的 YouTube 视频页上抓取信息，经 [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) 写入笔记库。

**不调用任何 YouTube / Google API**，只解析当前页面 DOM 与页内嵌数据（`ytInitialPlayerResponse` / `ytInitialData`）。

## 功能

| 内容 | 说明 |
|------|------|
| 视频标题、链接、播放量、发布日期 | 来自页面数据与 DOM |
| 视频封面 | 下载后写入 Obsidian 附件目录 |
| 视频标签 / 简介话题 `#tag` | 页面可见标签；隐藏 SEO 词不写入 |
| 视频简介、章节、章节缩略图 | 时间戳章节 + 可选缩略图 |
| 内容转文字（全文转录） | 点开「内容转文字」后从右侧面板抽取 |
| 前 N 条评论（默认 100） | 下滑加载，按热度；折叠楼中楼展开后挂在首评下 |
| 视频本体 | 暂不自动下载，请手动保存 |

## 安装

1. 下载或克隆本仓库
2. 打开 Chrome：`chrome://extensions/`
3. 开启「开发者模式」
4. 「加载已解压的扩展程序」→ 选择本项目根目录（含 `manifest.json` 的文件夹）

## Obsidian 配置

1. 在 Obsidian 社区插件市场安装并启用 **Local REST API**
2. 建议勾选 **Enable Non-encrypted (HTTP) Server**（默认 `http://127.0.0.1:27123`），避免 Chrome 拦截自签 HTTPS
3. 复制插件设置里的 **API Key**
4. 打开本扩展「设置」，填写：
   - **API 地址**：`http://127.0.0.1:27123`
   - **API Key**
   - **笔记目录**（库内相对路径，如 `Clippings/YouTube`）
   - **附件目录**（如 `Clippings/YouTube/assets`）
   - **笔记命名格式** / **封面命名格式**

路径都是**相对 Obsidian 库根目录**的，不要写磁盘绝对路径。

### 命名变量

| 变量 | 含义 |
|------|------|
| `{{title}}` | 视频标题 |
| `{{videoId}}` | 视频 ID |
| `{{channel}}` | 频道名 |
| `{{date}}` / `{{datetime}}` | 日期 / 日期时间 |
| `{{seq}}` / `{{seq2}}` / `{{seq:N}}` | 自增序号（1 / 01 / 补 N 位） |

序号以**目标文件夹内已有文件**为准：已有 `视频-01`…`视频-03`，下一个为 `视频-04`。

示例：

- 笔记：`视频-{{seq2}}` → `视频-01.md`
- 封面：`{{seq2}}-cover` → `01-cover.jpg`（与笔记共用序号）

## 使用

1. 在 Chrome 打开 `https://www.youtube.com/watch?v=...`
2. 点扩展图标 →「抓取当前页面」
3. 等待状态变为「抓取完成」（字幕与评论滚动加载需数秒）
4. 「写入 Obsidian 笔记」

### 抓取范围

可在弹窗或设置中勾选：全文转录、评论、章节缩略图、封面图片，并设置评论条数上限。

## 笔记结构（属性为中文）

```yaml
---
标题: ...
链接: https://www.youtube.com/watch?v=...
视频ID: ...
频道: ...
播放量: ...
发布日期: ...
时长: ...
标签: [youtube, clipping, ...]
话题标签: [Economics, History, ...]
章节数: 4
评论数: 66
转录字数: 12000
封面: "[[Clippings/YouTube/assets/xxx.jpg]]"
抓取日期: 2026-10-04
来源: youtube
---
```

正文包含：基本信息表、标签、简介、章节、全文转录、评论（含展开后的回复列表）。

## 项目结构

```
manifest.json      # Chrome MV3 清单
index.html         # 弹窗 UI（扩展入口）
popup.js / css
options.html       # 设置页
options.js / css
background.js      # Service Worker：写入 Obsidian、下载图片
content/extract.js # YouTube 页面抓取
lib/settings.js    # 设置与命名模板
lib/obsidian.js    # Local REST API 客户端
lib/markdown.js    # 笔记 Markdown 组装
icons/             # 扩展图标
scripts/make_icons.py
```

## 说明与限制

- 需自行在浏览器中打开视频页；扩展不代替你访问 YouTube
- 字幕依赖视频是否提供「内容转文字 / 文稿」；无字幕时转录为空
- 评论依赖页面滚动加载；请勿在抓取过程中切换标签页
- 本地 REST API 仅用于写入你自己的 Obsidian 库

## 免责声明

本工具仅供个人学习与资料整理。数据来自你本人浏览器中已打开的页面，不存储、不分发 YouTube 内容。使用后果自负，请遵守 YouTube 服务条款与当地法律法规。

## License

MIT
