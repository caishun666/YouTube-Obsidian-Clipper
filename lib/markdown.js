/** 将抓取结果组装为 Obsidian Markdown 笔记 */

function yamlEscape(s) {
  if (s == null) return '""';
  const str = String(s);
  if (/^[\w一-鿿][\w\s一-鿿-]*$/.test(str) && !str.includes(": ") && !str.startsWith(" ")) {
    return str;
  }
  return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

function yamlList(arr) {
  if (!arr || !arr.length) return "[]";
  return "[" + arr.map((x) => yamlEscape(x)).join(", ") + "]";
}

function fmtViews(n) {
  if (n == null || n === "") return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toLocaleString("en-US");
}

function section(text) {
  return text && String(text).trim() ? text : "_（无）_";
}

/**
 * @param {object} data extractAll 的返回值
 * @param {object} opts { noteFolder, defaultTags, include* flags, thumbnailVaultPath, chapterImages }
 */
export function buildNote(data, opts = {}) {
  const include = {
    description: opts.includeDescription !== false,
    chapters: opts.includeChapters !== false,
    hashtags: opts.includeHashtags !== false,
    transcript: opts.includeTranscript !== false,
    comments: opts.includeComments !== false,
    thumbnail: opts.includeThumbnail !== false,
    chapterThumbs: opts.includeChapterThumbs !== false,
  };

  const clipDate = new Date();
  const clipDateStr = clipDate.toISOString();
  const clipDay = `${clipDate.getFullYear()}-${String(clipDate.getMonth() + 1).padStart(2, "0")}-${String(clipDate.getDate()).padStart(2, "0")}`;

  const defaultTags = String(opts.defaultTags || "")
    .split(/[,，\s]+/)
    .map((t) => t.replace(/^#/, "").trim())
    .filter(Boolean);

  // 仅使用页面可见的 #话题标签 + 设置里的默认标签。
  // videoDetails.keywords 是页源隐藏 SEO 词，不进「标签」。
  const hashtagTags = (data.hashtags || []).map((h) =>
    String(h).replace(/\s+/g, "-")
  );
  const allTags = [...new Set([...defaultTags, ...hashtagTags])];

  const frontmatter = [
    "---",
    `标题: ${yamlEscape(data.title)}`,
    `链接: ${yamlEscape(data.url)}`,
    `视频ID: ${yamlEscape(data.videoId)}`,
    `频道: ${yamlEscape(data.channel)}`,
    `频道ID: ${yamlEscape(data.channelId)}`,
    `播放量: ${data.views != null ? data.views : "0"}`,
    `发布日期: ${yamlEscape(data.published)}`,
    `上传日期: ${yamlEscape(data.uploadDate)}`,
    `时长: ${yamlEscape(data.durationText)}`,
    `分类: ${yamlEscape(data.category)}`,
    `标签: ${yamlList(allTags)}`,
    `话题标签: ${yamlList((data.hashtags || []).map(String))}`,
    `章节数: ${(data.chapters || []).length}`,
    `评论数: ${(data.comments || []).length}`,
    `转录字数: ${(data.transcript?.text || "").length}`,
    include.thumbnail && opts.thumbnailVaultPath
      ? `封面: ${yamlEscape("[[" + opts.thumbnailVaultPath + "]]")}`
      : null,
    `抓取日期: ${yamlEscape(clipDay)}`,
    `来源: youtube`,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const lines = [];
  lines.push(frontmatter);
  lines.push("");
  lines.push(`# ${data.title || "未命名视频"}`);
  lines.push("");

  if (include.thumbnail && opts.thumbnailVaultPath) {
    lines.push(`![[${opts.thumbnailVaultPath}]]`);
    lines.push("");
  }

  // 基本信息
  lines.push("## 基本信息");
  lines.push("");
  lines.push("| 字段 | 内容 |");
  lines.push("| --- | --- |");
  lines.push(`| 链接 | [${data.url}](${data.url}) |`);
  lines.push(`| 频道 | ${data.channel || "-"} |`);
  lines.push(`| 播放量 | ${fmtViews(data.views) || "-"} |`);
  lines.push(`| 发布日期 | ${data.published || "-"} |`);
  lines.push(`| 时长 | ${data.durationText || "-"} |`);
  if (data.category) lines.push(`| 分类 | ${data.category} |`);
  lines.push(`| 视频 ID | ${data.videoId || "-"} |`);
  lines.push("");

  // 标签
  if (include.hashtags) {
    lines.push("## 标签");
    lines.push("");
    if (allTags.length) {
      lines.push(allTags.slice(0, 40).map((t) => `#${t}`).join(" "));
    } else {
      lines.push("_（无）_");
    }
    lines.push("");
  }

  // 简介
  if (include.description) {
    lines.push("## 视频简介");
    lines.push("");
    lines.push(section(data.description));
    lines.push("");
  }

  // 章节
  if (include.chapters) {
    lines.push("## 视频章节");
    lines.push("");
    const chapters = data.chapters || [];
    if (!chapters.length) {
      lines.push("_（未检测到章节）_");
    } else {
      for (const c of chapters) {
        lines.push(`### ${c.index || ""}. [${c.timestamp}](${c.url || data.url}) ${c.title}`);
        lines.push("");
        if (include.chapterThumbs && opts.chapterImages && opts.chapterImages[c.index - 1]) {
          lines.push(`![[${opts.chapterImages[c.index - 1]}]]`);
          lines.push("");
        }
      }
    }
    lines.push("");
  }

  // 转录
  if (include.transcript) {
    lines.push("## 全文转录");
    lines.push("");
    const t = data.transcript?.text?.trim();
    if (!t) {
      lines.push("_（本页未能提取到字幕/转录文本。请确认视频有字幕，或已在页面打开「显示文稿」后再抓取。）_");
    } else {
      lines.push(t);
    }
    lines.push("");
  }

  // 评论
  if (include.comments) {
    lines.push(`## 评论（前 ${data.comments?.length || 0} 条，按热度）`);
    lines.push("");
    const comments = data.comments || [];
    if (!comments.length) {
      lines.push("_（未能提取到评论，请在页面滚动评论区后重试。）_");
    } else {
      comments.forEach((c, i) => {
        const likes = c.likes ? ` · 👍 ${c.likes}` : "";
        const time = c.published ? ` · ${c.published}` : "";
        const replyList = Array.isArray(c.replies) ? c.replies : [];
        const replyNote = replyList.length
          ? ` · ${replyList.length} 条回复`
          : c.replyCount > 0
            ? ` · ${c.replyCount} 条回复`
            : "";
        const heart = c.hearted ? " · ❤️ UP 点赞" : "";
        lines.push(`### ${i + 1}. ${c.author || "匿名"}${likes}${time}${replyNote}${heart}`);
        lines.push("");
        lines.push(section(c.content));
        lines.push("");
        if (replyList.length) {
          lines.push("**回复：**");
          lines.push("");
          replyList.forEach((r, j) => {
            const rLikes = r.likes ? ` · 👍 ${r.likes}` : "";
            const rTime = r.published ? ` · ${r.published}` : "";
            lines.push(`- **${j + 1}. ${r.author || "匿名"}**${rLikes}${rTime}`);
            lines.push(`  ${section(r.content).replace(/\n/g, "\n  ")}`);
          });
          lines.push("");
        }
      });
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `> 由 YouTube Obsidian Clipper 于 ${clipDate.toLocaleString("zh-CN")} 从浏览器页面抓取写入。`
  );
  lines.push("");

  return lines.join("\n");
}

/** 生成安全的附件文件名 */
export function assetFileName(prefix, ext) {
  const safe = String(prefix || "asset")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return `${safe}.${ext || "jpg"}`;
}

export function guessImageExt(url, contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  const u = String(url || "").toLowerCase();
  if (u.includes(".png")) return "png";
  if (u.includes(".webp")) return "webp";
  if (u.includes(".gif")) return "gif";
  return "jpg";
}
