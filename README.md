# github-of-life

Conway's Game of Life, animated on the GitHub contribution graph.

## How it works

A Cloudflare Worker runs on two schedules:

- **Every 15 minutes** — ticks GoL forward one generation and rewrites the commit history of this repo so the contribution graph reflects the current pattern.
- **Every day at midnight UTC** — reseeds the board from real GitHub contributions (commits across all repos *except* this one) over the past 52 weeks, resetting to generation 0.

If there are no contributions in the past year, it falls back to a glider seed so the simulation doesn't immediately go extinct.

## Architecture

| File | Purpose |
|------|---------|
| `worker.js` | Cloudflare Worker — GoL logic, GitHub API writes, reseed from contributions |
| `wrangler.toml` | Worker config and cron triggers |
| `seed.js` | One-time bootstrap script — fetches contribution graph, writes KV state, initializes repo |

## State

GoL state (generation number + 52×7 boolean grid) is stored in a Cloudflare KV namespace. The `main` branch of this repo is force-pushed each tick to reflect the alive cells as dated commits.

## Setup

1. Create a Cloudflare Worker and KV namespace
2. Set secrets: `GITHUB_TOKEN` (PAT with `repo` scope), `GITHUB_USER`
3. Run `node seed.js --token <PAT>` to bootstrap
4. `npx wrangler deploy`
