const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "127.0.0.1";
const appRoot = __dirname;
const kimiCodingModelsPath = process.env.KIMI_CODING_MODELS_FILE || "/Users/mac/.openclaw/agents/content/agent/models.json";
const privateEnvPath = process.env.KIMI_CODING_ENV_FILE || "/Users/mac/.config/advisor-practice-simulator/.env";

function readPrivateEnvValue(key) {
  try {
    const content = require("node:fs").readFileSync(privateEnvPath, "utf8");
    const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));
    return match ? match[1].trim().replace(/^['\"]|['\"]$/g, "") : "";
  } catch {
    return "";
  }
}

function readKimiCodingConfig() {
  try {
    return JSON.parse(require("node:fs").readFileSync(kimiCodingModelsPath, "utf8")).providers?.["kimi-coding"] || {};
  } catch {
    return {};
  }
}

const kimiCoding = readKimiCodingConfig();
const apiKey = process.env.KIMI_CODING_API_KEY || readPrivateEnvValue("KIMI_CODING_API_KEY") || kimiCoding.apiKey;
const baseUrl = (process.env.KIMI_CODING_BASE_URL || kimiCoding.baseUrl || "https://api.kimi.com/coding/").replace(/\/$/, "");
const model = process.env.KIMI_CODING_MODEL || kimiCoding.models?.[0]?.id || "kimi-code";
const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
const requestWindowMs = 60 * 1000;
const maxRequestsPerWindow = Number(process.env.MAX_REQUESTS_PER_WINDOW || 30);
const requestBuckets = new Map();

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function allowRequest(req) {
  const key = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (requestBuckets.get(key) || []).filter((time) => now - time < requestWindowMs);
  if (recent.length >= maxRequestsPerWindow) return false;
  recent.push(now);
  requestBuckets.set(key, recent);
  return true;
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

function buildPrompt({ scenario, messages, readiness }) {
  const transcript = messages.map((item) => `${item.role}：${item.text}`).join("\n");
  return `你是 K12 家长，正在参加顾问新人陪练。你必须始终扮演家长，不能变成老师或评价顾问。\n\n场景：${scenario.name || scenario.title || "咨询陪练"}\n家长初始顾虑：${scenario.parent || scenario.opening || "请结合当前对话判断"}\n本轮训练目标：${scenario.goal || "理解家长真实顾虑"}\n合规边界：${scenario.risk || scenario.boundary || "不承诺效果，不制造焦虑"}\n当前训练阶段：${readiness.stage || scenario.stage || "需求诊断"}\n还未完成：${(readiness.missing || []).join("；") || "已完成，可自然收口"}\n\n对话记录：\n${transcript}\n\n请只输出 JSON，不要 Markdown：{"reply":"一条自然、口语化的家长回复，50-100 字", "ready_to_close": true/false}\n规则：根据顾问刚才的内容继续追问或确认；不要重复前一句；信息不足就只追问一个最关键的问题；出现提分承诺、稀缺催促或施压时明确表示不接受；只有当顾问完成共情、诊断和具体下一步后才同意自然收口。`;
}

async function askKimi(prompt, maxTokens = 500) {
  if (!apiKey || !model) throw new Error("未设置有效的 KIMI_CODING_API_KEY");
  let upstream;
  let lastEmptyResponse = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    upstream = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: "优先输出有效 JSON；若无法输出 JSON，也只输出家长的自然回复正文。",
        messages: [
          { role: "user", content: prompt },
        ],
      }),
    });
    if (upstream.status === 429 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      continue;
    }
    if (!upstream.ok || upstream.status === 429) break;
    const body = await upstream.json();
    const content = body?.content?.map((item) => item.text || item.content || "").join("\n") || body?.completion || "";
    if (typeof content === "string" && content.trim()) return content.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
    lastEmptyResponse = true;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 450 * (attempt + 1)));
  }
  if (!upstream.ok) {
    if (upstream.status === 401) throw new Error("Kimi Coding API Key 无效或已过期（HTTP 401）");
    if (upstream.status === 429) throw new Error("Kimi Coding 当前引擎繁忙，请稍后重试（HTTP 429）");
    throw new Error(`模型请求失败：${upstream.status}`);
  }
  if (lastEmptyResponse) throw new Error("模型连续 3 次未返回可用内容");
  throw new Error("模型请求失败，请稍后重试");
}

