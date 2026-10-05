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

  // 主世界读取页面全局对象（绕过 YouTube CSP，禁止在页面里塞 inline script）
  if (msg.type === "YT_PAGE_WORLD") {
    readPageWorld(sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: String(err && err.message ? err.message : err),
        })
      );
    return true;
  }

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

/** 在 MAIN world 序列化当前页 ytInitialPlayerResponse / 评论（精简，避免卡顿） */
async function readPageWorld(sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null) throw new Error("no-tab");

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      function text(v) {
        if (v == null) return "";
        if (typeof v === "string") return v;
        if (v.simpleText) return String(v.simpleText);
        if (v.content && typeof v.content === "string") return v.content;
        if (Array.isArray(v.runs)) return v.runs.map((x) => x.text || "").join("");
        return "";
      }
      function pickAuthor(o) {
        return (
          text(o && o.authorText) ||
          text(o && o.author) ||
          (o && o.author && (o.author.displayName || o.author.name || o.author.text)) ||
          ""
        );
      }
      function pickContent(o) {
        return (
          text(o && o.contentText) ||
          text(o && o.content) ||
          (o && o.content && (o.content.content || o.content.text)) ||
          ""
        );
      }

      const payload = {
        player: null,
        micro: null,
        playerVideoId: null,
        comments: [],
        heatmap: [],
      };

      try {
        const p = window.ytInitialPlayerResponse;
        if (p && p.videoDetails) {
          const d = p.videoDetails;
          const mf = (p.microformat && p.microformat.playerMicroformatRenderer) || {};
          payload.playerVideoId = d.videoId || null;
          payload.player = {
            videoDetails: {
              videoId: d.videoId,
              title: d.title,
              lengthSeconds: d.lengthSeconds,
              keywords: d.keywords || [],
              channelId: d.channelId,
              shortDescription: d.shortDescription,
              viewCount: d.viewCount,
              author: d.author,
              thumbnail: d.thumbnail,
              isLiveContent: d.isLiveContent,
            },
          };
          payload.micro = {
            publishDate: mf.publishDate || "",
            uploadDate: mf.uploadDate || "",
            category: mf.category || "",
            ownerChannelName: mf.ownerChannelName || "",
            externalChannelId: mf.externalChannelId || "",
            lengthSeconds: mf.lengthSeconds,
          };
        }
      } catch (_) {
        /* ignore */
      }

      // 评论：只走已知路径 + 限量 BFS
      try {
        const acc = [];
        const seen = {};
        function push(c) {
          if (!c || (!c.content && !c.author)) return;
          const k = `${c.author || ""}|${String(c.content || "").slice(0, 80)}`;
          if (seen[k]) return;
          seen[k] = 1;
          acc.push(c);
        }
        function fromThread(th) {
          const cr =
            (th.comment && (th.comment.commentRenderer || th.comment.commentViewModel)) ||
            th.commentRenderer;
          if (!cr) return;
          push({
            author: pickAuthor(cr),
            content: pickContent(cr),
            published: text(cr.publishedTimeText) || "",
            likes: text(cr.voteCount) || text(cr.voteCountIfNotZero) || "",
            replyCount: 0,
          });
        }
        function walkList(arr, depth) {
          if (!Array.isArray(arr) || depth > 8) return;
          for (let i = 0; i < arr.length; i++) {
            const item = arr[i];
            if (!item || typeof item !== "object") continue;
            if (item.commentThreadRenderer) fromThread(item.commentThreadRenderer);
            if (item.commentRenderer) {
              push({
                author: pickAuthor(item.commentRenderer),
                content: pickContent(item.commentRenderer),
                published: text(item.commentRenderer.publishedTimeText) || "",
                likes: "",
                replyCount: 0,
              });
            }
            if (item.itemSectionRenderer && item.itemSectionRenderer.contents) {
              walkList(item.itemSectionRenderer.contents, depth + 1);
            }
            if (item.sectionListRenderer && item.sectionListRenderer.contents) {
              walkList(item.sectionListRenderer.contents, depth + 1);
            }
          }
        }

        const d = window.ytInitialData;
        if (d) {
          try {
            const contents =
              (d.contents &&
                d.contents.twoColumnWatchNextResults &&
                d.contents.twoColumnWatchNextResults.results &&
                d.contents.twoColumnWatchNextResults.results.results &&
                d.contents.twoColumnWatchNextResults.results.results.contents) ||
              [];
            walkList(contents, 0);
          } catch (_) {
            /* ignore */
          }
          try {
            walkList(d.engagementPanels || [], 0);
          } catch (_) {
            /* ignore */
          }

          if (!acc.length) {
            const q = [d];
            let n = 0;
            const seenObj = new Set();
            while (q.length && n < 2500) {
              const o = q.shift();
              if (!o || typeof o !== "object" || seenObj.has(o)) continue;
              seenObj.add(o);
              n++;
              if (o.commentThreadRenderer) fromThread(o.commentThreadRenderer);
              if (Array.isArray(o)) {
                for (let i = 0; i < o.length; i++) q.push(o[i]);
              } else {
                for (const k of Object.keys(o)) q.push(o[k]);
              }
            }
          }
        }
        payload.comments = acc;
      } catch (_) {
        /* ignore */
      }

      // Heatmap / most replayed
      try {
        const markers = [];
        const seen = new Set();
        const pushMarker = (mr) => {
          if (!mr || typeof mr !== "object") return;
          const start = Number(
            mr.timeRangeStartMillis ?? mr.startMs ?? mr.startMsMillis
          );
          const end = Number(mr.timeRangeEndMillis ?? mr.endMs ?? mr.endMsMillis);
          const scoreRaw =
            mr.heatMarkerIntensityScoreNormalized ??
            mr.intensityScoreNormalized ??
            mr.score ??
            mr.normalizedScore;
          const score = Number(scoreRaw);
          if (!Number.isFinite(start)) return;
          const item = {
            startMs: start,
            endMs: Number.isFinite(end) && end >= start ? end : start,
            score: Number.isFinite(score) ? score : null,
          };
          const k = `${item.startMs}|${item.endMs}|${item.score}`;
          if (seen.has(k)) return;
          seen.add(k);
          markers.push(item);
        };

        const walkHeat = (o, depth) => {
          if (!o || typeof o !== "object" || depth > 18) return;
          if (Array.isArray(o)) {
            for (const x of o) walkHeat(x, depth + 1);
            return;
          }

          // 单个 marker
          if (o.heatMarkerRenderer) pushMarker(o.heatMarkerRenderer);
          if (o.heatMarkerViewModel) pushMarker(o.heatMarkerViewModel);
          // 自带字段的 marker
          if (
            o.timeRangeStartMillis != null &&
            (o.heatMarkerIntensityScoreNormalized != null ||
              o.intensityScoreNormalized != null ||
              o.score != null)
          ) {
            pushMarker(o);
          }

          // 列表容器
          for (const key of Object.keys(o)) {
            const v = o[key];
            if (
              Array.isArray(v) &&
              /heat|marker/i.test(key) &&
              v.length &&
              typeof v[0] === "object"
            ) {
              for (const m of v) {
                if (!m || typeof m !== "object") continue;
                pushMarker(m.heatMarkerRenderer || m.heatMarkerViewModel || m);
              }
            }
          }

          for (const k of Object.keys(o)) walkHeat(o[k], depth + 1);
        };

        walkHeat(window.ytInitialPlayerResponse, 0);
        walkHeat(window.ytInitialData, 0);

        // 定向再扫一遍常见路径
        try {
          const ov =
            window.ytInitialPlayerResponse?.playerOverlays?.playerOverlayRenderer;
          const multi =
            ov?.decoratedPlayerBarRenderer?.decoratedPlayerBarViewModel
              ?.multiMarkersPlayerBarViewModel || ov?.multiMarkersPlayerBarViewModel;
          const hm = multi?.heatmapViewModel || multi?.heatmapRenderer;
          const list = hm?.heatMarkers || hm?.markers || [];
          for (const m of list) {
            pushMarker(m?.heatMarkerRenderer || m?.heatMarkerViewModel || m);
          }
        } catch (_) {
          /* ignore */
        }

        markers.sort((a, b) => a.startMs - b.startMs);
        payload.heatmap = markers;
      } catch (_) {
        /* ignore */
      }

      return payload;
    },
  });

  return result || { player: null, micro: null, playerVideoId: null, comments: [] };
}

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
        // 仅当就是封面同一 URL 时复用，章节独立帧不复用封面
        const coverUrl = data.thumbnail?.url || "";
        const sameAsCover =
          thumbnailVaultPath &&
          c.thumbnailUrl &&
          coverUrl &&
          (c.thumbnailUrl === coverUrl ||
            c.thumbnailUrl.replace(/^https?:/, "") === coverUrl.replace(/^https?:/, ""));
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
