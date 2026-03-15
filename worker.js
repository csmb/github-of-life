// Conway's Game of Life — Cloudflare Worker
// Runs every 5 minutes via cron trigger.
// Reads state from KV, ticks GoL, rewrites github-of-life commit history.

const COLS = 52;
const ROWS = 7;
// Tree containing README.md — persists across all generated commits.
// Recreate with: seed.js or the GitHub Git Data API if README changes.
const COMMIT_TREE = "96d84c1ff3701775641c697390f25f3f59d4d16a";
const REPO = "github-of-life";

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
 * Creates a root commit (no parents) for the given date.
 * Returns the commit SHA.
 */
async function createRootCommit(dateStr, token, user, userId, treeSha) {
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
      parents: [],
      author: authorInfo,
      committer: authorInfo,
    },
    token
  );
  return data.sha;
}

/**
 * Creates a chained commit with one parent for the given date.
 * Returns the commit SHA.
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

function randomSeed(density = 0.25) {
  return Array.from({ length: COLS * ROWS }, () => Math.random() < density);
}

async function deleteAndRecreateRepo(token, user) {
  // Preserve README before deletion
  let readmeContent;
  try {
    const existing = await ghFetch(`/repos/${user}/${REPO}/contents/README.md`, "GET", null, token);
    readmeContent = existing.content.replace(/\n/g, ""); // base64, strip newlines GitHub adds
  } catch {
    readmeContent = btoa("github-of-life: Conway's Game of Life on the GitHub contribution graph\n");
  }

  // Delete — contribution credits are removed when the repo is gone
  await ghFetch(`/repos/${user}/${REPO}`, "DELETE", null, token);
  console.log("Repo deleted.");

  // Recreate
  await ghFetch("/user/repos", "POST", {
    name: REPO,
    private: false,
    auto_init: false,
    description: "Conway's Game of Life on the GitHub contribution graph",
  }, token);
  console.log("Repo recreated.");

  // Bootstrap main with preserved README so the branch exists for force-push
  const initResult = await ghFetch(`/repos/${user}/${REPO}/contents/README.md`, "PUT", {
    message: "GoL seed: initialize repo",
    content: readmeContent,
  }, token);
  const treeSha = initResult?.commit?.tree?.sha;
  console.log(`main branch initialized. tree=${treeSha}`);
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

  // 4. Delete and recreate repo for a clean slate, then push alive cells.
  // Force-pushing orphans old commits but GitHub keeps crediting them until
  // the repo is deleted — so we delete every tick to ensure dead cells truly
  // disappear from the contribution graph.
  const newTreeSha = await deleteAndRecreateRepo(token, user);
  const activeSha = newTreeSha || treeSha;

  if (aliveDates.length === 0) {
    const reseeded = randomSeed();
    await env.GOL_STATE.put("state", JSON.stringify({ generation: 0, cells: reseeded, treeSha: activeSha }));
    console.log(`Extinction at gen ${state.generation + 1}. Reseeded randomly.`);
    return;
  }

  let sha = await createRootCommit(aliveDates[0], token, user, userId, activeSha);
  for (let i = 1; i < aliveDates.length; i++) {
    sha = await createCommit(aliveDates[i], sha, token, user, userId, activeSha);
  }
  await forceUpdateRef(sha, token, user);
  console.log(`Generation ${state.generation + 1}: painted ${aliveDates.length} cells. HEAD=${sha}`);

  // 5. Persist next state
  await env.GOL_STATE.put(
    "state",
    JSON.stringify({ generation: state.generation + 1, cells: nextCells, treeSha: activeSha })
  );
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "0 0 * * *") {
      const raw = await env.GOL_STATE.get("state");
      const treeSha = raw ? JSON.parse(raw).treeSha : COMMIT_TREE;
      const cells = randomSeed();
      await env.GOL_STATE.put("state", JSON.stringify({ generation: 0, cells, treeSha }));
      console.log(`Daily reseed: random, ~${cells.filter(Boolean).length} alive cells.`);
    } else {
      // Per-minute GoL tick
      await runTick(env);
    }
  },
};
