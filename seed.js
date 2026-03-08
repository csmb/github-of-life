#!/usr/bin/env node
// seed.js — Run once locally to bootstrap the GoL state.
//
// Usage:
//   node seed.js --token <GITHUB_PAT> --user <GITHUB_USERNAME>
//
// What it does:
//   1. Fetches contribution graph via GitHub GraphQL API
//   2. Maps 52×7 grid: alive if contributionCount > 0
//   3. Writes state to Cloudflare KV via wrangler CLI
//   4. Creates the initial root commit in github-of-life so the branch exists

import { execSync } from "child_process";

const COLS = 52;
const ROWS = 7;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const REPO = "github-of-life";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}

const TOKEN = getArg("token") || process.env.GITHUB_TOKEN;
const USER = getArg("user") || process.env.GITHUB_USER || "csmb";

if (!TOKEN) {
  console.error("Error: --token <PAT> is required (or set GITHUB_TOKEN env var)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function ghGraphQL(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "github-of-life-seed",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function ghFetch(path, method, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "github-of-life-seed",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// 1. Fetch contribution graph
// ---------------------------------------------------------------------------
async function fetchContributionGrid() {
  // We need ~52 weeks of data. GitHub's contributionCalendar returns up to 1 year.
  const now = new Date();
  const from = new Date(now);
  from.setFullYear(from.getFullYear() - 1);

  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  const data = await ghGraphQL(query, {
    login: USER,
    from: from.toISOString(),
    to: now.toISOString(),
  });

  const weeks = data.user.contributionsCollection.contributionCalendar.weeks;

  // Take the last 52 weeks
  const last52 = weeks.slice(-52);

  // Build flat cells array: col * 7 + row
  const cells = new Array(COLS * ROWS).fill(false);
  last52.forEach((week, col) => {
    week.contributionDays.forEach((day, row) => {
      cells[col * ROWS + row] = day.contributionCount > 0;
    });
  });

  const alive = cells.filter(Boolean).length;
  console.log(`Fetched contribution graph: ${alive} alive cells across ${last52.length} weeks.`);
  return cells;
}

// ---------------------------------------------------------------------------
// 2. Initialize the repo so the branch exists for the Worker to force-push
// ---------------------------------------------------------------------------
async function initializeRepo() {
  // The Git Data API rejects operations on completely empty repos.
  // Use the Contents API to create a seed file — this initializes the git
  // backend and creates the main branch in one call.
  const content = Buffer.from("github-of-life: Conway's Game of Life on the GitHub contribution graph\n").toString("base64");
  try {
    await ghFetch(`/repos/${USER}/${REPO}/contents/README.md`, "PUT", {
      message: "GoL seed: initialize repo",
      content,
    });
    console.log("Repo initialized with seed commit.");
  } catch (e) {
    // If the file already exists the worker will overwrite history anyway.
    console.log(`Repo init skipped (may already exist): ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Write state to Cloudflare KV via wrangler
// ---------------------------------------------------------------------------
function writeKVState(cells) {
  const state = JSON.stringify({ generation: 0, cells });
  // Escape single quotes in the JSON for shell safety
  const escaped = state.replace(/'/g, "'\\''");
  const cmd = `npx wrangler kv:key put --binding GOL_STATE state '${escaped}'`;
  console.log("Writing state to Cloudflare KV...");
  try {
    execSync(cmd, { stdio: "inherit" });
    console.log("KV state written successfully.");
  } catch (e) {
    console.error("Failed to write KV state. Make sure wrangler is configured and you're logged in.");
    console.error("You can also run manually:");
    console.error(`  ${cmd}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log(`Seeding github-of-life for user: ${USER}`);

  const cells = await fetchContributionGrid();
  writeKVState(cells);
  await initializeRepo();

  console.log("\nSeed complete!");
  console.log("Next steps:");
  console.log("  1. Verify KV:   wrangler kv:key get --binding GOL_STATE state");
  console.log("  2. Deploy:      wrangler deploy");
  console.log(`  3. Check:       https://github.com/${USER}`);
})();
