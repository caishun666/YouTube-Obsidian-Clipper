/** 默认设置与 chrome.storage 读写 */
export const DEFAULT_SETTINGS = {
  obsidianApiBaseUrl: "http://127.0.0.1:27123",
  obsidianApiKey: "",
  noteFolder: "Clippings/YouTube",
  noteNameTemplate: "{{date}} - {{title}}",
  coverNameTemplate: "{{videoId}}-cover",
  assetFolder: "Clippings/YouTube/assets",
  commentLimit: 100,
  includeTranscript: true,
  includeComments: true,
  includeChapterThumbs: true,
  includeThumbnail: true,
  includeDescription: true,
  includeChapters: true,
  includeHashtags: true,
  defaultTags: "youtube, clipping",
  openAfterSave: true,
};

const STORAGE_KEY = "ytObsidianSettings";

export async function loadSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(STORAGE_KEY, (result) => {
        resolve({ ...DEFAULT_SETTINGS, ...(result?.[STORAGE_KEY] || {}) });
      });
    } catch (_) {
      resolve({ ...DEFAULT_SETTINGS });
    }
  });
}

export async function saveSettings(settings) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.set({ [STORAGE_KEY]: settings }, () => resolve(true));
    } catch (_) {
      resolve(false);
    }
  });
}

export function sanitizeFilename(name) {
  return String(name || "untitled")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

export function formatDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDateTime(d = new Date()) {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 笔记命名模板变量：
 * {{title}} {{videoId}} {{channel}} {{date}} {{datetime}} {{views}} {{duration}}
 * 序号：{{seq}} 原始数字；{{seq2}} 补零 2 位（01）；{{seq3}} 3 位；{{seq:N}} N 位
 * 例：视频-{{seq2}}  →  视频-01 / 视频-02
 */
export function applyTemplate(template, data) {
  const seq = Number(data.seq);
  const hasSeq = Number.isFinite(seq);
  const map = {
    title: data.title || "untitled",
    videoId: data.videoId || "",
    channel: data.channel || "",
    date: data.date || formatDate(),
    datetime: data.datetime || formatDateTime(),
    views: data.views != null ? String(data.views) : "",
    duration: data.duration || "",
    published: data.published || "",
    seq: hasSeq ? String(seq) : "",
    seq2: hasSeq ? String(seq).padStart(2, "0") : "",
    seq3: hasSeq ? String(seq).padStart(3, "0") : "",
    seq02: hasSeq ? String(seq).padStart(2, "0") : "",
    seq03: hasSeq ? String(seq).padStart(3, "0") : "",
  };

  return String(template || "{{date}} - {{title}}")
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (map[key] != null ? map[key] : ""))
    .replace(/\{\{\s*seq\s*:\s*(\d+)\s*\}\}/g, (_, width) =>
      hasSeq ? String(seq).padStart(Number(width), "0") : ""
    );
}

export function joinVaultPath(...parts) {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}
