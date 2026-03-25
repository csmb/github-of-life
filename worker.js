// Conway's Game of Life — Cloudflare Worker
// Runs every 5 minutes via cron trigger (rate-limited by GitHub API at 5k req/hr).
// Reads state from KV, ticks GoL, force-pushes a fresh linear commit chain to gol-graph.

const COLS = 52;
const ROWS = 7;
// Tree containing README.md — persists across all generated commits.
// Recreate with: seed.js or the GitHub Git Data API if README changes.
const COMMIT_TREE = "96d84c1ff3701775641c697390f25f3f59d4d16a";
const REPO = "gol-graph";
const COMMITS_PER_CELL = 3; // multiple commits per date → darker green squares

// ---------------------------------------------------------------------------
// GoL logic
// ---------------------------------------------------------------------------

function idx(col, row) {
  return col * ROWS + row;
}

function tick(cells) {
  const next = new Array(COLS * ROWS).fill(false);
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      let alive = 0;
      for (let dc = -1; dc <= 1; dc++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (dc === 0 && dr === 0) continue;
          const nc = (col + dc + COLS) % COLS;
          const nr = (row + dr + ROWS) % ROWS;
          if (cells[idx(nc, nr)]) alive++;
        }
      }
      const wasAlive = cells[idx(col, row)];
      next[idx(col, row)] = wasAlive ? alive === 2 || alive === 3 : alive === 3;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Date mapping
// ---------------------------------------------------------------------------

/**
 * Returns an ISO-8601 date string (YYYY-MM-DD) for the given grid cell.
 * col=51 = current week, col=0 = 51 weeks ago.
 * row=0 = Sunday, row=6 = Saturday.
 */
