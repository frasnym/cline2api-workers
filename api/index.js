/**
 * cline2api - Cloudflare Workers 版
 *
 * 逆向自 https://github.com/luawei1/cline2api (Go 版反向代理)
 *
 * 核心逻辑：
 *  1. 每次请求用 refreshToken 换 accessToken（缓存到内存，过期自动刷新）
 *  2. 把 OpenAI / Anthropic 请求转发到 https://api.cline.bot/api/v1/chat/completions
 *  3. SSE 流式响应剥掉上游 {data:{...}} 包装，透传给客户端
 *
 * 环境变量：
 *  - CLINE_REFRESH_TOKEN (必需)  Cline 账号的 refreshToken（多行 = 多账号）
 *  - API_KEY                (可选) 自定义访问 key；不设置则每次部署随机生成并打印到日志
 *  - ACCOUNT_STRATEGY       (可选) 多账号调度: round-robin(默认) / random / fill-first
 *
 * 用法（OpenAI 兼容）：
 *   curl https://你的worker/v1/chat/completions \
 *     -H "Authorization: Bearer <API_KEY>" \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"cline/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
 */

const CLINE_API_BASE = "https://api.cline.bot/api/v1";

// 账号池：支持多个 Cline 账号，每个账号独立缓存 accessToken
// CLINE_REFRESH_TOKEN 环境变量可包含多行，每行一个 refreshToken，
// 调度策略由 ACCOUNT_STRATEGY 控制（默认 round-robin 轮流用号），
// 额度用尽(空响应)/限流时自动冷却当前账号并切换到下一个。
// 结构：{ refreshToken, accessToken, expiry, cooldownUntil }
let accounts = [];
let accountIndex = 0;          // round-robin 游标
let currentAccount = null;     // 当前正在使用的账号（串行队列下安全）

// 模型列表：原样使用 Cline /v1/models 返回的完整模型 ID。
// 不人为添加 cline/ 前缀；Telegram 会完整显示这些 ID，避免不同供应商模型名被截断后混淆。
const MODELS = [
  { id: "cline-free/nemotron-3.5-super-vl", upstream: "cline-free/nemotron-3.5-super-vl", provider: "cline", cost: "free" },
  { id: "cline-free/mimo-v2.6-flash", upstream: "cline-free/mimo-v2.6-flash", provider: "cline", cost: "free" },
  { id: "cline-free/muse-spark-1.3-contributor", upstream: "cline-free/muse-spark-1.3-contributor", provider: "cline", cost: "free" },
  { id: "cline-free/solar-mini4", upstream: "cline-free/solar-mini4", provider: "cline", cost: "free" },
  { id: "deepseek/deepseek-v4-flash", upstream: "deepseek/deepseek-v4-flash", provider: "deepseek", cost: "free" },
  { id: "poolside/laguna-s-2.1:free", upstream: "poolside/laguna-s-2.1:free", provider: "poolside", cost: "free" },
  { id: "cline-pass/glm-5.2", upstream: "cline-pass/glm-5.2", provider: "zai", cost: "pass" },
  { id: "cline-pass/deepseek-v4-flash", upstream: "cline-pass/deepseek-v4-flash", provider: "deepseek", cost: "pass" },
  { id: "cline-pass/qwen3.7-max", upstream: "cline-pass/qwen3.7-max", provider: "qwen", cost: "pass" },
  { id: "zai/glm-5.3-flash", upstream: "zai/glm-5.3-flash", provider: "zai", cost: "free" },
];

// ============ 动态模型列表 (2026-08-29) ============
// 优先从 Cline 官方 /v1/models 拉取, 失败回退到上面内置列表。
// 每 10 分钟刷新一次缓存。
let modelsCache = null;
let modelsCacheTime = 0;
const MODELS_TTL = 10 * 60 * 1000; // 10 分钟

