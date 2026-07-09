import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY env vars");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== DeepSeek AI 分析 =====
async function analyzeWithDeepSeek(prompt) {
  if (!DEEPSEEK_KEY) return "";
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "你是一个自律数据分析助手。用简洁的中文回复，控制在200字以内，语气温暖鼓励。" },
          { role: "user", content: prompt },
        ],
        max_tokens: 400,
        temperature: 0.7,
      }),
    });
    const json = await res.json();
    return json.choices?.[0]?.message?.content || "";
  } catch (e) {
    console.error("DeepSeek error:", e.message);
    return "";
  }
}

async function main() {
  console.log("=== 周报生成开始 ===");

  // 1. 读取用户数据
  const { data: row, error } = await sb.from("user_data").select("data").eq("id", 1).single();
  if (error || !row?.data) {
    console.error("Failed to fetch user data:", error);
    process.exit(1);
  }

  const data = row.data;
  const today = new Date();
  // 统计上周（上周日 ~ 上周六），因为每周日运行
  const weekEnd = new Date(today);
  weekEnd.setDate(today.getDate() - 1); // 昨天（周六）
  weekEnd.setHours(23, 59, 59, 999);
  const weekStart = new Date(weekEnd);
  weekStart.setDate(weekEnd.getDate() - 6); // 上周日
  weekStart.setHours(0, 0, 0, 0);

  // 2. 统计本周数据
  const signIns = data.signIns || {};
  const tasks = data.tasks || [];
  const goals = data.goals || [];
  const monitorResults = data.monitorResults || {};

  // 本周签到
  let weekSignCount = 0;
  for (let d = new Date(weekStart); d <= today; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().split("T")[0];
    if (signIns[ds]) weekSignCount++;
  }

  // 本周完成任务数
  let weekCompletions = 0;
  let weekXpEarned = 0;
  let weekXpLost = 0;
  for (const task of tasks) {
    const completedDates = task.completedDates || {};
    for (const [date, val] of Object.entries(completedDates)) {
      const dateObj = new Date(date + "T00:00:00+08:00");
      if (dateObj >= weekStart && val) {
        weekCompletions++;
        weekXpEarned += task.reward || 0;
      }
    }
    // 惩罚记录
    const penalties = task.penaltyLog || [];
    for (const p of penalties) {
      const pDate = new Date(p.date + "T00:00:00+08:00");
      if (pDate >= weekStart) weekXpLost += p.amount || 0;
    }
  }

  // 总积分
  const totalXp = data.points || 0;
  const streak = getStreakFromData(signIns, today);
  const level = getLevelFromXp(totalXp);

  // 监测更新数
  let monitorUpdates = 0;
  for (const r of Object.values(monitorResults)) {
    if (r.latestPubDate) {
      const pubDate = new Date(r.latestPubDate);
      if (pubDate >= weekStart && pubDate <= weekEnd) monitorUpdates++;
    }
  }

  // 3. 构建分析提示
  const weekLabel = `${weekStart.getMonth() + 1}/${weekStart.getDate()} - ${weekEnd.getMonth() + 1}/${weekEnd.getDate()}`;
  const prompt = `请分析以下自律数据并给出本周总结和建议：

📅 周期: ${weekLabel}
✅ 签到: ${weekSignCount}天
🎯 完成任务: ${weekCompletions}次
⭐ 积分变化: +${weekXpEarned} / -${weekXpLost}（净${weekXpEarned - weekXpLost > 0 ? '+' : ''}${weekXpEarned - weekXpLost}）
🔥 连续签到: ${streak}天
📊 当前等级: Lv.${level}
📡 监测更新: ${monitorUpdates}条
💰 总积分: ${totalXp}

请用2-3句话总结本周表现，并给1条下周的改进建议。`;

  const aiAnalysis = await analyzeWithDeepSeek(prompt);

  // 4. 存入 Supabase
  const report = {
    weekLabel,
    weekSignCount,
    weekCompletions,
    weekXpEarned,
    weekXpLost,
    totalXp,
    streak,
    level,
    monitorUpdates,
    aiAnalysis,
    generatedAt: weekEnd.toISOString(),
  };

  // 更新 user_data 中的 weeklyReport
  data.weeklyReport = report;
  const { error: updateError } = await sb
    .from("user_data")
    .upsert({ id: 1, data, updated_at: new Date().toISOString() });

  if (updateError) {
    console.error("Failed to save report:", updateError);
    process.exit(1);
  }

  console.log("=== 周报生成完成 ===");
  console.log("签到:", weekSignCount, "天 | 完成:", weekCompletions, "次 | XP:", weekXpEarned - weekXpLost);
  console.log("AI分析:", aiAnalysis?.substring(0, 80) || "(无)");
}

function getStreakFromData(signIns, today) {
  let streak = 0;
  const d = new Date(today);
  while (true) {
    const ds = d.toISOString().split("T")[0];
    if (signIns[ds]) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function getLevelFromXp(xp) {
  if (xp < 100) return 1;
  if (xp < 300) return 2;
  if (xp < 600) return 3;
  if (xp < 1000) return 4;
  if (xp < 2000) return 5;
  if (xp < 4000) return 6;
  if (xp < 7000) return 7;
  if (xp < 12000) return 8;
  if (xp < 20000) return 9;
  return 10;
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