function parseJson(text, fallback) {
  try {
    const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function getParentReply(payload) {
  const cleaned = await askKimi(buildPrompt(payload), 300);
  const parsed = parseJson(cleaned, {});
  const extracted = parsed.reply || cleaned.match(/"reply"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/)?.[1] || cleaned;
  return extracted.replace(/\\n/g, " ").replace(/^家长[：:]/, "").trim();
}

async function testModelConnection() {
  const reply = await askKimi("你正在进行连通性测试。请只回复：连接正常", 300);
  return reply.replace(/\s+/g, " ").slice(0, 80);
}

async function getCoachReview({ scenario, transcript }) {
  const prompt = `你是K12顾问训练教练。仅依据下列对话复盘，不虚构事实，不承诺效果，不使用焦虑营销。按共情、诊断、下一步、合规分别0-25/30/25/20打分。必须逐条分析每一句【顾问】回复；每条都说明做对了什么、具体问题、以及一条能直接替换发送的范文。最后给出一段适合本场景的完整示范话术（2-4句）。输出严格JSON：{"scores":{"empathy":0,"diagnosis":0,"action":0,"compliance":0},"summary":"一句总评","missing":["..."],"rewrite":"下一句范文","turns":[{"turn":1,"advisor":"顾问原话","what_worked":"具体亮点或无","problem":"具体问题","better_reply":"替换范文"}],"full_script":"2-4句完整示范话术"}。\n场景：${scenario.name}\n边界：${scenario.risk}\n对话：\n${transcript}`;
  return parseJson(await askKimi(prompt, 1200), { scores: { empathy: 8, diagnosis: 10, action: 8, compliance: 20 }, summary: "建议先补齐家长主顾虑，再约定下一步。", missing: ["补一个诊断问题"], rewrite: "我理解您的担心，方便先确认孩子现在最困扰的问题和可沟通的时间吗？", turns: [], full_script: "我理解您担心钱花了却不适合孩子。方便先说说他现在最抗拒或最卡的是哪一部分吗？我先根据情况帮您判断是否值得继续了解；如果适合，我们再约一个您方便的时间，用 10 分钟把下一步说清楚。" });
}

async function getCopilot({ context }) {
  const prompt = `你是K12顾问的实时辅助驾驶。只基于输入事实，不承诺效果，不制造焦虑，不自动发送。输出严格JSON：{"stage":"当前阶段","concern":"核心顾虑","missing":["缺失信息"],"next":"唯一下一步及完成标准","reply":"一段可编辑、低压力的建议回复"}。\n输入对话：\n${context}`;
  return parseJson(await askKimi(prompt), { stage: "待确认", concern: "需要补充家长真实顾虑", missing: ["孩子具体困难", "可沟通时间"], next: "先确认一条关键事实，再约定回访", reply: "我理解您想先判断是否适合。方便先说说孩子现在最困扰的问题吗？" });
}

http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/config") return json(res, 200, { configured: Boolean(apiKey && model), provider: "Kimi Coding", model });
    if (req.method === "GET" && req.url === "/api/health") return json(res, 200, { ok: true, configured: Boolean(apiKey && model) });
    if (req.method === "POST" && req.url.startsWith("/api/") && !allowRequest(req)) return json(res, 429, { error: "请求过于频繁，请稍后再试。" });
    if (req.method === "POST" && req.url === "/api/model-test") return json(res, 200, { ok: true, provider: "Kimi Coding", model, response: await testModelConnection() });
    if (req.method === "POST" && req.url === "/api/parent-reply") return json(res, 200, { reply: await getParentReply(await readJson(req)) });
    if (req.method === "POST" && req.url === "/api/coach-score") {
      const payload = await readJson(req);
      return json(res, 200, await getCoachReview(payload).catch(() => ({ scores: { empathy: 8, diagnosis: 10, action: 8, compliance: 20 }, summary: "已完成基础复盘，建议补齐家长主顾虑与明确下一步。", missing: ["补一个诊断问题"], rewrite: "我理解您的担心，方便先确认孩子现在最困扰的问题，以及我们什么时候再用10分钟对齐吗？", turns: [], full_script: "我理解您会担心花了钱却不适合孩子。方便先说说他目前最卡的是哪一部分吗？我先帮您判断需要确认什么；如果合适，我们再约一个您方便的时间把下一步对齐。" })));
    }
    if (req.method === "POST" && req.url === "/api/copilot") return json(res, 200, await getCopilot(await readJson(req)));
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const requested = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
    const filePath = path.resolve(appRoot, `.${requested}`);
    if (!filePath.startsWith(appRoot)) return json(res, 403, { error: "Forbidden" });
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch (error) {
    json(res, 500, { error: error.message || "Server error" });
  }
}).listen(port, host, () => console.log(`顾问陪练服务已启动：http://${host}:${port}`));
