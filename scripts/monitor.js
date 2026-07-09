import { createClient } from "@supabase/supabase-js";
import RssParser from "rss-parser";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service_role key for write access

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY env vars");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const rssParser = new RssParser({ timeout: 15000 });

const TODAY = new Date().toISOString().split("T")[0];

// ===== B站 API =====
async function fetchBilibili(mid) {
  try {
    const url = `https://api.bilibili.com/x/space/arc/search?mid=${mid}&ps=10&order=pubdate`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://www.bilibili.com/",
      },
    });
    const json = await res.json();
    if (json.code !== 0 || !json.data?.list?.vlist) {
      console.error(`B站 fetch failed for mid=${mid}:`, json.message);
      return [];
    }
    return json.data.list.vlist.map((v) => ({
      id: `bv_${v.bvid}`,
      title: v.title,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      description: v.description?.substring(0, 200) || "",
      pubDate: new Date(v.created * 1000).toISOString(),
      author: v.author,
      source: "bilibili",
    }));
  } catch (e) {
    console.error(`B站 error for mid=${mid}:`, e.message);
    return [];
  }
}

// ===== RSS 抓取 =====
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

// ===== 判断URL类型并抓取 =====
async function fetchMonitor(monitor) {
  const url = monitor.url || "";
  const name = monitor.name || "";

  // B站: URL包含 bilibili.com 或直接是UID数字
  if (url.includes("bilibili.com") || /^\d+$/.test(url.trim())) {
    let mid = url.trim();
    // 从URL中提取mid
    const midMatch = url.match(/space\.bilibili\.com\/(\d+)/);
    if (midMatch) mid = midMatch[1];
    if (!/^\d+$/.test(mid)) {
      console.log(`无法解析B站UID: ${url}`);
      return null;
    }
    console.log(`[B站] 检查 ${name} (mid=${mid})`);
    const items = await fetchBilibili(mid);
    return { monitor, items, type: "bilibili", sourceId: mid };
  }

  // RSS/微信公众号: URL以http开头 (微信需通过RSSHub桥接: https://rsshub.app/wechat/mp/profile/MP_ID)
  if (url.startsWith("http")) {
    console.log(`[RSS] 检查 ${name} (${url})`);
    const items = await fetchRSS(url);
    return { monitor, items, type: "rss", sourceId: url };
  }

  console.log(`无法识别的源: ${url}`);
  return null;
}

// ===== 主流程 =====
async function main() {
  console.log("=== 监测任务启动:", new Date().toISOString(), "===");

  // 1. 读取用户数据
  const { data: row, error } = await sb
    .from("user_data")
    .select("data")
    .eq("id", 1)
    .single();

  if (error || !row?.data) {
    console.error("无法读取用户数据:", error);
    return;
  }

  const userData = row.data;
  const monitors = (userData.tasks || []).filter(
    (t) => t.type === "monitor" && t.subType === "reminder" && t.url
  );

  if (monitors.length === 0) {
    console.log("没有监测任务，跳过");
    return;
  }

  console.log(`共 ${monitors.length} 个监测源`);

  // 2. 初始化 monitorResults
  if (!userData.monitorResults) userData.monitorResults = {};

  let newCount = 0;

  // 3. 逐个抓取
  for (const monitor of monitors) {
    const result = await fetchMonitor(monitor);
    if (!result) continue;

    const { items } = result;
    if (items.length === 0) continue;

    // 上次检查结果
    const lastResult = userData.monitorResults[monitor.id] || {};
    const lastId = lastResult.lastContentId || "";
    const lastChecked = lastResult.lastChecked || "";

    // 检查是否有新内容（比较第一条的ID）
    const latestItem = items[0];
    if (latestItem.id !== lastId) {
      // 有新内容！
      newCount++;
      userData.monitorResults[monitor.id] = {
        monitorId: monitor.id,
        monitorName: monitor.name,
        lastContentId: latestItem.id,
        lastChecked: TODAY,
        latestTitle: latestItem.title,
        latestUrl: latestItem.url,
        latestPubDate: latestItem.pubDate,
        updatedAt: new Date().toISOString(),
        items: items.slice(0, 5), // 保留最近5条
      };
      console.log(`  ✅ 新内容: ${monitor.name} -> ${latestItem.title}`);
    } else {
      // 没变化，只更新检查时间
      userData.monitorResults[monitor.id] = {
        ...lastResult,
        lastChecked: TODAY,
      };
      console.log(`  ⏭ 无更新: ${monitor.name}`);
    }

    // 避免请求太频繁
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 4. 写回 Supabase
  if (newCount > 0) {
    const { error: writeErr } = await sb
      .from("user_data")
      .upsert({
        id: 1,
        data: userData,
        updated_at: new Date().toISOString(),
      });

    if (writeErr) {
      console.error("写入失败:", writeErr);
    } else {
      console.log(`✅ 已同步: ${newCount} 个源有更新`);
    }
  } else {
    console.log("所有源均无更新");
  }

  console.log("=== 监测完成 ===");
}

main().catch((e) => {
  console.error("监测脚本异常:", e);
  process.exit(1);
});
