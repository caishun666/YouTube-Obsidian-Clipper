/**
 * YouTube 视频页信息提取 Content Script
 * 从 ytInitialPlayerResponse / ytInitialData / DOM 抽取全部字段，
 * 并按需加载字幕与前 N 条热门评论。
 */
(() => {
  "use strict";

  if (window.__ytObsidianExtractorLoaded) return;
  window.__ytObsidianExtractorLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function parseJsonFromPage(varName) {
    try {
      if (window[varName]) return window[varName];
    } catch (_) {
      /* ignore */
    }
    const html = document.documentElement.innerHTML;
    // 方式 1：var ytInitialPlayerResponse = {...};
    const assignRe = new RegExp(
      `(?:var|window\\.)\\s*${varName}\\s*=\\s*(\\{[\\s\\S]*?\\});\\s*(?:var|</script>|\\n\\s*var)`
    );
    let m = html.match(assignRe);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch (_) {
        /* ignore */
      }
    }
    // 方式 2：从 script 标签内找超大 JSON
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      const text = s.textContent || "";
      const idx = text.indexOf(`"${varName}"`);
      if (idx === -1) {
        const assignIdx = text.indexOf(varName);
        if (assignIdx === -1) continue;
      }
      const start = text.indexOf("{", text.indexOf(varName));
      if (start === -1) continue;
      // 用括号配平截取
      let depth = 0;
      let end = -1;
      let inStr = false;
      let esc = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end > start) {
        try {
          return JSON.parse(text.slice(start, end + 1));
        } catch (_) {
          /* ignore */
        }
      }
    }
    return null;
  }

  function deepFind(obj, key, maxDepth = 12) {
    const seen = new Set();
    const stack = [{ o: obj, d: 0 }];
    while (stack.length) {
      const { o, d } = stack.pop();
      if (!o || typeof o !== "object" || d > maxDepth) continue;
      if (seen.has(o)) continue;
      seen.add(o);
      if (Object.prototype.hasOwnProperty.call(o, key) && o[key] != null) {
        return o[key];
      }
      for (const v of Object.values(o)) {
        if (v && typeof v === "object") stack.push({ o: v, d: d + 1 });
      }
    }
    return null;
  }

  function deepFindAll(obj, key, maxDepth = 14, maxVisit = 4000) {
    const out = [];
    const seen = new Set();
    const stack = [{ o: obj, d: 0 }];
    let visits = 0;
    while (stack.length && visits < maxVisit) {
      const { o, d } = stack.pop();
      if (!o || typeof o !== "object" || d > maxDepth) continue;
      if (seen.has(o)) continue;
      seen.add(o);
      visits++;
      if (Object.prototype.hasOwnProperty.call(o, key) && o[key] != null) {
        out.push(o[key]);
      }
      for (const v of Object.values(o)) {
        if (v && typeof v === "object") stack.push({ o: v, d: d + 1 });
      }
    }
    return out;
  }

  function textFromRuns(runs) {
    if (!runs) return "";
    if (typeof runs === "string") return runs;
    if (Array.isArray(runs)) {
      return runs.map((r) => r.text || r.simpleText || "").join("");
    }
    return runs.simpleText || runs.text || "";
  }

  function formatViews(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return String(n ?? "");
    return num.toLocaleString("en-US");
  }

  function parseTimestampToSeconds(ts) {
    const parts = String(ts).split(":").map((p) => Number(p));
    if (parts.some((p) => !Number.isFinite(p))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
  }

  function formatSeconds(ts) {
    const s = Math.max(0, Math.floor(Number(ts) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  function getVideoId() {
    const u = new URL(location.href);
    return u.searchParams.get("v") || (u.pathname.match(/\/shorts\/([\w-]+)/) || [])[1] || null;
  }

  function normalizeUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  function parseChaptersFromDescription(description) {
    const chapters = [];
    const lines = String(description || "").split(/\r?\n/);
    const re = /(?:^|\s)(?:(\d{1,2}:)?(\d{1,2}):(\d{2}))\s*[-–—:]?\s*(.+)$/;
    for (const line of lines) {
      const m = line.trim().match(re);
      if (!m) continue;
      const ts = [m[1], m[2], m[3]].filter(Boolean).join(":");
      const seconds = parseTimestampToSeconds(ts);
      if (seconds == null) continue;
      chapters.push({
        seconds,
        timestamp: formatSeconds(seconds),
        title: m[4].trim().replace(/^[-–—:]\s*/, ""),
      });
    }
    // 去重：同秒只保留第一条
    const seen = new Set();
    return chapters.filter((c) => {
      if (seen.has(c.seconds)) return false;
      seen.add(c.seconds);
      return true;
    });
  }

  function parseChaptersFromPlayer(player) {
    try {
      const lists = deepFindAll(player, "macroMarkersListItemRenderer", 16);
      const chapters = [];
      for (const item of lists) {
        const title = textFromRuns(item.title);
        const timeDesc = textFromRuns(item.timeDescription);
        const seconds = parseTimestampToSeconds(timeDesc);
        if (seconds == null && item.onTap?.watchEndpoint?.startTimeSeconds == null) continue;
        const sec = seconds ?? item.onTap.watchEndpoint.startTimeSeconds;
        let thumb = null;
        const candidates = [
          item.thumbnail?.thumbnails,
          item.thumbnails,
          item.thumbnail?.playerThumbnail?.thumbnails,
        ];
        for (const arr of candidates) {
          if (Array.isArray(arr) && arr.length) {
            const u = arr[arr.length - 1]?.url || arr[0]?.url;
            if (u && !thumb) thumb = u;
          }
        }
        if (!thumb) {
          const any = deepFind(item, "thumbnails", 6);
          if (Array.isArray(any) && any.length) thumb = any[any.length - 1]?.url || null;
        }
        chapters.push({
          seconds: Number(sec),
          timestamp: formatSeconds(sec),
          title: title || `章节 ${formatSeconds(sec)}`,
          thumbnailUrl: thumb,
        });
      }
      chapters.sort((a, b) => a.seconds - b.seconds);
      return chapters;
    } catch (_) {
      return [];
    }
  }

  function thumbFromNode(node) {
    // 1) img src / srcset / data-src
    const imgs = [...node.querySelectorAll("img")];
    for (const img of imgs) {
      const src =
        img.currentSrc ||
        img.src ||
        img.getAttribute("src") ||
        img.getAttribute("data-src") ||
        "";
      if (src && /ytimg|ggpht|googleusercontent|yt3\./i.test(src) && !/avatar|channel/i.test(src)) {
        return src.split("?")[0];
      }
      const srcset = img.getAttribute("srcset") || "";
      if (srcset) {
        const last = srcset.split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
        if (last) return last.split("?")[0];
      }
    }
    // 2) background-image
    const bgEls = [
      node.querySelector("#thumbnail, .ytd-macro-markers-list-item-renderer #thumbnail"),
      node.querySelector("yt-image, yt-img-shadow, .yt-core-image"),
      node,
    ];
    for (const el of bgEls) {
      const bg =
        (el?.style?.backgroundImage || getComputedStyle?.(el)?.backgroundImage || "") + "";
      const m = bg.match(/url\((['"]?)(.*?)\1\)/);
      if (m && m[2] && /ytimg|ggpht/i.test(m[2])) {
        return m[2].split("?")[0];
      }
    }
    return null;
  }

  function parseChaptersFromDom() {
    const nodes = document.querySelectorAll(
      "ytd-macro-markers-list-item-renderer, ytd-chapter-renderer"
    );
    const chapters = [];
    nodes.forEach((node) => {
      const titleEl =
        node.querySelector("#details h4, #details #video-title, h4, [title]") || node;
      const timeEl = node.querySelector(
        "#time, .ytd-macro-markers-list-item-renderer #time, ytd-macro-markers-list-item-renderer #time"
      );
      const title = (titleEl.getAttribute("title") || titleEl.textContent || "").replace(/\s+/g, " ").trim();
      const timeText = (timeEl?.textContent || "").trim();
      const seconds = parseTimestampToSeconds(timeText);
      const thumb = thumbFromNode(node);
      if (seconds == null) return;
      chapters.push({
        seconds,
        timestamp: formatSeconds(seconds),
        title: title || `章节 ${formatSeconds(seconds)}`,
        thumbnailUrl: thumb,
      });
    });
    return chapters;
  }

  /** YouTube 官方「不同帧」缩略图：hq1/hq2/hq3、maxres1-3 等 */
  function chapterFrameThumb(videoId, index) {
    if (!videoId) return null;
    const variants = [
      `https://i.ytimg.com/vi/${videoId}/hq1.jpg`,
      `https://i.ytimg.com/vi/${videoId}/hq2.jpg`,
      `https://i.ytimg.com/vi/${videoId}/hq3.jpg`,
      `https://i.ytimg.com/vi/${videoId}/maxres1.jpg`,
      `https://i.ytimg.com/vi/${videoId}/maxres2.jpg`,
      `https://i.ytimg.com/vi/${videoId}/maxres3.jpg`,
    ];
    return variants[index % variants.length];
  }

  /** 合并多来源章节：结构 + 缩略图 */
  function mergeChapters(primary, fromDom, videoId) {
    const bySec = new Map();
    const put = (c) => {
      if (!c || c.seconds == null) return;
      const key = Number(c.seconds);
      const prev = bySec.get(key);
      if (!prev) {
        bySec.set(key, { ...c, seconds: key });
        return;
      }
      if (!prev.thumbnailUrl && c.thumbnailUrl) prev.thumbnailUrl = c.thumbnailUrl;
      if ((!prev.title || prev.title.startsWith("章节 ")) && c.title) prev.title = c.title;
    };
    (primary || []).forEach(put);
    (fromDom || []).forEach(put);

    const list = [...bySec.values()].sort((a, b) => a.seconds - b.seconds);
    return list.map((c, idx) => {
      let thumb = c.thumbnailUrl;
      // 禁止所有章节都用同一张封面图
      const coverLike =
        !thumb ||
        /\/(default|mqdefault|sddefault|hqdefault|maxresdefault)\.jpg$/i.test(thumb) ||
        thumb.includes(`i.ytimg.com/vi/${videoId}/hqdefault`) ||
        thumb.includes(`i.ytimg.com/vi/${videoId}/maxresdefault`);
      if (coverLike) {
        thumb = chapterFrameThumb(videoId, idx) || thumb;
      }
      return {
        ...c,
        thumbnailUrl: thumb,
        url: normalizeUrl(videoId) + `&t=${c.seconds}s`,
        index: idx + 1,
      };
    });
  }

  function extractHashtags(description) {
    const tags = new Set();
    const re = /#([\w一-鿿぀-ヿ가-힯]+)/g;
    const text = String(description || "");
    let m;
    while ((m = re.exec(text))) tags.add(m[1]);
    return [...tags];
  }

  function pickBestThumb(thumbnails) {
    if (!Array.isArray(thumbnails) || !thumbnails.length) return null;
    const sorted = [...thumbnails].sort(
      (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
    );
    return {
      url: sorted[0].url,
      width: sorted[0].width,
      height: sorted[0].height,
    };
  }

  function transcriptPanelReady() {
    return !!document.querySelector(
      "ytd-transcript-renderer, " +
        "ytd-transcript-segment-renderer, " +
        "ytd-transcript-segment-view-model, " +
        "yt-transcript-segment-renderer, " +
        "ytd-transcript-section-list-renderer ytd-transcript-segment-renderer"
    );
  }

  async function openTranscriptPanel() {
    if (transcriptPanelReady()) return true;

    // 先展开简介，否则「内容转文字」按钮可能被折叠
    const expandBtn = document.querySelector(
      "#description-inline-expander tp-yt-paper-button#expand, " +
        "#expand, " +
        "ytd-text-inline-expander #expand, " +
        "tp-yt-paper-button#expand"
    );
    if (expandBtn) {
      try {
        expandBtn.click();
        await sleep(400);
      } catch (_) {
        /* ignore */
      }
    }

    const labelRe = /内容转文字|显示文稿|文稿|字幕|transcript|show transcript|open transcript/i;
    const candidates = [
      ...document.querySelectorAll(
        "ytd-video-description-transcript-section-renderer button, " +
          "ytd-video-description-transcript-section-renderer yt-button-shape button, " +
          "ytd-video-description-transcript-section-renderer tp-yt-paper-button, " +
          "button[aria-label*='transcript' i], " +
          "button[aria-label*='字幕' i], " +
          "button[aria-label*='文稿' i], " +
          "button[aria-label*='内容转文字' i], " +
          "ytd-video-description-infobox-renderer button, " +
          "#description button"
      ),
    ];

    for (const btn of candidates) {
      const label = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.title || ""}`;
      if (!labelRe.test(label)) continue;
      if (!(btn.offsetParent !== null || btn.getClientRects().length)) continue;
      try {
        btn.click();
        await sleep(900);
        if (transcriptPanelReady()) return true;
      } catch (_) {
        /* ignore */
      }
    }

    // engagement panel 内按钮
    const panels = document.querySelectorAll("ytd-engagement-panel-section-list-renderer");
    for (const panel of panels) {
      const head = (panel.textContent || "").slice(0, 120);
      if (!/transcript|文稿|字幕|转文字/i.test(head)) continue;
      if (/chapters|章节|playlists|播放列表/i.test(head) && !/transcript|文稿|转文字/i.test(head)) continue;
      const target =
        panel.querySelector(
          "ytd-video-description-transcript-section-renderer button, button, yt-button-shape button"
        ) || panel.querySelector("button");
      if (target) {
        try {
          target.click();
          await sleep(900);
          if (transcriptPanelReady()) return true;
        } catch (_) {
          /* ignore */
        }
      }
    }

    // 最后：按可见文字直接点
    const allBtns = [...document.querySelectorAll("button, tp-yt-paper-button, yt-button-shape")];
    for (const btn of allBtns) {
      const t = (btn.textContent || "").trim();
      if (!/^(内容转文字|显示文稿|文稿|Transcript|Show transcript)$/i.test(t)) continue;
      try {
        btn.click();
        await sleep(1000);
        if (transcriptPanelReady()) return true;
      } catch (_) {
        /* ignore */
      }
    }

    return transcriptPanelReady();
  }

  function parseTranscriptSegments() {
    // 只用一种主选择器，避免嵌套节点导致同一句出现两次
    let nodes = [...document.querySelectorAll("ytd-transcript-segment-renderer")];
    if (!nodes.length) {
      nodes = [...document.querySelectorAll("ytd-transcript-segment-view-model")];
    }
    if (!nodes.length) {
      nodes = [...document.querySelectorAll("yt-transcript-segment-renderer")];
    }

    const seen = new Set();
    const out = [];
    for (const el of nodes) {
      const time = (
        el.querySelector(".segment-timestamp, [class*='timestamp'], #timestamp")?.textContent || ""
      ).trim();
      let text = (
        el.querySelector(".segment-text, [class*='segment-text'], #content")?.textContent ||
        el.textContent ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      text = text.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, "").trim();
      const seconds = parseTimestampToSeconds(time);
      const key = `${seconds ?? 0}|${text}`;
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push({
        seconds: seconds ?? 0,
        timestamp: formatSeconds(seconds ?? 0),
        text,
      });
    }
    return out;
  }

  async function extractTranscript() {
    const opened = await openTranscriptPanel();
    let segments = [];

    if (opened || transcriptPanelReady()) {
      const scroller = document.querySelector(
        "ytd-transcript-renderer #body.ytd-transcript-renderer, " +
          "ytd-transcript-renderer ytd-transcript-segment-list-renderer, " +
          "ytd-transcript-segment-list-renderer, " +
          "ytd-transcript-renderer #segments"
      );
      if (scroller) {
        scroller.scrollTop = 0;
        for (let i = 0; i < 50; i++) {
          const before = parseTranscriptSegments().length;
          scroller.scrollTop = scroller.scrollHeight;
          await sleep(140);
          const after = parseTranscriptSegments().length;
          if (after === before && i > 4) break;
        }
      }
      segments = parseTranscriptSegments();
    }

    // 仅从页面 DOM 提取，不请求任何 YouTube 接口
    if (!segments.length) {
      return { text: "", segments: [], method: opened ? "opened-empty" : "none" };
    }

    // 去重（同一秒+同一句）
    const uniq = new Map();
    for (const s of segments) {
      if (!s.text) continue;
      const key = `${s.seconds}|${s.text}`;
      if (!uniq.has(key)) uniq.set(key, s);
    }
    segments = [...uniq.values()].sort((a, b) => a.seconds - b.seconds);
    const text = segments.map((s) => `${s.timestamp} ${s.text}`.trim()).join("\n");
    return {
      text,
      segments,
      method: "dom",
    };
  }

  function commentFromRenderer(renderer) {
    const comment = renderer.comment || renderer.commentRenderer || renderer;
    const cr =
      comment.commentRenderer ||
      comment.commentThreadRenderer?.comment?.commentRenderer ||
      comment;

    const author =
      cr.authorText?.simpleText ||
      textFromRuns(cr.authorText) ||
      (cr.authorText ? String(cr.authorText) : "") ||
      "";

    // 折叠内容也取全文（collapsed content counts as one）
    let content = textFromRuns(cr.contentText || cr.content);
    if (!content && cr.content?.runs) content = textFromRuns(cr.content.runs);
    if (!content) {
      const el = cr;
      content = el?.contentText ? textFromRuns(el.contentText) : "";
    }

    // 有时 DOM 里有展开按钮
    let expanded = content;

    const published = cr.publishedTimeText
      ? textFromRuns(cr.publishedTimeText)
      : "";

    const likes = cr.voteCount
      ? textFromRuns(cr.voteCount)
      : textFromRuns(cr.voteCountIfNotZero) || "";

    const authorChannelId = cr.authorEndpoint?.browseEndpoint?.browseId || "";
    const avatar =
      cr.authorThumbnail?.thumbnails?.slice(-1)[0]?.url ||
      cr.authorThumbnail?.thumbnails?.[0]?.url ||
      null;
    const replyCount =
      cr.replyCount != null
        ? Number(cr.replyCount) || 0
        : Number(textFromRuns(cr.replyCountText) || 0) || 0;

    const heart = !!(cr.isHearted || deepFind(cr, "heartedHeartRenderer") || cr.heartedTooltip);

    return {
      author,
      authorChannelId,
      avatarUrl: avatar,
      content: expanded || content || "",
      published,
      likes,
      replyCount,
      hearted: heart,
    };
  }

  function findCommentThreads() {
    // 一级评论线程（不把楼中楼算独立条目）
    const scope = document.querySelector("#comments") || document;
    const set = new Set();

    // 1) 经典 thread-renderer
    scope.querySelectorAll("ytd-comment-thread-renderer").forEach((el) => set.add(el));

    // 2) 新版 view-model（排除 replies 内）
    if (set.size === 0) {
      scope.querySelectorAll("ytd-comment-view-model").forEach((el) => {
        let p = el.parentElement;
        while (p && p !== document.body) {
          if (
            p.tagName === "YTD-COMMENT-REPLIES-RENDERER" ||
            p.id === "replies" ||
            p.classList?.contains("ytd-comment-replies-renderer")
          ) {
            return;
          }
          p = p.parentElement;
        }
        set.add(el);
      });
    }

    // 3) 再退回整页（评论区节点尚未挂上 #comments 时）
    if (set.size === 0) {
      document.querySelectorAll("ytd-comment-thread-renderer").forEach((el) => set.add(el));
    }

    return [...set];
  }

  /** 去掉混进正文的 YouTube 按钮/菜单文案 */
  function cleanCommentText(raw) {
    try {
      let t = String(raw || "").replace(/\s+/g, " ").trim();
      if (!t) return "";

      // 固定 UI 短语：直接删（不会出现在正常句子里）
      const hardRemove = [
        "取消点赞",
        "取消点踩",
        "取消喜欢",
        "取消不喜欢",
        "取消心心",
        "点踩",
        "举报此评论",
        "隐藏此评论",
        "Show more replies",
        "Show fewer replies",
        "Show more",
        "Show less",
        "Read more",
        "Unheart",
        "Unlove",
        "Unlike",
        "Undislike",
      ];
      for (const p of hardRemove) {
        t = t.split(p).join(" ");
      }

      // 短词：仅在独立出现时删
      const soft = ["点赞", "喜欢", "不喜欢", "回复", "分享", "保存", "举报", "隐藏", "Like", "Dislike", "Reply", "Share", "Save", "Report", "Hide", "Heart", "Love"];
      for (const p of soft) {
        const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(
          `(^|[\\s·|/、，,;；:：.。!！?？"'（(【\\[])${esc}($|[\\s·|/、，,;；:：.。!！?？"'）)】\\]])`,
          "g"
        );
        t = t.replace(re, "$1$2");
      }

      t = t.replace(/\s+/g, " ").trim();
      if (/^(点赞|点踩|回复|分享|Like|Unlike|Reply|Share|Dislike|取消点赞|取消点踩)+$/i.test(t)) {
        return "";
      }
      return t;
    } catch (_) {
      return String(raw || "").replace(/\s+/g, " ").trim();
    }
  }

  function textWithoutButtons(el) {
    if (!el) return "";
    try {
      const clone = el.cloneNode(true);
      clone
        .querySelectorAll(
          "button, tp-yt-paper-button, yt-button-shape, ytd-button-renderer, [role='button'], tp-yt-paper-tooltip, #like-button, #dislike-button, #reply-button-end, [aria-label*='点赞'], [aria-label*='点踩'], [aria-label*='取消'], [aria-label*='Like' i], [aria-label*='Dislike' i], [aria-label*='Reply' i]"
        )
        .forEach((n) => n.remove());
      return (clone.textContent || clone.innerText || "").replace(/\s+/g, " ").trim();
    } catch (_) {
      return (el.textContent || "").replace(/\s+/g, " ").trim();
    }
  }

  function parseLikes(text) {
    try {
      const t = String(text || "").trim();
      if (!t) return "";
      if (/^(赞|like|likes|unavailable)$/i.test(t)) return "";
      const cn = t.match(/([\d.,]+)\s*万/);
      if (cn) return `${cn[1]}万`;
      const m = t.match(/[\d.,]+/);
      return m ? m[0] : t;
    } catch (_) {
      return "";
    }
  }

  function parseReplyCount(text) {
    const t = String(text || "").replace(/\s+/g, " ");
    const cn = t.match(/(\d+)\s*条回复/);
    if (cn) return Number(cn[1]) || 0;
    const m = t.match(/(\d+)/);
    return m ? Number(m[1]) || 0 : 0;
  }

  function extractRepliesFromThread(node) {
    const repliesBox =
      node.querySelector("ytd-comment-replies-renderer") ||
      node.querySelector("#replies ytd-comment-replies-renderer") ||
      node.querySelector("#replies");
    if (!repliesBox) return [];

    const parentComment =
      node.querySelector(":scope > ytd-comment-renderer#comment") ||
      node.querySelector(":scope > ytd-comment-renderer") ||
      node.querySelector("ytd-comment-renderer#comment");

    const replyNodes = [
      ...repliesBox.querySelectorAll(
        "ytd-comment-renderer#comment, ytd-comment-renderer, ytd-comment-view-model"
      ),
    ].filter((r) => r !== parentComment && repliesBox.contains(r));

    const out = [];
    const seen = new Set();
    for (const r of replyNodes) {
      const authorEl =
        r.querySelector("#author-text, a#author-text, ytd-channel-name #text") ||
        r.querySelector("[id*='author']");
      const contentEl =
        r.querySelector(
          "#content-text, yt-attributed-string#content-text, #content yt-attributed-string"
        ) || r.querySelector("[id*='content-text']");
      const timeEl = r.querySelector("#published-time-text a, #published-time-text");
      const likeEl = r.querySelector("#vote-count-middle, #vote-count-left, #vote-count, #like-button");
      const author = (authorEl?.textContent || "").replace(/\s+/g, " ").trim();
      const content = cleanCommentText(textWithoutButtons(contentEl) || contentEl?.innerText || contentEl?.textContent);
      const published = (timeEl?.textContent || "").replace(/\s+/g, " ").trim();
      const likes = parseLikes(likeEl?.textContent || likeEl?.title || "");
      const key = `${author}|${content.slice(0, 80)}`;
      if (!content && !author) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ author, content, published, likes });
    }
    return out;
  }

  function extractCommentsFromDom() {
    const nodes = findCommentThreads();

    return nodes.map((node) => {
      // 每个 thread 只算一条（楼中楼挂在 replies 数组里）
      const main =
        node.querySelector(":scope > ytd-comment-renderer#comment") ||
        node.querySelector("ytd-comment-renderer#comment") ||
        node.querySelector("ytd-comment-view-model") ||
        node.querySelector("ytd-comment-renderer") ||
        node;

      const repliesBox =
        node.querySelector("ytd-comment-replies-renderer") ||
        node.querySelector("#replies");

      const authorEl =
        main.querySelector("#author-text, #author-text span, ytd-channel-name #text, a#author-text") ||
        main.querySelector("[id*='author']");
      const contentEl =
        main.querySelector(
          "#content-text, yt-attributed-string#content-text, #content yt-attributed-string, #content #content-text"
        ) || main.querySelector("[id*='content-text']");
      const timeEl =
        main.querySelector(
          "#published-time-text a, #published-time-text, yt-formatted-string#published-time-text"
        ) || main.querySelector("[id*='published']");
      const likeEl =
        main.querySelector(
          "#vote-count-middle, #vote-count-left, #vote-count-right, #vote-count, #like-button"
        ) || main.querySelector("[id*='vote-count']");

      const author = (authorEl?.textContent || "").replace(/\s+/g, " ").trim();
      let content = cleanCommentText(
        textWithoutButtons(contentEl) || contentEl?.innerText || contentEl?.textContent
      );

      // 展开被截断的主评论全文
      const looksTruncated = /…|\.\.\.$/.test(content);
      if (looksTruncated) {
        const moreBtn = main.querySelector(
          "#content ytd-expandable-section-renderer button, #more button, button[aria-label*='Show more' i]"
        );
        if (moreBtn && /show more|更多|展开/i.test(moreBtn.textContent || moreBtn.ariaLabel || "")) {
          try {
            moreBtn.click();
          } catch (_) {
            /* ignore */
          }
        }
      }

      const published = (timeEl?.textContent || "").replace(/\s+/g, " ").trim();
      const likes = parseLikes(likeEl?.textContent || likeEl?.title || likeEl?.getAttribute("aria-label") || "");
      const avatar =
        main.querySelector("#author-thumbnail img, img#img")?.src || null;

      let replyCount = 0;
      if (repliesBox) {
        const rc =
          repliesBox.querySelector("#more-replies") ||
          repliesBox.querySelector("#collapsed-replies");
        replyCount = parseReplyCount(rc?.textContent || repliesBox.textContent || "");
      }

      // 已展开的楼中楼
      const replies = extractRepliesFromThread(node);

      const structured = extractCommentFromModel(node);
      const base = structured?.content
        ? {
            ...structured,
            content: cleanCommentText(content || structured.content),
            author: author || structured.author,
            published: published || structured.published,
            likes: likes || parseLikes(structured.likes) || "",
            replyCount: replyCount || structured.replyCount || 0,
          }
        : {
            author,
            authorChannelId: "",
            avatarUrl: avatar,
            content: content || "",
            published,
            likes,
            replyCount,
            hearted: false,
          };

      return { ...base, replies };
    });
  }

  function extractCommentFromModel(node) {
    try {
      // 某些版本把数据挂在 yt-component-observer 或 ytd-comment-thread-renderer 的 __data
      const anyData =
        node.__data ||
        node._templateInstance ||
        null;
      if (anyData && anyData.data) {
        return commentFromRenderer(anyData.data);
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function textFromAny(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (v.simpleText) return String(v.simpleText);
    if (Array.isArray(v.runs)) return v.runs.map((x) => x.text || "").join("");
    if (typeof v.content === "string") return v.content;
    return "";
  }

  /** 通过扩展 background 在 MAIN world 读页面全局对象（避开 YouTube CSP） */
  async function requestPageWorld() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "YT_PAGE_WORLD" });
      if (res?.ok && res.data) return res.data;
      return { player: null, micro: null, playerVideoId: null, comments: [] };
    } catch (_) {
      return { player: null, micro: null, playerVideoId: null, comments: [] };
    }
  }

  function extractCommentsFromInitialData(data) {
    const out = [];
    const seen = new Set();
    const push = (c) => {
      if (!c) return;
      const content = c.content || "";
      const author = c.author || "";
      if (!content && !author) return;
      const key = `${author}|${content.slice(0, 100)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    };

    // 多种节点结构
    deepFindAll(data || {}, "commentThreadRenderer", 14).forEach((th) => {
      try {
        const cr =
          th.comment?.commentRenderer ||
          th.comment?.commentViewModel ||
          th.comment?.comment ||
          th.commentRenderer;
        if (cr) push(commentFromRenderer({ comment: { commentRenderer: cr }, ...th }));
      } catch (_) {
        /* ignore */
      }
    });
    deepFindAll(data || {}, "commentRenderer", 14).forEach((cr) => {
      try {
        push(commentFromRenderer({ comment: { commentRenderer: cr } }));
      } catch (_) {
        /* ignore */
      }
    });
    deepFindAll(data || {}, "commentViewModel", 14).forEach((vm) => {
      try {
        push({
          author: textFromAny(vm.author || vm.authorText || vm.header),
          content: cleanCommentText(
            textFromAny(vm.content || vm.contentText) ||
              String(vm.content?.content || vm.content?.text || "")
          ),
          published: textFromAny(vm.publishedTimeText || vm.publishedTime),
          likes: textFromAny(vm.voteCount) || "",
          replyCount: 0,
          hearted: false,
          replies: [],
        });
      } catch (_) {
        /* ignore */
      }
    });

    return out;
  }

  function seedCommentsFromList(list, map) {
    let count = 0;
    for (const c of list || []) {
      const content = cleanCommentText(c.content);
      const author = c.author || "";
      if (!content && !author) continue;
      const key = `${author}|${content.slice(0, 100)}`;
      if (!map.has(key)) {
        map.set(key, { ...c, content, author, replies: c.replies || [] });
        count++;
      }
    }
    return count;
  }

  function seedCommentsFromInitialData(map, pageWorld) {
    let count = 0;
    if (pageWorld?.comments?.length) {
      count = seedCommentsFromList(pageWorld.comments, map);
    }
    if (count > 0) return count;

    try {
      const data = parseJsonFromPage("ytInitialData");
      count = seedCommentsFromList(extractCommentsFromInitialData(data), map);
    } catch (_) {
      /* ignore */
    }
    return count;
  }

  function collectInto(map) {
    try {
      const domComments = extractCommentsFromDom().filter((c) => c.content || c.author);
      for (const c of domComments) {
        const key = `${c.author}|${c.content.slice(0, 100)}`;
        const prev = map.get(key);
        if (!prev) {
          map.set(key, c);
        } else if ((c.replies?.length || 0) > (prev.replies?.length || 0)) {
          map.set(key, c);
        }
      }
      return map.size;
    } catch (e) {
      console.warn("collectInto failed", e);
      return map.size;
    }
  }

  function findReplyExpandControls(scope) {
    const root = scope || document.querySelector("#comments") || document;
    const out = [];
    const sel = [
      // 仅「加载更多回复」相关，绝不含点赞/点踩
      "ytd-comment-replies-renderer #more-replies",
      "ytd-comment-replies-renderer ytd-button-renderer#more-replies",
      "ytd-comment-replies-renderer tp-yt-paper-button#more-replies",
      "ytd-comment-replies-renderer ytd-continuation-item-renderer",
      "#replies #more-replies",
      "#replies ytd-continuation-item-renderer",
      "ytd-comment-thread-renderer #more-replies",
    ];
    for (const s of sel) {
      root.querySelectorAll(s).forEach((el) => out.push(el));
    }

    // 仅文案明确是「展开/查看全部回复」的控件
    const textSel =
      "button, tp-yt-paper-button, ytd-button-renderer, yt-button-shape, ytd-continuation-item-renderer, #more-replies";
    root.querySelectorAll(textSel).forEach((el) => {
      const label = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.id || ""}`;
      if (/查看全部\s*\d*\s*条回复|show more replies|show \d+ more replies|更多回复|展开.*回复|more.?replies/i.test(label)) {
        // 排除赞/踩
        if (/点赞|点踩|dislike|like|unlike|不喜欢|喜欢/i.test(label) && !/回复|replies/i.test(label)) {
          return;
        }
        out.push(el);
      }
    });
    return out;
  }

  function clickTargetFrom(el) {
    if (!el) return null;
    if (el.tagName === "BUTTON" || el.tagName === "TP-YT-PAPER-BUTTON") return el;
    // 不要 generic closest button，以免点到父级上的赞/踩
    const inner = el.querySelector?.(
      "button, tp-yt-paper-button, yt-button-shape button, ytd-button-renderer button"
    );
    if (inner) return inner;
    if (el.tagName === "YTD-CONTINUATION-ITEM-RENDERER") {
      return el.querySelector("button, #button, yt-button-shape button") || el;
    }
    return null;
  }

  /** 展开各主题下折叠的楼中楼（在一级评论加载完、回到顶部后调用） */
  async function expandCollapsedReplies(maxClicks = 60) {
    const root = document.querySelector("#comments") || document;
    const clickedEls = new WeakSet();
    let clicked = 0;

    for (let pass = 0; pass < 3 && clicked < maxClicks; pass++) {
      const controls = findReplyExpandControls(root);
      let passClicks = 0;

      for (const raw of controls) {
        if (clicked >= maxClicks) break;
        if (clickedEls.has(raw)) continue;

        const target = clickTargetFrom(raw);
        if (!target || !target.isConnected) continue;
        if (clickedEls.has(target)) continue;

        const label = `${target.textContent || ""} ${target.getAttribute("aria-label") || ""} ${raw.textContent || ""} ${target.id || ""}`;
        if (/收起|show less|收起回复/i.test(label)) continue;
        // 硬排除赞/踩
        if (/点赞|点踩|不喜欢|喜欢|dislike|unlike|(^|\s)like(\s|$)/i.test(label)) continue;
        // 只允许明确的「加载更多回复」
        if (!/查看全部|show more|更多回复|展开.*回复|more.?replies|加载更多/i.test(label) &&
            raw.tagName !== "YTD-CONTINUATION-ITEM-RENDERER" &&
            !/more-replies/i.test(`${raw.id || ""} ${raw.className || ""}`)) {
          continue;
        }
        // 只在回复区内
        const inReplies =
          raw.closest?.("ytd-comment-replies-renderer, #replies") ||
          target.closest?.("ytd-comment-replies-renderer, #replies");
        if (!inReplies && raw.tagName !== "YTD-CONTINUATION-ITEM-RENDERER") {
          const moreId = `${raw.id || ""} ${target.id || ""}`;
          if (!/more-replies/i.test(moreId)) continue;
        }

        try {
          target.scrollIntoView({ block: "center" });
          target.click();
          clickedEls.add(raw);
          clickedEls.add(target);
          clicked++;
          passClicks++;
          await sleep(300);
        } catch (_) {
          /* ignore */
        }
      }

      // 没有新点击就结束，不再滚回第一条重复展开
      if (passClicks === 0) break;
      await sleep(200);
    }
    return clicked;
  }

  /** 从评论区末尾滚回第一条评论 */
  async function scrollToFirstComment() {
    const threads = findCommentThreads();
    const first = threads[0] || document.querySelector("#comments ytd-comment-thread-renderer");
    if (first) {
      try {
        first.scrollIntoView({ block: "start", behavior: "instant" });
      } catch (_) {
        first.scrollIntoView({ block: "start" });
      }
      await sleep(300);
      return true;
    }
    const header = document.querySelector("#comments, ytd-comments#comments");
    header?.scrollIntoView({ block: "start" });
    await sleep(300);
    return false;
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** 仅评论区里「可见且未完成」的 continuation */
  function hasPendingContinuation() {
    const scope = document.querySelector("#comments") || document;
    const items = scope.querySelectorAll("ytd-continuation-item-renderer");
    for (const item of items) {
      if (!isVisible(item)) continue;
      const loading =
        item.hasAttribute("loading") ||
        !!item.querySelector("tp-yt-paper-spinner-lite, ytd-horizontal-list-renderer tp-yt-paper-spinner-lite");
      const btn = item.querySelector(
        "button, yt-button-shape, #button, ytd-button-renderer"
      );
      // 有可点按钮或正在 loading 才算还有下一页
      if (loading || (btn && isVisible(btn))) return true;
    }
    return false;
  }

  function isLoadingComments() {
    const scope = document.querySelector("#comments") || document;
    return !!scope.querySelector(
      "ytd-comments-header-renderer tp-yt-paper-spinner-lite, " +
        "ytd-comments #spinner tp-yt-paper-spinner-lite, " +
        "tp-yt-paper-spinner-lite"
    );
  }

  async function loadTopComments(limit = 100, pageWorld) {
    const collected = new Map();
    let seeded = 0;
    let domBefore = 0;
    let err = null;
    // 硬截止 28s，保证一定能返回，避免外层 timeout 变成 0 条
    const hardDeadline = Date.now() + 28000;

    try {
      seeded = seedCommentsFromInitialData(collected, pageWorld);

      const commentsHeader = document.querySelector(
        "#comments, ytd-comments#comments, ytd-comments"
      );

      const phase1Deadline = Date.now() + 14000;
      if (Date.now() < hardDeadline) {
        if (commentsHeader) {
          commentsHeader.scrollIntoView({ block: "start" });
          await sleep(400);
        } else {
          window.scrollBy(0, 800);
          await sleep(300);
        }

        for (let i = 0; i < 15 && Date.now() < phase1Deadline && Date.now() < hardDeadline; i++) {
          if (findCommentThreads().length > 0) break;
          window.scrollBy(0, 400);
          await sleep(250);
        }

        domBefore = findCommentThreads().length;
        collectInto(collected);
      }

      // 下滑加载一级评论
      let stagnant = 0;
      while (Date.now() < phase1Deadline && Date.now() < hardDeadline && collected.size < limit) {
        collectInto(collected);
        const threads = findCommentThreads();
        const lastThread = threads[threads.length - 1];
        if (lastThread) {
          try {
            lastThread.scrollIntoView({ block: "end" });
          } catch (_) {
            /* ignore */
          }
        }
        window.scrollBy(0, 420);
        await sleep(320);

        const before = collected.size;
        collectInto(collected);
        if (collected.size > before) {
          stagnant = 0;
          continue;
        }
        stagnant++;
        if (stagnant >= 3) break;
      }

      if (Date.now() < hardDeadline) {
        await scrollToFirstComment();
        try {
          await expandCollapsedReplies(40);
          collectInto(collected);
        } catch (_) {
          /* ignore */
        }
      }
    } catch (e) {
      err = String(e && e.message ? e.message : e);
    }

    if (collected.size === 0) {
      seedCommentsFromInitialData(collected, pageWorld);
    }

    return {
      comments: [...collected.values()].slice(0, limit),
      method: "bridge+dom-scroll",
      seeded,
      domBefore,
      withReplies: [...collected.values()].filter((c) => c.replies?.length).length,
      error: err,
    };
  }

  /** 使用 background 注入 MAIN world 得到的精简数据（已过滤过期 videoId） */
  function selectLivePage(pageWorld, currentVideoId) {
    const pw = pageWorld || {};
    const playerVideoId = pw.playerVideoId || pw.player?.videoDetails?.videoId || null;
    if (currentVideoId && playerVideoId && playerVideoId !== currentVideoId) {
      return { player: null, micro: null, stale: true, playerVideoId };
    }
    return {
      player: pw.player || null,
      micro: pw.micro || null,
      stale: !pw.player,
      playerVideoId,
    };
  }

  /** 从简介区「次观看 / 发布日」文案解析 */
  function parseViewsAndDateFromDom() {
    const blobs = [];
    const pushText = (el) => {
      if (!el) return;
      const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length <= 400) blobs.push(t);
    };

    // 整块信息区 + 简介头 + 简介全文
    [
      "#info",
      "ytd-watch-info-text",
      "ytd-watch-info-text #info",
      "#description-inline-expander",
      "ytd-text-inline-expander#description-inline-expander",
      "ytd-video-description-header-renderer",
      "ytd-watch-metadata #info",
      "#description",
    ].forEach((sel) => {
      document.querySelectorAll(sel).forEach(pushText);
    });

    let views = null;
    let published = "";

    for (const t of blobs) {
      if (views == null) {
        const m =
          t.match(/([\d][\d,.]*)\s*(万|亿)?\s*(次观看|views?)/i) ||
          t.match(/(次观看|views?)\s*([\d][\d,.]*)\s*(万|亿)?/i);
        if (m) {
          const numRaw = m[1] && /[\d]/.test(m[1]) ? m[1] : m[2];
          const unit = m[0].includes("万") ? "万" : m[0].includes("亿") ? "亿" : "";
          let n = Number(String(numRaw).replace(/,/g, ""));
          if (unit === "万") n = Math.round(n * 10000);
          if (unit === "亿") n = Math.round(n * 100000000);
          if (Number.isFinite(n) && n > 0) views = n;
        }
      }
      if (!published) {
        const cn = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
        if (cn) {
          published = `${cn[1]}-${String(cn[2]).padStart(2, "0")}-${String(cn[3]).padStart(2, "0")}`;
        } else {
          const iso = t.match(/(\d{4}-\d{2}-\d{2})/);
          if (iso) published = iso[1];
          else {
            const en = t.match(
              /([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})/
            );
            if (en) published = en[1];
          }
        }
      }
    }

    // 再从正文简介里的日期补一次
    if (!published) {
      const desc = (document.querySelector("#description-inline-expander, #description")?.innerText || "");
      const cn = desc.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
      if (cn) {
        published = `${cn[1]}-${String(cn[2]).padStart(2, "0")}-${String(cn[3]).padStart(2, "0")}`;
      }
    }

    return { views, published };
  }

  function parseDurationFromDom() {
    const el = document.querySelector(
      ".ytp-time-duration, ytd-player .ytp-time-duration, span.ytp-time-duration"
    );
    const t = (el?.textContent || "").trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return t;
    return "";
  }

  function parseChannelIdFromDom(pageWorld) {
    // 1) 经典 /channel/UC...
    const a1 = document.querySelector(
      '#channel-name a[href*="/channel/"], #owner a[href*="/channel/"], ytd-channel-name a[href*="/channel/"], #avatar-section a[href*="/channel/"]'
    );
    const href1 = a1?.getAttribute("href") || "";
    const m1 = href1.match(/\/channel\/(UC[\w-]+)/);
    if (m1) return m1[1];

    // 2) 页内 JSON
    const cid =
      pageWorld?.player?.videoDetails?.channelId || pageWorld?.micro?.externalChannelId || "";
    if (cid) return cid;

    // 3) @handle
    const handleA = document.querySelector(
      '#channel-name a[href^="/@"], #owner a[href^="/@"], ytd-channel-name a[href^="/@"]'
    );
    const href2 = handleA?.getAttribute("href") || "";
    const m2 = href2.match(/\/@([\w.-]+)/);
    return m2 ? `@${m2[1]}` : "";
  }

  function extractBasicInfo(pageWorld) {
    const videoId = getVideoId();
    const live = selectLivePage(pageWorld, videoId);

    // 2) 仅当 live 不可用且 HTML 里的 ID 匹配时才用 HTML 解析
    let player = live.player;
    let data = parseJsonFromPage("ytInitialData");
    if (!player) {
      const htmlPlayer = parseJsonFromPage("ytInitialPlayerResponse");
      const htmlId = htmlPlayer?.videoDetails?.videoId;
      if (!videoId || !htmlId || htmlId === videoId) {
        player = htmlPlayer;
      }
    }

    const details = player?.videoDetails || {};
    const micro = live.micro || player?.microformat?.playerMicroformatRenderer || {};

    // DOM 兜底（SPA 切页后 DOM 是当前视频）
    const domTitle =
      document.querySelector(
        "h1.ytd-watch-metadata yt-formatted-string, h1 yt-formatted-string, #title h1, ytd-watch-metadata h1"
      )?.textContent?.trim() || document.title.replace(/ - YouTube$/, "");
    const domChannel =
      document.querySelector(
        "ytd-channel-name #text a, #channel-name #text a, ytd-watch-metadata #channel-name a, #owner #channel-name a"
      )?.textContent?.trim() || "";
    const domInfo = parseViewsAndDateFromDom();
    const domDuration = parseDurationFromDom();
    const domChannelId = parseChannelIdFromDom(pageWorld);

    // 封面：优先按「当前 URL 的 videoId」拼官方图
    let bestThumb = null;
    if (videoId) {
      bestThumb = {
        url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        width: 1280,
        height: 720,
      };
    }
    const thumbs = details.thumbnail?.thumbnails || micro.thumbnail?.thumbnails || [];
    const fromJson = pickBestThumb(thumbs);
    if (fromJson && videoId && fromJson.url.includes(videoId)) {
      bestThumb = fromJson;
    }

    // 描述：当前页 DOM 优先
    let description = "";
    const descEl = document.querySelector(
      "ytd-text-inline-expander#description-inline-expander, #description-inline-expander, ytd-watch-metadata #description"
    );
    const moreBtn = document.querySelector(
      "#description-inline-expander tp-yt-paper-button#expand, #expand"
    );
    if (moreBtn) {
      try {
        moreBtn.click();
      } catch (_) {
        /* ignore */
      }
    }
    description = (descEl?.innerText || descEl?.textContent || "").trim();
    if (!description) description = details.shortDescription || "";

    let keywords = details.keywords || micro.keywords || [];
    if (!Array.isArray(keywords)) keywords = [];
    if (live.stale && !details.keywords) keywords = [];

    // 时长 / 播放量 / 发布日期：JSON 缺失时用 DOM
    const lengthSeconds = Number(details.lengthSeconds || micro.lengthSeconds || 0);
    const durationText =
      lengthSeconds > 0 ? formatSeconds(lengthSeconds) : domDuration || "";

    const viewCount =
      details.viewCount != null && Number(details.viewCount) > 0
        ? Number(details.viewCount)
        : domInfo.views;

    const publishDate = micro.publishDate || micro.uploadDate || domInfo.published || "";
    const uploadDate = micro.uploadDate || micro.publishDate || domInfo.published || "";

    // 简介正文里也有日期/观看数，再兜一层
    let pubFinal = publishDate;
    if (!pubFinal && description) {
      const cn = description.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
      if (cn) {
        pubFinal = `${cn[1]}-${String(cn[2]).padStart(2, "0")}-${String(cn[3]).padStart(2, "0")}`;
      }
    }
    let viewFinal = viewCount;
    if ((viewFinal == null || viewFinal === 0) && description) {
      const m = description.match(/([\d][\d,.]*)\s*(万|亿)?\s*(次观看|views?)/i);
      if (m) {
        let n = Number(String(m[1]).replace(/,/g, ""));
        if (m[2] === "万") n = Math.round(n * 10000);
        if (m[2] === "亿") n = Math.round(n * 100000000);
        if (Number.isFinite(n) && n > 0) viewFinal = n;
      }
    }

    const fromPlayer = parseChaptersFromPlayer(player) || [];
    const fromDesc = parseChaptersFromDescription(description) || [];
    const fromDom = parseChaptersFromDom() || [];
    const primary = fromPlayer.length ? fromPlayer : fromDesc;
    const chapters = mergeChapters(primary, fromDom, videoId);

    const hashtags = extractHashtags(description);

    return {
      videoId,
      url: normalizeUrl(videoId),
      title: domTitle || details.title || "",
      channel: domChannel || details.author || micro.ownerChannelName || "",
      channelId:
        details.channelId || micro.externalChannelId || domChannelId || "",
      views: viewFinal,
      viewsText: viewFinal != null ? formatViews(viewFinal) : "",
      published: pubFinal,
      uploadDate: uploadDate || pubFinal,
      durationSeconds: lengthSeconds,
      durationText,
      category: micro.category || "",
      isLive: !!(details.isLiveContent || details.isLive),
      description,
      keywords,
      hashtags,
      thumbnail: bestThumb,
      chapters,
      _player: player,
      _data: data,
    };
  }

  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      promise,
      new Promise((resolve) =>
        setTimeout(() => resolve(fallback), ms)
      ),
    ]);
  }

  async function extractAll(options = {}) {
    const commentLimit = Number(options.commentLimit || 100);
    const wantTranscript = options.transcript !== false;
    const wantComments = options.comments !== false;
    const wantChapterThumbs = options.chapterThumbs !== false;

    // 先取主世界数据（CSP 安全通道）
    const pageWorld = await requestPageWorld();
    const basic = extractBasicInfo(pageWorld);

    // 转文字（最多 12s）
    let transcript = { text: "", segments: [], method: "none" };
    if (wantTranscript) {
      try {
        transcript = await withTimeout(
          extractTranscript(),
          12000,
          { text: "", segments: [], method: "timeout" }
        );
      } catch (err) {
        transcript = { text: "", segments: [], method: "error", error: String(err) };
      }
    }

    // 评论（最多 35s：先加载完再展开回复）
    let commentResult = { comments: [], method: "none" };
    if (wantComments) {
      try {
        commentResult = await withTimeout(
          loadTopComments(commentLimit, pageWorld),
          35000,
          { comments: [], method: "timeout" }
        );
      } catch (err) {
        commentResult = { comments: [], method: "error", error: String(err) };
      }
    }

    // 章节缩略图：若 DOM 里没有独立图，保留 URL 供 background 下载封面
    let chapters = basic.chapters || [];
    if (!wantChapterThumbs) {
      chapters = chapters.map((c) => ({ ...c, thumbnailUrl: null }));
    }

    const { _player, _data, ...clean } = basic;

    return {
      ...clean,
      chapters,
      transcript,
      comments: commentResult.comments,
      commentMeta: {
        count: commentResult.comments.length,
        method: commentResult.method,
        limit: commentLimit,
        seeded: commentResult.seeded ?? null,
        domBefore: commentResult.domBefore ?? null,
        error: commentResult.error || null,
      },
      transcriptMeta: {
        count: transcript.segments.length,
        method: transcript.method,
        error: transcript.error || null,
      },
      extractedAt: new Date().toISOString(),
    };
  }

  // 消息通道
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "PING") {
      sendResponse({ ok: true, pong: true });
      return;
    }
    if (msg.type !== "YT_EXTRACT") return;
    const options = msg.payload || {};
    extractAll(options)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
      );
    return true; // async
  });

  // 供调试
  window.__ytObsidianExtract = extractAll;
})();
