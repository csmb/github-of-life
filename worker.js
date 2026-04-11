// 1D Rule 30 Cellular Automaton — Cloudflare Worker
// Runs once daily at noon UTC. Appends commits to gol-graph for alive cells.
// No force-push — contributions accumulate naturally on the GitHub graph.

const CELLS = 7; // One per row (day of week) on the contribution graph
const REPO = "gol-graph";

// Rule 30: next[i] = left XOR (current OR right)
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

// Map streak length to number of commits (controls green intensity)
function commitsForStreak(streak) {
  if (streak <= 0) return 0;
  if (streak === 1) return 1;
  if (streak === 2) return 3;
  return 6; // streak 3+
}

// ---------------------------------------------------------------------------
// GitHub API
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

// Get the SHA of the current HEAD on main
async function getHeadSha(token, user) {
  const ref = await ghFetch(`/repos/${user}/${REPO}/git/ref/heads/main`, "GET", null, token);
  return ref.object.sha;
}

// Get the tree SHA from a commit
async function getTreeSha(token, user, commitSha) {
  const commit = await ghFetch(`/repos/${user}/${REPO}/git/commits/${commitSha}`, "GET", null, token);
  return commit.tree.sha;
}

// Create a commit parented to the given SHA
async function createCommit(dateStr, parentSha, treeSha, token, user, email) {
  const dateISO = `${dateStr}T12:00:00Z`;
  const author = { name: user, email, date: dateISO };
  const data = await ghFetch(
    `/repos/${user}/${REPO}/git/commits`,
    "POST",
    {
      message: `Rule 30 — ${dateStr}`,
      tree: treeSha,
      parents: [parentSha],
      author,
      committer: author,
    },
    token
  );
  return data.sha;
}

// Update main branch ref (fast-forward, not force)
async function updateRef(sha, token, user) {
  await ghFetch(
    `/repos/${user}/${REPO}/git/refs/heads/main`,
    "PATCH",
    { sha, force: false },
    token
  );
}

// ---------------------------------------------------------------------------
// Scheduled handler
// ---------------------------------------------------------------------------

export default {
  async scheduled(event, env, ctx) {
    const token = env.GITHUB_TOKEN;
    const user = env.GITHUB_USER;
    const email = env.GITHUB_EMAIL;

    // Load state from KV
    const raw = await env.GOL_STATE.get("state");
    if (!raw) {
      console.error("No state in KV. Run seed.js first.");
      return;
    }
    const state = JSON.parse(raw);

    // Guard against running twice on the same day
    const today = new Date().toISOString().slice(0, 10);
    if (state.lastDate === today) {
      console.log(`Already ticked for ${today}, skipping.`);
      return;
    }

    // Compute next generation
    const nextCells = rule30(state.cells);

    // Update streaks
    const nextStreaks = new Array(CELLS).fill(0);
    for (let i = 0; i < CELLS; i++) {
      nextStreaks[i] = nextCells[i] ? (state.streaks[i] + 1) : 0;
    }

    // Count commits needed
    const totalCommits = nextStreaks.reduce((sum, s) => sum + commitsForStreak(s), 0);
    if (totalCommits === 0) {
      // All cells dead — save state and move on (no commits today)
      await env.GOL_STATE.put("state", JSON.stringify({
        cells: nextCells,
        streaks: nextStreaks,
        generation: state.generation + 1,
        lastDate: today,
      }));
      console.log(`Generation ${state.generation + 1}: all dead, no commits.`);
      return;
    }

    // Get current HEAD and tree
    let parentSha = await getHeadSha(token, user);
    const treeSha = await getTreeSha(token, user, parentSha);

    // Create commits for each alive cell
    for (let i = 0; i < CELLS; i++) {
      const count = commitsForStreak(nextStreaks[i]);
      for (let c = 0; c < count; c++) {
        parentSha = await createCommit(today, parentSha, treeSha, token, user, email);
      }
    }

    // Fast-forward main to new HEAD
    await updateRef(parentSha, token, user);

    // Save state
    await env.GOL_STATE.put("state", JSON.stringify({
      cells: nextCells,
      streaks: nextStreaks,
      generation: state.generation + 1,
      lastDate: today,
    }));

    console.log(`Generation ${state.generation + 1}: ${nextCells.filter(Boolean).length} alive, ${totalCommits} commits. HEAD=${parentSha.slice(0, 7)}`);
  },
};
