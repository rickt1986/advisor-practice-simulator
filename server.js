const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { WebSocket } = require("ws");

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
// 陪练中的家长回复是高频、短输出的即时交互：使用 K2.6 非思考模式，
// 复盘与实时建议仍沿用默认模型，以避免为了速度牺牲诊断质量。
const parentModel = process.env.KIMI_PARENT_MODEL || "kimi-k2.6";
const volcAsrApiKey = process.env.VOLC_ASR_API_KEY || readPrivateEnvValue("VOLC_ASR_API_KEY");
const volcAsrResourceId = process.env.VOLC_ASR_RESOURCE_ID || readPrivateEnvValue("VOLC_ASR_RESOURCE_ID");
const trainingAssets = (() => {
  try { return require("./training-assets.json"); } catch { return { version: "unavailable", grades: {} }; }
})();
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

async function readBuffer(req, maxBytes = 12 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("音频文件过大，请控制在 12MB 内");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function asrFrame(messageType, flags, serialization, payload) {
  const compressed = zlib.gzipSync(payload);
  const header = Buffer.from([0x11, (messageType << 4) | flags, (serialization << 4) | 0x01, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressed.length);
  return Buffer.concat([header, size, compressed]);
}

function parseAsrFrame(data) {
  const frame = Buffer.from(data);
  if (frame.length < 8) return {};
  const headerSize = (frame[0] & 0x0f) * 4;
  const type = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const compression = frame[2] & 0x0f;
  let offset = headerSize;
  if (type === 9 && (flags === 1 || flags === 3)) offset += 4;
  if (type === 15) {
    const code = frame.readUInt32BE(offset);
    const size = frame.readUInt32BE(offset + 4);
    return { type, flags, error: frame.subarray(offset + 8, offset + 8 + size).toString("utf8"), code };
  }
  const size = frame.readUInt32BE(offset);
  let payload = frame.subarray(offset + 4, offset + 4 + size);
  if (compression === 1) payload = zlib.gunzipSync(payload);
  try { return { type, flags, body: JSON.parse(payload.toString("utf8")) }; } catch { return { type, flags }; }
}

async function transcribeWithVolcAsr(audio) {
  if (!volcAsrApiKey || !volcAsrResourceId) throw new Error("豆包语音识别尚未配置");
  if (audio.length < 48) throw new Error("没有采集到有效语音");
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    let latestText = "";
    const finish = (error, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.terminate();
      error ? reject(error) : resolve(text || latestText);
    };
    const socket = new WebSocket("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream", {
      headers: {
        "X-Api-Key": volcAsrApiKey,
        "X-Api-Resource-Id": volcAsrResourceId,
        "X-Api-Request-Id": requestId,
        "X-Api-Sequence": "-1",
      },
      handshakeTimeout: 10000,
    });
    const timeout = setTimeout(() => finish(new Error("豆包语音识别超时，请重试")), 30000);
    socket.on("open", () => {
      const request = Buffer.from(JSON.stringify({
        user: { uid: "advisor-practice" },
        audio: { format: "wav", codec: "raw", rate: 16000, bits: 16, channel: 1, language: "zh-CN" },
        request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, show_utterances: false },
      }));
      socket.send(asrFrame(1, 0, 1, request));
      socket.send(asrFrame(2, 2, 0, audio));
    });
    socket.on("message", (data) => {
      try {
        const parsed = parseAsrFrame(data);
        if (parsed.error) return finish(new Error(`豆包语音识别失败：${parsed.error}`));
        const text = parsed.body?.result?.text?.trim();
        if (text) latestText = text;
        if (parsed.type === 9 && parsed.flags === 3) return finish(null, latestText);
      } catch (error) { finish(error); }
    });
    socket.on("unexpected-response", (_request, response) => finish(new Error(`豆包语音识别鉴权失败（HTTP ${response.statusCode || "未知"}）`)));
    socket.on("error", (error) => finish(new Error(`豆包语音识别连接失败：${error.message || "网络异常"}`)));
    socket.on("close", () => { if (!settled) finish(latestText ? null : new Error("豆包语音识别未返回文字")); });
  });
}

