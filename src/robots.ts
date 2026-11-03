// A small robots.txt parser. Honouring robots.txt is not required to make this Actor work, and none
// of the competitors checked appear to do it, but it is cheap, it is what a site owner uses to say
// what automated access they want, and a tool that reads other people's websites should be on the
// right side of that. Default on, and the caller can switch it off for their own crawls.
//
// Pure and synchronous: fetching the file lives in crawl.ts so the rules can be unit tested.

export interface RobotsRules {
    /** Path prefixes disallowed for our user agent, longest first. */
    disallow: string[];
    /** Allow rules win over a disallow of equal or shorter length, per the usual convention. */
    allow: string[];
    crawlDelayMs: number | null;
}

export const EMPTY_ROBOTS: RobotsRules = { disallow: [], allow: [], crawlDelayMs: null };

/**
 * Parses robots.txt, taking the most specific group that applies: an exact match on our own token
 * if present, otherwise the `*` group. Groups for other agents are ignored.
 */
export function parseRobots(text: string, userAgentToken = 'nerolabs-seo-audit'): RobotsRules {
    const groups = new Map<string, { disallow: string[]; allow: string[]; crawlDelay: number | null }>();
    let currentAgents: string[] = [];
    let expectingAgents = true;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.split('#')[0].trim();
        if (line === '') continue;
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const field = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();

        if (field === 'user-agent') {
            // A run of consecutive user-agent lines shares one group of rules.
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
            if (field === 'disallow' && value !== '') group.disallow.push(value);
            else if (field === 'allow' && value !== '') group.allow.push(value);
            else if (field === 'crawl-delay') {
                const n = Number(value);
                if (Number.isFinite(n) && n >= 0) group.crawlDelay = n;
            }
        }
    }

    const chosen = groups.get(userAgentToken.toLowerCase()) ?? groups.get('*');
    if (!chosen) return EMPTY_ROBOTS;
    return {
        disallow: [...chosen.disallow].sort((a, b) => b.length - a.length),
        allow: [...chosen.allow].sort((a, b) => b.length - a.length),
        crawlDelayMs: chosen.crawlDelay === null ? null : Math.round(chosen.crawlDelay * 1000),
    };
}

/** Matches a robots path pattern, supporting the `*` wildcard and a trailing `$` anchor. */
function matches(pattern: string, path: string): boolean {
    if (pattern === '') return false;
    const anchored = pattern.endsWith('$');
    const body = anchored ? pattern.slice(0, -1) : pattern;
    if (!body.includes('*')) return anchored ? path === body : path.startsWith(body);
    const escaped = body.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

/** A disallow only wins when no allow rule of at least equal length also matches, per convention. */
export function isAllowed(rules: RobotsRules, pathname: string): boolean {
    const path = pathname || '/';
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
