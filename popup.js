/** Popup：触发抓取 → 预览 → 写入 Obsidian */
import { loadSettings, saveSettings } from "./lib/settings.js";

const $ = (id) => document.getElementById(id);

let lastExtract = null;
let settings = null;

function setStatus(kind, text, hint) {
  const dot = $("statusDot");
  dot.className = "dot" + (kind ? ` ${kind}` : "");
  $("statusText").textContent = text;
  if (hint != null) $("videoHint").textContent = hint;
}

function log(msg, kind = "") {
  const el = $("log");
  el.hidden = false;
  el.className = "log" + (kind ? ` ${kind}` : "");
  el.textContent = msg;
}

function updatePreview(data) {
  if (!data) {
    $("pvTitle").textContent = "—";
    $("pvUrl").textContent = "—";
    $("pvViews").textContent = "—";
    $("pvPublished").textContent = "—";
    $("pvChapters").textContent = "—";
    $("pvTranscript").textContent = "—";
    $("pvComments").textContent = "—";
    return;
  }
  $("pvTitle").textContent = data.title || "—";
  $("pvUrl").textContent = data.url || "—";
  $("pvViews").textContent = data.views != null ? Number(data.views).toLocaleString() : "—";
  $("pvPublished").textContent = data.published || "—";
  $("pvChapters").textContent = `${(data.chapters || []).length} 个`;
  $("pvTranscript").textContent = `${(data.transcript?.text || "").length} 字`;
  $("pvComments").textContent = `${(data.comments || []).length} 条`;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function isYouTubeWatch(tab) {
  if (!tab || !tab.url) return false;
  try {
    const u = new URL(tab.url);
    return (
      /(^|\.)youtube\.com$/i.test(u.hostname) &&
      (u.pathname === "/watch" || u.pathname.startsWith("/watch") || u.pathname.startsWith("/shorts/"))
    );
  } catch (_) {
    return false;
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/extract.js"],
    });
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function doExtract() {
  const tab = await getActiveTab();
  if (!isYouTubeWatch(tab)) {
    setStatus("err", "不是视频页面", "请打开 https://www.youtube.com/watch?v=... 后再试");
    log("当前标签页不是 YouTube 视频页。", "err");
    return;
  }

  setStatus("busy", "正在抓取…", "字幕约 12s、评论约 25s 内结束，请勿切换页面");
  $("btnExtract").disabled = true;
  $("btnSave").disabled = true;
  log("抓取中：先读页面数据，再加载字幕与评论……");

  try {
    await ensureContentScript(tab.id);
    const opts = {
      transcript: $("optTranscript").checked,
      comments: $("optComments").checked,
      chapterThumbs: $("optChapterThumbs").checked,
      thumbnail: $("optThumbnail").checked,
      commentLimit: Number($("optCommentLimit").value || 100),
    };

    const response = await Promise.race([
      chrome.tabs.sendMessage(tab.id, {
        type: "YT_EXTRACT",
        payload: opts,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("抓取超时（约 50 秒）。请重新加载扩展后再试；若仍卡住，请把控制台报错发我。")),
          50000
        )
      ),
    ]);

    if (!response?.ok) {
      throw new Error(response?.error || "抓取失败");
    }

    lastExtract = response.data;
    updatePreview(lastExtract);
    setStatus(
      "ok",
      "抓取完成",
      `${lastExtract.title ? lastExtract.title.slice(0, 40) : ""} · 评论 ${lastExtract.comments?.length || 0} · 转录 ${(lastExtract.transcript?.text || "").length} 字`
    );
    log(
      `已抓取：\n标题：${lastExtract.title}\n章节 ${lastExtract.chapters?.length || 0} · 评论 ${lastExtract.comments?.length || 0} · 字幕 ${lastExtract.transcriptMeta?.count || 0} 段` +
        `\n评论来源：seeded=${lastExtract.commentMeta?.seeded ?? "-"} dom=${lastExtract.commentMeta?.domBefore ?? "-"} method=${lastExtract.commentMeta?.method ?? "-"}` +
        (lastExtract.commentMeta?.error ? `\n评论错误：${lastExtract.commentMeta.error}` : ""),
      lastExtract.comments?.length ? "ok" : "err"
    );
    $("btnSave").disabled = false;
  } catch (err) {
    setStatus("err", "抓取失败", String(err.message || err));
    log(String(err.message || err), "err");
  } finally {
    $("btnExtract").disabled = false;
  }
}

