// AI Crawler Access Check, a GitHub Action (and a plain Node CLI).
// For each URL: reads robots.txt, works out per AI crawler whether it may read the page, then fetches the
// page once with each crawler's published user agent and once as a browser and compares the answers.
// Also looks for /llms.txt. Writes a job summary table, step outputs and annotations, and can fail the
// build when AI search bots are shut out. No dependencies: Node's built-in fetch only.

import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import {
    BOTS, buildFixes, checkRobotsForBot, classifyFetch, hasNoAiDirective, parseLlmsTxt, siteVerdict, summariseBot,
    type BotDef, type BotResult, type FetchVerdict, type LlmsTxtCheck, type ProbeResult, type SiteVerdict,
} from './bots.js';

const VERSION = '1.0.0';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const DEFAULT_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'Meta-ExternalAgent'];
const MAX_URLS = 50;
const ACTOR_URL = 'https://apify.com/nerolabs/ai-crawler-access-checker';

interface Options {
    urls: string[];
    bots: BotDef[];
    failOn: string;
    fetchTest: boolean;
    checkLlms: boolean;
    requireLlms: boolean;
    timeoutMs: number;
}

interface Probe extends ProbeResult {
    finalUrl: string | null;
    contentType: string | null;
    xRobotsTag: string | null;
    body: string;
    error: string | null;
}

interface UrlReport {
    url: string;
    finalUrl: string | null;
    status: 'ok' | 'unreachable' | 'invalid';
    detail: string | null;
    verdict: SiteVerdict | null;
    robotsTxt: 'found' | 'missing' | 'unreachable' | 'refused' | null;
    llmsTxt: LlmsTxtCheck | null;
    noaiDirective: boolean;
    bots: BotResult[];
    fixes: string[];
    failing: string[];
}

const inActions = process.env.GITHUB_ACTIONS === 'true';

function input(name: string, fallback = ''): string {
    const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
    return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function bool(v: string): boolean {
    return /^(true|yes|1|on)$/i.test(v.trim());
}

function splitList(v: string): string[] {
    return v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function pickBots(list: string[]): BotDef[] {
    if (list.length === 1 && list[0].toLowerCase() === 'all') return [...BOTS];
    const wanted = (list.length ? list : DEFAULT_BOTS).map((t) => t.toLowerCase());
    const unknown = wanted.filter((w) => !BOTS.some((b) => b.token.toLowerCase() === w));
    if (unknown.length) warn(`Unknown bot name(s) ignored: ${unknown.join(', ')}. Known: ${BOTS.map((b) => b.token).join(', ')}.`);
    const picked = BOTS.filter((b) => wanted.includes(b.token.toLowerCase()));
    return picked.length ? picked : BOTS.filter((b) => DEFAULT_BOTS.includes(b.token));
}

function normaliseUrl(raw: string): string | null {
    const s = raw.trim();
    if (!s) return null;
    try {
        const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.toString();
    } catch {
        return null;
    }
}

function readOptions(): Options {
    if (inActions) {
        return {
            urls: splitList(input('urls')),
            bots: pickBots(splitList(input('bots'))),
            failOn: input('fail-on', 'search').toLowerCase(),
            fetchTest: bool(input('fetch-test', 'true')),
            checkLlms: bool(input('check-llms-txt', 'true')),
            requireLlms: bool(input('require-llms-txt', 'false')),
            timeoutMs: Math.min(Math.max(Number(input('timeout-seconds', '20')) || 20, 5), 60) * 1000,
        };
    }
    // CLI: node dist/index.js <url> [url...] [--bots a,b] [--fail-on search|any|none|Bot,Bot] [--no-fetch] [--require-llms-txt]
    const args = process.argv.slice(2);
    const urls: string[] = [];
    let bots = '';
    let failOn = 'search';
    let fetchTest = true;
    let requireLlms = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--bots') bots = args[++i] ?? '';
        else if (a === '--fail-on') failOn = (args[++i] ?? 'search').toLowerCase();
        else if (a === '--no-fetch') fetchTest = false;
        else if (a === '--require-llms-txt') requireLlms = true;
        else if (a === '--help' || a === '-h') {
            console.log('Usage: node dist/index.js <url> [url...] [--bots GPTBot,ClaudeBot|all] [--fail-on search|any|none|GPTBot,...] [--no-fetch] [--require-llms-txt]');
            process.exit(0);
        } else urls.push(a);
    }
    return { urls, bots: pickBots(splitList(bots)), failOn, fetchTest, checkLlms: true, requireLlms, timeoutMs: 20_000 };
}

// ----- GitHub workflow commands -----
function escapeData(s: string): string {
    return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function warn(msg: string): void {
    console.log(inActions ? `::warning::${escapeData(msg)}` : `WARNING: ${msg}`);
}
function annotate(level: 'error' | 'warning' | 'notice', title: string, msg: string): void {
    if (inActions) console.log(`::${level} title=${escapeData(title).replace(/:/g, '%3A').replace(/,/g, '%2C')}::${escapeData(msg)}`);
}
function setOutput(name: string, value: string): void {
    const file = process.env.GITHUB_OUTPUT;
    if (!file) return;
    const delim = `EOF_${randomBytes(8).toString('hex')}`;
    appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
}
function summary(md: string): void {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file) appendFileSync(file, md);
}

// ----- network -----
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

function looksLikeChallenge(status: number | null, html: string): boolean {
    const head = html.slice(0, 20000);
    if (/<title>\s*(Just a moment\.\.\.|Attention Required! \| Cloudflare|Pardon Our Interruption|Access denied|Access to this page has been denied|Robot Check|Robot or human\?|Are you a robot|Request unsuccessful\. Incapsula incident|Security Checkpoint|Vercel Security Checkpoint)/i.test(head)) return true;
    if (/cf-browser-verification|challenge-platform\/h\/[a-z]|_Incapsula_Resource|\/_Incapsula_|px-captcha|captcha-delivery\.com|perimeterx/i.test(head) && html.length < 60000) return true;
    return status === 503 && /cloudflare|captcha|challenge/i.test(head);
}

async function probe(url: string, userAgent: string, timeoutMs: number, maxBytes: number): Promise<Probe> {
    const none: Probe = { httpStatus: null, challenge: false, noAnswer: true, finalUrl: null, contentType: null, xRobotsTag: null, body: '', error: null };
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8', 'accept-language': 'en-GB,en;q=0.9' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (res.body) {
            const reader = res.body.getReader();
            while (total < maxBytes) {
                const { done, value } = await reader.read();
                if (done || !value) break;
                chunks.push(value);
                total += value.byteLength;
            }
            await reader.cancel().catch(() => undefined);
        }
        const body = Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
        return {
            httpStatus: res.status, challenge: looksLikeChallenge(res.status, body), noAnswer: false, finalUrl: res.url || url,
            contentType: res.headers.get('content-type'), xRobotsTag: res.headers.get('x-robots-tag'), body, error: null,
        };
    } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
        return { ...none, error: timedOut ? `No answer within ${Math.round(timeoutMs / 1000)} s.` : `Could not reach the site${e.cause?.code ? ` (${e.cause.code})` : ''}.` };
    }
}