async function refreshModels() {
  try {
    const now = Date.now();
    if (modelsCache && now - modelsCacheTime < MODELS_TTL) {
      return modelsCache;
    }
    const resp = await fetch(CLINE_API_BASE + "/models", {
      headers: { "User-Agent": "Mozilla/5.0 (cline2api)" },
    });
    if (!resp.ok) {
      console.log("[models] upstream fetch failed, HTTP", resp.status, "falling back to built-in list");
      return MODELS;
    }
    const data = await resp.json();
    if (!data || !Array.isArray(data.data) || data.data.length === 0) {
      return MODELS;
    }
    // 只保留免费模型: :free 后缀 + Cline 官方免费白名单 (2026-08-29)
    const FREE_WHITELIST = [
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-0731",
      "z-ai/glm-5.3-flash",
      "z-ai/glm-5.2:free",
      "xiaomi/mimo-v2.5",
      "minimax/minimax-m3",
      "poolside/laguna-s-2.1",
      "cline-free/nemotron-3.5-super-vl",
      "cline-free/mimo-v2.6-flash",
      "cline-free/muse-spark-1.3-contributor",
      "cline-free/solar-mini4",
      "cline-free/minimax-m3.1-flash",
    ];
    const baseList = data.data
      .filter((m) => {
        const id = m.id || "";
        if (":batch" in m && m.batch) return false;
        if (id.endsWith(":batch")) return false;
        if (id.includes(":free")) return true;
        if (FREE_WHITELIST.includes(id)) return true;
        return false;
      })
      .map((m) => {
        const id = m.id || "";
        const prefix = id.split("/")[0] || "cline";
        return { id, upstream: id, provider: prefix, cost: "free" };
      });
    // 合并 recommended-models 里的 cline-free 免费模型
    const freeExtra = await refreshFreeModels();
    for (const fm of freeExtra) {
      if (!baseList.some((b) => b.id === fm.id)) baseList.push(fm);
    }
    modelsCache = baseList;
    modelsCacheTime = now;
    console.log("[models] dynamic fetch OK:", modelsCache.length, "models (incl. cline-free channel)");
    return modelsCache;
  } catch (e) {
    console.log("[models] fetch error:", String(e).slice(0, 100), "falling back to built-in list");
    return MODELS;
  }
}


// =====================================================================
// Cline 官方免费模型列表（逆向自插件 recommended-models 接口）
// 官方插件用 https://api.cline.bot/api/v1/ai/cline/recommended-models 获取
// 免费 (cline-free/) 模型。这些模型走官方免费额度，不需要 credits。
// 反之 deepseek/deepseek-v4.1-flash 是付费档，余额不足返回 402 insufficient_credits。
// 动态刷新时同时拉这个接口，把 free 列表合并进模型池。
// ⚠️ 只合并 data.free 分支：
//  - data.clineCloud（如 cline-cloud/deepseek-v4.1-flash）是 Cloud Agents 浏览器沙箱专用，
//    API 侧调用任何 UA/头组合一律 403 "only available via Cline product surfaces"（2026-10 实测），排除。
//  - data.clinePass 需要 ClinePass 付费订阅（$9.99/月，403 ENTITLEMENT_ERROR），排除。
// =====================================================================
async function refreshFreeModels() {
  try {
    const resp = await fetch(CLINE_API_BASE + "/ai/cline/recommended-models", {
      headers: { "User-Agent": "Mozilla/5.0 (cline2api)" },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const list = Array.isArray(data?.free) ? data.free : [];
    return list
      .filter((m) => m && m.id)
      .map((m) => ({ id: m.id, upstream: m.id, provider: m.id.split("/")[0] || "cline", cost: "free" }));
  } catch (e) {
    return [];
  }
}

// 默认模型：Cline 官方免费通道（2026-10 名单：nemotron-3.5-super-vl / mimo-v2.6-flash /
//   muse-spark-1.3-contributor / solar-mini4）。deepseek-v4.1-flash 已被官方下架。
const DEFAULT_MODEL = "cline-free/nemotron-3.5-super-vl";
const VERSION = "1.3.0";

// =====================================================================
// Vercel Edge Function 入口
// 与根目录 worker.js（Cloudflare Workers）同源，逻辑完全一致，
// 仅部署入口与区域声明不同；改动时两份需同步。
// Vercel Edge Function：区域在文件内声明（文档标准写法），美区 iad1/sfo1
export const config = { runtime: "edge", regions: ["iad1", "sfo1"] };

// 原 Cloudflare Worker 版：export default { fetch(request, env) }
// Vercel Edge Runtime 直接支持 Web API（Request/Response/fetch），
// 唯一差异是环境变量从 process.env 读取，这里统一转成 env 对象传入。
// =====================================================================
export default async function handler(request) {
  const env = {
    CLINE_REFRESH_TOKEN: process.env.CLINE_REFRESH_TOKEN || '',
    API_KEY: process.env.API_KEY || '',
    ACCOUNT_STRATEGY: process.env.ACCOUNT_STRATEGY || '',
  };
  return await clineFetchHandler(request, env);
}

// 原 Worker 的 fetch 处理器（逻辑完全不变，只是拆成独立函数）
async function clineFetchHandler(request, env) {
  const url = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // 健康诊断端点（无需鉴权，用于排查环境变量是否生效）
    if (request.method === "GET" && url.pathname === "/v1/health") {
      const poolN = parseAccounts(env).length;
      return jsonResponse({
        ok: true,
        version: VERSION,
        authenticated: !!(env.API_KEY),
        accounts: poolN,
        strategy: parseStrategy(env),
        model: DEFAULT_MODEL,
      }, 200);
    }

    // 全局鉴权：所有端点都需要 API Key（除 OPTIONS 预检）
    // 若未配置 API_KEY，则使用内置默认 key "cline2api-default-key"
    // (可选) 设 API_KEY="" 表示完全关闭鉴权
    // GET /v1/models —— 免鉴权，让 GUI 验证能拉到模型列表
    // （chat 等写端点仍强制鉴权；models 公开是 kilo 等代理的标准做法）
    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return handleModels();
    }

    // POST 聊天端点
    if (request.method === "POST") {
      if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
        return handleChat(request, env);
      }
      if (url.pathname === "/v1/messages" || url.pathname === "/messages") {
        return handleAnthropic(request, env);
      }
      // Anthropic count_tokens：Claude Code 每轮调用，粗估 chars/4
      if (url.pathname === "/v1/messages/count_tokens" || url.pathname === "/messages/count_tokens") {
        try {
          const req = await request.json();
          let chars = 0;
          if (req.system) chars += typeof req.system === "string" ? req.system.length : JSON.stringify(req.system).length;
          for (const m of req.messages || []) {
            chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
          }
          return jsonResponse({ input_tokens: Math.ceil(chars / 4) }, 200);
        } catch {
          return jsonResponse({ input_tokens: 0 }, 200);
        }
      }
    }

    return jsonResponse({ error: { message: "Not found", type: "not_found" } }, 404);
}

