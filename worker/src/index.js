/**
 * Asset Portal write-proxy (Cloudflare Worker).
 *
 *   POST /requests  -> validate a submission, create a labeled GitHub Issue.
 *   GET  /requests  -> list open request markers for a site (cached ~60s).
 *
 * Secrets/vars (set via `wrangler secret put` / dashboard):
 *   GH_TOKEN       fine-grained PAT, Issues read+write on the one repo
 *   GH_REPO        "owner/name"  (e.g. NapsterX27/AsSet-Capture-BEI)
 *   SUBMIT_KEY     shared spam-deterrent key (also embedded in the SPA)
 *   ALLOWED_ORIGIN the Pages origin (e.g. https://napsterx27.github.io)
 */

const CANON = ["Civil","Electrical","Foundation","Collection","Install","Mechanical",
  "Commissioning","Substation","BESS","Safety","SM/PCC","Survey","Quality","TLine","Inventory","Decom","Other"];

function cors(env){
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-submit-key",
  };
}
function json(obj, status, headers){
  return new Response(JSON.stringify(obj), {
    status, headers: { ...headers, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(req, env, ctx){
    const h = cors(env);
    if (req.method === "OPTIONS") return new Response(null, { headers: h });
    const url = new URL(req.url);
    if (url.pathname !== "/requests") return new Response("not found", { status: 404, headers: h });
    if (req.method === "POST") return postRequest(req, env, h);
    if (req.method === "GET") return getRequests(url, env, h, ctx);
    return new Response("method not allowed", { status: 405, headers: h });
  },
};

function buildTitle(b){
  return b.type === "reassign"
    ? `[Reassign] Unit ${b.unit} (SN ${b.serial}) -> ${b.requestedTrade} @ ${b.site}`
    : `[Issue] Unit ${b.unit} (SN ${b.serial}) @ ${b.site}`;
}
function buildMarker(b){
  return JSON.stringify({
    unit: b.unit, serial: b.serial, type: b.type, site: b.site,
    requestedTrade: b.type === "reassign" ? b.requestedTrade : "",
  });
}
function buildBody(b){
  return [
    `**Unit:** ${b.unit}`,
    `**Serial:** ${b.serial}`,
    `**Description:** ${b.description || ""}`,
    `**Site:** ${b.site}`,
    `**Current trade:** ${b.currentTrade || "(none)"}`,
    b.type === "reassign" ? `**Requested trade:** ${b.requestedTrade}` : `**Report:** issue`,
    `**Detail:** ${b.detail || ""}`,
    `**Requester:** ${b.requester}`,
    ``,
    "```json",
    buildMarker(b),
    "```",
  ].join("\n");
}

async function postRequest(req, env, h){
  if (req.headers.get("x-submit-key") !== env.SUBMIT_KEY) return json({ error: "bad key" }, 401, h);
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400, h); }
  const required = ["type", "site", "unit", "serial", "requester"].every(k => String(b[k] || "").trim());
  if (!required || !["reassign", "issue"].includes(b.type)) return json({ error: "missing fields" }, 400, h);
  if (b.type === "reassign" && !CANON.includes(b.requestedTrade)) return json({ error: "bad trade" }, 400, h);

  const labels = [b.type === "reassign" ? "request:reassign" : "request:issue", `site:${b.site}`];
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/issues`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "asset-portal",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: buildTitle(b), body: buildBody(b), labels }),
  });
  if (!r.ok) {
    const t = await r.text();
    return json({ error: "github " + r.status, detail: t.slice(0, 300) }, 502, h);
  }
  const gi = await r.json();
  return json({ ok: true, issueNumber: gi.number, url: gi.html_url }, 201, h);
}

function parseMarker(body){
  const m = /```json\s*({[\s\S]*?})\s*```/.exec(body || "");
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function getRequests(url, env, h, ctx){
  const site = url.searchParams.get("site") || "";
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const out = [];
  for (let page = 1; page <= 5; page++){
    const gr = await fetch(
      `https://api.github.com/repos/${env.GH_REPO}/issues?state=open&labels=site:${encodeURIComponent(site)}&per_page=100&page=${page}`,
      { headers: { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "asset-portal" } }
    );
    if (!gr.ok) break;
    const arr = await gr.json();
    if (!arr.length) break;
    for (const it of arr){
      const d = parseMarker(it.body);
      if (!d) continue;
      out.push({ unit: d.unit, serial: d.serial, type: d.type, requestedTrade: d.requestedTrade || "", issue: it.number, url: it.html_url });
    }
    if (arr.length < 100) break;
  }
  const resp = json({ requests: out, cachedAt: new Date().toISOString() }, 200, { ...h, "Cache-Control": "max-age=60" });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

// Exported for the contract test (Node/py port mirrors these).
export const _internals = { buildTitle, buildMarker, buildBody, parseMarker, CANON };