function scenarioAnchor(scenario = {}) {
  const anchors = {
    price: "价格/预算：识别家长真正担心的不是报价本身，而是钱花出去后孩子不用、效果不匹配或再次花冤枉钱。",
    will: "孩子意愿：识别孩子抗拒的真实原因，并降低家长强迫孩子的压力。",
    trial: "试听转化：把模糊的试听评价转成孩子是否听得懂、愿不愿继续的可验证事实。",
    delay: "犹豫拖延：分清家长说‘再看看’背后的真实阻碍，并约定低压力的下一步。",
    fit: "课程匹配：厘清孩子最急的学科困难与学习负担，形成最小可行方案。",
    time: "时间冲突：排除家庭真实执行障碍，确认一个能完成的小动作和时间。",
  };
  return anchors[scenario.id] || scenario.goal || "围绕家长本轮最初提出的核心顾虑完成诊断与推进。";
}

const gradeScenarioMap = { price: "价格异议、预算与比价", will: "孩子意愿、抵触与学习动力", trial: "试听、体验、回放与有效期", delay: "用户拒绝留资/隐私顾虑", fit: "学情诊断与薄弱学科", time: "时间安排、执行冲突与跟进" };

function trainingCardContext(scenario = {}) {
  const profile = scenario.trainingProfile || {};
  if (profile.channel !== "训练营私域" || !/^[3-9]$/.test(String(profile.grade || ""))) return "当前训练画像：通用私域。没有启用年级训练卡，只遵循场景主线与课程事实。";
  const card = trainingAssets.grades?.[String(profile.grade)]?.[gradeScenarioMap[scenario.id]];
  if (!card) return "当前训练画像：训练营私域，但此场景没有匹配的年级训练卡，只遵循场景主线与课程事实。";
  const situations = card.situations.map((item) => `情形${item.situation}：触发=${item.trigger}；必补=${item.requiredFacts}；目标=${item.goal}；分支=${item.branches}；禁说=${item.forbidden}；完成=${item.completion}；年级校准=${item.gradeGuidance}`).join("\n");
  return `当前训练画像：${profile.grade}年级 · 训练营私域。已命中蒸馏卡《${card.title}》（${trainingAssets.version}）。\n${situations}\n使用原则：先根据家长真实表达选最贴近的一个情形；一轮只补一个事实，不把三种情形全部问完。推荐表达只学口语节奏，不能逐字复述。若年级校准写明“不强行带入”，不得为了体现年级而生硬提年级。`;
}

