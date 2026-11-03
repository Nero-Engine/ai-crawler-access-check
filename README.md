# AI Crawler Access Check (GitHub Action)

**Is your site blocking GPTBot, ChatGPT search, ClaudeBot or PerplexityBot without you knowing?** This GitHub Action checks your live site on every deploy (or every week) and fails the build when an AI search crawler is shut out, by `robots.txt` **or** by your firewall or CDN.

A single copied `robots.txt` line, a WordPress SEO plugin update or a Cloudflare "block AI bots" switch can quietly remove you from ChatGPT search, Perplexity and Claude answers. This catches it the day it happens.

[![self-test](https://github.com/Nero-Engine/ai-crawler-access-check/actions/workflows/self-test.yml/badge.svg)](https://github.com/Nero-Engine/ai-crawler-access-check/actions/workflows/self-test.yml)

## What it checks

For every URL you give it:

1. **robots.txt, per AI crawler.** Reads your `robots.txt` and works out, for each crawler, whether it may read that exact page (own group first, then the `*` group, `Allow` beats an equal or shorter `Disallow`, `*` and `$` wildcards supported).
2. **A real fetch with each crawler's user agent.** Requests the page as GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot and Meta-ExternalAgent, and once as a normal browser, then compares. A 403, 429 or a "Just a moment..." challenge page for the bot, while the browser is served, is a **firewall block** that robots.txt never shows.
3. **llms.txt.** Looks for `/llms.txt` and tells you when it is missing (or fails the build if you ask it to).
4. **noai directives** in `X-Robots-Tag` or the robots meta tag.

Crawlers checked by default:

| Crawler | Company | Used for |
|---|---|---|
| GPTBot | OpenAI | model training |
| OAI-SearchBot | OpenAI | ChatGPT search results |
| ChatGPT-User | OpenAI | opening a page when a user asks |
| ClaudeBot | Anthropic | model training |
| Claude-SearchBot | Anthropic | Claude search results |
| PerplexityBot | Perplexity | Perplexity answers |
| Google-Extended | Google | Gemini training and grounding (not Google Search) |
| Meta-ExternalAgent | Meta | model training |

Also available with `bots: all`: Claude-User, Applebot-Extended, CCBot (Common Crawl).

## Quick start

```yaml
# .github/workflows/ai-crawler-check.yml
name: AI crawler access
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 7 * * 1'   # every Monday
  workflow_dispatch:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: Nero-Engine/ai-crawler-access-check@v1
        with:
          urls: |
            https://www.your-site.com
            https://www.your-site.com/blog
```

By default the step **fails only when a search or user-click crawler is blocked** (OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot, Claude-User). Blocking training crawlers such as GPTBot is a normal choice, so it is reported as a warning, not a failure.

The job summary shows a table per URL:

| Crawler | Company | Used for | Access | robots.txt | Real fetch |
|---|---|---|---|---|---|
| GPTBot | OpenAI | training | ⛔ robots.txt | blocked | served (200) |
| OAI-SearchBot ❗ | OpenAI | search | ⛔ robots.txt | blocked | served (200) |
| PerplexityBot ❗ | Perplexity | search | ⛔ firewall (HTTP 403) | allowed | blocked (403) |

plus a "What to fix" list in plain sentences, and an annotation on the run for every blocked crawler.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `urls` | (required) | One or more URLs, one per line or comma separated, up to 50. `example.com` works. |
| `bots` | 8 above | Comma separated crawler names, or `all`. |
| `fail-on` | `search` | `search`, `any`, `none` (report only), or a list of crawler names that must be allowed, e.g. `OAI-SearchBot,PerplexityBot`. |
| `fetch-test` | `true` | Also run the real fetch test to catch firewall and CDN blocks. |
| `check-llms-txt` | `true` | Look for `/llms.txt`. |
| `require-llms-txt` | `false` | Fail when `/llms.txt` is missing. |
| `timeout-seconds` | `20` | Per request timeout (5 to 60). |

## Outputs

| Output | Example |
|---|---|
| `result` | `pass` or `fail` |
| `blocked-count` | `3` |
| `blocked-bots` | `GPTBot,PerplexityBot` |
| `report` | JSON array, one object per URL with `verdict`, `robotsTxt`, `llmsTxtFound`, `failing`, `fixes` and per crawler `blocked`, `blockedBy` (`robots.txt`, `firewall`, `both`), `robots`, `fetch`, `fetchHttpStatus` |

Use it in a later step:

```yaml
      - id: ai
        uses: Nero-Engine/ai-crawler-access-check@v1
        with:
          urls: https://www.your-site.com
          fail-on: none
      - if: steps.ai.outputs.blocked-count != '0'
        run: echo "Blocked: ${{ steps.ai.outputs.blocked-bots }}"
```

## Run it locally

No install, no dependencies, Node 20 or newer:

```bash
git clone https://github.com/Nero-Engine/ai-crawler-access-check
node ai-crawler-access-check/dist/index.js https://www.your-site.com --fail-on search
```

Flags: `--bots GPTBot,ClaudeBot|all`, `--fail-on search|any|none|<names>`, `--no-fetch`, `--require-llms-txt`. Exit code 1 means failing.

## How accurate is it?

- **robots.txt verdicts are exact**, read the same way the crawlers read them.
- **The real fetch test is a strong hint, not proof.** It sends each crawler's published user agent from the GitHub runner. Some bot protection lets the genuine crawler in by checking the company's published IP ranges, so a firewall block here can be a false alarm for the real crawler, and "served" does not guarantee the real one gets in. A block only counts if a second try a few seconds later is refused too.
- If the site refuses even the browser request (common on heavily protected sites from data centre IPs), the fetch result is `not_comparable` and only robots.txt is judged.
- Google-Extended, Applebot-Extended, Claude-SearchBot and Claude-User are robots.txt control tokens, so they are checked in robots.txt only.

## Many sites, or alerts when something changes?

This action is free and checks up to 50 URLs per run. To check hundreds or thousands of client sites from a CSV, Google Sheet or dataset, on a schedule, with a "now blocked" alert only when something changes, use [AI Crawler Access Checker on Apify](https://apify.com/nerolabs/ai-crawler-access-checker) (same check, pay per URL, MCP and API ready).

## Licence

MIT. Made by [Nero Labs](https://apify.com/nerolabs).
