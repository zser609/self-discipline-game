import { createClient } from "@supabase/supabase-js";
import RssParser from "rss-parser";
import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY env vars");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const rssParser = new RssParser({ timeout: 20000, headers: { "User-Agent": "Mozilla/5.0" } });

const TODAY = new Date().toISOString().split("T")[0];
const BJ_NOW = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== B站: RSSHub 优先, WBI API 备用 =====
async function fetchBilibili(mid) {
  // 策略1: RSSHub (云端IP友好)
  try {
    console.log("  [策略1] RSSHub...");
    const rssUrl = `https://rsshub.app/bilibili/user/video/${mid}`;
    const feed = await rssParser.parseURL(rssUrl);
    if (feed.items && feed.items.length > 0) {
      console.log(`  RSSHub: ${feed.items.length} videos`);
      return feed.items.slice(0, 5).map((item) => {
        const bvidMatch = (item.link || "").match(/video\/(BV[a-zA-Z0-9]+)/);
        return {
          id: item.guid || item.link || item.title,
          bvid: bvidMatch ? bvidMatch[1] : "",
          title: item.title,
          url: item.link || "",
          description: (item.contentSnippet || item.content || "").substring(0, 300),
          pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
          author: item.creator || feed.title || "",
          source: "bilibili",
        };
      });
    }
  } catch (e) {
    console.log("  RSSHub failed:", e.message);
  }

  // 策略2: RSSHub 备用域名
  try {
    console.log("  [策略2] RSSHub (alt)...");
    const rssUrl = `https://rsshub.rss3.io/bilibili/user/video/${mid}`;
    const feed = await rssParser.parseURL(rssUrl);
    if (feed.items && feed.items.length > 0) {
      console.log(`  RSSHub-alt: ${feed.items.length} videos`);
      return feed.items.slice(0, 5).map((item) => {
        const bvidMatch = (item.link || "").match(/video\/(BV[a-zA-Z0-9]+)/);
        return {
          id: item.guid || item.link || item.title,
          bvid: bvidMatch ? bvidMatch[1] : "",
          title: item.title,
          url: item.link || "",
          description: (item.contentSnippet || item.content || "").substring(0, 300),
          pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
          author: item.creator || feed.title || "",
          source: "bilibili",
        };
      });
    }
  } catch (e) {
    console.log("  RSSHub-alt failed:", e.message);
  }

  // 策略3: WBI API
  try {
    console.log("  [策略3] WBI API...");
    await sleep(2000);
    const keys = await getWbiKeys();
    if (!keys) throw new Error("no wbi keys");
    
    const qs = signWbi({ mid, ps: "5", order: "pubdate" }, keys.imgKey, keys.subKey);
    const url = `https://api.bilibili.com/x/space/wbi/arc/search?${qs}`;

    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Referer: `https://space.bilibili.com/${mid}/` },
    });
    const text = await res.text();
    if (!text.startsWith("{")) throw new Error("non-JSON response");
    const json = JSON.parse(text);
    if (json.code !== 0) throw new Error(`code=${json.code} msg=${json.message}`);
    const vlist = json.data?.list?.vlist || [];
    
    console.log(`  WBI API: ${vlist.length} videos`);
    return vlist.map((v) => ({
      id: `bv_${v.bvid}`,
      bvid: v.bvid,
      title: v.title,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      description: (v.description || "").substring(0, 300),
      pubDate: new Date(v.created * 1000).toISOString(),
      author: v.author,
      source: "bilibili",
    }));
  } catch (e) {
    console.log("  WBI failed:", e.message);
  }

  console.log("  ALL strategies failed for B站 mid=" + mid);
  return [];
}

// ===== WBI 签名 =====
const WBI_MIXIN_IDX = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,52,44,34];
let _wbiCache = null;

async function getWbiKeys() {
  if (_wbiCache) return _wbiCache;
  const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    headers: { ...BROWSER_HEADERS, Referer: "https://www.bilibili.com/" },
  });
  const json = await res.json();
  const imgKey = json.data?.wbi_img?.img_url?.split("/").pop()?.split(".")[0] || "";
  const subKey = json.data?.wbi_img?.sub_url?.split("/").pop()?.split(".")[0] || "";
  if (!imgKey || !subKey) throw new Error("no wbi keys");
  _wbiCache = { imgKey, subKey };
  return _wbiCache;
}

function signWbi(params, imgKey, subKey) {
  let mixin = "";
  for (const idx of WBI_MIXIN_IDX) {
    if (idx < (imgKey + subKey).length) mixin += (imgKey + subKey)[idx];
  }
  const mixinKey = mixin.substring(0, 32);
  const wts = Math.floor(Date.now() / 1000);
  const allParams = { ...params, wts };
  const sorted = Object.keys(allParams).sort();
  const query = sorted.map(k => `${k}=${encodeURIComponent(allParams[k]).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`).join("&");
  const w_rid = crypto.createHash("md5").update(query + mixinKey).digest("hex");
  return query + "&w_rid=" + w_rid;
}

