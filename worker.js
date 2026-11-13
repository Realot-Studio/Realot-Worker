/**
 * Realot feedback proxy: a small Cloudflare Worker that sits between the hub
 * (a public website) and the feedback server.
 *
 * WHY IT EXISTS
 * The feedback server needs a permanent API key. Anything inside a website's
 * files can be read by every visitor, so the key must never be put in the hub.
 * It lives here instead, as a Worker secret (FEEDBACK_API_KEY), and the hub only
 * ever talks to this Worker.
 *
 *   GET  /announcements   the developer's announcements (cached for 60 s)
 *   POST /feedback        a bug report / idea, with an optional image OR short video
 *   GET  /health          {"ok":true}
 *   /api/v1/*             the Android build service (APK export): the editor talks to
 *                         this Worker, which adds the permanent service key (APK_API_KEY)
 *                         and passes the request on. Only the calls the editor needs are allowed.
 *
 * The Worker checks everything again on the server side (types, sizes, real
 * file contents), so a modified browser cannot push unexpected files through.
 */

const MAX_MESSAGE = 10000;                    // characters, the feedback server's limit
const IMAGE_MAX = 10 * 1024 * 1024;           // 10 MB
const VIDEO_MAX = 25 * 1024 * 1024;           // 25 MB
const REQUEST_MAX = VIDEO_MAX + 512 * 1024;   // biggest body we will even look at
const CATEGORIES = new Set(["bug", "improvement", "engine_feature"]);
const EPOCH = "1970-01-01T00:00:00.000Z";

const APK_UPLOAD_MAX = 100 * 1024 * 1024;      // Cloudflare's own limit on free/pro plans

// Best-effort spam brakes. Each Worker instance keeps its own counters, so for a
// hard limit also add Cloudflare rate-limiting rules (see README.md).
//   feedback: 5 reports per IP per 10 minutes     APK builds: 6 per IP per hour
const hits = new Map();

function rateLimited(bucket, ip, max, windowMs) {
  const key = bucket + "|" + ip;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { hits.set(key, recent); return true; }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) { for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k); }
  return false;
}

/** What the file really is, judged by its first bytes (never by its name or declared type). */
function sniff(b) {
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return { type: "image/jpeg", kind: "image" };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { type: "image/png", kind: "image" };
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { type: "image/gif", kind: "image" };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { type: "image/webp", kind: "image" };
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return { type: "video/mp4", kind: "video" };
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return { type: "video/webm", kind: "video" };
  return null;
}

function corsFor(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origin && allowed.length && !allowed.includes(origin)) return null; // browser from a site we don't know
  return {
    "Access-Control-Allow-Origin": allowed.length && origin ? origin : "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, Accept",
    "Access-Control-Expose-Headers": "Content-Disposition, Content-Length, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function reply(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, cors || {}),
  });
}

const apiBase = (env) => String(env.FEEDBACK_API_BASE || "").replace(/\/+$/, "");
const authHeader = (env) => ({ Authorization: "Bearer " + env.FEEDBACK_API_KEY });

/** Plain text only, with a length limit (the hub shows these as text, never as HTML). */
function clean(value, max) {
  return String(value == null ? "" : value).replace(/\u0000/g, "").slice(0, max);
}

