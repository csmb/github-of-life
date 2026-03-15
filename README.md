# github-of-life

Conway's Game of Life, animated on the GitHub contribution graph.

![Conway's Game of Life on the GitHub contribution graph](https://raw.githubusercontent.com/csmb/github-of-life/source/contribution-graph.gif)

## How it works

A Cloudflare Worker runs every minute, ticking GoL forward one generation and rewriting the commit history of this repo so the contribution graph reflects the current alive cells.

The repo is deleted and recreated on every tick so dead cells immediately disappear from the graph. Alive cells are written as dated commits; GitHub renders them as green squares.

At midnight UTC the board is reseeded with a fresh random pattern. On extinction it reseeds automatically.

## Architecture

| File | Purpose |
|------|---------|
| `worker.js` | Cloudflare Worker — GoL logic, GitHub API writes, random reseed |
| `wrangler.toml` | Worker config and cron triggers |
| `capture.js` | Local script — renders GoL frames and assembles `contribution-graph.gif` |

## State

GoL state (generation + 52×7 boolean grid) is stored in a Cloudflare KV namespace. The `main` branch is force-pushed each tick to reflect the current pattern.

## Setup

1. Create a Cloudflare Worker and KV namespace
2. Set secrets: `GITHUB_TOKEN` (PAT with `repo` + `delete_repo` scopes), `GITHUB_USER`
3. Seed initial KV state via `npx wrangler secret put GITHUB_TOKEN`
4. `npx wrangler deploy`