// ---------------------------------------------------------------------------
// Token 管理
// ---------------------------------------------------------------------------

// 从环境变量解析账号池：CLINE_REFRESH_TOKEN 每行一个
function parseAccounts(env) {
  const raw = env.CLINE_REFRESH_TOKEN || "";
  const tokens = raw.split("\n").map((s) => s.trim()).filter((s) => s.length > 8);
  if (tokens.length === 0) return [];

  // 若 token 列表变化（增删账号），重建账号池
  const changed =
    accounts.length !== tokens.length ||
    accounts.some((a, i) => a.refreshToken !== tokens[i]);
  if (changed) {
    accounts = tokens.map((rt) => ({
      refreshToken: rt,
      accessToken: null,
      expiry: 0,
      cooldownUntil: 0,
    }));
  }
  return accounts;
}

// 取得当前账号的 accessToken（独立缓存，失效/冷却则刷新）
async function getAccountToken(account) {
  const now = Date.now();
  // 冷却期内不可用
  if (account.cooldownUntil > now) {
    throw new Error("account_cooldown");
  }
  if (account.accessToken && now < account.expiry) {
    return account.accessToken;
  }
  const resp = await fetch(CLINE_API_BASE + "/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refreshToken: account.refreshToken,
      grantType: "refresh_token",
    }),
  });
  if (!resp.ok) {
    // 刷新失败：冷却 60s，交给上层切号
    let bodySnippet = "";
    try { bodySnippet = (await resp.clone().text()).slice(0, 200); } catch (e) {}
    console.log(`[refresh] failed status=${resp.status} body=${bodySnippet} tokenLen=${account.refreshToken?.length || 0}`);
    account.cooldownUntil = now + 60 * 1000;
    throw new Error("refresh_failed");
  }
  const data = await resp.json();
  const accessToken = data?.data?.accessToken;
  if (!accessToken) {
    console.log(`[refresh] no_token keys=${Object.keys(data || {}).join(",")}|dataKeys=${Object.keys(data?.data || {}).join(",")}`);
    account.cooldownUntil = now + 60 * 1000;
    throw new Error("refresh_no_token");
  }
  account.accessToken = accessToken;
  // Cline 会在刷新时轮换 refreshToken；必须保存新 token，避免下一次刷新 invalid_grant。
  if (typeof data?.data?.refreshToken === "string" && data.data.refreshToken.trim()) {
    account.refreshToken = data.data.refreshToken.trim();
  }
  // 过期时间：优先服务端，兜底 10 分钟，留 60s 余量
  const expiresAt = data?.data?.expiresAt;
  let expiry = now + 10 * 60 * 1000;
  if (typeof expiresAt === "number") {
    expiry = expiresAt;
  } else if (typeof expiresAt === "string") {
    const t = Date.parse(expiresAt);
    if (!isNaN(t)) expiry = t;
  }
  account.expiry = expiry - 60000;
  return accessToken;
}

// 账号调度策略（环境变量 ACCOUNT_STRATEGY，v1.1.9）：
//  - round-robin (默认): 请求轮流使用各账号 1→2→3→1→…，均匀分摊用量。
//    游标是 isolate 内存变量：本代理有全局串行队列，单 isolate 内严格轮转；
//    多 isolate 并存/冷启动时为近似均匀（要求严格均匀可用 random）。
//  - random:           每次请求随机洗牌选号，多 isolate 下分布最均匀。
//  - fill-first:       黏住列表第一个健康账号，冷却/刷新失败才切下一个
//                      （= v1.1.8 及以前版本的实际行为，当时宣称 round-robin 但从未生效）。
function parseStrategy(env) {
  const s = (env.ACCOUNT_STRATEGY || "").trim().toLowerCase();
  if (s === "random") return "random";
  if (s === "fill-first" || s === "fill_first" || s === "fillfirst") return "fill-first";
  return "round-robin";
}

