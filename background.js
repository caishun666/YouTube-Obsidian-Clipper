/**
 * Service Worker：接收 content 抓取结果，下载封面/章节图，写入 Obsidian。
 * 不调用任何 YouTube / Google API，仅访问当前页面数据与 Obsidian Local REST API。
 */
import { loadSettings, sanitizeFilename, formatDate, formatDateTime, applyTemplate, joinVaultPath } from "./lib/settings.js";
import { createObsidianClient } from "./lib/obsidian.js";
import { buildNote, assetFileName, guessImageExt } from "./lib/markdown.js";

// MV3 service worker 支持 ESM 时用 import；若加载失败则退回 importScripts 路径。
// 为兼容性，这里在 manifest 中使用 module 类型的 background。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "YT_CLIP_SAVE") {
    handleSave(msg.payload || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: String(err && err.message ? err.message : err),
        })
      );
    return true;
  }

  if (msg.type === "YT_TEST_OBSIDIAN") {
    testObsidian(msg.payload || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: String(err && err.message ? err.message : err),
        })
      );
    return true;
  }
});

async function testObsidian({ baseUrl, apiKey }) {
  const client = createObsidianClient({
    baseUrl: baseUrl || "http://127.0.0.1:27123",
    apiKey,
  });
  const status = await client.status();
  return { status };
}

/** 把 Local REST API 目录列表规范成文件名数组 */
function normalizeListing(listing) {
  const out = [];
  const push = (v) => {
    if (v == null) return;
    const name = typeof v === "string" ? v : v.name || v.path || v.filename || v.file || "";
    if (name) out.push(String(name));
  };
  if (Array.isArray(listing)) {
    listing.forEach(push);
  } else if (Array.isArray(listing?.files)) {
    listing.files.forEach(push);
  } else if (Array.isArray(listing?.data)) {
    listing.data.forEach(push);
  } else if (listing && typeof listing === "object") {
    // 有时返回 { "文件名": ... } 或 { files: { ... } }
    if (listing.files && typeof listing.files === "object" && !Array.isArray(listing.files)) {
      Object.keys(listing.files).forEach(push);
    } else {
      Object.keys(listing).forEach(push);
    }
  }
  return out;
}

/**
 * 以库内目标文件夹为准计算下一个序号。
 * 文件夹已有 1、2、3 → 返回 4。
 * 仅在目录读取失败时，才退回插件本地计数。
 */
