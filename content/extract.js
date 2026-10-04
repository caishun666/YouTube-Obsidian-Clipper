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

  function deepFindAll(obj, key, maxDepth = 14) {
    const out = [];
    const seen = new Set();
    const stack = [{ o: obj, d: 0 }];
    while (stack.length) {
      const { o, d } = stack.pop();
      if (!o || typeof o !== "object" || d > maxDepth) continue;
      if (seen.has(o)) continue;
      seen.add(o);
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
        const thumbs =
          item.thumbnail?.thumbnails ||
          item.thumbnails ||
          deepFind(item, "thumbnails");
        if (Array.isArray(thumbs) && thumbs.length) {
          thumb = thumbs[thumbs.length - 1].url;
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

  function parseChaptersFromDom() {
    const nodes = document.querySelectorAll(
      "ytd-macro-markers-list-item-renderer, ytd-chapter-renderer"
    );
    const chapters = [];
    nodes.forEach((node) => {
      const titleEl =
        node.querySelector("#details h4, #details #video-title, h4, [title]") ||
        node;
      const timeEl = node.querySelector("#time, .ytd-macro-markers-list-item-renderer #time");
      const title = (titleEl.getAttribute("title") || titleEl.textContent || "").trim();
      const timeText = (timeEl?.textContent || "").trim();
      const seconds = parseTimestampToSeconds(timeText);
      const img = node.querySelector("img");
      const thumb =
        img?.src ||
        img?.getAttribute("src") ||
        (img?.style?.backgroundImage || "").replace(/^url\(["']?/, "").replace(/["']?\)$/, "") ||
        null;
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

  /** 主世界桥：content script 读不到 window.ytInitialData，用临时 script + DOM 传出来 */
  function extractCommentsViaPageBridge() {
    const bridgeId = "__ytObsidianCommentBridge";
    document.getElementById(bridgeId)?.remove();

    const el = document.createElement("pre");
    el.id = bridgeId;
    el.hidden = true;
    el.style.display = "none";
    document.documentElement.appendChild(el);

    const s = document.createElement("script");
    s.textContent = `
      (function () {
        function text(v) {
          if (v == null) return "";
          if (typeof v === "string") return v;
          if (v.simpleText) return String(v.simpleText);
          if (v.content) return String(v.content);
          if (Array.isArray(v.runs)) return v.runs.map(function (x) { return x.text || ""; }).join("");
          return "";
        }
        function pickAuthor(o) {
          return text(o.authorText) || text(o.author) ||
            (o.author && (o.author.displayName || o.author.name || o.author.text)) || "";
        }
        function pickContent(o) {
          return text(o.contentText) || text(o.content) ||
            (o.content && (o.content.content || o.content.text)) || "";
        }
        var acc = [];
        function walk(o, depth) {
          if (!o || typeof o !== "object" || depth > 16) return;
          if (Array.isArray(o)) {
            for (var i = 0; i < o.length; i++) walk(o[i], depth + 1);
            return;
          }
          try {
            if (o.commentThreadRenderer) {
              var th = o.commentThreadRenderer;
              var cr = (th.comment && (th.comment.commentRenderer || th.comment.commentViewModel)) || null;
              if (cr) {
                acc.push({
                  author: pickAuthor(cr),
                  content: pickContent(cr),
                  published: text(cr.publishedTimeText) || text(cr.publishedTime),
                  likes: text(cr.voteCount) || text(cr.voteCountIfNotZero) || "",
                  replyCount: 0
                });
              }
            } else if (o.commentRenderer) {
              acc.push({
                author: pickAuthor(o.commentRenderer),
                content: pickContent(o.commentRenderer),
                published: text(o.commentRenderer.publishedTimeText) || "",
                likes: text(o.commentRenderer.voteCount) || "",
                replyCount: 0
              });
            } else if (o.commentViewModel || o.commentEntityPayload) {
              var vm = o.commentViewModel || o.commentEntityPayload;
              acc.push({
                author: pickAuthor(vm),
                content: pickContent(vm),
                published: text(vm.publishedTimeText) || text(vm.publishedTime) || "",
                likes: text(vm.voteCount) || "",
                replyCount: 0
              });
            }
          } catch (e) {}
          for (var k in o) {
            if (Object.prototype.hasOwnProperty.call(o, k)) walk(o[k], depth + 1);
          }
        }
        walk(window.ytInitialData, 0);
        walk(window.ytInitialPlayerResponse, 0);
        var el = document.getElementById("__ytObsidianCommentBridge");
        if (el) el.textContent = JSON.stringify(acc);
      })();
    `;
    document.documentElement.appendChild(s);
    s.remove();

    let out = [];
    try {
      out = JSON.parse(el.textContent || "[]");
    } catch (_) {
      out = [];
    }
    el.remove();
    return Array.isArray(out) ? out : [];
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

  function seedCommentsFromInitialData(map) {
    let count = 0;
    try {
      // 1) 主世界桥（最可靠）
      const bridged = extractCommentsViaPageBridge();
      for (const c of bridged) {
        const content = cleanCommentText(c.content);
        const author = c.author || "";
        if (!content && !author) continue;
        const key = `${author}|${content.slice(0, 100)}`;
        if (!map.has(key)) {
          map.set(key, { ...c, content, author, replies: [] });
          count++;
        }
      }
    } catch (_) {
      /* ignore */
    }

    try {
      // 2) 解析 HTML 内嵌 JSON
      const data = parseJsonFromPage("ytInitialData");
      for (const c of extractCommentsFromInitialData(data)) {
        const content = cleanCommentText(c.content);
        const author = c.author || "";
        if (!content && !author) continue;
        const key = `${author}|${content.slice(0, 100)}`;
        if (!map.has(key)) {
          map.set(key, { ...c, content, author, replies: c.replies || [] });
          count++;
        }
      }
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
    // ytd-continuation-item-renderer 本身可点
    if (el.tagName === "YTD-CONTINUATION-ITEM-RENDERER") {
      return el.querySelector("button, #button, yt-button-shape button") || el;
    }
    return null;
  }

  function clickTargetFrom(el) {
    if (!el) return null;
    if (el.tagName === "BUTTON" || el.tagName === "TP-YT-PAPER-BUTTON") return el;
    return (
      el.querySelector?.("button, tp-yt-paper-button, yt-button-shape button") ||
      (el.closest?.("button, tp-yt-paper-button") ?? null) ||
      el
    );
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

  async function loadTopComments(limit = 100) {
    const collected = new Map();
    let seeded = 0;
    let domBefore = 0;
    let err = null;

    try {
      // 无论评论区 DOM 是否就绪，都先从页内数据取一批
      seeded = seedCommentsFromInitialData(collected);

      const commentsHeader = document.querySelector(
        "#comments, ytd-comments#comments, ytd-comments, ytd-item-section-renderer #contents"
      );

      // 阶段1：向下滚加载完所有一级评论（先不展开回复）
      // 阶段2：回到第一条评论
      // 阶段3：再展开折叠的楼中楼并采集
      const phase1Deadline = Date.now() + 18000;

      if (commentsHeader) {
        commentsHeader.scrollIntoView({ block: "start" });
        await sleep(500);
      } else {
        // 评论区节点可能在简介下方，往下滚找一找
        window.scrollBy(0, 900);
        await sleep(400);
      }

      for (let i = 0; i < 25 && Date.now() < phase1Deadline; i++) {
        if (findCommentThreads().length > 0) break;
        (commentsHeader || document.body).scrollIntoView?.({ block: "start" });
        window.scrollBy(0, 400);
        await sleep(300);
      }

      domBefore = findCommentThreads().length;

      // 确保按热度排序（Top）
      try {
        const sortMenu = document.querySelector(
          "ytd-comments-header-renderer #sort-menu, ytd-comments-header-renderer ytd-sort-filter-submenu-renderer"
        );
        const menuText = (sortMenu?.textContent || "").toLowerCase();
        if (sortMenu && /(newest|最新)/i.test(menuText) && !/热门|top/i.test(menuText)) {
          sortMenu.click();
          await sleep(250);
          const topOption = [
            ...document.querySelectorAll(
              "ytd-comments-header-renderer tp-yt-paper-item, ytd-menu-service-item-renderer, tp-yt-paper-listbox tp-yt-paper-item"
            ),
          ].find((el) => /热门|top |热度|top comments/i.test(el.textContent || ""));
          if (topOption) {
            topOption.click();
            await sleep(500);
          }
        }
      } catch (_) {
        /* ignore */
      }

      let stagnant = 0;

      while (Date.now() < phase1Deadline) {
        collectInto(collected);

        const threads = findCommentThreads();
        const lastThread = threads[threads.length - 1];
        if (lastThread) {
          try {
            lastThread.scrollIntoView({ block: "end", behavior: "instant" });
          } catch (_) {
            lastThread.scrollIntoView({ block: "end" });
          }
        }
        window.scrollBy(0, 480);

        const pending = hasPendingContinuation();
        await sleep(pending ? 550 : 320);

        const before = collected.size;
        collectInto(collected);

        if (collected.size > before) {
          stagnant = 0;
          continue;
        }

        stagnant++;
        if (isLoadingComments() && stagnant < 6) {
          await sleep(450);
          collectInto(collected);
          if (collected.size > before) {
            stagnant = 0;
            continue;
          }
        }

        if (pending && stagnant === 2) {
          try {
            const btn = (document.querySelector("#comments") || document).querySelector(
              "ytd-continuation-item-renderer button, ytd-continuation-item-renderer #button"
            );
            if (btn && isVisible(btn)) {
              btn.click();
              await sleep(650);
              collectInto(collected);
              if (collected.size > before) {
                stagnant = 0;
                continue;
              }
            }
          } catch (_) {
            /* ignore */
          }
        }

        if (stagnant >= 4) break;
      }

      // 阶段2/3：回到顶部并展开楼中楼
      await scrollToFirstComment();
      try {
        await expandCollapsedReplies(60);
        collectInto(collected);
      } catch (_) {
        /* ignore */
      }
    } catch (e) {
      err = String(e && e.message ? e.message : e);
    }

    // 最后再垫一次，保证不是 0
    if (collected.size === 0) {
      seedCommentsFromInitialData(collected);
    }

    const withReplies = [...collected.values()].filter((c) => c.replies?.length).length;

    return {
      comments: [...collected.values()].slice(0, limit),
      method: "bridge+dom-scroll",
      seeded,
      domBefore,
      withReplies,
      error: err,
    };
  }

  function extractBasicInfo() {
    const player = parseJsonFromPage("ytInitialPlayerResponse");
    const data = parseJsonFromPage("ytInitialData");
    const videoId = getVideoId();
    const details = player?.videoDetails || {};
    const micro =
      player?.microformat?.playerMicroformatRenderer ||
      deepFind(player || {}, "playerMicroformatRenderer") ||
      {};

    // DOM 兜底
    const domTitle =
      document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1 yt-formatted-string, #title h1")
        ?.textContent?.trim() || document.title.replace(/ - YouTube$/, "");
    const domChannel =
      document.querySelector(
        "ytd-channel-name #text a, #channel-name #text a, ytd-watch-metadata #channel-name a, #owner #channel-name a"
      )?.textContent?.trim() || "";
    const domViews =
      document.querySelector(
        "ytd-watch-info-text #info span, #info #view-count #count, ytd-watch-metadata #info span"
      )?.textContent?.trim() || "";

    const thumbs = details.thumbnail?.thumbnails || micro.thumbnail?.thumbnails || [];
    const bestThumb = pickBestThumb(thumbs);

    // 描述：优先 shortDescription，再从 DOM / ytInitialData 展开后的 description
    let description = details.shortDescription || "";
    if (!description) {
      const descEl = document.querySelector(
        "ytd-text-inline-expander#description-inline-expander, #description-inline-expander, ytd-watch-metadata #description"
      );
      // 尝试点开“显示更多”
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
    }

    // 标签
    let keywords = details.keywords || micro.keywords || [];
    if (!Array.isArray(keywords)) keywords = [];

    // 时长
    const lengthSeconds = Number(details.lengthSeconds || micro.lengthSeconds || 0);

    // 发布日期
    const publishDate = micro.publishDate || micro.uploadDate || "";
    const uploadDate = micro.uploadDate || micro.publishDate || "";

    // 播放量
    const viewCount = details.viewCount != null ? Number(details.viewCount) : null;

    // 章节
    let chapters = parseChaptersFromPlayer(player) || [];
    if (!chapters.length) chapters = parseChaptersFromDescription(description);
    if (!chapters.length) chapters = parseChaptersFromDom();
    // 补章节缩略图：没有则用视频封面/时间戳链接
    chapters = chapters.map((c, idx) => {
      let thumb = c.thumbnailUrl;
      if (!thumb && videoId) {
        // YouTube 官方封面，不保证章节时间点
        thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      }
      return {
        ...c,
        thumbnailUrl: thumb,
        url: normalizeUrl(videoId) + `&t=${c.seconds}s`,
        index: idx + 1,
      };
    });

    // 简介中的标签
    const hashtags = extractHashtags(description);

    return {
      videoId,
      url: normalizeUrl(videoId),
      title: details.title || domTitle || "",
      channel: details.author || micro.ownerChannelName || domChannel || "",
      channelId:
        details.channelId ||
        micro.externalChannelId ||
        micro.ownerProfileId ||
        "",
      views: viewCount,
      viewsText: viewCount != null ? formatViews(viewCount) : (domViews || ""),
      published: publishDate,
      uploadDate,
      durationSeconds: lengthSeconds,
      durationText: formatSeconds(lengthSeconds),
      category: micro.category || "",
      isLive: !!(details.isLiveContent || details.isLive),
      isFamilySafe: micro.isFamilySafe,
      description,
      keywords,
      hashtags,
      thumbnail: bestThumb,
      chapters,
      // 供后续抓取使用
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

    const basic = extractBasicInfo();

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
          loadTopComments(commentLimit),
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
