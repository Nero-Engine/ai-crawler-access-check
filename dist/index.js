// src/main.ts
var import_node_fs = require("node:fs");
var import_node_crypto = require("node:crypto");

// src/robots.ts
var EMPTY_ROBOTS = { disallow: [], allow: [], crawlDelayMs: null };
function parseRobots(text, userAgentToken = "nerolabs-seo-audit") {
  const groups = /* @__PURE__ */ new Map();
  let currentAgents = [];
  let expectingAgents = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!expectingAgents) {
        currentAgents = [];
        expectingAgents = true;
      }
      currentAgents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), { disallow: [], allow: [], crawlDelay: null });
      continue;
    }
    expectingAgents = false;
    for (const agent of currentAgents) {
      const group = groups.get(agent);
      if (!group) continue;
      if (field === "disallow" && value !== "") group.disallow.push(value);
      else if (field === "allow" && value !== "") group.allow.push(value);
      else if (field === "crawl-delay") {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) group.crawlDelay = n;
      }
    }
  }
  const chosen = groups.get(userAgentToken.toLowerCase()) ?? groups.get("*");
  if (!chosen) return EMPTY_ROBOTS;
  return {
    disallow: [...chosen.disallow].sort((a, b) => b.length - a.length),
    allow: [...chosen.allow].sort((a, b) => b.length - a.length),
    crawlDelayMs: chosen.crawlDelay === null ? null : Math.round(chosen.crawlDelay * 1e3)
  };
}
function matches(pattern, path) {
  if (pattern === "") return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  if (!body.includes("*")) return anchored ? path === body : path.startsWith(body);
  const escaped = body.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(path);
}
function isAllowed(rules, pathname) {
  const path = pathname || "/";
  let longestDisallow = -1;
  for (const rule of rules.disallow) {
    if (matches(rule, path)) {
      longestDisallow = Math.max(longestDisallow, rule.length);
      break;
    }
  }
  if (longestDisallow === -1) return true;
  for (const rule of rules.allow) {
    if (matches(rule, path) && rule.length >= longestDisallow) return true;
  }
  return false;
}

// src/bots.ts
var BOTS = [
  {
    token: "GPTBot",
    field: "gptbot",
    vendor: "OpenAI",
    purpose: "training",
    blockMeaning: "OpenAI will not use this site to train its models.",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot"
  },
  {
    token: "OAI-SearchBot",
    field: "oaiSearchbot",
    vendor: "OpenAI",
    purpose: "search",
    blockMeaning: "The site can be left out of ChatGPT search results.",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot"
  },
  {
    token: "ChatGPT-User",
    field: "chatgptUser",
    vendor: "OpenAI",
    purpose: "user_action",
    blockMeaning: "ChatGPT cannot open this site when a user asks it to.",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot"
  },
  {
    token: "ClaudeBot",
    field: "claudebot",
    vendor: "Anthropic",
    purpose: "training",
    blockMeaning: "Anthropic will not use this site to train Claude.",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"
  },
  {
    token: "PerplexityBot",
    field: "perplexitybot",
    vendor: "Perplexity",
    purpose: "search",
    blockMeaning: "The site can be left out of Perplexity answers.",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)"
  },
  {
    token: "Meta-ExternalAgent",
    field: "metaExternalagent",
    vendor: "Meta",
    purpose: "training",
    blockMeaning: "Meta will not use this site to train its AI.",
    userAgent: "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)"
  },
  {
    token: "Google-Extended",
    field: "googleExtended",
    vendor: "Google",
    purpose: "training",
    blockMeaning: "Google will not use this site for Gemini training or grounding. Normal Google Search is not affected.",
    userAgent: null
  },
  {
    token: "Applebot-Extended",
    field: "applebotExtended",
    vendor: "Apple",
    purpose: "training",
    blockMeaning: "Apple will not use this site to train its AI. Normal Applebot search is not affected.",
    userAgent: null
  },
  {
    token: "Claude-SearchBot",
    field: "claudeSearchbot",
    vendor: "Anthropic",
    purpose: "search",
    blockMeaning: "The site can be left out of Claude search results.",
    userAgent: null
  },
  {
    token: "Claude-User",
    field: "claudeUser",
    vendor: "Anthropic",
    purpose: "user_action",
    blockMeaning: "Claude cannot open this site when a user asks it to.",
    userAgent: null
  },
  {
    token: "CCBot",
    field: "ccbot",
    vendor: "Common Crawl",
    purpose: "training",
    blockMeaning: "The site is left out of Common Crawl, the open archive many AI models are trained on.",
    userAgent: "CCBot/2.0 (https://commoncrawl.org/faq/)"
  }
];
function hasOwnGroup(robotsText, token) {
  const wanted = token.toLowerCase();
  for (const raw of robotsText.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim().toLowerCase() === "user-agent" && line.slice(idx + 1).trim().toLowerCase() === wanted) return true;
  }
  return false;
}
function checkRobotsForBot(robotsText, token, pathname) {
  if (robotsText === null) return { verdict: "unknown", ruleSource: "none", disallowRules: 0 };
  if (robotsText.trim() === "") return { verdict: "allowed", ruleSource: "none", disallowRules: 0 };
  const rules = parseRobots(robotsText, token);
  const own = hasOwnGroup(robotsText, token);
  const hasWildcard = hasOwnGroup(robotsText, "*");
  const ruleSource = own ? "own_group" : hasWildcard ? "wildcard" : "none";
  return {
    verdict: isAllowed(rules, pathname) ? "allowed" : "blocked",
    ruleSource,
    disallowRules: rules.disallow.length
  };
}
function isRefusal(p) {
  if (p.noAnswer) return false;
  if (p.challenge) return true;
  return p.httpStatus === 401 || p.httpStatus === 403 || p.httpStatus === 429 || p.httpStatus === 451 || p.httpStatus === 406;
}
function classifyFetch(browser, bot) {
  if (bot.noAnswer) return browser.noAnswer ? "not_comparable" : "error";
  const browserOk = !browser.noAnswer && !isRefusal(browser) && browser.httpStatus !== null && browser.httpStatus < 400;
  if (!browserOk) {
    return bot.httpStatus !== null && bot.httpStatus < 400 && !bot.challenge ? "served" : "not_comparable";
  }
  if (isRefusal(bot)) return "blocked";
  if (bot.httpStatus !== null && bot.httpStatus >= 400) return "error";
  return "served";
}
function hasNoAiDirective(xRobotsTag, htmlHead) {
  const re = /\bno(?:ai|imageai)\b/i;
  if (xRobotsTag && re.test(xRobotsTag)) return true;
  if (!htmlHead) return false;
  for (const m of htmlHead.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (/name\s*=\s*["']?(robots|googlebot|bingbot)["']?/i.test(tag) && re.test(tag)) return true;
  }
  return false;
}
function parseLlmsTxt(httpStatus, contentType, body) {
  if (httpStatus !== 200 || !body || body.trim() === "") return { found: false, bytes: null, title: null };
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("html") || /<(!doctype html|html|head|body)\b/i.test(body.slice(0, 1e3))) return { found: false, bytes: null, title: null };
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? null;
  return { found: true, bytes: Buffer.byteLength(body), title };
}
function summariseBot(def, robots, fetchVerdict, fetchHttpStatus) {
  const byRobots = robots.verdict === "blocked";
  const byFirewall = fetchVerdict === "blocked";
  return {
    token: def.token,
    field: def.field,
    vendor: def.vendor,
    purpose: def.purpose,
    robots: robots.verdict,
    ruleSource: robots.ruleSource,
    disallowRules: robots.disallowRules,
    fetch: fetchVerdict,
    fetchHttpStatus,
    blocked: byRobots || byFirewall,
    blockedBy: byRobots && byFirewall ? "both" : byRobots ? "robots.txt" : byFirewall ? "firewall" : null,
    meaning: byRobots || byFirewall ? def.blockMeaning : null
  };
}
function siteVerdict(results) {
  const blocked = results.filter((r) => r.blocked).length;
  if (blocked === 0) {
    const undetermined = results.some((r) => r.robots === "unknown" && r.fetch !== "served");
    return undetermined ? "unverified" : "open";
  }
  return blocked === results.length ? "all_blocked" : "partly_blocked";
}
function buildFixes(results, llms) {
  const fixes = [];
  for (const r of results) {
    if (r.blockedBy === "robots.txt" || r.blockedBy === "both") {
      fixes.push(`${r.token} is disallowed in robots.txt${r.ruleSource === "wildcard" ? " by the * rule" : ""}. ${r.meaning} Remove or narrow that Disallow if you want it let in.`);
    }
    if (r.blockedBy === "firewall") {
      fixes.push(`${r.token} gets HTTP ${r.fetchHttpStatus ?? "?"} from your server or firewall although robots.txt allows it. ${r.meaning} Check your CDN or bot-protection rules.`);
    }
  }
  if (llms && !llms.found) fixes.push("There is no /llms.txt file. It is optional, but it is the page AI assistants are told to read first.");
  return fixes;
}

// src/main.ts
var VERSION = "1.0.0";
var BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
var DEFAULT_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "Meta-ExternalAgent"];
var MAX_URLS = 50;
var ACTOR_URL = "https://apify.com/nerolabs/ai-crawler-access-checker";
var inActions = process.env.GITHUB_ACTIONS === "true";
function input(name, fallback = "") {
  const v = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return v === void 0 || v.trim() === "" ? fallback : v.trim();
}
function bool(v) {
  return /^(true|yes|1|on)$/i.test(v.trim());
}
function splitList(v) {
  return v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}