function cellToDate(col, row) {
  const now = new Date();
  // Strip time — work in whole days
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayDow = today.getUTCDay(); // 0=Sun
  // Start of the current week (Sunday)
  const weekStart = new Date(today);
  weekStart.setUTCDate(today.getUTCDate() - todayDow);

  const offsetDays = (col - 51) * 7 + row;
  const target = new Date(weekStart);
  target.setUTCDate(weekStart.getUTCDate() + offsetDays);

  return target.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function ghFetch(path, method, body, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "github-of-life-worker",
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

/**
 * Creates a commit for the given date, chained to parentSha.
 * Linear chain ensures GitHub counts each commit as a contribution.
 * Returns the new commit SHA.
 */
async function createCommit(dateStr, parentSha, token, user, userId, treeSha) {
  const dateISO = `${dateStr}T12:00:00Z`;
  const authorInfo = {
    name: user,
    email: `${userId}+${user}@users.noreply.github.com`,
    date: dateISO,
  };
  const data = await ghFetch(
    `/repos/${user}/${REPO}/git/commits`,
    "POST",
    {
      message: `GoL alive cell ${dateStr}`,
      tree: treeSha,
      parents: [parentSha],
      author: authorInfo,
      committer: authorInfo,
    },
    token
  );
  return data.sha;
}

/**
 * Force-updates the main branch ref to the given SHA.
 */
async function forceUpdateRef(sha, token, user) {
  await ghFetch(
    `/repos/${user}/${REPO}/git/refs/heads/main`,
    "PATCH",
    { sha, force: true },
    token
  );
}

// ---------------------------------------------------------------------------
// Random seed
// ---------------------------------------------------------------------------

// Places exactly 120 cells: one per column (52) + 68 random extras.
// ~33% density — sweet spot for GoL stability and visual coverage.
function randomSeed() {
  const cells = new Array(COLS * ROWS).fill(false);
  for (let col = 0; col < COLS; col++) {
    cells[idx(col, Math.floor(Math.random() * ROWS))] = true;
  }
  const spare = cells.reduce((a, v, i) => { if (!v) a.push(i); return a; }, []);
  for (let i = spare.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [spare[i], spare[j]] = [spare[j], spare[i]];
  }
  for (let i = 0; i < 68; i++) cells[spare[i]] = true;
  return cells;
}

/**
 * Creates the repo if it doesn't exist. Returns the tree SHA.
 * We no longer delete/recreate every tick — force-pushing new history
 * is enough. GitHub removes contribution credit for unreachable commits.
 */
async function ensureRepoExists(token, user, env) {
  try {
    await ghFetch(`/repos/${user}/${REPO}`, "GET", null, token);
    return null; // already exists
  } catch (e) {
    if (!e.message.includes("404")) throw e;
  }

  // Create from scratch
  await ghFetch("/user/repos", "POST", {
    name: REPO,
    private: false,
    auto_init: false,
    description: "Conway's Game of Life — GitHub contribution graph animation",
  }, token);
  console.log("Repo created.");

  const readmeContent = await env.GOL_STATE.get("readme") ??
    btoa("# github-of-life\n\nConway's Game of Life on the GitHub contribution graph.\n");
  const initResult = await ghFetch(`/repos/${user}/${REPO}/contents/README.md`, "PUT", {
    message: "GoL seed: initialize repo",
    content: readmeContent,
  }, token);

  let treeSha = initResult?.commit?.tree?.sha;

  const gifContent = await env.GOL_STATE.get("gif");
  if (gifContent) {
    const gifResult = await ghFetch(`/repos/${user}/${REPO}/contents/contribution-graph.gif`, "PUT", {
      message: "GoL seed: add gif",
      content: gifContent,
    }, token);
    treeSha = gifResult?.commit?.tree?.sha;
  }

  console.log(`Repo initialized. tree=${treeSha}`);
  return treeSha;
}

// ---------------------------------------------------------------------------
// Scheduled handler
// ---------------------------------------------------------------------------

async function runTick(env) {
  const token = env.GITHUB_TOKEN;
  const user = env.GITHUB_USER;
  const { id: userId } = await ghFetch("/user", "GET", null, token);

  // 1. Load state
  const raw = await env.GOL_STATE.get("state");
  if (!raw) {
    console.error("No state found in KV. Run seed.js first.");
    return;
  }
  const state = JSON.parse(raw);
  const treeSha = state.treeSha || COMMIT_TREE;

  // 2. Tick
  const nextCells = tick(state.cells);

  // 3. Collect alive cells → dates, sorted ascending
  const aliveDates = [];
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      if (nextCells[idx(col, row)]) {
        aliveDates.push(cellToDate(col, row));
      }
    }
  }
  aliveDates.sort();

  // 4. Ensure repo exists (create only if missing — no more delete/recreate).
  const newTreeSha = await ensureRepoExists(token, user, env);
  const activeTree = newTreeSha || treeSha;

  const RESEED_THRESHOLD = 30;
  let cellsToPaint = nextCells;
  let nextGeneration = state.generation + 1;
  if (aliveDates.length < RESEED_THRESHOLD) {
    // Too sparse — reseed and paint the seed directly (no blank frame, no tick die-off).
    cellsToPaint = randomSeed();
    aliveDates.length = 0;
    for (let col = 0; col < COLS; col++)
      for (let row = 0; row < ROWS; row++)
        if (cellsToPaint[idx(col, row)]) aliveDates.push(cellToDate(col, row));
    aliveDates.sort();
    nextGeneration = 0;
    console.log(`Reseed at gen ${state.generation + 1} (${nextCells.filter(Boolean).length} alive < ${RESEED_THRESHOLD}). Painted ${aliveDates.length} cells.`);
  }

  // Build a fresh linear chain: orphan root → GoL commits.
  // Force-pushing replaces history — GitHub drops contribution credit
  // for unreachable commits, so dead cells fade from the graph.
  const now = new Date().toISOString();
  const authorBase = {
    name: user,
    email: `${userId}+${user}@users.noreply.github.com`,
  };
  const rootData = await ghFetch(
    `/repos/${user}/${REPO}/git/commits`, "POST",
    {
      message: "GoL base",
      tree: activeTree,
      parents: [],
      author: { ...authorBase, date: now },
      committer: { ...authorBase, date: now },
    },
    token
  );
  let parentSha = rootData.sha;

  for (const date of aliveDates) {
    for (let i = 0; i < COMMITS_PER_CELL; i++) {
      parentSha = await createCommit(date, parentSha, token, user, userId, activeTree);
    }
  }
  await forceUpdateRef(parentSha, token, user);
  console.log(`Generation ${nextGeneration}: painted ${aliveDates.length} cells (${aliveDates.length * COMMITS_PER_CELL} commits). HEAD=${parentSha}`);

  // 5. Persist next state
  await env.GOL_STATE.put(
    "state",
    JSON.stringify({ generation: nextGeneration, cells: cellsToPaint, treeSha: activeTree })
  );
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "0 0 * * *") {
      const raw = await env.GOL_STATE.get("state");
      const treeSha = raw ? JSON.parse(raw).treeSha : COMMIT_TREE;
      const cells = randomSeed();
      await env.GOL_STATE.put("state", JSON.stringify({ generation: 0, cells, treeSha }));
      console.log(`Daily reseed: random, ~${cells.filter(Boolean).length} alive cells (${cells.filter(Boolean).length * COMMITS_PER_CELL} commits).`);
    } else {
      // Per-minute GoL tick
      await runTick(env);
    }
  },
};
