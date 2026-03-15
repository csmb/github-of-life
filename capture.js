#!/usr/bin/env node
// Captures N generations of GoL as PNGs, then assembles a GIF with ffmpeg.
// Usage: node capture.js [frames=40]

import { chromium } from "playwright";
import { execSync } from "child_process";
import { mkdirSync, rmSync, existsSync } from "fs";
import { execFileSync } from "child_process";

const COLS = 52;
const ROWS = 7;
const FRAMES = parseInt(process.argv[2] ?? "40");
const OUT_DIR = "/tmp/gol-frames";
const GIF_OUT = "contribution-graph.gif";

// ── GoL tick ──────────────────────────────────────────────────────────────────
function idx(col, row) { return col * ROWS + row; }

function tick(cells) {
  const next = new Array(COLS * ROWS).fill(false);
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      let alive = 0;
      for (let dc = -1; dc <= 1; dc++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (dc === 0 && dr === 0) continue;
          alive += cells[idx((col + dc + COLS) % COLS, (row + dr + ROWS) % ROWS)] ? 1 : 0;
        }
      }
      const was = cells[idx(col, row)];
      next[idx(col, row)] = was ? alive === 2 || alive === 3 : alive === 3;
    }
  }
  return next;
}

function randomSeed(density = 0.25) {
  return Array.from({ length: COLS * ROWS }, () => Math.random() < density);
}

// Guarantees at least one alive cell in every column (full-year coverage),
// then sprinkles extra cells at the given fill density.
function fullYearSeed(extraDensity = 0.3) {
  const cells = new Array(COLS * ROWS).fill(false);
  for (let col = 0; col < COLS; col++) {
    cells[idx(col, Math.floor(Math.random() * ROWS))] = true;
  }
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] && Math.random() < extraDensity) cells[i] = true;
  }
  return cells;
}

// ── HTML renderer ─────────────────────────────────────────────────────────────
function renderHTML(cells, generation) {
  const CELL = 11;
  const GAP = 2;
  const W = COLS * (CELL + GAP) - GAP;
  const H = ROWS * (CELL + GAP) - GAP;

  const rects = [];
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const alive = cells[idx(col, row)];
      const x = col * (CELL + GAP);
      const y = row * (CELL + GAP);
      // GitHub's contribution graph colours
      const fill = alive ? "#39d353" : "#161b22";
      rects.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"/>`);
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d1117;
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 20px 24px 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .label {
    color: #7d8590;
    font-size: 12px;
    margin-bottom: 10px;
    letter-spacing: 0.01em;
  }
  .gen {
    color: #7d8590;
    font-size: 11px;
    margin-top: 10px;
  }
</style>
</head>
<body>
  <div class="label">Conway's Game of Life — GitHub contribution graph</div>
  <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${rects.join("\n    ")}
  </svg>
  <div class="gen">generation ${generation}</div>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// Full-year seed: every column has at least one cell + 30% extra fill
let cells = fullYearSeed(0.3);
console.log(`Starting with full-year seed (${cells.filter(Boolean).length} alive cells).`);

const browser = await chromium.launch();
const page = await browser.newPage();

for (let gen = 0; gen < FRAMES; gen++) {
  const html = renderHTML(cells, gen);
  await page.setContent(html, { waitUntil: "load" });
  // Size viewport to content
  const body = await page.$("body");
  const box = await body.boundingBox();
  await page.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
  const framePath = `${OUT_DIR}/frame-${String(gen).padStart(4, "0")}.png`;
  await body.screenshot({ path: framePath });
  process.stdout.write(`\r  frame ${gen + 1}/${FRAMES} — ${cells.filter(Boolean).length} alive`);

  cells = tick(cells);
  if (!cells.some(Boolean)) {
    console.log(`\n  Extinction at gen ${gen + 1}, reseeding.`);
    cells = fullYearSeed(0.3);
  }
}

await browser.close();
console.log(`\nFrames saved to ${OUT_DIR}`);

// Assemble GIF with ffmpeg (10fps, loop forever, high quality palette)
console.log(`Building GIF → ${GIF_OUT} ...`);
execFileSync("ffmpeg", [
  "-y",
  "-framerate", "8",
  "-pattern_type", "glob",
  "-i", `${OUT_DIR}/frame-*.png`,
  "-vf", "split[s0][s1];[s0]palettegen=max_colors=32:stats_mode=full[p];[s1][p]paletteuse=dither=bayer",
  "-loop", "0",
  GIF_OUT,
], { stdio: "inherit" });

console.log(`Done → ${GIF_OUT}`);