function scenarioGuardReply({ scenario = {}, messages = [] }) {
  const guards = {
    price: {
      detour: /二讲|主讲|督课|作业|打电话|答疑|课前|课后|退费|退款|到账|回放|几点|周末|直播互动|服务时段/,
      replies: [
        "这些细节我先记下了，但我最怕的还是钱花了孩子又不用。怎么先判断他这次会不会愿意坚持？",
        "时段和服务可以再确认，我现在更在意孩子会不会又学两周就停了，这笔钱是不是又白花？",
        "我不想先被服务细节说服。先说说怎么判断孩子能不能跟上、愿不愿意继续，这对我更重要。",
      ],
    },
    will: {
      detour: /价格|费用|退费|退款|回放|二讲|时段|几点|服务/,
      replies: ["这些我可以后面再看，我现在最担心的是孩子会不会一开始就抵触。怎么先弄清他的真实想法？", "先不急着聊这些细节，我怕的是孩子又不愿意学。我们怎么判断他到底卡在哪儿？"],
    },
    trial: {
      detour: /价格|费用|退费|退款|二讲|时段|几点|服务/,
      replies: ["这些可以后面再确认，我更想先知道孩子自己听完会不会排斥、能不能听进去。", "先别急着讲服务，我想先让孩子真正听一次，再看他愿不愿意继续。"],
    },
    delay: {
      detour: /课程细节|二讲|回放|服务|时段|价格/,
      replies: ["这些信息我先记下，我现在还没想清楚真正卡的是哪一点，得先把这个说透。", "先别急着补更多细节，我需要先判断这件事到底适不适合我们家。"],
    },
    fit: {
      detour: /价格|退费|退款|二讲|时段|服务/,
      replies: ["这些可以后面再确认，我更想先把孩子最急的学科问题和能承受的学习量弄清楚。", "先不急着讲这些，我想知道数学和物理到底哪一块最该先解决。"],
    },
    time: {
      detour: /价格|退费|退款|二讲|回放|服务细节/,
      replies: ["这些可以后面再确认，我现在最怕的是时间排出来也坚持不了。我们先定一个真能做到的小安排吧。", "先别急着展开服务细节，我想先确认这个时间孩子和我能不能真的执行下来。"],
    },
  };
  const guard = guards[scenario.id];
  if (!guard) return "";
  const parentMessages = messages.filter((item) => item.role === "家长").slice(1);
  const detours = parentMessages.filter((item) => guard.detour.test(item.text || "")).length;
  const alreadyBridged = parentMessages.some((item) => guard.replies.includes(String(item.text || "").trim()));
  if (detours < 1 || alreadyBridged) return "";
  return guard.replies[(parentMessages.length + detours) % guard.replies.length];
}

function buildPrompt({ scenario, messages, readiness }) {
  const anchor = scenarioAnchor(scenario);
  const assetContext = trainingCardContext(scenario);
  const transcript = `${messages.map((item) => `${item.role}：${item.text}`).join("\n")}\n\n【本轮训练锚点】${anchor}\n【锚点护栏】家长可以就顾问刚提出的一个服务细节追问一次；同一支线（服务时段、回放、退费、监督方式等）不得连续追问第二次。若顾问编造未确认服务，先简短表示需要确认，然后立即把话题拉回训练锚点。若此前已经拉回过主线，本轮必须换一个主线维度继续追问，严禁复用前一句或再次讨论服务细节。`;
  const courseFacts = scenario.courseFacts || { delivery: "课程采用在线直播双师大班课形式。", support: "可安排试听、确认内容与学习节奏；直播互动与双师服务以实际课程安排为准。", boundary: "不承诺效果。" };
  return `你是一个真实的中国 K12 家长，在微信里和课程顾问沟通。你必须始终扮演家长，不能变成老师、销售或评价者。\n\n人物背景：${scenario.persona || "普通 K12 家长"}\n表达习惯：${scenario.voice || "自然、简短、有保留"}\n当前场景：${scenario.name || scenario.title || "咨询陪练"}\n起始顾虑：${scenario.parent || scenario.opening || "请结合当前对话判断"}\n课程事实：${courseFacts.delivery} ${courseFacts.support} ${courseFacts.boundary}\n蒸馏训练规则：${assetContext}\n\n对话记录：\n${transcript}\n\n请只输出 JSON，不要 Markdown：{"reply":"家长本轮微信回复", "ready_to_close": true/false}\n硬性要求：\n1. 回复 15-45 个汉字，最多两句，像手机上顺手回的微信；\n2. 每轮只推进一个真实顾虑，不要把所有问题一次问完；\n3. 必须承接顾问刚才的具体内容，再给出新的细节、犹豫或一个追问；\n4. 在线直播双师大班课、课堂互动本身不是错误；只有顾问把未确认的服务说成已包含，或把直播双师大班说成录播/回放时，才像真实家长一样追问澄清；\n5. 禁止客服腔、长段落、编号、总结或教学建议；\n6. 顾问出现提分承诺、稀缺催促或施压时，像真实家长一样表示不舒服或想缓一缓。`;
}