// 按调度策略生成本次请求尝试账号的下标顺序（冷却跳过与失败切换由 getAccessToken 处理）
function candidateOrder(n, strategy) {
  const idx = [...Array(n).keys()];
  if (strategy === "fill-first") return idx;
  if (strategy === "random") {
    // Fisher-Yates 洗牌：随机顺序尝试
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx;
  }
  // round-robin：从游标处旋转一周，游标前移一位
  const start = accountIndex % n;
  accountIndex = (accountIndex + 1) % n;
  return idx.map((k) => (start + k) % n);
}

async function getAccessToken(env) {
  const pool = parseAccounts(env);
  if (pool.length === 0) {
    throw new Error("missing CLINE_REFRESH_TOKEN env var");
  }
  // 按策略顺序尝试账号（跳过冷却中的；刷新失败自动切下一个）
  const order = candidateOrder(pool.length, parseStrategy(env));
  for (const i of order) {
    const acc = pool[i];
    if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) continue;
    currentAccount = acc;
    try {
      return await getAccountToken(acc);
    } catch (e) {
      continue; // 刷新失败也切下个号（getAccountToken 内已给该账号设置了冷却）
    }
  }
  // 全部冷却/失败，清掉首选账号的冷却重试一次
  const acc = pool[order[0]];
  currentAccount = acc;
  acc.cooldownUntil = 0;
  try {
    return await getAccountToken(acc);
  } catch (e) {
    throw new Error("all accounts failed to refresh token");
  }
}

// Cline 客户端指纹请求头（官方靠这些头识别"是不是 Cline 客户端"）
// 缺少会被 403: "deepseek/deepseek-v4-flash is only available via Cline product surfaces"
// 关键：Cline API 会检查请求头，无伪装头的请求会被 403（"only available via Cline
// product surfaces"）。以下头伪装成 Cline 官方客户端（3.0.47），成功绕过。
// 验证：同 refreshToken，curl 裸测 → 403；走 clineHeaders → 429 限流（正常额度状态）。
// ⚠️ 升级/同步时务必保留这些头，否则 deepseek 免费通道直接 403。
function clineHeaders(sessionId) {
  return {
    Authorization: "Bearer workos:" + currentToken,
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
    "User-Agent": "Cline/3.0.47",
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-sdk",
    "X-CLIENT-VERSION": "3.0.47",
    "X-PLATFORM": "terminal",
    "X-PLATFORM-VERSION": "3.0.47",
    "X-CORE-VERSION": "0.0.66",
    "X-Task-ID": sessionId,
  };
}

// 当前账号的 accessToken（供 clineHeaders 使用）
let currentToken = "";

async function clineFetch(env, path, bodyObj, sessionId, retried = false) {
  const acc = currentAccount || null;
  const token = await getAccessToken(env);
  currentToken = token;
  const headers = clineHeaders(sessionId);
  headers.Authorization = "Bearer workos:" + token;
  const resp = await fetch(CLINE_API_BASE + path, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
  });
  if (resp.status === 401 && !retried) {
    // token 失效：标记当前账号冷却，强制重试（会用别的账号/刷新）
    if (currentAccount) {
      currentAccount.cooldownUntil = Date.now() + 60 * 1000;
      currentAccount.accessToken = null;
      currentAccount.expiry = 0;
    }
    return clineFetch(env, path, bodyObj, sessionId, true);
  }
  return resp;
}

// ---------------------------------------------------------------------------
// 并发限流队列：上游免费通道并发超过 1 就返回空响应，这里强制串行 + 间隔
// ---------------------------------------------------------------------------

let queueTail = Promise.resolve(); // 全局串行队列尾巴
const MIN_GAP_MS = 800;            // 两次上游请求最小间隔

