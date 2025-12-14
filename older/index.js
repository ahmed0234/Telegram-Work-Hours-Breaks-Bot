require("dotenv").config();
const mongoose = require("mongoose");
const TelegramBot = require("node-telegram-bot-api");

// 1. Connect MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.log("❌ MongoDB Connection Error:", err));

// 2. Schema
const activitySchema = new mongoose.Schema({
  user_id: { type: Number, required: true },  // CHANGED: This will now store msg.from.id (Unique User ID)
  date: { type: String, required: true },     // YYYY-MM-DD
  activities: [
    {
      category: String,  // Work, Eat, Toilet, Smoke, SessionEnd
      start: String,
      end: String,
    },
  ],
});
const Activity = mongoose.model("Activity", activitySchema);

// 3. Initialize Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// 4. Helpers (Cambodia Time)
const getToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Phnom_Penh" });
const getTime = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Phnom_Penh", hour12: false });

function getDurationMinutes(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  const today = getToday();
  const start = new Date(`${today}T${startStr}`);
  const end = new Date(`${today}T${endStr}`);
  return (end - start) / 1000 / 60;
}

function formatDuration(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.floor(totalMinutes % 60);
  const seconds = Math.floor((totalMinutes % 1) * 60);
  let parts = [];
  if (hours > 0) parts.push(`${hours}小时`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}分`);
  parts.push(`${seconds}秒`);
  return parts.join("") || "0秒";
}

const ICONS = { Work: "💼", Eat: "🍔", Toilet: "🚽", Smoke: "🚬" };

const catNames = {
  Work: { cn: "工作", en: "Work" },
  Eat: { cn: "吃饭", en: "Eat" },
  Toilet: { cn: "上厕所", en: "Toilet" },
  Smoke: { cn: "抽烟", en: "Smoke" }
};

// 5. 独立计算每个人的本次总结
async function buildSessionSummary(userId, userName) {
  const today = getToday();
  const record = await Activity.findOne({ user_id: userId, date: today });
  if (!record || record.activities.length === 0) {
    return "📝 <b>本次工作总结</b>\n<i>暂无活动记录</i>";
  }

  // 找到最近一次 SessionEnd 的位置（本次会话从那之后开始）
  let sessionStartIndex = record.activities.findIndex(a => a.category === "SessionEnd");
  sessionStartIndex = sessionStartIndex === -1 ? 0 : sessionStartIndex + 1;
  const sessionActivities = record.activities.slice(sessionStartIndex);

  let totalSessionMinutes = 0;
  let totalBreakMinutes = 0;
  let summaryText = "";

  ["Work", "Eat", "Toilet", "Smoke"].forEach(cat => {
    const totalMins = sessionActivities
      .filter(a => a.category === cat && a.end)
      .reduce((sum, a) => sum + getDurationMinutes(a.start, a.end), 0);

    totalSessionMinutes += totalMins;
    if (cat !== "Work") totalBreakMinutes += totalMins;

    const count = sessionActivities.filter(a => a.category === cat && a.end).length;
    if (totalMins > 0 || count > 0) {
      const countStr = cat === "Work" ? "" : ` (${count}次)`;
      summaryText += `\n${ICONS[cat]} <b>${catNames[cat].cn} / ${catNames[cat].en}:</b> ${formatDuration(totalMins)}${countStr}`;
    }
  });

  const netWorkMinutes = totalSessionMinutes - totalBreakMinutes;

  return `
📝 <b>本次工作总结 / Session Summary</b>
👤 <b>用户 / User:</b> ${userName}
──────────────────${summaryText || "\n<i>暂无活动记录</i>"}
──────────────────
⏱ <b>本次总时长 / Total Session Time:</b> ${formatDuration(totalSessionMinutes)}
✅ <b>实际工作时长 / Actual Working Hours:</b> ${formatDuration(netWorkMinutes)}
`;
}

// 6. Keyboard
const mainKeyboard = {
  reply_markup: {
    keyboard: [
      ["💼 开始工作 / Start Work", "🏁 下班 / Off Work"],
      ["🍔 吃饭 / Eat", "🚽 上厕所 / Toilet", "🚬 抽烟 / Smoke"],
      ["🪑 回到座位 / Back to Seat", "📊 本次总结 / Session Summary"]
    ],
    resize_keyboard: true,
    is_persistent: true,
  },
};

// 7. /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id; // FIXED: Uses the individual User ID
  const userName = msg.from.first_name || "用户";

  // 确保今天的数据记录存在（独立于其他人）
  await Activity.findOneAndUpdate(
    { user_id: userId, date: getToday() }, // FIXED: Query by userId, not chatId
    { user_id: userId, date: getToday(), activities: [] },
    { upsert: true }
  );

  bot.sendMessage(
    chatId,
    `👋 <b>欢迎，${userName}！</b>\n你的独立考勤面板已就绪。\n每人数据完全独立记录。`,
    { parse_mode: "HTML", ...mainKeyboard }
  );
});

// 8. Message Handler
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;     // Where to send the message (Group or DM)
  const userId = msg.from.id;     // FIXED: Who clicked the button (Unique ID)
  const userName = msg.from.first_name || "用户";
  const text = msg.text.trim();
  const today = getToday();
  const timeNow = getTime();

  // 获取当前用户的今日记录（独立）
  // FIXED: Querying by userId ensures we get THIS specific person's document
  let record = await Activity.findOne({ user_id: userId, date: today });
  
  if (!record) {
    record = new Activity({ user_id: userId, date: today, activities: [] });
  }

  // 停止上一个活动并返回信息
  const stopPrevious = () => {
    const last = record.activities[record.activities.length - 1];
    if (last && !last.end && last.category !== "SessionEnd") {
      last.end = timeNow;
      const duration = getDurationMinutes(last.start, timeNow);
      const cat = catNames[last.category];
      return { text: `${cat.cn} / ${cat.en}`, duration };
    }
    return null;
  };

  let response = "";
  let prevInfo = null;

  switch (text) {
    case "💼 开始工作 / Start Work":
      prevInfo = stopPrevious();
      record.activities.push({ category: "Work", start: timeNow });
      response = `💼 <b>开始工作 / Work Started</b>\n👤 <b>${userName}</b>\n🕐 时间 / Time: ${timeNow}`;
      if (prevInfo) response += `\n\n✅ 上一个活动结束 / Previous ended:\n${prevInfo.text}: ${formatDuration(prevInfo.duration)}`;
      break;

    case "🍔 吃饭 / Eat":
      prevInfo = stopPrevious();
      record.activities.push({ category: "Eat", start: timeNow });
      response = `🍔 <b>吃饭去了 / Eating</b>\n👤 <b>${userName}</b>\n🕐 开始时间 / Start Time: ${timeNow}`;
      if (prevInfo) response += `\n\n✅ 上一个活动结束:\n${prevInfo.text}: ${formatDuration(prevInfo.duration)}`;
      break;

    case "🚽 上厕所 / Toilet":
      prevInfo = stopPrevious();
      record.activities.push({ category: "Toilet", start: timeNow });
      response = `🚽 <b>上厕所 / Toilet Break</b>\n👤 <b>${userName}</b>\n🕐 开始时间 / Start Time: ${timeNow}`;
      if (prevInfo) response += `\n\n✅ 上一个活动结束:\n${prevInfo.text}: ${formatDuration(prevInfo.duration)}`;
      break;

    case "🚬 抽烟 / Smoke":
      prevInfo = stopPrevious();
      record.activities.push({ category: "Smoke", start: timeNow });
      response = `🚬 <b>抽烟去了 / Smoking</b>\n👤 <b>${userName}</b>\n🕐 开始时间 / Start Time: ${timeNow}`;
      if (prevInfo) response += `\n\n✅ 上一个活动结束:\n${prevInfo.text}: ${formatDuration(prevInfo.duration)}`;
      break;

    case "🪑 回到座位 / Back to Seat":
      prevInfo = stopPrevious();
      record.activities.push({ category: "Work", start: timeNow });
      response = `🪑 <b>回到座位，继续工作 / Back to Work</b>\n👤 <b>${userName}</b>\n🕐 时间 / Time: ${timeNow}`;
      if (prevInfo) response += `\n\n✅ 休息结束 / Break ended:\n${prevInfo.text}: ${formatDuration(prevInfo.duration)}`;
      break;

    case "📊 本次总结 / Session Summary":
      response = await buildSessionSummary(userId, userName);
      break;

    case "🏁 下班 / Off Work":
      prevInfo = stopPrevious();
      record.activities.push({ category: "SessionEnd", start: timeNow, end: timeNow });
      response = `🏁 <b>下班啦！/ Off Work</b>\n👤 <b>${userName}</b>\n🕐 时间 / Time: ${timeNow}`;
      if (prevInfo) response += `\n\n✅ 最后一个活动结束:\n${prevInfo.text}: ${formatDuration(prevInfo.duration)}`;
      response += `\n\n${await buildSessionSummary(userId, userName)}`;
      break;

    default:
      return;
  }

  await record.save();
  // We send the message to chatId (the group or chat), but the logic above used userId (the person)
  bot.sendMessage(chatId, response, { parse_mode: "HTML", ...mainKeyboard });
});

console.log("🤖 多用户独立考勤机器人已启动 - Cambodia Time");