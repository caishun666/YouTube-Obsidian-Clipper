import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "./lib/settings.js";

const $ = (id) => document.getElementById(id);

function readForm() {
  return {
    obsidianApiBaseUrl: $("obsidianApiBaseUrl").value.trim(),
    obsidianApiKey: $("obsidianApiKey").value.trim(),
    noteFolder: $("noteFolder").value.trim() || DEFAULT_SETTINGS.noteFolder,
    assetFolder: $("assetFolder").value.trim() || DEFAULT_SETTINGS.assetFolder,
    noteNameTemplate: $("noteNameTemplate").value.trim() || DEFAULT_SETTINGS.noteNameTemplate,
    coverNameTemplate: $("coverNameTemplate").value.trim() || DEFAULT_SETTINGS.coverNameTemplate,
    commentLimit: Number($("commentLimit").value || 100),
    includeTranscript: $("includeTranscript").checked,
    includeComments: $("includeComments").checked,
    includeChapterThumbs: $("includeChapterThumbs").checked,
    includeThumbnail: $("includeThumbnail").checked,
    includeDescription: $("includeDescription").checked,
    includeChapters: $("includeChapters").checked,
    includeHashtags: $("includeHashtags").checked,
    defaultTags: $("defaultTags").value.trim(),
    openAfterSave: true,
  };
}

function fillForm(s) {
  $("obsidianApiBaseUrl").value = s.obsidianApiBaseUrl || "";
  $("obsidianApiKey").value = s.obsidianApiKey || "";
  $("noteFolder").value = s.noteFolder || "";
  $("assetFolder").value = s.assetFolder || "";
  $("noteNameTemplate").value = s.noteNameTemplate || "";
  $("coverNameTemplate").value = s.coverNameTemplate || "";
  $("commentLimit").value = s.commentLimit || 100;
  $("includeTranscript").checked = s.includeTranscript !== false;
  $("includeComments").checked = s.includeComments !== false;
  $("includeChapterThumbs").checked = s.includeChapterThumbs !== false;
  $("includeThumbnail").checked = s.includeThumbnail !== false;
  $("includeDescription").checked = s.includeDescription !== false;
  $("includeChapters").checked = s.includeChapters !== false;
  $("includeHashtags").checked = s.includeHashtags !== false;
  $("defaultTags").value = s.defaultTags || "";
}

async function init() {
  const s = await loadSettings();
  fillForm(s);

  $("btnSave").addEventListener("click", async () => {
    const next = readForm();
    const ok = await saveSettings(next);
    const el = $("saveResult");
    el.textContent = ok ? "已保存" : "保存失败";
    el.className = "save-result " + (ok ? "ok" : "err");
    if (ok) setTimeout(() => (el.textContent = ""), 2500);
  });

  $("btnTest").addEventListener("click", async () => {
    const el = $("testResult");
    el.textContent = "测试中…";
    el.className = "test-result";
    try {
      const res = await chrome.runtime.sendMessage({
        type: "YT_TEST_OBSIDIAN",
        payload: {
          baseUrl: $("obsidianApiBaseUrl").value.trim(),
          apiKey: $("obsidianApiKey").value.trim(),
        },
      });
      if (res?.ok) {
        el.textContent = `连接成功：${res.status?.authenticated ? "已认证" : "服务可达"}`;
        el.className = "test-result ok";
      } else {
        el.textContent = res?.error || "连接失败";
        el.className = "test-result err";
      }
    } catch (err) {
      el.textContent = String(err.message || err);
      el.className = "test-result err";
    }
  });
}

// 独立浏览器打开时的简化初始化
if (typeof chrome !== "undefined" && chrome.storage && chrome.runtime?.id) {
  init();
} else {
  fillForm(DEFAULT_SETTINGS);
  $("btnSave").addEventListener("click", () => {
    const el = $("saveResult");
    el.textContent = "预览模式：请在 Chrome 扩展设置中保存";
    el.className = "save-result err";
  });
  $("btnTest").addEventListener("click", () => {
    const el = $("testResult");
    el.textContent = "预览模式：无法测试连接";
    el.className = "test-result err";
  });
}