function enqueue(fn) {
  // 前一个任务结束后，等待间隔，再执行 fn
  const run = queueTail.then(() => sleep(MIN_GAP_MS)).then(fn);
  // 不管成功失败都继续链，避免队列断裂
  queueTail = run.catch(() => {});
  return run;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 解析上游 429/限流响应里的等待时间，返回毫秒
// 支持格式: "Try again in 2h 51m" / "Try again in 30m" / "Try again in 1h" / "Try again in 15s"
function parseCooldown(body, status) {
  const m = (body || "").match(/try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m) {
    const h = parseInt(m[1] || 0, 10);
    const min = parseInt(m[2] || 0, 10);
    const s = parseInt(m[3] || 0, 10);
    const ms = (h * 3600 + min * 60 + s) * 1000;
    if (ms > 0) return Math.min(ms, 6 * 3600 * 1000); // 上限 6 小时
  }
  // 429 默认 5 分钟；空响应默认 60 秒
  if (status === 429) return 5 * 60 * 1000;
  return 60 * 1000;
}

// 带重试的 clineFetch：429限流/空响应/5xx 自动切换账号 + 指数退避重试
// 一个号额度用完或限流(429 Daily free limit reached)时：
//   - 冷却该账号（冷却时长按上游提示，如 2h51m）
//   - 自动轮换到下一个号重试同一请求
// 所有账号都冷却时，直接返回原始响应（不空转）
// ---- 流式探测（issue #8 修复配套）----
function isLimitSignal(text) {
  if (!text) return false;
  return text.includes("empty response content") ||
         text.includes("Daily free limit") ||
         text.includes("INFERENCE_CAP_ERROR");
}

async function peekStreamHead(resp, maxWaitMs) {
  try {
    const reader = resp.body.getReader();
    const timer = new Promise((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), maxWaitMs));
    const first = await Promise.race([reader.read(), timer]);
    if (first.done) {
      try { reader.releaseLock(); } catch {}
      return { head: "", chunk: null };
    }
    reader.releaseLock();
    const chunk = first.value;
    const head = new TextDecoder().decode(chunk, { stream: true });
    return { head, chunk };
  } catch (e) {
    return { head: "", chunk: null };
  }
}

function reattachStreamHead(resp, headChunk) {
  if (!headChunk || !resp.body) return resp;
  const { readable, writable } = new TransformStream();
  (async () => {
    const writer = writable.getWriter();
    try {
      await writer.write(headChunk);
      writer.releaseLock();        // ⚠️ pipeTo 要求 writable 未被锁；不释放会直接抛错断流
      await resp.body.pipeTo(writable);
    } catch (e) {
      try { await writer.abort(); } catch {}
    }
  })();
  return new Response(readable, { status: resp.status, headers: resp.headers });
}

async function clineFetchWithRetry(env, path, bodyObj, sessionId, isStream = false, maxRetries = 4) {
  let lastResp = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 通过队列串行执行，避免并发空响应
    const resp = await enqueue(() => clineFetch(env, path, bodyObj, sessionId));
    lastResp = resp;

    // 统一读 body（clone 不消耗流）
    let bodyText = "";
    let headChunk = null;
    try {
      if (isStream && resp.ok && resp.body) {
        const peek = await peekStreamHead(resp, 3000);
        bodyText = peek.head;
        headChunk = peek.chunk || null;
      } else {
        bodyText = await resp.clone().text();
      }
    } catch (e) {}

    // 判定"额度/限流"信号（需要切号）：
    // 1. 429（Daily free limit reached / rate limit）
    // 2. 5xx 且含 empty response content
    // 3. 200 非流式但 body 是空响应包装
    // 4. 200 流式但首个 chunk 就是限流/空响应信号
    const isLimitHit =
      resp.status === 429 ||
      (resp.status >= 500 && bodyText.includes("empty response content")) ||
      (resp.ok && !isStream && bodyText.includes("empty response content")) ||
      (resp.ok && isStream && isLimitSignal(bodyText));

    if (isLimitHit) {
      const cooldownMs = parseCooldown(bodyText, resp.status);
      if (currentAccount) {
        currentAccount.cooldownUntil = Date.now() + cooldownMs;
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        console.log(`[account-switch] quota/rate limit hit, cooling down ${Math.round(cooldownMs / 1000)}s, switching to next account`);
      }
      // 还有可用账号 → 短退避后重试（会切到下一个号）
      const pool = parseAccounts(env);
      const hasOther = pool.some((a) => !a.cooldownUntil || a.cooldownUntil <= Date.now());
      if (!hasOther) {
        console.log(`[retry] all accounts cooling down, returning upstream response as-is`);
        return resp; // 不空转，把 429/错误返回给客户端
      }
      try { if (resp.body) await resp.body.cancel(); } catch {}
      await sleep(500 + Math.floor(Math.random() * 500));
      continue;
    }

    // 正常响应（200）
    if (resp.ok) {
      if (isStream) return reattachStreamHead(resp, headChunk); // 流式：首 chunk 由探测读走，回填再转发
      return resp;               // 非流式：body 已确认非空响应
    }

    // 其他错误（403/400/401 等）不重试，直接返回
    return resp;
  }
  // 重试次数用完，返回最后一次响应
  return lastResp;
}

// ---------------------------------------------------------------------------
// OpenAI 协议
// ---------------------------------------------------------------------------