async function askKimi(prompt, maxTokens = 500, options = {}) {
  if (!apiKey || !model) throw new Error("未设置有效的 KIMI_CODING_API_KEY");
  let upstream;
  let lastEmptyResponse = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    upstream = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: options.model || model,
        max_tokens: maxTokens,
        temperature: 0.85,
        ...(options.thinking ? { thinking: options.thinking } : {}),
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
  const forcedReply = scenarioGuardReply(payload);
  if (forcedReply) return forcedReply;
  const cleaned = await askKimi(buildPrompt(payload), 180, {
    model: parentModel,
    thinking: { type: "disabled" },
  });
  const parsed = parseJson(cleaned, {});
  const extracted = parsed.reply || cleaned.match(/"reply"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/)?.[1] || cleaned;
  return extracted.replace(/\\n/g, " ").replace(/^家长[：:]/, "").trim();
}

async function testModelConnection() {
  const reply = await askKimi("你正在进行连通性测试。请只回复：连接正常", 80, {
    model: parentModel,
    thinking: { type: "disabled" },
  });
  return reply.replace(/\s+/g, " ").slice(0, 80);
}

async function getCoachReview({ scenario, transcript: rawTranscript }) {
  const anchor = scenarioAnchor(scenario);
  const assetContext = trainingCardContext(scenario);
  const transcript = `${rawTranscript}\n\n【本轮训练锚点】${anchor}\n【复盘重点】若顾问连续围绕服务细节、时间、退费等支线沟通，未回到训练锚点，要明确指出“被支线带跑偏”，并给出拉回主线的替换句。`;
  const courseFacts = scenario.courseFacts || { delivery: "课程采用在线直播双师大班课形式。", support: "可安排试听、确认内容与学习节奏；直播互动与双师服务以实际课程安排为准。", boundary: "不承诺效果。" };
  const advisorCount = (transcript.match(/^顾问：/gm) || []).length;
  const prompt = `你是带过一线 K12 顾问的业务主管，正在复盘新人对话。只依据下列事实复盘，不虚构课程能力，不承诺效果。\n课程事实：${courseFacts.delivery} ${courseFacts.support} ${courseFacts.boundary}\n\n这不是总结报告，而是逐句教练。对话中一共有 ${advisorCount} 句【顾问】回复，你必须只输出恰好 ${advisorCount} 条 turns，顺序与原对话一致，advisor 必须逐字抄回对应的顾问原话。\n\n逐句规则：\n1. problem 只分析这一句造成的具体问题，不能把整轮的问题复制到每一条；\n2. better_reply 是“这句话当时应该怎样说”的单条替代回复，必须承接当时上一句家长的话，不能拿最后一轮的话术倒灌到前面；\n3. 每条 better_reply 必须不同，不能用相同开头或相同整句。整份复盘中“我理解/我明白”最多出现一次；\n4. 若第一次把课程形式说错，可在该条明确纠正一次。后续再次说错时，只指出仍在重复错误，并把替代句改为推进家长当前问题，禁止反复复制“我们不是直播互动课”；\n5. 不要把“愿意继续沟通”“问题方向基本对”等空话当作 what_worked；没有亮点就写“无明显有效动作”；\n6. 范文必须是顾问微信里真的会说的短句，禁止“赋能、承接、主顾虑、关键事实、闭环、数据跟他谈、淘汰率、保证”等 AI 或压迫性表达。\n\n输出严格 JSON：{"scores":{"empathy":0,"diagnosis":0,"action":0,"compliance":0},"summary":"家长唯一主矛盾 + 对本轮最大判断","missing":["最多2条可执行缺口"],"rewrite":"只给下一轮最该发的一句，和逐句范文不同","turns":[{"turn":1,"advisor":"顾问原话","what_worked":"6-20字具体亮点或无明显有效动作","problem":"15-40字，仅针对本句","better_reply":"18-55字、该时点可直接发出的唯一改写"}],"full_script":"按真实对话节奏写3-5句完整示范，不复用 turns 中的整句"}。\n场景：${scenario.name}\n边界：${scenario.risk}\n对话：\n${transcript}`;
  const correctedPrompt = prompt.replace("若第一次把课程形式说错，可在该条明确纠正一次。后续再次说错时，只指出仍在重复错误，并把替代句改为推进家长当前问题，禁止反复复制“我们不是直播互动课”；", "课程是在线直播双师大班课，不能把直播、双师或课堂互动本身判为错误；只有说成录播/回放，或虚构未确认服务时才纠正。第一次课程形式说错可明确纠正一次，后续回到家长当前问题；");
  const guardedPrompt = `${correctedPrompt}\n\n蒸馏训练规则：${assetContext}\n课程事实硬边界：只可使用“在线直播双师大班课”“可安排试听、确认内容与学习节奏”“互动与双师服务以实际安排为准”。禁止编造旁听几节、不强制连麦、课前找老师打招呼、私下问老师、保证跟上或任何未确认的具体服务。`;
  const fallback = { scores: { empathy: 8, diagnosis: 10, action: 8, compliance: 20 }, summary: "建议逐句确认家长真实顾虑，再推进下一步。", missing: ["围绕家长刚说的内容追问", "避免虚构课程形式"], rewrite: "我先把您最担心的这点确认清楚，再看下一步怎么安排会更合适。", turns: [], full_script: "先把孩子目前最卡的地方说清楚，我们再判断是否适合继续了解。" };
  // 结构化复盘使用与家长相同的稳定 K2.6 路由；提示词已明确限定逐句规则，
  // 关闭思考避免长时间无响应后又退回到重复的本地模板。
  const reviewOptions = { model: parentModel, thinking: { type: "disabled" } };
  const first = parseJson(await askKimi(guardedPrompt, 1500, reviewOptions), fallback);
  const replies = (first.turns || []).map((item) => String(item?.better_reply || "").replace(/\s+/g, ""));
  const valid = Array.isArray(first.turns) && first.turns.length === advisorCount && replies.every(Boolean) && new Set(replies).size === replies.length;
  if (valid) return first;
  const retryPrompt = `${guardedPrompt}\n\n上一次草稿不合格：逐句数量不对或改写重复。请完全重新生成，尤其确保每个 better_reply 都是对应当时语境的不同句子。`;
  return parseJson(await askKimi(retryPrompt, 1500, reviewOptions), first);
}