async function probeTwice(url: string, ua: string, timeoutMs: number): Promise<Probe> {
    const first = await probe(url, ua, timeoutMs, 8 * 1024);
    if (!first.noAnswer) return first;
    await sleep(1500);
    return probe(url, ua, timeoutMs, 8 * 1024);
}

const pr = (p: Probe): ProbeResult => ({ httpStatus: p.httpStatus, challenge: p.challenge, noAnswer: p.noAnswer });

// ----- the check -----
function isFailing(r: BotResult, failOn: string): boolean {
    if (!r.blocked || failOn === 'none') return false;
    if (failOn === 'any') return true;
    if (failOn === 'search') return r.purpose === 'search' || r.purpose === 'user_action';
    return splitList(failOn).map((s) => s.toLowerCase()).includes(r.token.toLowerCase());
}

async function checkUrl(raw: string, o: Options): Promise<UrlReport> {
    const base: UrlReport = { url: raw, finalUrl: null, status: 'invalid', detail: null, verdict: null, robotsTxt: null, llmsTxt: null, noaiDirective: false, bots: [], fixes: [], failing: [] };
    const url = normaliseUrl(raw);
    if (!url) return { ...base, detail: 'Not a valid http or https URL.' };
    const browser = await probe(url, BROWSER_UA, o.timeoutMs, 64 * 1024);
    if (browser.noAnswer) return { ...base, url, status: 'unreachable', detail: browser.error ?? 'No answer from the site.' };
    const finalUrl = browser.finalUrl ?? url;
    const fin = new URL(finalUrl);

    const rb = await probe(`${fin.origin}/robots.txt`, BROWSER_UA, o.timeoutMs, 512 * 1024);
    let robotsText: string | null;
    let robotsTxt: UrlReport['robotsTxt'];
    if (rb.noAnswer) { robotsText = null; robotsTxt = 'unreachable'; }
    else if (rb.challenge || rb.httpStatus === 401 || rb.httpStatus === 403 || rb.httpStatus === 429) { robotsText = null; robotsTxt = 'refused'; }
    else if ((rb.httpStatus ?? 0) >= 500) { robotsText = null; robotsTxt = 'unreachable'; }
    else if (rb.httpStatus === 200 && !/<html|<!doctype html/i.test(rb.body.slice(0, 500)) && !/html/i.test(rb.contentType ?? '')) {
        robotsText = rb.body; robotsTxt = rb.body.trim() === '' ? 'missing' : 'found';
    } else { robotsText = ''; robotsTxt = 'missing'; }

    let llms: LlmsTxtCheck | null = null;
    if (o.checkLlms || o.requireLlms) {
        const l = await probe(`${fin.origin}/llms.txt`, BROWSER_UA, o.timeoutMs, 200 * 1024);
        llms = parseLlmsTxt(l.httpStatus, l.contentType, l.body);
    }

    const results: BotResult[] = [];
    for (const def of o.bots) {
        const robots = checkRobotsForBot(robotsText, def.token, fin.pathname + fin.search);
        let fv: FetchVerdict = 'not_tested';
        let fs: number | null = null;
        if (o.fetchTest && def.userAgent) {
            const res = await probeTwice(url, def.userAgent, o.timeoutMs);
            fv = classifyFetch(pr(browser), pr(res));
            fs = res.httpStatus;
            // Bot protection sometimes refuses a spoofed user agent at random; a block only counts if a second try is refused too.
            if (fv === 'blocked') {
                await sleep(2000 + Math.round(Math.random() * 1500));
                const again = await probe(url, def.userAgent, o.timeoutMs, 8 * 1024);
                const second = classifyFetch(pr(browser), pr(again));
                if (second !== 'blocked') { fv = second; fs = again.httpStatus; }
            }
        }
        results.push(summariseBot(def, robots, fv, fs));
    }
    const fixes = buildFixes(results, o.checkLlms ? llms : null);
    const failing = results.filter((r) => isFailing(r, o.failOn)).map((r) => r.token);
    if (o.requireLlms && llms && !llms.found) failing.push('llms.txt');
    return {
        url, finalUrl, status: 'ok', detail: null, verdict: siteVerdict(results), robotsTxt, llmsTxt: llms,
        noaiDirective: hasNoAiDirective(browser.xRobotsTag, browser.body.slice(0, 64 * 1024)), bots: results, fixes, failing,
    };
}