async function handleChat(request, env) {
  // API Key 鉴权
  const key = getApiKey(request, env);
  if (!key) {
    return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
  }

  let params;
  try {
    params = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }

  const isStream = !!params.stream;
  const sessionId = "sess_" + Date.now();
  const model = params.model || DEFAULT_MODEL;
  const modelConfig = (await refreshModels()).find((m) => m.id === model);
  const upstreamModel = modelConfig?.upstream || model;

  // 构造上游 body（外部模型 ID 与 Cline 上游模型 ID 分离）
  const body = {
    model: upstreamModel,
    session_id: sessionId,
    reasoning_effort: params.reasoning_effort || params.reasoningEffort || "high",
    messages: params.messages || [],
  };
  // ⚠️ 上游风控: 免费模型请求体带 max_tokens 字段一律 500 "empty response content"，剥离
  // ⚠️ 免费 DeepSeek 通道：非流式请求被上游限流(500 empty response content)，
  //    流式请求正常。所以客户端要非流式时，强制上游走 stream，再聚合返回。
  const forceStream = !isStream && (upstreamModel.startsWith("deepseek/") || upstreamModel.startsWith("cline-free/") || upstreamModel.startsWith("cline-pass/"));
  if (isStream || forceStream) body.stream = true;
  // 透传可选参数
  for (const k of ["temperature", "top_p", "tools", "tool_choice", "stop", "presence_penalty", "frequency_penalty", "response_format", "user", "n", "seed"]) {
    if (params[k] !== undefined) body[k] = params[k];
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, true);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      // 客户端要流式：直接透传 SSE
      return streamResponse(resp, model);
    }
    if (forceStream) {
      // 客户端要非流式 + 上游是流式：聚合 chunks 再返回
      // ⚠️ 免费通道(deepseek/cline-free)会概率性返回「HTTP200但content全程为空」的流
      //    （100个chunk全是reasoning，无正式content）。这里做内容检测：空则切号重试。
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, resp);
      if (retried.error) return retried.error;
      retried.data.model = model;
      return jsonResponse(retried.data, 200);
    }
    // 非流式 + 非 deepseek：原逻辑
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    normalized.model = model;
    return jsonResponse(normalized, 200);
  } catch (e) {
    return jsonResponse({ error: { message: e.message, type: "api_error" } }, 500);
  }
}

// 把上游 SSE 流聚合成 OpenAI 非流式响应对象
// 用于"客户端要非流式，但上游只能流式"的情况（deepseek 免费通道）
// 额外处理：上游 200 但 content 全空（只有 reasoning）→ 视为坏响应，切号重试
// 由调用方传入"已获取的上游响应"，这里负责聚合 + content 检测 + 空则重试。
async function nonStreamWithContentCheck(env, path, bodyObj, sessionId, firstResp) {
  const maxAttempts = 3; // 最多试 3 次（覆盖多账号切换）
  let lastData = null;
  let resp = firstResp;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!resp) {
      // 需要重新发起上游请求（空响应重试时）
      resp = await clineFetchWithRetry(env, path, bodyObj, sessionId, true);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { error: jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status) };
    }
    const ct = resp.headers.get("content-type") || "";
    let normalized = null;
    if (ct.includes("text/event-stream")) {
      normalized = await streamToNonStream(resp);
    } else {
      const raw = await resp.json().catch(() => null);
      if (raw) normalized = unwrapData(raw);
    }
    if (!normalized) {
      return { error: jsonResponse({ error: { message: "upstream returned non-SSE body", type: "api_error" } }, 502) };
    }
    lastData = normalized;
    const msg = normalized?.choices?.[0]?.message || {};
    const content = (msg.content || "").trim();
    const reasoning = (msg.reasoning || "").trim();
    // ⚠️ reasoning 兜底标记：content 为空时 streamToNonStream 会把 reasoning 拼进 content，
    //    这里要识别出来，不能把它当成"好响应"。
    const isReasoningFallback = msg.reasoning_used_as_content === true;
    if (content && !isReasoningFallback) {
      return { data: normalized }; // 有正式 content → 好响应
    }
    // content 为空（或只有兜底 reasoning）：如果只有 reasoning，标记当前账号冷却并重试
    if (reasoning || isReasoningFallback) {
      if (currentAccount) {
        currentAccount.cooldownUntil = Date.now() + 30 * 1000; // 短冷却 30s
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        console.log(`[empty-content] account ${attempt} returned empty content, 30s cooldown, retry #${attempt + 2}`);
      }
      await sleep(300 + Math.floor(Math.random() * 300));
      resp = null; // 下次循环重新请求（切到下一个号）
      continue;
    }
    // 完全空（连 reasoning 都没有）→ 也重试
    console.log(`[empty-response] account ${attempt} returned fully empty response, retry #${attempt + 2}`);
    await sleep(300 + Math.floor(Math.random() * 300));
    resp = null;
  }
  // 重试用完仍空：返回最后一次（至少带 reasoning，让客户端看到点东西）
  return { data: lastData };
}