async function nextSequence(client, folder, template) {
  const prefixMatch = String(template).match(/^(.*?)\{\{/);
  const prefix = prefixMatch ? prefixMatch[1].replace(/[\\/:*?"<>|]/g, " ").trim() : "";

  function maxFromFileNames(files) {
    let max = 0;
    for (const name of files) {
      const base = String(name).split("/").pop() || "";
      const bare = base.replace(/\.(md|jpg|jpeg|png|webp|gif)$/i, "");
      // 优先：前缀 + 数字（视频-01 / 视频-1）
      let m = null;
      if (prefix) {
        const re = new RegExp(
          "^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "0*(\\d+)$",
          "i"
        );
        m = bare.match(re);
      }
      // 退回：任意末尾数字（01、001、12）
      if (!m) m = bare.match(/0*(\d+)$/);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }

  // 1) 库内目录（资源管理器里的真实文件）——唯一权威
  let files = [];
  let listedOk = false;
  try {
    const listing = await client.list(folder);
    files = normalizeListing(listing);
    listedOk = true;
  } catch (_) {
    listedOk = false;
    files = [];
  }

  let max = listedOk ? maxFromFileNames(files) : 0;

  // 2) 目录读不到时，才用本地计数兜底，避免撞名
  if (!listedOk) {
    try {
      const key = `ytSeq:${folder}:${prefix}`;
      const stored = await new Promise((resolve) => {
        try {
          chrome.storage.local.get(key, (r) => resolve(r[key] || 0));
        } catch (_) {
          resolve(0);
        }
      });
      max = Number(stored) || 0;
    } catch (_) {
      max = 0;
    }
  }

  const next = max + 1;

  // 仅记录，供「读不到库」时使用；列表成功时不拿它去抬高序号
  try {
    const key = `ytSeq:${folder}:${prefix}`;
    chrome.storage.local.set({ [key]: next });
  } catch (_) {
    /* ignore */
  }
  return next;
}

async function handleSave(payload) {
  const settings = await loadSettings();
  const data = payload.data;

  if (!data || !data.videoId) {
    throw new Error("页面数据不完整：缺少 videoId");
  }
  if (!settings.obsidianApiKey) {
    throw new Error("尚未配置 Obsidian API Key，请先打开设置页填写。");
  }

  const client = createObsidianClient({
    baseUrl: settings.obsidianApiBaseUrl,
    apiKey: settings.obsidianApiKey,
  });

  // 命名（含自增序号）
  const dateStr = formatDate();
  const datetimeStr = formatDateTime();
  const folder = settings.noteFolder || "Clippings/YouTube";
  const template = settings.noteNameTemplate || "{{date}} - {{title}}";
  const needsSeq = /\{\{\s*seq(\d+|:\d+)?\s*\}\}/i.test(template);
  const seq = needsSeq ? await nextSequence(client, folder, template) : null;

  const nameRaw = applyTemplate(template, {
    title: data.title,
    videoId: data.videoId,
    channel: data.channel,
    date: dateStr,
    datetime: datetimeStr,
    views: data.views,
    duration: data.durationText,
    published: data.published,
    seq,
  });
  const noteName = sanitizeFilename(nameRaw);
  const notePath = joinVaultPath(folder, `${noteName}.md`);

  // 附件目录：与笔记同级 assets
  const assetBase = settings.assetFolder || joinVaultPath(folder, "assets");
  const idPrefix = data.videoId;

  // 封面命名：与笔记共用序号；若笔记不用 seq、封面用 seq，则扫附件目录
  const coverTemplate = settings.coverNameTemplate || "{{videoId}}-cover";
  const coverNeedsSeq = /\{\{\s*seq(\d+|:\d+)?\s*\}\}/i.test(coverTemplate);
  let coverSeq = seq;
  if (coverNeedsSeq && coverSeq == null) {
    coverSeq = await nextSequence(client, assetBase, coverTemplate);
  }

  const uploaded = [];

  // 封面
  let thumbnailVaultPath = null;
  if (settings.includeThumbnail && data.thumbnail?.url) {
    try {
      const ext = guessImageExt(data.thumbnail.url);
      const coverNameRaw = applyTemplate(coverTemplate, {
        title: data.title,
        videoId: data.videoId,
        channel: data.channel,
        date: dateStr,
        datetime: datetimeStr,
        views: data.views,
        duration: data.durationText,
        published: data.published,
        seq: coverSeq,
      });
      const fileName = assetFileName(coverNameRaw, ext);
      const vaultPath = joinVaultPath(assetBase, fileName);
      await client.putImageFromUrl(vaultPath, data.thumbnail.url);
      thumbnailVaultPath = vaultPath;
      uploaded.push(vaultPath);
    } catch (err) {
      console.warn("封面上传失败", err);
    }
  }

  // 章节缩略图
  const chapterImages = [];
  if (settings.includeChapterThumbs && Array.isArray(data.chapters)) {
    for (let i = 0; i < data.chapters.length; i++) {
      const c = data.chapters[i];
      if (!c.thumbnailUrl) {
        chapterImages.push(null);
        continue;
      }
      try {
        // 与封面相同 / 同源视频图时复用封面，避免重复上传
        const sameAsCover =
          thumbnailVaultPath &&
          (c.thumbnailUrl === data.thumbnail?.url ||
            (data.videoId &&
              c.thumbnailUrl.includes(`i.ytimg.com/vi/${data.videoId}`) &&
              data.thumbnail?.url?.includes(`i.ytimg.com/vi/${data.videoId}`)));
        if (sameAsCover) {
          chapterImages.push(thumbnailVaultPath);
          continue;
        }
        const ext = guessImageExt(c.thumbnailUrl);
        const fileName = assetFileName(`${idPrefix}-ch${i + 1}`, ext);
        const vaultPath = joinVaultPath(assetBase, fileName);
        await client.putImageFromUrl(vaultPath, c.thumbnailUrl);
        chapterImages.push(vaultPath);
        uploaded.push(vaultPath);
      } catch (err) {
        console.warn("章节图上传失败", err);
        chapterImages.push(null);
      }
    }
  }

  // 组装并写入笔记
  const markdown = buildNote(data, {
    includeDescription: settings.includeDescription,
    includeChapters: settings.includeChapters,
    includeHashtags: settings.includeHashtags,
    includeTranscript: settings.includeTranscript,
    includeComments: settings.includeComments,
    includeThumbnail: settings.includeThumbnail,
    includeChapterThumbs: settings.includeChapterThumbs,
    defaultTags: settings.defaultTags,
    thumbnailVaultPath,
    chapterImages,
  });

  await client.putMarkdown(notePath, markdown);

  return {
    notePath,
    thumbnailVaultPath,
    uploaded,
    title: data.title,
    commentCount: data.comments?.length || 0,
    transcriptChars: data.transcript?.text?.length || 0,
    chapterCount: data.chapters?.length || 0,
  };
}

// 安装时打开设置（可选）
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    try {
      chrome.runtime.openOptionsPage();
    } catch (_) {
      /* ignore */
    }
  }
});