async function getCopilot({ context }) {
  const prompt = `你是K12顾问的实时辅助驾驶。只基于输入事实，不承诺效果，不制造焦虑，不自动发送。输出严格JSON：{"stage":"当前阶段","concern":"核心顾虑","missing":["缺失信息"],"next":"唯一下一步及完成标准","reply":"一段可编辑、低压力的建议回复"}。\n输入对话：\n${context}`;
  return parseJson(await askKimi(prompt), { stage: "待确认", concern: "需要补充家长真实顾虑", missing: ["孩子具体困难", "可沟通时间"], next: "先确认一条关键事实，再约定回访", reply: "我理解您想先判断是否适合。方便先说说孩子现在最困扰的问题吗？" });
}

http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/config") return json(res, 200, { configured: Boolean(apiKey && model), provider: "Kimi Coding", model: parentModel, parentThinking: "disabled", asrConfigured: Boolean(volcAsrApiKey && volcAsrResourceId) });
    if (req.method === "GET" && req.url === "/api/health") return json(res, 200, { ok: true, configured: Boolean(apiKey && model), asrConfigured: Boolean(volcAsrApiKey && volcAsrResourceId) });
    if (req.method === "POST" && req.url.startsWith("/api/") && !allowRequest(req)) return json(res, 429, { error: "请求过于频繁，请稍后再试。" });
    if (req.method === "POST" && req.url === "/api/model-test") return json(res, 200, { ok: true, provider: "Kimi Coding", model: parentModel, thinking: "disabled", response: await testModelConnection() });
    if (req.method === "POST" && req.url === "/api/asr/transcribe") {
      const audio = await readBuffer(req);
      const text = await transcribeWithVolcAsr(audio);
      return json(res, 200, { text });
    }
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