async function streamToNonStream(upstream) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let model = "";
  let id = "";
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const normalized = unwrapData(obj);
        const choice = normalized?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning) reasoning += delta.reasoning;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (normalized.id) id = normalized.id;
        if (normalized.model) model = normalized.model;
        if (normalized.usage) usage = normalized.usage;
      } catch {}
    }
  }

  const msg = { role: "assistant", content };
  if (reasoning) msg.reasoning = reasoning;
  // ⚠️ 兜底：免费通道偶尔整个流只有 reasoning 没有 content（HTTP 200 但空）。
  //    聚合后发现 content 仍为空且 reasoning 非空时，把 reasoning 拼进 content，
  //    保证客户端（qwenpaw 等）至少能收到可见内容，不会"静默不回复"。
  if (!content && reasoning) {
    msg.content = reasoning;
    msg.reasoning_used_as_content = true;
  }
  return {
    id: id || "gen_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [{
      index: 0,
      message: msg,
      finish_reason: finishReason || "stop",
      logprobs: null,
      native_finish_reason: finishReason || "stop",
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API → 转 OpenAI 格式再转发
// ---------------------------------------------------------------------------

async function handleAnthropic(request, env) {
  const key = getApiKey(request, env);
  if (!key) {
    return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
  }

  let req;
  try {
    req = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }

  const isStream = !!req.stream;
  const sessionId = "sess_" + Date.now();
  const requestedModel = req.model || DEFAULT_MODEL;
  const modelConfig = (await refreshModels()).find((m) => m.id === requestedModel);
  const upstreamModel = modelConfig?.upstream || requestedModel;

  // Anthropic → OpenAI 消息转换
  const messages = [];
  if (req.system) {
    const sysContent = typeof req.system === "string" ? req.system : JSON.stringify(req.system);
    messages.push({ role: "system", content: sysContent });
  }
  for (const m of req.messages || []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (Array.isArray(m.content)) {
      const parts = [];
      const toolCalls = [];
      const toolResults = [];
      for (const blk of m.content) {
        if (blk?.type === "text") parts.push(blk.text || "");
        else if (blk?.type === "tool_use") {
          toolCalls.push({ id: blk.id, type: "function", function: { name: blk.name, arguments: JSON.stringify(blk.input || {}) } });
        } else if (blk?.type === "tool_result") {
          const inner = typeof blk.content === "string" ? blk.content
            : Array.isArray(blk.content) ? blk.content.filter((x) => x?.type === "text").map((x) => x.text).join("\n")
            : JSON.stringify(blk.content ?? "");
          toolResults.push({ role: "tool", tool_call_id: blk.tool_use_id || blk.id || "", content: inner });
        } else if (blk?.type === "image") {
          parts.push("[image omitted]");
        }
      }
      if (toolResults.length > 0) messages.push(...toolResults);
      if (toolCalls.length > 0) {
        messages.push({ role: "assistant", content: parts.join("\n") || "", tool_calls: toolCalls });
      } else if (parts.length > 0) {
        messages.push({ role: m.role, content: parts.join("\n") });
      }
      continue;
    }
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    messages.push({ role: m.role, content });
  }

  const body = {
    model: upstreamModel,
    session_id: sessionId,
    reasoning_effort: "high",
    messages,
  };
  // ⚠️ 上游风控: 免费模型请求体带 max_tokens 字段一律 500，剥离（同 chat/completions 路径）
  // ⚠️ 免费 DeepSeek 通道：非流式被上游限流，强制上游 stream 再聚合
  const forceStream = !isStream && (upstreamModel.startsWith("deepseek/") || upstreamModel.startsWith("cline-free/") || upstreamModel.startsWith("cline-pass/"));
  if (isStream || forceStream) body.stream = true;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.tools) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || {} },
    }));
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, true);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      // 上游是 OpenAI SSE，转成 Anthropic SSE 格式
      return streamResponseAnthropic(resp, requestedModel);
    }
    if (forceStream) {
      // 客户端要非流式 + 上游是流式：聚合后再转 Anthropic
      // ⚠️ 同样做 content 检测：免费通道会概率性返回"200但content全空"的流，空则切号重试
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, resp);
      if (retried.error) return retried.error;
      return jsonResponse(openAItoAnthropic(retried.data), 200);
    }
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    // OpenAI → Anthropic
    return jsonResponse(openAItoAnthropic(normalized), 200);
  } catch (e) {
    return jsonResponse({ error: { message: e.message, type: "api_error" } }, 500);
  }
}

// ---------------------------------------------------------------------------
// 响应处理
// ---------------------------------------------------------------------------

// 剥掉上游 {data:{...}} 包装（上游有时包一层 data）
function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object") {
    const d = obj.data;
    if (d.choices || d.id || d.usage) return d;
  }
  return obj;
}

