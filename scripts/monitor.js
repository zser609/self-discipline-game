import { createClient } from "@supabase/supabase-js";
import RssParser from "rss-parser";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY env vars");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const rssParser = new RssParser({ timeout: 15000 });

const TODAY = new Date().toISOString().split("T")[0];

// ===== B站 字幕抓取 =====
async function fetchBilibiliSubtitle(bvid) {
  try {
    const infoUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    const infoRes = await fetch(infoUrl, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/" }
    });
    const infoJson = await infoRes.json();
    if (infoJson.code !== 0) return "";

    const subList = infoJson.data?.subtitle?.list || [];
    if (subList.length === 0) {
      console.log("    无字幕");
      return "";
    }
    // 优先中文
    const zhSub = subList.find(s => s.lan === "zh-Hans" || s.lan === "zh-CN") || subList[0];
    const subUrl = zhSub.subtitle_url;
    if (!subUrl) return "";

    const subRes = await fetch(subUrl.startsWith("http") ? subUrl : "https:" + subUrl);
    const subJson = await subRes.json();
    const texts = (subJson.body || []).map(s => s.content).join(" ");
    console.log(`    字幕长度: ${texts.length} 字符`);
    return texts.substring(0, 6000); // 限制长度节约token
  } catch (e) {
    console.error("    字幕抓取失败:", e.message);
    return "";
  }
}

// ===== DeepSeek AI 总结 =====
async function summarizeWithDeepSeek(title, description, subtitle) {
  if (!DEEPSEEK_KEY) {
    console.log("    未配置DEEPSEEK_KEY，跳过AI总结");
    return "";
  }
  try {
    const content = [
      `标题：${title}`,
      `简介：${description || "无"}`,
      `字幕片段：${subtitle || "无字幕"}`,
    ].join("\n\n");

    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: `你是一个知识提取助手。根据视频的标题、简介和字幕，提炼出3-5个核心知识点。用简洁的Markdown格式输出，每个知识点一行，格式：- **要点名称**：一句话解释。总字数不超过200字。不要问候语。`,
          },
          { role: "user", content },
        ],
        max_tokens: 400,
        temperature: 0.3,
      }),
    });

    const json = await res.json();
    if (json.choices?.[0]?.message?.content) {
      const summary = json.choices[0].message.content.trim();
      console.log(`    AI总结: ${summary.substring(0, 80)}...`);
      return summary;
    }
    console.error("    DeepSeek 返回异常:", JSON.stringify(json).substring(0, 200));
    return "";
  } catch (e) {
    console.error("    DeepSeek 调用失败:", e.message);
    return "";
  }
}

// ===== B站 API =====
async function fetchBilibili(mid) {
  try {
    await new Promise(r=>setTimeout(r,2000));
    const url = `https://api.bilibili.com/x/space/arc/search?mid=${mid}&ps=5&order=pubdate`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        Referer: "https://www.bilibili.com/",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    const json = await res.json();
    if (json.code !== 0 || !json.data?.list?.vlist) {
      console.error(`B站 fetch failed for mid=${mid}:`, json.message);
      return [];
    }
    return json.data.list.vlist.map((v) => ({
      id: `bv_${v.bvid}`,
      bvid: v.bvid,
      title: v.title,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      description: v.description?.substring(0, 300) || "",
      pubDate: new Date(v.created * 1000).toISOString(),
      author: v.author,
      source: "bilibili",
    }));
  } catch (e) {
    console.error(`B站 error for mid=${mid}:`, e.message);
    return [];
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
      author: feed.title || "",
      source: "rss",
    }));
  } catch (e) {
    console.error(`RSS error for ${feedUrl}:`, e.message);
    return [];
  }
}

async function fetchMonitor(monitor) {
  const url = (monitor.url || "").trim();
  const name = monitor.name || "";

  if (url.includes("bilibili.com") || /^\d+$/.test(url.trim())) {
    let mid = url.trim();
    const midMatch = url.match(/space\.bilibili\.com\/(\d+)/);
    if (midMatch) mid = midMatch[1];
    if (!/^\d+$/.test(mid)) { console.log(`无法解析B站UID: ${url}`); return null; }
    console.log(`[B站] 检查 ${name} (mid=${mid})`);
    const items = await fetchBilibili(mid);
    return { monitor, items, type: "bilibili", sourceId: mid };
  }

  if(url.includes("douyin.com")||url.includes("xiaohongshu.com")){
    console.log("  ⚠ 抖音/小红书暂不支持，已跳过: "+name);
    return null;
  }
  if (url.startsWith("http")) {
    console.log(`[RSS] 检查 ${name} (${url})`);
    const items = await fetchRSS(url);
    return { monitor, items, type: "rss", sourceId: url };
  }

  console.log(`无法识别的源: ${url}`);
  return null;
}

async function main() {
  console.log("=== 监测任务启动:", new Date().toISOString(), "===");

  const { data: row, error } = await sb.from("user_data").select("data").eq("id", 1).single();
  if (error || !row?.data) { console.error("无法读取用户数据:", error); return; }

  const userData = row.data;
  const monitors = (userData.tasks || []).filter(t => t.type === "monitor" && t.subType === "reminder" && t.url);
  if (monitors.length === 0) { console.log("没有监测任务，跳过"); return; }

  console.log(`共 ${monitors.length} 个监测源`);
  if (!userData.monitorResults) userData.monitorResults = {};

  let newCount = 0;

  for (const monitor of monitors) {
    const result = await fetchMonitor(monitor);
    if (!result) continue;
    const { items, type } = result;
    if (items.length === 0) continue;

    const lastResult = userData.monitorResults[monitor.id] || {};
    const lastId = lastResult.lastContentId || "";
    const latestItem = items[0];

    if (latestItem.id !== lastId) {
      newCount++;

      // ===== AI 总结：仅B站 =====
      let aiSummary = "";
      if (type === "bilibili" && latestItem.bvid && DEEPSEEK_KEY) {
        console.log(`   🤖 抓取字幕并AI总结...`);
        const subtitle = await fetchBilibiliSubtitle(latestItem.bvid);
        aiSummary = await summarizeWithDeepSeek(latestItem.title, latestItem.description, subtitle);
      }

      userData.monitorResults[monitor.id] = {
        monitorId: monitor.id,
        monitorName: monitor.name,
        lastContentId: latestItem.id,
        lastChecked: TODAY,
        latestTitle: latestItem.title,
        latestUrl: latestItem.url,
        latestPubDate: latestItem.pubDate,
        updatedAt: new Date().toISOString(),
        items: items.slice(0, 5),
        aiSummary,
      };
      console.log(`  ✅ 新内容: ${monitor.name} -> ${latestItem.title}`);
    } else {
      userData.monitorResults[monitor.id] = { ...lastResult, lastChecked: TODAY };
      console.log(`  ⏭ 无更新: ${monitor.name}`);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  if (newCount > 0) {
    const { error: writeErr } = await sb.from("user_data").upsert({
      id: 1, data: userData, updated_at: new Date().toISOString(),
    });
    if (writeErr) { console.error("写入失败:", writeErr); }
    else { console.log(`✅ 已同步: ${newCount} 个源有更新`); }
  } else {
    console.log("所有源均无更新");
  }

  console.log("=== 监测完成 ===");
}

main().catch((e) => { console.error("监测脚本异常:", e); process.exit(1); });