async function announcements(request, env, cors) {
  const url = new URL(request.url);
  let after = url.searchParams.get("after") || EPOCH;
  if (Number.isNaN(Date.parse(after))) after = EPOCH;
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "30", 10) || 30));

  const upstream = new URL(apiBase(env) + "/api/developer-messages");
  upstream.searchParams.set("after", after);
  upstream.searchParams.set("limit", String(limit));

  // Everyone shares one cached copy for a minute, so the feedback server isn't hit per visitor.
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(upstream.toString());
  let text = null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) text = await hit.text();
  }
  if (text === null) {
    const res = await fetch(upstream, { headers: authHeader(env), signal: AbortSignal.timeout(15000) });
    if (!res.ok) return reply({ error: "upstream_" + res.status }, 502, cors);
    text = await res.text();
    if (cache) {
      await cache.put(cacheKey, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" } }));
    }
  }

  let list;
  try { list = JSON.parse(text); } catch (_) { return reply({ error: "bad_upstream" }, 502, cors); }
  if (!Array.isArray(list)) return reply({ error: "bad_upstream" }, 502, cors);

  const items = list
    .filter((m) => m && m.id != null && m.createdAt)
    .map((m) => ({ id: clean(m.id, 100), title: clean(m.title, 200), message: clean(m.message, 5000), createdAt: clean(m.createdAt, 40) }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const out = reply({ items }, 200, cors);
  out.headers.set("Cache-Control", "public, max-age=30");
  return out;
}

async function feedback(request, env, cors) {
  const length = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (length > REQUEST_MAX) return reply({ error: "too_large" }, 413, cors);
  if (!/^multipart\/form-data/i.test(request.headers.get("Content-Type") || "")) return reply({ error: "bad_request" }, 400, cors);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited("feedback", ip, 5, 10 * 60 * 1000)) return reply({ error: "slow_down" }, 429, cors);

  let form;
  try { form = await request.formData(); } catch (_) { return reply({ error: "bad_request" }, 400, cors); }

  // Hidden "website" box that real people never fill in: bots do. Pretend it worked.
  if (String(form.get("website") || "").trim() !== "") return reply({ ok: true }, 200, cors);

  const category = String(form.get("category") || "");
  if (!CATEGORIES.has(category)) return reply({ error: "bad_category" }, 400, cors);

  const message = clean(form.get("message"), MAX_MESSAGE + 1).trim();
  if (message.length > MAX_MESSAGE) return reply({ error: "message_too_long" }, 400, cors);

  const file = form.get("media");
  const hasFile = file && typeof file === "object" && typeof file.arrayBuffer === "function" && file.size > 0;
  if (!hasFile && message.length < 3) return reply({ error: "empty" }, 400, cors);

  const body = { category };
  if (message) body.message = message;

  if (hasFile) {
    if (file.size > VIDEO_MAX) return reply({ error: "file_too_large" }, 413, cors);
    const found = sniff(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    if (!found) return reply({ error: "bad_file_type" }, 415, cors);
    if (file.size > (found.kind === "image" ? IMAGE_MAX : VIDEO_MAX)) return reply({ error: "file_too_large" }, 413, cors);

    // 1) ask for a signed upload address  2) send the bytes there  3) remember the path
    const name = clean(file.name || "upload", 100).replace(/[^\w.\- ]+/g, "_") || "upload";
    const ask = await fetch(apiBase(env) + "/api/storage/uploads/request-url", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeader(env)),
      body: JSON.stringify({ name, size: file.size, contentType: found.type }),
      signal: AbortSignal.timeout(15000),
    });
    if (!ask.ok) return reply({ error: "upload_refused" }, 502, cors);
    const slot = await ask.json().catch(() => null);
    if (!slot || typeof slot.uploadURL !== "string" || typeof slot.objectPath !== "string" || !/^https:\/\//i.test(slot.uploadURL)) {
      return reply({ error: "upload_refused" }, 502, cors);
    }
    const put = await fetch(slot.uploadURL, {
      method: "PUT",
      headers: { "Content-Type": found.type },
      body: await file.arrayBuffer(),
      signal: AbortSignal.timeout(90000),
    });
    if (!put.ok) return reply({ error: "upload_failed" }, 502, cors);
    body[found.kind === "image" ? "imagePath" : "videoPath"] = slot.objectPath;
  }

  const res = await fetch(apiBase(env) + "/api/feedback", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, authHeader(env)),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return reply({ error: res.status >= 500 ? "upstream_error" : "rejected" }, 502, cors);
  const saved = await res.json().catch(() => ({}));
  return reply({ ok: true, id: saved && saved.id != null ? String(saved.id) : null }, 200, cors);
}

/** What the editor may ask the Android build service for. Anything else (key management, admin...) is refused. */
function apkAllowed(method, path) {
  if (method === "POST") return path === "/api/v1/build";
  if (method === "DELETE") return /^\/api\/v1\/build\/[^/]+/.test(path);
  if (method === "GET") return !/^\/api\/v1\/(keys|admin)(\/|$)/.test(path);
  return false;
}

/**
 * Passes an Android build request on to the build service with the permanent key
 * added. The editor sends a placeholder X-Api-Key, which is always replaced here,
 * so the real key never reaches a browser. Uploads and APK downloads are streamed.
 */
async function apkProxy(request, env, cors, path) {
  if (!env.APK_API_KEY || !env.APK_API_BASE) return reply({ error: "not_configured" }, 503, cors);
  if (!apkAllowed(request.method, path)) return reply({ error: "not_allowed" }, 405, cors);

  const isUpload = request.method === "POST";
  if (isUpload) {
    const length = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (length > APK_UPLOAD_MAX) return reply({ error: "too_large" }, 413, cors);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited("apk", ip, 6, 60 * 60 * 1000)) return reply({ error: "slow_down" }, 429, cors);
  }

  const base = String(env.APK_API_BASE).replace(/\/+$/, "");
  const incoming = new URL(request.url);
  const headers = new Headers({ "X-Api-Key": env.APK_API_KEY });
  for (const name of ["Content-Type", "Accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const init = { method: request.method, headers };
  if (isUpload) { init.body = request.body; init.duplex = "half"; }
  else init.signal = AbortSignal.timeout(30000);

  let upstream;
  try { upstream = await fetch(base + path + incoming.search, init); }
  catch (_) { return reply({ error: "upstream_unreachable" }, 502, cors); }

  const out = new Headers(cors);
  for (const name of ["Content-Type", "Content-Disposition", "Content-Length"]) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set("Cache-Control", "no-store");

  // Job tickets contain links (statusUrl, downloadUrl, cancelUrl). If the service writes them as
  // full addresses, point them back at this Worker so the editor keeps going through the proxy.
  if (/json/i.test(upstream.headers.get("Content-Type") || "")) {
    const text = (await upstream.text()).split(base).join(incoming.origin);
    out.delete("Content-Length");
    return new Response(text, { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(request, env) {
    const cors = corsFor(request, env);
    if (cors === null) return reply({ error: "origin_not_allowed" }, 403, null);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    try {
      if (path.startsWith("/api/v1/")) return await apkProxy(request, env, cors, path);
      if (path === "/health" && request.method === "GET") return reply({ ok: true }, 200, cors);
      if (!env.FEEDBACK_API_KEY || !env.FEEDBACK_API_BASE) return reply({ error: "not_configured" }, 503, cors);
      if (path === "/announcements" && request.method === "GET") return await announcements(request, env, cors);
      if (path === "/feedback" && request.method === "POST") return await feedback(request, env, cors);
      return reply({ error: "not_found" }, 404, cors);
    } catch (err) {
      console.error("[feedback-worker]", err && err.message ? err.message : err); // never log the key or the message text
      return reply({ error: "server_error" }, 500, cors);
    }
  },
};