// OpenAI SSE 流式透传（剥 data 包装）
async function streamResponse(upstream, externalModel) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buf = "";
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // 按行处理
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") {
              await writer.write(encoder.encode(line + "\n\n"));
              continue;
            }
            try {
              const obj = JSON.parse(payload);
              const normalized = unwrapData(obj);
              if (normalized && externalModel) normalized.model = externalModel;
              await writer.write(encoder.encode("data: " + JSON.stringify(normalized) + "\n\n"));
            } catch {
              await writer.write(encoder.encode(line + "\n"));
            }
          } else {
            await writer.write(encoder.encode(line + "\n"));
          }
        }
      }
    } catch (e) {
      // ignore
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

// Anthropic SSE：把上游 OpenAI chunk 转成 Anthropic 格式
async function streamResponseAnthropic(upstream, externalModel) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buf = "";
  let modelId = externalModel || "";
  let messageId = "msg_" + Date.now();
  let messageStarted = false;
  let textBlockOpen = false;   // 当前文本 content_block 是否已 start
  const toolBlocks = new Map(); // toolIndex -> { id, name, started }
  let nextToolIndex = 0;
  const sse = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            const normalized = unwrapData(obj);
            if (normalized?.model && !modelId) modelId = normalized.model;
            const choice = normalized?.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};
            const fr = choice.finish_reason;

            // message_start 只发一次
            if (!messageStarted) {
              messageStarted = true;
              await writer.write(sse("message_start", {
                type: "message_start",
                message: { id: messageId, type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
              }));
            }

            // 文本增量 → text content_block（首个文本 delta 前 open block）
            if (delta.content) {
              if (!textBlockOpen) {
                textBlockOpen = true;
                await writer.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
              }
              await writer.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } }));
            }

            // 工具调用增量 → 独立 tool_use content_block（按 index 累积 id/name/参数）
            for (const tc of delta.tool_calls || []) {
              const tcKey = (tc.index !== undefined && tc.index !== null) ? tc.index : 0;
              let blk = toolBlocks.get(tcKey);
              if (!blk) {
                blk = { id: tc.id || ("toolu_" + Date.now() + "_" + tcKey), name: "", started: false, index: 1 + nextToolIndex };
                nextToolIndex++;
                toolBlocks.set(tcKey, blk);
              }
              if (tc.function?.name) blk.name += tc.function.name;
              // 冷启动首个 delta 通常带 id+name，此时即打开 tool_use 块
              if (!blk.started && (blk.id)) {
                blk.started = true;
                await writer.write(sse("content_block_start", { type: "content_block_start", index: blk.index, content_block: { type: "tool_use", id: blk.id, name: blk.name, input: {} } }));
              }
              const args = tc.function?.arguments;
              if (args !== undefined && args !== null) {
                await writer.write(sse("content_block_delta", { type: "content_block_delta", index: blk.index, delta: { type: "input_json_delta", partial_json: args } }));
              }
            }

            // finish_reason 有值 → 关掉所有打开的块
            if (fr) {
              if (textBlockOpen) {
                textBlockOpen = false;
                await writer.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
              }
              for (const blk of toolBlocks.values()) {
                if (blk.started) {
                  await writer.write(sse("content_block_stop", { type: "content_block_stop", index: blk.index }));
                  blk.started = false;
                }
              }
            }
          } catch {}
        }
      }
      // 上游没有 finish_reason 的兜底：关块
      if (textBlockOpen) await writer.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      for (const blk of toolBlocks.values()) if (blk.started) await writer.write(sse("content_block_stop", { type: "content_block_stop", index: blk.index }));
      // 若连 message_start 都没发过（空流），补发以满足 SDK 完整性
      if (!messageStarted) {
        await writer.write(sse("message_start", {
          type: "message_start",
          message: { id: messageId, type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
        }));
      }
      const stopReason = toolBlocks.size > 0 ? "tool_use" : "end_turn";
      await writer.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 0 } }));
      await writer.write(sse("message_stop", { type: "message_stop" }));
    } catch (e) {
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

// OpenAI 非流式 → Anthropic 非流式
function openAItoAnthropic(openAI) {
  const choice = openAI?.choices?.[0];
  const msg = choice?.message || {};
  const content = [];
  const text = msg.content || "";
  if (text) content.push({ type: "text", text });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: tc.id || ("toolu_" + Date.now()), name: tc.function?.name || "", input });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: openAI?.id || ("msg_" + Date.now()),
    type: "message",
    role: "assistant",
    model: openAI?.model || "",
    content,
    stop_reason: (msg.tool_calls?.length || 0) > 0 ? "tool_use" : "end_turn",
    usage: {
      input_tokens: openAI?.usage?.prompt_tokens || 0,
      output_tokens: openAI?.usage?.completion_tokens || 0,
    },
  };
}
// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async function handleModels() {
  const list = await refreshModels();
  const payload = list.map((m) => ({
    id: m.id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "cline",
  }));
  return jsonResponse({ object: "list", data: payload }, 200, { "X-Cline2api-Version": VERSION });
}

function getApiKey(request, env) {
  const provided = env.API_KEY;
  // 未配置 API_KEY → 使用内置默认 key
  const expected = provided !== undefined && provided !== null && provided !== "" ? provided : "cline2api-default-key";

  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7) === expected ? expected : null;
  }
  const xKey = request.headers.get("x-api-key");
  return xKey === expected ? expected : null;
}

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
  };
}