// ===== B站字幕 =====
async function fetchBilibiliSubtitle(bvid) {
  if (!bvid) return "";
  try {
    const keys = await getWbiKeys();
    if (!keys) return "";
    const qs = signWbi({ bvid }, keys.imgKey, keys.subKey);
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?${qs}`, {
      headers: { ...BROWSER_HEADERS, Referer: "https://www.bilibili.com/" },
    });
    const json = await res.json();
    if (json.code !== 0) return "";
    const subList = json.data?.subtitle?.list || [];
    if (subList.length === 0) return "";
    const zhSub = subList.find(s => s.lan === "zh-Hans" || s.lan === "zh-CN") || subList[0];
    const subUrl = zhSub.subtitle_url;
    if (!subUrl) return "";
    const subRes = await fetch(subUrl.startsWith("http") ? subUrl : "https:" + subUrl);
    const subJson = await subRes.json();
    const texts = (subJson.body || []).map(s => s.content).join(" ");
    return texts.substring(0, 6000);
  } catch (e) {
    return "";
  }
}

// ===== RSS =====
async function fetchRSS(feedUrl) {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    return (feed.items || []).slice(0, 10).map((item) => ({
      id: item.guid || item.link || item.title,
      title: item.title,
      url: item.link,
      description: (item.contentSnippet || item.content || "").substring(0, 300),
      pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
      author: item.creator || feed.title || "",
      source: "rss",
    }));
  } catch (e) {
    console.error("    RSS error:", e.message);
    return [];
  }
}

// ===== DeepSeek =====
async function summarizeWithDeepSeek(title, description, subtitle) {
  if (!DEEPSEEK_KEY) return "";
  try {
    const content = [`标题：${title}`, `简介：${description || "无"}`, `字幕：${subtitle || "无字幕"}`].join("\n\n");
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "你是知识提取助手。根据视频标题、简介和字幕，提炼3-5个核心知识点。用简洁Markdown输出，格式：- **要点**：一句话解释。总字数≤200字。" },
          { role: "user", content },
        ],
        max_tokens: 400, temperature: 0.3,
      }),
    });
    const json = await res.json();
    const summary = json.choices?.[0]?.message?.content?.trim();
    if (summary) return summary;
    return "";
  } catch (e) {
    return "";
  }
}

function classify(monitor) {
  const url = (monitor.url || "").trim();
  if (url.includes("bilibili.com") || /^\d+$/.test(url)) {
    let mid = url;
    const m = url.match(/space\.bilibili\.com\/(\d+)/);
    if (m) mid = m[1];
    if (/^\d+$/.test(mid)) return { type: "bilibili", id: mid };
    return null;
  }
  if (url.startsWith("http")) return { type: "rss", id: url };
  return null;
}

async function main() {
  console.log(`=== Monitor Start ${BJ_NOW.toLocaleString("zh-CN")} ===`);

  const { data: row, error } = await sb.from("user_data").select("data").eq("id", 1).single();
  if (error || !row?.data) { console.error("Cannot read user data:", error); return; }

  const userData = row.data;
  const allMonitors = (userData.tasks || []).filter(t => t.type === "monitor" && t.subType === "reminder" && t.url);
  console.log(`Total monitors: ${(userData.tasks||[]).filter(t=>t.type==='monitor').length}, with URL: ${allMonitors.length}`);

  const bilibiliList = [];
  const rssList = [];
  for (const m of allMonitors) {
    const info = classify(m);
    if (!info) { console.log(`  SKIP: ${m.name} (unrecognized URL)`); continue; }
    if (info.type === "bilibili") bilibiliList.push({ monitor: m, id: info.id });
    else rssList.push({ monitor: m, id: info.id });
  }

  console.log(`B站:${bilibiliList.length} RSS:${rssList.length}`);

  if (!userData.monitorResults) userData.monitorResults = {};
  let newCount = 0;

  for (const { monitor, id } of bilibiliList) {
    console.log(`[B站] ${monitor.name} (mid=${id})`);
    const items = await fetchBilibili(id);
    if (items.length === 0) { console.log("  No results"); continue; }

    const last = userData.monitorResults[monitor.id] || {};
    if (items[0].id !== (last.lastContentId || "")) {
      newCount++;
      console.log(`  NEW: ${items[0].title}`);

      let aiSummary = "";
      if (items[0].bvid && DEEPSEEK_KEY) {
        const subtitle = await fetchBilibiliSubtitle(items[0].bvid);
        aiSummary = await summarizeWithDeepSeek(items[0].title, items[0].description, subtitle);
        if (aiSummary) console.log(`  AI: ${aiSummary.substring(0, 60)}...`);
      }

      userData.monitorResults[monitor.id] = {
        monitorId: monitor.id, monitorName: monitor.name,
        lastContentId: items[0].id, lastChecked: TODAY,
        latestTitle: items[0].title, latestUrl: items[0].url,
        latestPubDate: items[0].pubDate, updatedAt: new Date().toISOString(),
        items: items.slice(0, 5), aiSummary,
      };
    } else {
      userData.monitorResults[monitor.id] = { ...last, lastChecked: TODAY };
      console.log("  No update");
    }
    await sleep(2000);
  }

  for (const { monitor, id } of rssList) {
    console.log(`[RSS] ${monitor.name}`);
    const items = await fetchRSS(id);
    if (items.length === 0) { console.log("  No results"); continue; }

    const last = userData.monitorResults[monitor.id] || {};
    if (items[0].id !== (last.lastContentId || "")) {
      newCount++;
      console.log(`  NEW: ${items[0].title}`);
      userData.monitorResults[monitor.id] = {
        monitorId: monitor.id, monitorName: monitor.name,
        lastContentId: items[0].id, lastChecked: TODAY,
        latestTitle: items[0].title, latestUrl: items[0].url,
        latestPubDate: items[0].pubDate, updatedAt: new Date().toISOString(),
        items: items.slice(0, 5), aiSummary: "",
      };
    } else {
      userData.monitorResults[monitor.id] = { ...last, lastChecked: TODAY };
      console.log("  No update");
    }
    await sleep(1000);
  }

  if (newCount > 0) {
    const { error: writeErr } = await sb.from("user_data").upsert({
      id: 1, data: userData, updated_at: new Date().toISOString(),
    });
    if (writeErr) console.error("Write failed:", writeErr);
    else console.log(`DONE: ${newCount} sources updated`);
  } else {
    console.log("No new content from any source");
  }
  console.log("=== Monitor End ===");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });