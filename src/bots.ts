// The AI crawlers this Actor can test, and the pure logic that turns a robots.txt, a fetch result
// and an llms.txt into a verdict. No network in here, so it is unit tested on saved text.

import { isAllowed, parseRobots } from './robots.js';

export type BotPurpose = 'training' | 'search' | 'user_action';

export interface BotDef {
    /** The robots.txt product token, as the vendor documents it. */
    token: string;
    /** Prefix of the columns written for this bot. */
    field: string;
    vendor: string;
    purpose: BotPurpose;
    /** What blocking it means, in one plain sentence. */
    blockMeaning: string;
    /** The full User-Agent header sent in the real fetch test. Null = robots.txt-only control token. */
    userAgent: string | null;
}

export const BOTS: BotDef[] = [
    {
        token: 'GPTBot', field: 'gptbot', vendor: 'OpenAI', purpose: 'training',
        blockMeaning: 'OpenAI will not use this site to train its models.',
        userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot',
    },
    {
        token: 'OAI-SearchBot', field: 'oaiSearchbot', vendor: 'OpenAI', purpose: 'search',
        blockMeaning: 'The site can be left out of ChatGPT search results.',
        userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
    },
    {
        token: 'ChatGPT-User', field: 'chatgptUser', vendor: 'OpenAI', purpose: 'user_action',
        blockMeaning: 'ChatGPT cannot open this site when a user asks it to.',
        userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    },
    {
        token: 'ClaudeBot', field: 'claudebot', vendor: 'Anthropic', purpose: 'training',
        blockMeaning: 'Anthropic will not use this site to train Claude.',
        userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    },
    {
        token: 'PerplexityBot', field: 'perplexitybot', vendor: 'Perplexity', purpose: 'search',
        blockMeaning: 'The site can be left out of Perplexity answers.',
        userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    },
    {
        token: 'Meta-ExternalAgent', field: 'metaExternalagent', vendor: 'Meta', purpose: 'training',
        blockMeaning: 'Meta will not use this site to train its AI.',
        userAgent: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    },
    {
        token: 'Google-Extended', field: 'googleExtended', vendor: 'Google', purpose: 'training',
        blockMeaning: 'Google will not use this site for Gemini training or grounding. Normal Google Search is not affected.',
        userAgent: null,
    },
    {
        token: 'Applebot-Extended', field: 'applebotExtended', vendor: 'Apple', purpose: 'training',
        blockMeaning: 'Apple will not use this site to train its AI. Normal Applebot search is not affected.',
        userAgent: null,
    },
    {
        token: 'Claude-SearchBot', field: 'claudeSearchbot', vendor: 'Anthropic', purpose: 'search',
        blockMeaning: 'The site can be left out of Claude search results.',
        userAgent: null,
    },
    {
        token: 'Claude-User', field: 'claudeUser', vendor: 'Anthropic', purpose: 'user_action',
        blockMeaning: 'Claude cannot open this site when a user asks it to.',
        userAgent: null,
    },
    {
        token: 'CCBot', field: 'ccbot', vendor: 'Common Crawl', purpose: 'training',
        blockMeaning: 'The site is left out of Common Crawl, the open archive many AI models are trained on.',
        userAgent: 'CCBot/2.0 (https://commoncrawl.org/faq/)',
    },
];

/** The five bots asked for by default. */
export const DEFAULT_BOT_TOKENS = ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Meta-ExternalAgent'];

export function pickBots(tokens: string[] | undefined): BotDef[] {
    const wanted = (tokens && tokens.length > 0 ? tokens : DEFAULT_BOT_TOKENS).map((t) => t.trim().toLowerCase());
    const picked = BOTS.filter((b) => wanted.includes(b.token.toLowerCase()));
    return picked.length > 0 ? picked : BOTS.filter((b) => DEFAULT_BOT_TOKENS.includes(b.token));
}

export type RobotsVerdict = 'allowed' | 'blocked' | 'unknown';

export interface RobotsCheck {
    verdict: RobotsVerdict;
    /** Which group of rules applied: the bot's own, the wildcard (*) group, or none (no file or no rules). */
    ruleSource: 'own_group' | 'wildcard' | 'none';
    /** How many Disallow lines the applied group has, so "allowed" next to 40 rules is visible. */
    disallowRules: number;
}

/** True when robots.txt has a group addressed to this exact token. */
export function hasOwnGroup(robotsText: string, token: string): boolean {
    const wanted = token.toLowerCase();
    for (const raw of robotsText.split(/\r?\n/)) {
        const line = raw.split('#')[0].trim();
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        if (line.slice(0, idx).trim().toLowerCase() === 'user-agent' && line.slice(idx + 1).trim().toLowerCase() === wanted) return true;
    }
    return false;
}

/**
 * Does robots.txt let this bot read this path? `robotsText` null means the file could not be read at all
 * (an error, not a 404), which is reported as unknown rather than guessed.
 */
export function checkRobotsForBot(robotsText: string | null, token: string, pathname: string): RobotsCheck {
    if (robotsText === null) return { verdict: 'unknown', ruleSource: 'none', disallowRules: 0 };
    if (robotsText.trim() === '') return { verdict: 'allowed', ruleSource: 'none', disallowRules: 0 };
    const rules = parseRobots(robotsText, token);
    const own = hasOwnGroup(robotsText, token);
    const hasWildcard = hasOwnGroup(robotsText, '*');
    const ruleSource = own ? 'own_group' : hasWildcard ? 'wildcard' : 'none';
    return {
        verdict: isAllowed(rules, pathname) ? 'allowed' : 'blocked',
        ruleSource,
        disallowRules: rules.disallow.length,
    };
}

export type FetchVerdict = 'served' | 'blocked' | 'error' | 'not_comparable' | 'not_tested';

export interface ProbeResult {
    /** HTTP status of the final response, null when there was no answer at all. */
    httpStatus: number | null;
    /** A bot-check page (Cloudflare, Akamai, Incapsula and the like) was served instead of the content. */
    challenge: boolean;
    /** No HTTP answer: DNS failure, timeout, connection refused. */
    noAnswer: boolean;
}

export function isRefusal(p: ProbeResult): boolean {
    if (p.noAnswer) return false;
    if (p.challenge) return true;
    return p.httpStatus === 401 || p.httpStatus === 403 || p.httpStatus === 429 || p.httpStatus === 451 || p.httpStatus === 406;
}

/**
 * Compares what a site did for the bot's user agent with what it did for a normal browser.
 * If the browser itself was refused or got no answer, the bot result cannot be judged against it.
 */
export function classifyFetch(browser: ProbeResult, bot: ProbeResult): FetchVerdict {
    if (bot.noAnswer) return browser.noAnswer ? 'not_comparable' : 'error';
    const browserOk = !browser.noAnswer && !isRefusal(browser) && browser.httpStatus !== null && browser.httpStatus < 400;
    if (!browserOk) {
        // The browser was refused too, so this is a site that blocks everything automated, not this bot.
        return bot.httpStatus !== null && bot.httpStatus < 400 && !bot.challenge ? 'served' : 'not_comparable';
    }
    if (isRefusal(bot)) return 'blocked';
    if (bot.httpStatus !== null && bot.httpStatus >= 400) return 'error';
    return 'served';
}

/** A short label for the network edge, from response headers. */
export function edgeHint(headers: Record<string, string>): string | null {
    const h = (name: string): string => headers[name] ?? '';
    if (h('cf-ray') || /cloudflare/i.test(h('server'))) return 'cloudflare';
    if (/akamai/i.test(h('server')) || h('x-akamai-transformed')) return 'akamai';
    if (h('x-vercel-id') || /vercel/i.test(h('server'))) return 'vercel';
    if (h('x-amz-cf-id') || /cloudfront/i.test(h('via'))) return 'cloudfront';
    if (/sucuri/i.test(h('server')) || h('x-sucuri-id')) return 'sucuri';
    if (/fastly/i.test(h('x-served-by')) || h('x-fastly-request-id')) return 'fastly';
    return null;
}

/** True when X-Robots-Tag or a robots meta tag carries a "noai" style directive. */
export function hasNoAiDirective(xRobotsTag: string | null, htmlHead: string | null): boolean {
    const re = /\bno(?:ai|imageai)\b/i;
    if (xRobotsTag && re.test(xRobotsTag)) return true;
    if (!htmlHead) return false;
    for (const m of htmlHead.matchAll(/<meta\b[^>]*>/gi)) {
        const tag = m[0];
        if (/name\s*=\s*["']?(robots|googlebot|bingbot)["']?/i.test(tag) && re.test(tag)) return true;
    }
    return false;
}

export interface LlmsTxtCheck {
    found: boolean;
    bytes: number | null;
    /** The first Markdown heading, which is the site name in a proper llms.txt. */
    title: string | null;
}

/** Decides whether a response body is a real llms.txt, not a homepage or an error page served with HTTP 200. */
export function parseLlmsTxt(httpStatus: number | null, contentType: string | null, body: string | null): LlmsTxtCheck {
    if (httpStatus !== 200 || !body || body.trim() === '') return { found: false, bytes: null, title: null };
    const ct = (contentType ?? '').toLowerCase();
    if (ct.includes('html') || /<(!doctype html|html|head|body)\b/i.test(body.slice(0, 1000))) return { found: false, bytes: null, title: null };
    const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? null;
    return { found: true, bytes: Buffer.byteLength(body), title };
}

export interface BotResult {
    token: string;
    field: string;
    vendor: string;
    purpose: BotPurpose;
    robots: RobotsVerdict;
    ruleSource: RobotsCheck['ruleSource'];
    disallowRules: number;
    fetch: FetchVerdict;
    fetchHttpStatus: number | null;
    /** True when robots.txt or a refused fetch keeps this bot out. */
    blocked: boolean;
    blockedBy: 'robots.txt' | 'firewall' | 'both' | null;
    meaning: string | null;
}

export function summariseBot(def: BotDef, robots: RobotsCheck, fetchVerdict: FetchVerdict, fetchHttpStatus: number | null): BotResult {
    const byRobots = robots.verdict === 'blocked';
    const byFirewall = fetchVerdict === 'blocked';
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
        blockedBy: byRobots && byFirewall ? 'both' : byRobots ? 'robots.txt' : byFirewall ? 'firewall' : null,
        meaning: byRobots || byFirewall ? def.blockMeaning : null,
    };
}

export type SiteVerdict = 'open' | 'partly_blocked' | 'all_blocked' | 'unverified';

/**
 * `unverified` = nothing was found blocking, but for at least one bot nothing could be established either
 * (robots.txt unreadable and the real fetch not served), so "open" would be a guess.
 */
export function siteVerdict(results: BotResult[]): SiteVerdict {
    const blocked = results.filter((r) => r.blocked).length;
    if (blocked === 0) {
        const undetermined = results.some((r) => r.robots === 'unknown' && r.fetch !== 'served');
        return undetermined ? 'unverified' : 'open';
    }
    return blocked === results.length ? 'all_blocked' : 'partly_blocked';
}

/** Plain sentences a site owner can act on. */
export function buildFixes(results: BotResult[], llms: LlmsTxtCheck | null): string[] {
    const fixes: string[] = [];
    for (const r of results) {
        if (r.blockedBy === 'robots.txt' || r.blockedBy === 'both') {
            fixes.push(`${r.token} is disallowed in robots.txt${r.ruleSource === 'wildcard' ? ' by the * rule' : ''}. ${r.meaning} Remove or narrow that Disallow if you want it let in.`);
        }
        if (r.blockedBy === 'firewall') {
            fixes.push(`${r.token} gets HTTP ${r.fetchHttpStatus ?? '?'} from your server or firewall although robots.txt allows it. ${r.meaning} Check your CDN or bot-protection rules.`);
        }
    }
    if (llms && !llms.found) fixes.push('There is no /llms.txt file. It is optional, but it is the page AI assistants are told to read first.');
    return fixes;
}

export interface Snapshot {
    checkedAt: string;
    bots: Record<string, { robots: RobotsVerdict; fetch: FetchVerdict }>;
    llmsTxtFound: boolean | null;
    robotsTxtHash: string | null;
}

/** Plain-English differences between two snapshots of the same URL. Empty means nothing changed. */
export function diffSnapshots(prev: Snapshot, next: Snapshot): string[] {
    const changes: string[] = [];
    for (const [token, now] of Object.entries(next.bots)) {
        const before = prev.bots[token];
        if (!before) {
            changes.push(`${token}: now being checked (robots.txt ${now.robots}, fetch ${now.fetch}).`);
            continue;
        }
        if (before.robots !== now.robots && before.robots !== 'unknown' && now.robots !== 'unknown') {
            changes.push(`${token}: robots.txt went from ${before.robots} to ${now.robots}.`);
        }
        const wasBlocked = before.fetch === 'blocked';
        const isBlocked = now.fetch === 'blocked';
        if (wasBlocked !== isBlocked && before.fetch !== 'not_tested' && now.fetch !== 'not_tested' && before.fetch !== 'not_comparable' && now.fetch !== 'not_comparable') {
            changes.push(`${token}: server ${isBlocked ? 'now refuses it' : 'no longer refuses it'} (was ${before.fetch}, now ${now.fetch}).`);
        }
    }
    if (prev.llmsTxtFound !== null && next.llmsTxtFound !== null && prev.llmsTxtFound !== next.llmsTxtFound) {
        changes.push(next.llmsTxtFound ? 'llms.txt was added.' : 'llms.txt was removed.');
    }
    if (changes.length === 0 && prev.robotsTxtHash && next.robotsTxtHash && prev.robotsTxtHash !== next.robotsTxtHash) {
        changes.push('robots.txt text changed, but no checked bot is affected.');
    }
    return changes;
}