function pickBots(list) {
  if (list.length === 1 && list[0].toLowerCase() === "all") return [...BOTS];
  const wanted = (list.length ? list : DEFAULT_BOTS).map((t) => t.toLowerCase());
  const unknown = wanted.filter((w) => !BOTS.some((b) => b.token.toLowerCase() === w));
  if (unknown.length) warn(`Unknown bot name(s) ignored: ${unknown.join(", ")}. Known: ${BOTS.map((b) => b.token).join(", ")}.`);
  const picked = BOTS.filter((b) => wanted.includes(b.token.toLowerCase()));
  return picked.length ? picked : BOTS.filter((b) => DEFAULT_BOTS.includes(b.token));
}
function normaliseUrl(raw) {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}
function readOptions() {
  if (inActions) {
    return {
      urls: splitList(input("urls")),
      bots: pickBots(splitList(input("bots"))),
      failOn: input("fail-on", "search").toLowerCase(),
      fetchTest: bool(input("fetch-test", "true")),
      checkLlms: bool(input("check-llms-txt", "true")),
      requireLlms: bool(input("require-llms-txt", "false")),
      timeoutMs: Math.min(Math.max(Number(input("timeout-seconds", "20")) || 20, 5), 60) * 1e3
    };
  }
  const args = process.argv.slice(2);
  const urls = [];
  let bots = "";
  let failOn = "search";
  let fetchTest = true;
  let requireLlms = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--bots") bots = args[++i] ?? "";
    else if (a === "--fail-on") failOn = (args[++i] ?? "search").toLowerCase();
    else if (a === "--no-fetch") fetchTest = false;
    else if (a === "--require-llms-txt") requireLlms = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node dist/index.js <url> [url...] [--bots GPTBot,ClaudeBot|all] [--fail-on search|any|none|GPTBot,...] [--no-fetch] [--require-llms-txt]");
      process.exit(0);
    } else urls.push(a);
  }
  return { urls, bots: pickBots(splitList(bots)), failOn, fetchTest, checkLlms: true, requireLlms, timeoutMs: 2e4 };
}
function escapeData(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function warn(msg) {
  console.log(inActions ? `::warning::${escapeData(msg)}` : `WARNING: ${msg}`);
}
function annotate(level, title, msg) {
  if (inActions) console.log(`::${level} title=${escapeData(title).replace(/:/g, "%3A").replace(/,/g, "%2C")}::${escapeData(msg)}`);
}
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `EOF_${(0, import_node_crypto.randomBytes)(8).toString("hex")}`;
  (0, import_node_fs.appendFileSync)(file, `${name}<<${delim}
${value}
${delim}
`);
}
function summary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) (0, import_node_fs.appendFileSync)(file, md);
}
var sleep = (ms) => new Promise((r) => {
  setTimeout(r, ms);
});
function looksLikeChallenge(status, html) {
  const head = html.slice(0, 2e4);
  if (/<title>\s*(Just a moment\.\.\.|Attention Required! \| Cloudflare|Pardon Our Interruption|Access denied|Access to this page has been denied|Robot Check|Robot or human\?|Are you a robot|Request unsuccessful\. Incapsula incident|Security Checkpoint|Vercel Security Checkpoint)/i.test(head)) return true;
  if (/cf-browser-verification|challenge-platform\/h\/[a-z]|_Incapsula_Resource|\/_Incapsula_|px-captcha|captcha-delivery\.com|perimeterx/i.test(head) && html.length < 6e4) return true;
  return status === 503 && /cloudflare|captcha|challenge/i.test(head);
}
async function probe(url, userAgent, timeoutMs, maxBytes) {
  const none = { httpStatus: null, challenge: false, noAnswer: true, finalUrl: null, contentType: null, xRobotsTag: null, body: "", error: null };
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8", "accept-language": "en-GB,en;q=0.9" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const chunks = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        total += value.byteLength;
      }
      await reader.cancel().catch(() => void 0);
    }
    const body = Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
    return {
      httpStatus: res.status,
      challenge: looksLikeChallenge(res.status, body),
      noAnswer: false,
      finalUrl: res.url || url,
      contentType: res.headers.get("content-type"),
      xRobotsTag: res.headers.get("x-robots-tag"),
      body,
      error: null
    };
  } catch (err) {
    const e = err;
    const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
    return { ...none, error: timedOut ? `No answer within ${Math.round(timeoutMs / 1e3)} s.` : `Could not reach the site${e.cause?.code ? ` (${e.cause.code})` : ""}.` };
  }
}
async function probeTwice(url, ua, timeoutMs) {
  const first = await probe(url, ua, timeoutMs, 8 * 1024);
  if (!first.noAnswer) return first;
  await sleep(1500);
  return probe(url, ua, timeoutMs, 8 * 1024);
}
var pr = (p) => ({ httpStatus: p.httpStatus, challenge: p.challenge, noAnswer: p.noAnswer });
function isFailing(r, failOn) {
  if (!r.blocked || failOn === "none") return false;
  if (failOn === "any") return true;
  if (failOn === "search") return r.purpose === "search" || r.purpose === "user_action";
  return splitList(failOn).map((s) => s.toLowerCase()).includes(r.token.toLowerCase());
}
async function checkUrl(raw, o) {
  const base = { url: raw, finalUrl: null, status: "invalid", detail: null, verdict: null, robotsTxt: null, llmsTxt: null, noaiDirective: false, bots: [], fixes: [], failing: [] };
  const url = normaliseUrl(raw);
  if (!url) return { ...base, detail: "Not a valid http or https URL." };
  const browser = await probe(url, BROWSER_UA, o.timeoutMs, 64 * 1024);
  if (browser.noAnswer) return { ...base, url, status: "unreachable", detail: browser.error ?? "No answer from the site." };
  const finalUrl = browser.finalUrl ?? url;
  const fin = new URL(finalUrl);
  const rb = await probe(`${fin.origin}/robots.txt`, BROWSER_UA, o.timeoutMs, 512 * 1024);
  let robotsText;
  let robotsTxt;
  if (rb.noAnswer) {
    robotsText = null;
    robotsTxt = "unreachable";
  } else if (rb.challenge || rb.httpStatus === 401 || rb.httpStatus === 403 || rb.httpStatus === 429) {
    robotsText = null;
    robotsTxt = "refused";
  } else if ((rb.httpStatus ?? 0) >= 500) {
    robotsText = null;
    robotsTxt = "unreachable";
  } else if (rb.httpStatus === 200 && !/<html|<!doctype html/i.test(rb.body.slice(0, 500)) && !/html/i.test(rb.contentType ?? "")) {
    robotsText = rb.body;
    robotsTxt = rb.body.trim() === "" ? "missing" : "found";
  } else {
    robotsText = "";
    robotsTxt = "missing";
  }
  let llms = null;
  if (o.checkLlms || o.requireLlms) {
    const l = await probe(`${fin.origin}/llms.txt`, BROWSER_UA, o.timeoutMs, 200 * 1024);
    llms = parseLlmsTxt(l.httpStatus, l.contentType, l.body);
  }
  const results = [];
  for (const def of o.bots) {
    const robots = checkRobotsForBot(robotsText, def.token, fin.pathname + fin.search);
    let fv = "not_tested";
    let fs = null;
    if (o.fetchTest && def.userAgent) {
      const res = await probeTwice(url, def.userAgent, o.timeoutMs);
      fv = classifyFetch(pr(browser), pr(res));
      fs = res.httpStatus;
      if (fv === "blocked") {
        await sleep(2e3 + Math.round(Math.random() * 1500));
        const again = await probe(url, def.userAgent, o.timeoutMs, 8 * 1024);
        const second = classifyFetch(pr(browser), pr(again));
        if (second !== "blocked") {
          fv = second;
          fs = again.httpStatus;
        }
      }
    }
    results.push(summariseBot(def, robots, fv, fs));
  }
  const fixes = buildFixes(results, o.checkLlms ? llms : null);
  const failing = results.filter((r) => isFailing(r, o.failOn)).map((r) => r.token);
  if (o.requireLlms && llms && !llms.found) failing.push("llms.txt");
  return {
    url,
    finalUrl,
    status: "ok",
    detail: null,
    verdict: siteVerdict(results),
    robotsTxt,
    llmsTxt: llms,
    noaiDirective: hasNoAiDirective(browser.xRobotsTag, browser.body.slice(0, 64 * 1024)),
    bots: results,
    fixes,
    failing
  };
}
function cell(r) {
  if (!r.blocked) return r.robots === "unknown" && r.fetch !== "served" ? "\u2754 unknown" : "\u2705 allowed";
  return r.blockedBy === "firewall" ? `\u26D4 firewall (HTTP ${r.fetchHttpStatus ?? "?"})` : r.blockedBy === "both" ? "\u26D4 robots.txt + firewall" : "\u26D4 robots.txt";
}
function markdown(reports, o, failed) {
  const lines = ["## AI Crawler Access Check", ""];
  lines.push(failed ? `**Result: failing** (fail-on: \`${o.failOn}\`)` : `**Result: passing** (fail-on: \`${o.failOn}\`)`, "");
  for (const rep of reports) {
    lines.push(`### ${rep.url}`);
    if (rep.status !== "ok") {
      lines.push("", `Not checked: ${rep.detail}`, "");
      continue;
    }
    lines.push("", `Verdict: **${rep.verdict?.replace("_", " ")}** \xB7 robots.txt: ${rep.robotsTxt} \xB7 llms.txt: ${rep.llmsTxt ? rep.llmsTxt.found ? "found" : "missing" : "not checked"}${rep.noaiDirective ? " \xB7 noai directive found" : ""}`, "");
    lines.push("| Crawler | Company | Used for | Access | robots.txt | Real fetch |", "|---|---|---|---|---|---|");
    for (const r of rep.bots) {
      const purpose = r.purpose === "user_action" ? "user clicks" : r.purpose;
      lines.push(`| ${r.token}${rep.failing.includes(r.token) ? " \u2757" : ""} | ${r.vendor} | ${purpose} | ${cell(r)} | ${r.robots} | ${r.fetch}${r.fetchHttpStatus ? ` (${r.fetchHttpStatus})` : ""} |`);
    }
    if (rep.fixes.length) lines.push("", "**What to fix**", "", ...rep.fixes.map((f) => `- ${f}`));
    lines.push("");
  }
  lines.push(`<sub>Real fetch = the page requested with the crawler's published user agent from this runner, compared with a normal browser request. Some bot protection only lets the genuine crawler in from its company IP ranges, so a firewall block can be a false alarm and "served" does not prove the real crawler gets in. robots.txt verdicts are exact.</sub>`, "");
  lines.push(`<sub>Checking hundreds of sites, or want an email when a site starts blocking AI crawlers? [AI Crawler Access Checker on Apify](${ACTOR_URL}) runs the same check on a schedule with change alerts.</sub>`, "");
  return lines.join("\n");
}
function consoleReport(rep) {
  console.log(`
${rep.url}`);
  if (rep.status !== "ok") {
    console.log(`  not checked: ${rep.detail}`);
    return;
  }
  console.log(`  verdict: ${rep.verdict}   robots.txt: ${rep.robotsTxt}   llms.txt: ${rep.llmsTxt ? rep.llmsTxt.found ? "found" : "missing" : "not checked"}`);
  for (const r of rep.bots) console.log(`  ${(r.token + (rep.failing.includes(r.token) ? " !" : "")).padEnd(22)} ${cell(r).replace(/[✅⛔❔] /u, "").padEnd(28)} robots ${r.robots.padEnd(8)} fetch ${r.fetch}`);
  for (const f of rep.fixes) console.log(`  fix: ${f}`);
}
async function main() {
  const o = readOptions();
  const seen = /* @__PURE__ */ new Set();
  const urls = o.urls.filter((u) => {
    const k = u.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (urls.length === 0) {
    const msg = "No URLs given. Set the `urls` input to one or more site URLs (one per line or comma separated).";
    if (inActions) console.log(`::error::${msg}`);
    else console.error(msg);
    process.exitCode = 1;
    return;
  }
  if (urls.length > MAX_URLS) warn(`Only the first ${MAX_URLS} URLs are checked. For more, use ${ACTOR_URL}`);
  console.log(`AI Crawler Access Check v${VERSION}: ${Math.min(urls.length, MAX_URLS)} URL(s), bots: ${o.bots.map((b) => b.token).join(", ")}, fail-on: ${o.failOn}`);
  const reports = [];
  const queue = urls.slice(0, MAX_URLS);
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let next = queue.shift(); next !== void 0; next = queue.shift()) {
      const idx = urls.indexOf(next);
      reports[idx] = await checkUrl(next, o);
    }
  });
  await Promise.all(workers);
  const done = reports.filter(Boolean);
  for (const rep of done) {
    consoleReport(rep);
    if (rep.status !== "ok") annotate("warning", "AI crawler check skipped", `${rep.url}: ${rep.detail}`);
    for (const r of rep.bots.filter((b) => b.blocked)) {
      annotate(rep.failing.includes(r.token) ? "error" : "warning", `${r.token} blocked`, `${rep.url}: ${r.token} (${r.vendor}) is blocked by ${r.blockedBy}. ${r.meaning ?? ""}`);
    }
    if (rep.failing.includes("llms.txt")) annotate("error", "llms.txt missing", `${rep.url}: no /llms.txt file found.`);
  }
  const failed = done.some((r) => r.failing.length > 0);
  const blockedCount = done.reduce((n, r) => n + r.bots.filter((b) => b.blocked).length, 0);
  const json = done.map((r) => ({
    url: r.url,
    finalUrl: r.finalUrl,
    status: r.status,
    detail: r.detail,
    verdict: r.verdict,
    robotsTxt: r.robotsTxt,
    llmsTxtFound: r.llmsTxt ? r.llmsTxt.found : null,
    noaiDirective: r.noaiDirective,
    failing: r.failing,
    fixes: r.fixes,
    bots: r.bots.map((b) => ({ token: b.token, vendor: b.vendor, purpose: b.purpose, blocked: b.blocked, blockedBy: b.blockedBy, robots: b.robots, fetch: b.fetch, fetchHttpStatus: b.fetchHttpStatus }))
  }));
  setOutput("report", JSON.stringify(json));
  setOutput("blocked-count", String(blockedCount));
  setOutput("result", failed ? "fail" : "pass");
  setOutput("blocked-bots", [...new Set(done.flatMap((r) => r.bots.filter((b) => b.blocked).map((b) => b.token)))].join(","));
  summary(markdown(done, o, failed));
  console.log(`
${failed ? "FAIL" : "PASS"}: ${blockedCount} blocked crawler result(s) across ${done.length} URL(s).`);
  console.log(`Scheduled checks with change alerts for many sites: ${ACTOR_URL}`);
  if (failed) process.exitCode = 1;
}
main().catch((err) => {
  const msg = `AI Crawler Access Check crashed: ${err.message}`;
  if (inActions) console.log(`::error::${escapeData(msg)}`);
  else console.error(msg);
  process.exitCode = 1;
});
