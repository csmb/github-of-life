#!/usr/bin/env node
// backfill.js — Compute N generations of Rule 30 and create backdated commits.
// Fills the contribution graph immediately instead of waiting day-by-day.
//
// Usage: node backfill.js [days]
//   days: how many days to backfill (default: 90, covers ~13 weeks of the graph)

import { readFileSync } from "fs";
import { execSync } from "child_process";

const DAYS = parseInt(process.argv[2] || "90", 10);
const CELLS = 7;
const REPO = "gol-graph";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
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

if (!TOKEN || !EMAIL) {
  console.error("Need GITHUB_TOKEN and GITHUB_EMAIL in .dev.vars or env");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Rule 30
// ---------------------------------------------------------------------------
function rule30(cells) {
  const next = new Array(CELLS).fill(0);
  for (let i = 0; i < CELLS; i++) {
    const left = cells[(i - 1 + CELLS) % CELLS];
    const current = cells[i];
    const right = cells[(i + 1) % CELLS];
    next[i] = left ^ (current | right);
  }
  return next;
}

function commitsForStreak(streak) {
  if (streak <= 0) return 0;
  if (streak === 1) return 1;
  if (streak === 2) return 3;
  return 6;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------
async function ghFetch(path, method, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "github-of-life-backfill",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log(`Backfilling ${DAYS} days of Rule 30 for ${USER}/${REPO}\n`);

  // Get current HEAD
  const ref = await ghFetch(`/repos/${USER}/${REPO}/git/ref/heads/main`, "GET", null);
  let parentSha = ref.object.sha;

  // Get tree SHA from HEAD
  const headCommit = await ghFetch(`/repos/${USER}/${REPO}/git/commits/${parentSha}`, "GET", null);
  const treeSha = headCommit.tree.sha;

  // Compute all generations starting from seed
  let cells = [0, 0, 0, 1, 0, 0, 0];
  const generations = [];

  for (let i = 0; i < DAYS; i++) {
    cells = rule30(cells);
    generations.push([...cells]);
  }

  // Assign dates: generation[0] = (today - DAYS + 1), generation[DAYS-1] = today
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);

  // Track streaks across generations
  let streaks = new Array(CELLS).fill(0);
  let totalCommits = 0;
  let totalDaysWithActivity = 0;

  for (let g = 0; g < DAYS; g++) {
    const genCells = generations[g];
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - (DAYS - 1 - g));
    const dateStr = date.toISOString().slice(0, 10);

    // Update streaks
    const nextStreaks = new Array(CELLS).fill(0);
    for (let i = 0; i < CELLS; i++) {
      nextStreaks[i] = genCells[i] ? (streaks[i] + 1) : 0;
    }
    streaks = nextStreaks;

    // Count commits for this day
    let dayCommits = 0;
    for (let i = 0; i < CELLS; i++) {
      dayCommits += commitsForStreak(streaks[i]);
    }

    if (dayCommits === 0) continue;

    totalCommits += dayCommits;
    totalDaysWithActivity++;

    // Create commits for this day
    const dateISO = `${dateStr}T12:00:00Z`;
    const author = { name: USER, email: EMAIL, date: dateISO };

    for (let i = 0; i < CELLS; i++) {
      const count = commitsForStreak(streaks[i]);
      for (let c = 0; c < count; c++) {
        const commit = await ghFetch(`/repos/${USER}/${REPO}/git/commits`, "POST", {
          message: `Rule 30 — ${dateStr}`,
          tree: treeSha,
          parents: [parentSha],
          author,
          committer: author,
        });
        parentSha = commit.sha;
      }
    }

    const alive = genCells.filter(Boolean).length;
    process.stdout.write(`\r  Gen ${g + 1}/${DAYS}: ${dateStr} — ${alive} alive, ${dayCommits} commits`);
  }

  // Update ref
  await ghFetch(`/repos/${USER}/${REPO}/git/refs/heads/main`, "PATCH", {
    sha: parentSha,
    force: true, // Need force since we're rewriting from the init commit
  });

  console.log(`\n\nDone! ${totalCommits} commits across ${totalDaysWithActivity} days.`);
  console.log(`HEAD: ${parentSha.slice(0, 7)}`);
  console.log(`\nFinal state (gen ${DAYS}):`);
  console.log(`  Cells:   [${generations[DAYS - 1].join(",")}]`);
  console.log(`  Streaks: [${streaks.join(",")}]`);

  // Print what to set in KV
  const lastDate = new Date(today).toISOString().slice(0, 10);
  const kvState = JSON.stringify({
    cells: generations[DAYS - 1],
    streaks: streaks,
    generation: DAYS,
    lastDate,
  });
  console.log(`\nUpdate remote KV with:`);
  console.log(`  ${kvState}`);
})();
