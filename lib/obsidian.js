/** Obsidian Local REST API 客户端
 * 文档：https://github.com/coddingtonbear/obsidian-local-rest-api
 * 默认 HTTP: http://127.0.0.1:27123  HTTPS: https://127.0.0.1:27124
 */

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function encodeVaultPath(path) {
  // 每段单独 encode，保留 /
  return String(path || "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

async function request(base, apiKey, method, path, { headers = {}, body = null, raw = false } = {}) {
  const url = `${normalizeBase(base)}${path.startsWith("/") ? path : "/" + path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...headers,
    },
  };
  if (body != null) init.body = body;

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(
      `无法连接 Obsidian Local REST API（${url}）：${err.message}\n` +
        `请确认 Obsidian 已启动并启用 Local REST API 插件。` +
        `若使用 HTTPS 自签证书失败，请在设置里改用 HTTP（默认 http://127.0.0.1:27123）。`
    );
  }

  if (raw) return res;

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.message || j.error || text;
    } catch (_) {
      /* ignore */
    }
    throw new Error(`Obsidian API ${res.status}：${detail}`);
  }

  try {
    return text ? JSON.parse(text) : { ok: true };
  } catch (_) {
    return { ok: true, text };
  }
}

export function createObsidianClient({ baseUrl, apiKey }) {
  const base = normalizeBase(baseUrl);
  const key = apiKey || "";

  return {
    baseUrl: base,

    async status() {
      return request(base, key, "GET", "/");
    },

    async list(path = "") {
      const p = path ? `/vault/${encodeVaultPath(path)}/` : "/vault/";
      return request(base, key, "GET", p);
    },

    async exists(path) {
      const res = await request(base, key, "GET", `/vault/${encodeVaultPath(path)}`, {
        raw: true,
      });
      return res.ok;
    },

    /** 写入/覆盖 Markdown 或二进制 */
    async putFile(path, content, contentType = "text/markdown") {
      return request(base, key, "PUT", `/vault/${encodeVaultPath(path)}`, {
        headers: { "Content-Type": contentType },
        body: content,
      });
    },

    async putMarkdown(path, markdown) {
      return this.putFile(path, markdown, "text/markdown");
    },

    async putBinary(path, arrayBuffer, contentType) {
      return this.putFile(path, arrayBuffer, contentType || "application/octet-stream");
    },

    /** 将远程图片下载后写入 vault */
    async putImageFromUrl(vaultPath, imageUrl) {
      let res;
      try {
        res = await fetch(imageUrl);
      } catch (err) {
        throw new Error(`下载图片失败 ${imageUrl}：${err.message}`);
      }
      if (!res.ok) throw new Error(`下载图片 HTTP ${res.status}：${imageUrl}`);
      const buf = await res.arrayBuffer();
      const type =
        res.headers.get("content-type") ||
        (vaultPath.endsWith(".png")
          ? "image/png"
          : vaultPath.endsWith(".webp")
            ? "image/webp"
            : "image/jpeg");
      await this.putBinary(vaultPath, buf, type);
      return { vaultPath, bytes: buf.byteLength, contentType: type };
    },

    /** 追加文本到笔记某标题下（可选） */
    async appendUnderHeading(path, heading, content) {
      return request(
        base,
        key,
        "PATCH",
        `/vault/${encodeVaultPath(path)}`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType: "heading",
            target: [heading],
            operation: "append",
            content,
          }),
        }
      );
    },
  };
}