// ----- output -----
function cell(r: BotResult): string {
    if (!r.blocked) return r.robots === 'unknown' && r.fetch !== 'served' ? '❔ unknown' : '✅ allowed';
    return r.blockedBy === 'firewall' ? `⛔ firewall (HTTP ${r.fetchHttpStatus ?? '?'})` : r.blockedBy === 'both' ? '⛔ robots.txt + firewall' : '⛔ robots.txt';
}

function markdown(reports: UrlReport[], o: Options, failed: boolean): string {
    const lines: string[] = ['## AI Crawler Access Check', ''];
    lines.push(failed ? `**Result: failing** (fail-on: \`${o.failOn}\`)` : `**Result: passing** (fail-on: \`${o.failOn}\`)`, '');
    for (const rep of reports) {
        lines.push(`### ${rep.url}`);
        if (rep.status !== 'ok') { lines.push('', `Not checked: ${rep.detail}`, ''); continue; }
        lines.push('', `Verdict: **${rep.verdict?.replace('_', ' ')}** · robots.txt: ${rep.robotsTxt} · llms.txt: ${rep.llmsTxt ? (rep.llmsTxt.found ? 'found' : 'missing') : 'not checked'}${rep.noaiDirective ? ' · noai directive found' : ''}`, '');
        lines.push('| Crawler | Company | Used for | Access | robots.txt | Real fetch |', '|---|---|---|---|---|---|');
        for (const r of rep.bots) {
            const purpose = r.purpose === 'user_action' ? 'user clicks' : r.purpose;
            lines.push(`| ${r.token}${rep.failing.includes(r.token) ? ' ❗' : ''} | ${r.vendor} | ${purpose} | ${cell(r)} | ${r.robots} | ${r.fetch}${r.fetchHttpStatus ? ` (${r.fetchHttpStatus})` : ''} |`);
        }
        if (rep.fixes.length) lines.push('', '**What to fix**', '', ...rep.fixes.map((f) => `- ${f}`));
        lines.push('');
    }
    lines.push('<sub>Real fetch = the page requested with the crawler\'s published user agent from this runner, compared with a normal browser request. Some bot protection only lets the genuine crawler in from its company IP ranges, so a firewall block can be a false alarm and "served" does not prove the real crawler gets in. robots.txt verdicts are exact.</sub>', '');
    lines.push(`<sub>Checking hundreds of sites, or want an email when a site starts blocking AI crawlers? [AI Crawler Access Checker on Apify](${ACTOR_URL}) runs the same check on a schedule with change alerts.</sub>`, '');
    return lines.join('\n');
}

