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

function fmtTimeMs(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function heatLabel(score) {
  const n = Math.round((Number(score) || 0) * 100);
  if (n >= 80) return "🔥🔥🔥🔥🔥";
  if (n >= 60) return "🔥🔥🔥🔥";
  if (n >= 40) return "🔥🔥🔥";
  if (n >= 25) return "🔥🔥";
  return "🔥";
}

/** 把稀疏热度点重采样成约 1 秒 1 点（线性插值），曲线更贴 YouTube */
function resampleHeatmapSeconds(points, durationSeconds) {
  if (!points || points.length < 2) return points || [];
  const sorted = [...points].sort((a, b) => a.startMs - b.startMs);
  const durSec = Math.max(
    1,
    Math.round(durationSeconds || sorted[sorted.length - 1].startMs / 1000 || 1)
  );

  // 若原始点已 ≥ 每秒 1 点，直接按时秒聚合
  const bySec = new Map();
  for (const p of sorted) {
    const sec = Math.max(0, Math.min(durSec, Math.round(p.startMs / 1000)));
    const prev = bySec.get(sec);
    if (prev == null || p.score > prev) bySec.set(sec, p.score);
  }

  const out = [];
  let i = 0;
  for (let sec = 0; sec <= durSec; sec++) {
    const ms = sec * 1000;
    if (bySec.has(sec)) {
      out.push({ startMs: ms, endMs: ms, score: bySec.get(sec) });
      continue;
    }
    // 线性插值
    while (i < sorted.length - 1 && sorted[i + 1].startMs < ms) i++;
    const a = sorted[Math.max(0, Math.min(sorted.length - 1, i))];
    const b = sorted[Math.max(0, Math.min(sorted.length - 1, i + 1))];
    if (b.startMs === a.startMs) {
      out.push({ startMs: ms, endMs: ms, score: a.score });
    } else {
      const r = (ms - a.startMs) / (b.startMs - a.startMs);
      out.push({
        startMs: ms,
        endMs: ms,
        score: Math.max(0, Math.min(1, a.score + (b.score - a.score) * r)),
      });
    }
  }
  return out;
}

/**
 * 热度图：时间线 + Top 榜（AI 友好） + ChartsView 图（人读）
 * heatmap: [{ startMs, endMs, score }]  score 0-1
 */
function buildHeatmapSection(heatmap, durationSeconds) {
  const points = (heatmap || [])
    .filter((p) => p && Number.isFinite(Number(p.startMs)))
    .map((p) => ({
      startMs: Number(p.startMs),
      endMs: Number(p.endMs) || Number(p.startMs),
      score: Number.isFinite(Number(p.score)) ? Number(p.score) : 0,
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const out = [];
  out.push("## 视频热度与高能时刻");
  out.push("");

  if (!points.length) {
    out.push(
      "_（本页未检测到 Heatmap / Most replayed。并非所有视频都有该曲线；若播放器进度条上有「最多重播」阴影，请重新打开视频后再抓一次。）_"
    );
    out.push("");
    return out;
  }

  // 图表用 1 秒粒度；正文列表仍采样，避免刷屏
  const dense = resampleHeatmapSeconds(points, durationSeconds);

  out.push("> 格式说明：[开始时间] - [结束时间] | 热度指数 (0-100)。热度来自 YouTube 进度条 Heatmap（Most replayed）。");
  out.push("");

  out.push("### ⏱️ 时间线热度流");
  out.push("");
  const step = Math.max(1, Math.ceil(dense.length / 40));
  for (let i = 0; i < dense.length; i += step) {
    const p = dense[i];
    const heat = Math.round(p.score * 100);
    const dur = Math.max(1, Math.round((p.endMs - p.startMs) / 1000)) || step;
    const tag = heat >= 85 ? " (🔥 全视频最高潮)" : heat >= 70 ? " (关注度明显上升)" : "";
    out.push(
      `- **[${fmtTimeMs(p.startMs)}]** (+${dur}s) | ${heatLabel(p.score)} 热度: **${heat}**${tag}`
    );
  }
  out.push("");

  // Top 3 局部峰值
  const peaks = [];
  for (let i = 0; i < dense.length; i++) {
    const prev = dense[i - 1]?.score ?? -1;
    const next = dense[i + 1]?.score ?? -1;
    const cur = dense[i].score;
    if (cur >= prev && cur >= next && cur > 0.15) peaks.push(dense[i]);
  }
  peaks.sort((a, b) => b.score - a.score);
  const byScore = [...dense].sort((a, b) => b.score - a.score);
  const top = [];
  for (const p of peaks) {
    if (top.length >= 3) break;
    top.push(p);
  }
  for (const p of byScore) {
    if (top.length >= 3) break;
    if (!top.includes(p)) top.push(p);
  }

  out.push("### 🏆 核心高能片段排行 (Top 3)");
  out.push("");
  top.forEach((p, i) => {
    const end = Math.max(p.endMs, p.startMs + 8000);
    const heat = Math.round(p.score * 100);
    const note = i === 0 ? " —— *全视频最受关注区域*" : "";
    out.push(
      `${i + 1}. **[${fmtTimeMs(p.startMs)} - ${fmtTimeMs(end)}]** | 热度: **${heat}**${note}`
    );
  });
  out.push("");

  // ChartsView：全分辨率（约 1s/点）
  const sampled = dense.map((p) => ({
    t: fmtTimeMs(p.startMs),
    v: Math.round(p.score * 100),
  }));
  out.push("### 📈 热度曲线 (ChartsView)");
  out.push("");
  out.push("```chartsview");
  out.push("#-----------------#");
  out.push("#- chart type    -#");
  out.push("#-----------------#");
  // ChartsView 用 @ant-design/plots 组件名，必须 PascalCase（Line/Area/Column…）
  out.push("type: Area");
  out.push("");
  out.push("#-----------------#");
  out.push("#- chart data    -#");
  out.push("#-----------------#");
  out.push("data:");
  for (const s of sampled) {
    out.push(`  - { t: '${s.t}', v: ${s.v} }`);
  }
  out.push("");
  out.push("#-----------------#");
  out.push("#- chart options -#");
  out.push("#-----------------#");
  out.push("options:");
  out.push("  xField: t");
  out.push("  yField: v");
  out.push("  smooth: true");
  out.push("  line:");
  out.push("    color: '#FF5211'");
  out.push("    size: 2");
  out.push("  areaStyle:");
  out.push("    fill: 'rgba(255, 82, 17, 0.22)'");
  out.push("  meta:");
  out.push("    t:");
  out.push("      alias: 时间");
  out.push("    v:");
  out.push("      alias: 热度");
  out.push("      min: 0");
  out.push("      max: 500");
  out.push("```");
  out.push("");

  // 原始序列，便于程序解析（压缩成一行 JSON）
  const raw = points.map((p) => [p.startMs, Math.round(p.score * 1000) / 1000]);
  out.push("<details>");
  out.push("<summary>原始热度序列 JSON（供脚本/AI 解析）</summary>");
  out.push("");
  out.push("```json");
  out.push(JSON.stringify(raw));
  out.push("```");
  out.push("");
  out.push("</details>");
  out.push("");

  return out;
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
    `热度点数: ${(data.heatmap || []).length}`,
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

  // 热度图（ChartsView + AI 列表）
  if (include.heatmap !== false) {
    lines.push(...buildHeatmapSection(data.heatmap, data.durationSeconds));
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
