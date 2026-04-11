#!/usr/bin/env node
// seed.js — Run once locally to bootstrap the Rule 30 CA.
//
// Usage:
//   node seed.js
//
// What it does:
//   1. Deletes the old gol-graph repo (clean slate)
//   2. Creates a fresh gol-graph repo with a README
//   3. Writes initial Rule 30 state to Cloudflare KV

import { execSync } from "child_process";

const REPO = "gol-graph";

// ---------------------------------------------------------------------------
// Config — reads from .dev.vars or env
// ---------------------------------------------------------------------------
import { readFileSync } from "fs";

let TOKEN, USER, EMAIL;
try {
  const vars = readFileSync(".dev.vars", "utf8");
  for (const line of vars.split("\n")) {
    const [key, ...rest] = line.split("=");
    const val = rest.join("=").trim();
    if (key.trim() === "GITHUB_TOKEN") TOKEN = val;
    if (key.trim() === "GITHUB_USER") USER = val;
    if (key.trim() === "GITHUB_EMAIL") EMAIL = val;
  }
} catch {}

TOKEN = TOKEN || process.env.GITHUB_TOKEN;
USER = USER || process.env.GITHUB_USER || "csmb";
EMAIL = EMAIL || process.env.GITHUB_EMAIL;

if (!TOKEN) {
  console.error("Error: GITHUB_TOKEN required (in .dev.vars or env)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GitHub API helper
// ---------------------------------------------------------------------------
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
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${await res.text()}`);
  }
  if (res.status === 204 || res.status === 404) return { status: res.status };
  return res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log(`Seeding Rule 30 CA for user: ${USER}\n`);

  // 1. Delete old repo
  console.log(`Deleting ${USER}/${REPO}...`);
  const del = await ghFetch(`/repos/${USER}/${REPO}`, "DELETE", null);
  if (del.status === 404) {
    console.log("  (repo didn't exist)");
  } else {
    console.log("  Deleted.");
  }

  // 2. Create fresh repo
  console.log(`Creating ${USER}/${REPO}...`);
  await ghFetch("/user/repos", "POST", {
    name: REPO,
    private: false,
    auto_init: false,
    description: "Rule 30 cellular automaton on the GitHub contribution graph",
  });

  // Initialize with README so the branch exists
  const readme = Buffer.from(
    "# gol-graph\n\nRule 30 cellular automaton painted on the GitHub contribution graph.\n"
  ).toString("base64");
  await ghFetch(`/repos/${USER}/${REPO}/contents/README.md`, "PUT", {
    message: "Initialize",
    content: readme,
  });
  console.log("  Created and initialized.\n");

  // 3. Write initial state to KV
  const initialState = JSON.stringify({
    cells: [0, 0, 0, 1, 0, 0, 0],
    streaks: [0, 0, 0, 0, 0, 0, 0],
    generation: 0,
    lastDate: null,
  });

  console.log("Writing initial state to KV...");
  const escaped = initialState.replace(/'/g, "'\\''");
  const cmd = `npx wrangler kv key put --binding GOL_STATE "state" '${escaped}'`;
  try {
    execSync(cmd, { stdio: "inherit", cwd: import.meta.dirname });
    console.log("  Done.\n");
  } catch (e) {
    console.error("Failed to write KV. Run manually:");
    console.error(`  ${cmd}`);
    process.exit(1);
  }

  console.log("Seed complete!");
  console.log("Next steps:");
  console.log("  1. Deploy:  npx wrangler deploy");
  console.log("  2. Test:    npx wrangler dev → then trigger cron manually");
  console.log(`  3. Check:   https://github.com/${USER}/${REPO}`);
})();