async function doSave() {
  if (!lastExtract) return;
  setStatus("busy", "正在写入 Obsidian…", "下载封面/章节图并创建笔记");
  $("btnSave").disabled = true;
  $("btnExtract").disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "YT_CLIP_SAVE",
      payload: { data: lastExtract },
    });
    if (!response?.ok) throw new Error(response?.error || "写入失败");

    setStatus("ok", "已写入", response.notePath);
    log(
      `笔记：${response.notePath}\n封面：${response.thumbnailVaultPath || "无"}\n评论 ${response.commentCount} 条 · 转录 ${response.transcriptChars} 字 · 章节 ${response.chapterCount}`,
      "ok"
    );
  } catch (err) {
    setStatus("err", "写入失败", String(err.message || err));
    log(String(err.message || err), "err");
  } finally {
    $("btnSave").disabled = !lastExtract;
    $("btnExtract").disabled = false;
  }
}

async function init() {
  settings = await loadSettings();
  // 将设置里的开关同步到 UI
  $("optTranscript").checked = settings.includeTranscript !== false;
  $("optComments").checked = settings.includeComments !== false;
  $("optChapterThumbs").checked = settings.includeChapterThumbs !== false;
  $("optThumbnail").checked = settings.includeThumbnail !== false;
  $("optCommentLimit").value = settings.commentLimit || 100;

  const tab = await getActiveTab();
  if (isYouTubeWatch(tab)) {
    setStatus("", "已识别视频页", "点击「抓取当前页面」开始提取");
  } else {
    setStatus("", "准备就绪", "请先打开一个 YouTube 视频页面");
  }

  $("btnOptions").addEventListener("click", () => {
    try {
      chrome.runtime.openOptionsPage();
    } catch (_) {
      window.open("options.html", "_blank");
    }
  });

  $("btnExtract").addEventListener("click", doExtract);
  $("btnSave").addEventListener("click", doSave);

  // 保存抓取选项到 settings，方便下次使用
  const persist = async () => {
    if (!settings) return;
    settings.includeTranscript = $("optTranscript").checked;
    settings.includeComments = $("optComments").checked;
    settings.includeChapterThumbs = $("optChapterThumbs").checked;
    settings.includeThumbnail = $("optThumbnail").checked;
    settings.commentLimit = Number($("optCommentLimit").value || 100);
    await saveSettings(settings);
  };
  ["optTranscript", "optComments", "optChapterThumbs", "optThumbnail", "optCommentLimit"].forEach(
    (id) => $(id).addEventListener("change", persist)
  );
}

// 浏览器独立打开时的演示模式
function initStandaloneDemo() {
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.runtime?.id) return;
  setStatus("", "预览模式", "在 Chrome 加载扩展后即可抓取 YouTube 页面");
  $("btnExtract").addEventListener("click", () => {
    setStatus("busy", "演示：抓取中…", "此为浏览器预览，无扩展环境");
    lastExtract = {
      title: "演示视频标题",
      url: "https://www.youtube.com/watch?v=demo",
      views: 123456,
      published: "2024-06-01",
      durationText: "12:34",
      channel: "演示频道",
      chapters: [{ title: "开场", timestamp: "0:00", url: "#t=0s", index: 1 }],
      transcript: { text: "这是一段演示转录文本……" },
      comments: [{ author: "用户A", content: "很有帮助！", likes: "12", published: "2 天前" }],
    };
    updatePreview(lastExtract);
    setStatus("ok", "演示抓取完成", "仅为 UI 预览");
    $("btnSave").disabled = false;
  });
  $("btnSave").addEventListener("click", () => {
    log("预览模式无法写入 Obsidian。请加载扩展并配置 API Key。", "err");
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.id && chrome.tabs) {
  init();
} else {
  initStandaloneDemo();
}