function consoleReport(rep: UrlReport): void {
    console.log(`\n${rep.url}`);
    if (rep.status !== 'ok') { console.log(`  not checked: ${rep.detail}`); return; }
    console.log(`  verdict: ${rep.verdict}   robots.txt: ${rep.robotsTxt}   llms.txt: ${rep.llmsTxt ? (rep.llmsTxt.found ? 'found' : 'missing') : 'not checked'}`);
    for (const r of rep.bots) console.log(`  ${(r.token + (rep.failing.includes(r.token) ? ' !' : '')).padEnd(22)} ${cell(r).replace(/[✅⛔❔] /u, '').padEnd(28)} robots ${r.robots.padEnd(8)} fetch ${r.fetch}`);
    for (const f of rep.fixes) console.log(`  fix: ${f}`);
}

async function main(): Promise<void> {
    const o = readOptions();
    const seen = new Set<string>();
    const urls = o.urls.filter((u) => { const k = u.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    if (urls.length === 0) {
        const msg = 'No URLs given. Set the `urls` input to one or more site URLs (one per line or comma separated).';
        if (inActions) console.log(`::error::${msg}`); else console.error(msg);
        process.exitCode = 1;
        return;
    }
    if (urls.length > MAX_URLS) warn(`Only the first ${MAX_URLS} URLs are checked. For more, use ${ACTOR_URL}`);
    console.log(`AI Crawler Access Check v${VERSION}: ${Math.min(urls.length, MAX_URLS)} URL(s), bots: ${o.bots.map((b) => b.token).join(', ')}, fail-on: ${o.failOn}`);

    const reports: UrlReport[] = [];
    const queue = urls.slice(0, MAX_URLS);
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            const idx = urls.indexOf(next);
            reports[idx] = await checkUrl(next, o);
        }
    });
    await Promise.all(workers);
    const done = reports.filter(Boolean);

    for (const rep of done) {
        consoleReport(rep);
        if (rep.status !== 'ok') annotate('warning', 'AI crawler check skipped', `${rep.url}: ${rep.detail}`);
        for (const r of rep.bots.filter((b) => b.blocked)) {
            annotate(rep.failing.includes(r.token) ? 'error' : 'warning', `${r.token} blocked`, `${rep.url}: ${r.token} (${r.vendor}) is blocked by ${r.blockedBy}. ${r.meaning ?? ''}`);
        }
        if (rep.failing.includes('llms.txt')) annotate('error', 'llms.txt missing', `${rep.url}: no /llms.txt file found.`);
    }

    const failed = done.some((r) => r.failing.length > 0);
    const blockedCount = done.reduce((n, r) => n + r.bots.filter((b) => b.blocked).length, 0);
    const json = done.map((r) => ({
        url: r.url, finalUrl: r.finalUrl, status: r.status, detail: r.detail, verdict: r.verdict, robotsTxt: r.robotsTxt,
        llmsTxtFound: r.llmsTxt ? r.llmsTxt.found : null, noaiDirective: r.noaiDirective, failing: r.failing, fixes: r.fixes,
        bots: r.bots.map((b) => ({ token: b.token, vendor: b.vendor, purpose: b.purpose, blocked: b.blocked, blockedBy: b.blockedBy, robots: b.robots, fetch: b.fetch, fetchHttpStatus: b.fetchHttpStatus })),
    }));
    setOutput('report', JSON.stringify(json));
    setOutput('blocked-count', String(blockedCount));
    setOutput('result', failed ? 'fail' : 'pass');
    setOutput('blocked-bots', [...new Set(done.flatMap((r) => r.bots.filter((b) => b.blocked).map((b) => b.token)))].join(','));
    summary(markdown(done, o, failed));

    console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${blockedCount} blocked crawler result(s) across ${done.length} URL(s).`);
    console.log(`Scheduled checks with change alerts for many sites: ${ACTOR_URL}`);
    if (failed) process.exitCode = 1;
}

main().catch((err) => {
    const msg = `AI Crawler Access Check crashed: ${(err as Error).message}`;
    if (inActions) console.log(`::error::${escapeData(msg)}`); else console.error(msg);
    process.exitCode = 1;
});
