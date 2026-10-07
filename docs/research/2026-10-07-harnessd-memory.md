# Before/after for the next release: published 0.3.60 vs main 08548179c

Measured 2026-10-07, 01:30–02:30 UTC, on a 12-core Mac. Measurement only; nothing was committed.

## Summary

Medians of 3 runs. RSS and physical footprint (`footprint -p`) in MiB after 60 s settled; CPU in seconds over the following 5-minute idle window.

| | 0.3.60 | main | change |
|---|---|---|---|
| **core**, (a) idle | 159.1 RSS / 99 fp / 1.99 s | 133.1 / 86 / 2.18 s | −26 RSS, −13 fp |
| **core**, (b) 2 agents | 172.9 / 114 / 3.31 s | 141.6 / 95 / 3.07 s | −31 RSS, −19 fp |
| **core**, (c) + window and terminal | 175.9 / 115 / 3.27 s | 142.5 / 100 / 2.64 s | −33 RSS, −15 fp, −0.6 s CPU |
| master, (a) | 58.2 / 17 / 0.04 s | 69.9 / 17 / 0.06 s | +12 RSS, footprint equal |
| processes running | 6 | 8 | |
| **all processes**, (a) | 490.6 RSS / 223 fp / 3.54 s | 636.6 / 277 / 4.54 s | +146 RSS, +54 fp, +1.0 s |
| **all processes**, (b) | 511.8 / 234 / 4.93 s | 669.8 / 292 / 5.54 s | +158 RSS, +58 fp, +0.6 s |
| **all processes**, (c) | 517.9 / 240 / 4.68 s | 675.3 / 298 / 4.95 s | +157 RSS, +58 fp, +0.3 s |
| core answers after `harness start` | 1821 ms | 929 ms | −0.9 s |
| `harness start` exits | 2019 ms | 956 ms | −1.1 s |
| first agent created | 2652 ms | 1901 ms | −0.75 s |

The processes running in each build:
- **0.3.60:** master, core, search, viewers, workspaces, teams. The updater ran inside the core.
- **main:** master, core, search, viewers, edge, gateway, models, updater. Teams and devices start only on demand, so they never started here.

### What the numbers say

- **The core is smaller in main:** 26 to 33 MiB less resident and 13 to 19 MiB less physical footprint, in every scenario.
- **Start-up is faster in main:** the core answers about 0.9 s sooner, and the first agent can be created about 0.75 s sooner.
- **The total is larger in main:** about 55 MiB more footprint and about 150 MiB more RSS. This is because main runs 8 processes against 0.3.60's 6. Each idle service process costs 61 to 85 MiB RSS and 20 to 40 MiB footprint, and about 0.37 CPU-seconds per 5 minutes (about 0.12% of one core) for its timers and heartbeat.
- **Summed RSS overstates the total.** It counts each process's shared, clean pages, such as the Node binary and the code it maps. Footprint is the better total.
- **main's master is 12 MiB larger in RSS, with the same footprint (17).** The extra is clean pages, not memory the master holds. It shows the same with a copied Node, so the binary's path is not the cause (see Method).
- **Idle CPU is small in both.** The whole daemon used 3.5 to 5.5 CPU-seconds per 5 minutes, about 1.2% to 1.8% of one core. The core's share is within noise between builds, except with a window open, where main's core used about 0.6 s less.
- **Nothing restarted during any measurement window:** every process's pid was the same at both ends, in all 18 windows.

## Method

- **Builds:**
  - **0.3.60:** the published `cli.js` and `notify.mjs` from the CDN. The `cli.js` sha256 is `cb1ae2452d006d414cefc6ce2deddd07a7a43fc9824402691a1ef0737d2277e3`, which matches `metadata.json`.
  - **main:** `08548179c` (#955), built with `node build-bundle.mjs` from a detached worktree. Its lean bundle passed `scripts/check-lean-bundle.mjs`. It reports version 0.0.1, as an unreleased build does.
- **Harness:** a scratch vitest file (not committed), run from main's `cli/` with `vitest.e2e.config.ts`. Each run lays the build down as the installer does:
  - the bundle at `~/.harness/cli/cli.js` with `notify.mjs` beside it;
  - a managed Node in `runtime/node-e2e/bin/node` recorded in `current-node`. For the three runs this is a symlink to the test's Node 22.23.1, as `e2e/cli.e2e.ts` does. A probe run with a copied Node gave the same numbers: master 57.6/69.0 RSS, core 159.7/133.8 RSS and 101/89 footprint, totals 218/279 footprint.
- **Isolation:**
  - each run uses a throwaway home, data folder and port, with a private tmux server and the e2e fake Claude Code and Codex;
  - it is signed out: the backend URL is a dead local port;
  - the fake `launchctl`, `systemctl` and `loginctl` refuse every call;
  - the real daemon, real home and real tmux server were never touched.
- **Updates on, so the updater runs where each build runs it.** The `ADAPTER_UPDATE_URL` manifest is served locally and offers the build's own version, so nothing was ever downloaded. Each build checked every 60 s, 18 requests per run, and nothing was staged.
- **Start-up:** on a fresh machine, the clock starts when `harness start` is spawned.
  - "Core answers" is the first `GET /api/health` that returns 200, polled every 25 ms.
  - "First agent created" is the first `agent_create` (Claude Code, fake engine) that returns without an error. It is tried every 50 ms from the start over the local socket, and its time includes the request itself.
- **Scenarios:** on a second fresh machine started with `harness start`, run one after another on the same daemon:
  - **(a)** no agents and no client;
  - **(b)** a Claude Code and a Codex agent, each created and having finished one turn, with the client then disconnected;
  - **(c)** (b) plus one window: a local client that opened the Claude Code agent's terminal (`terminal_open`, protocol 3, as a desktop window). It sends `terminal_alive` and acks every 2 s, as the app does.
- **Each scenario's measurement:**
  - wait 60 s, then read each process's RSS (`ps -o rss`) and footprint (`footprint -p`) once;
  - read `ps -o time` (cumulative user + system CPU), wait 5 minutes, and read it again; the CPU figure is the difference.
- **Processes:**
  - the master comes from `adapter.pid`;
  - the core and each service process come from the master's log lines, `core started (pid N)` and `service <name> started (pid N)`, keeping those alive.
  - The tmux server and the fake engines are not counted.
- **Pairing:** 3 runs. In each run both builds ran at the same time, started 45 s apart so their start-ups never overlapped. main went first in runs 1 and 3, and 0.3.60 in run 2.
- **Load:** other suites were running on the machine. The 1-minute load was 10 to 68 during the runs (table below). Run 2 had the highest load (54 to 68 at its start); run 3 the lowest (10 to 31). Both builds in a run saw the same load.

## Tables
### (a) idle, no agents

Medians of 3 runs (range in brackets). RSS and footprint in MiB after 60 s settled; CPU in seconds over the next 5 minutes.

| process | RSS 0.3.60 | RSS main | footprint 0.3.60 | footprint main | CPU s 0.3.60 | CPU s main |
|---|---|---|---|---|---|---|
| master | 58.2 (58.0–58.5) | 69.9 (69.3–70.7) | 17.0 (16.0–18.0) | 17.0 (17.0–17.0) | 0.04 (0.03–0.05) | 0.06 (0.04–0.06) |
| core | 159.1 (156.8–161.8) | 133.1 (131.5–135.9) | 99.0 (97.0–107.0) | 86.0 (85.0–88.0) | 1.99 (1.90–2.23) | 2.18 (1.83–2.20) |
| search | 75.4 (75.2–77.8) | 81.5 (80.0–83.4) | 33.0 (32.0–35.0) | 40.0 (39.0–41.0) | 0.37 (0.29–0.38) | 0.37 (0.31–0.38) |
| viewers | 69.9 (69.8–70.0) | 74.6 (74.2–74.6) | 26.0 (25.0–29.0) | 29.0 (29.0–31.0) | 0.37 (0.29–0.37) | 0.38 (0.31–0.38) |
| workspaces | 61.5 (61.5–61.7) | — | 20.0 (20.0–20.0) | — | 0.39 (0.30–0.39) | — |
| teams | 66.1 (65.8–66.3) | — | 25.0 (22.0–25.0) | — | 0.37 (0.29–0.37) | — |
| edge | — | 63.8 (63.8–64.1) | — | 23.0 (23.0–23.0) | — | 0.38 (0.32–0.39) |
| gateway | — | 75.9 (75.8–76.1) | — | 30.0 (30.0–30.0) | — | 0.37 (0.30–0.37) |
| models | — | 70.0 (69.7–70.4) | — | 28.0 (26.0–29.0) | — | 0.37 (0.31–0.37) |
| updater | — | 65.9 (65.8–65.9) | — | 24.0 (24.0–24.0) | — | 0.42 (0.35–0.42) |
| **total** | **490.6** (490.1–492.7) | **636.6** (632.6–636.7) | **223.0** (218.0–225.0) | **277.0** (276.0–280.0) | **3.54** (3.10–3.78) | **4.54** (3.77–4.56) |

### (b) idle, a Claude Code and a Codex agent after a turn each

Medians of 3 runs (range in brackets). RSS and footprint in MiB after 60 s settled; CPU in seconds over the next 5 minutes.

| process | RSS 0.3.60 | RSS main | footprint 0.3.60 | footprint main | CPU s 0.3.60 | CPU s main |
|---|---|---|---|---|---|---|
| master | 59.3 (59.1–59.6) | 71.1 (70.6–71.9) | 18.0 (17.0–19.0) | 19.0 (18.0–19.0) | 0.04 (0.02–0.05) | 0.06 (0.03–0.06) |
| core | 172.9 (170.7–180.2) | 141.6 (139.8–143.9) | 114.0 (109.0–120.0) | 95.0 (95.0–98.0) | 3.31 (2.77–3.65) | 3.07 (2.55–3.17) |
| search | 74.3 (74.0–78.3) | 81.8 (80.4–83.8) | 30.0 (29.0–31.0) | 38.0 (37.0–39.0) | 0.46 (0.42–0.54) | 0.52 (0.40–0.52) |
| viewers | 71.1 (71.0–71.2) | 75.8 (75.4–75.8) | 26.0 (26.0–26.0) | 31.0 (30.0–31.0) | 0.37 (0.29–0.38) | 0.37 (0.30–0.39) |
| workspaces | 63.2 (63.0–63.2) | — | 22.0 (22.0–22.0) | — | 0.38 (0.31–0.39) | — |
| teams | 67.4 (67.1–67.6) | — | 23.0 (23.0–23.0) | — | 0.36 (0.29–0.38) | — |
| edge | — | 65.5 (65.5–66.0) | — | 25.0 (24.0–25.0) | — | 0.39 (0.31–0.40) |
| gateway | — | 77.2 (77.1–77.5) | — | 32.0 (31.0–32.0) | — | 0.38 (0.30–0.39) |
| models | — | 71.2 (70.8–71.5) | — | 27.0 (27.0–28.0) | — | 0.37 (0.30–0.37) |
| updater | — | 83.8 (83.5–84.8) | — | 25.0 (24.0–31.0) | — | 0.38 (0.31–0.39) |
| **total** | **511.8** (505.7–515.7) | **669.8** (665.7–670.8) | **234.0** (227.0–239.0) | **292.0** (290.0–299.0) | **4.93** (4.10–5.38) | **5.54** (4.50–5.69) |

### (c) (b) plus one window with a terminal open

Medians of 3 runs (range in brackets). RSS and footprint in MiB after 60 s settled; CPU in seconds over the next 5 minutes.

| process | RSS 0.3.60 | RSS main | footprint 0.3.60 | footprint main | CPU s 0.3.60 | CPU s main |
|---|---|---|---|---|---|---|
| master | 60.1 (59.9–60.4) | 71.6 (71.0–72.3) | 19.0 (18.0–20.0) | 19.0 (19.0–19.0) | 0.04 (0.03–0.05) | 0.06 (0.05–0.06) |
| core | 175.9 (173.2–178.2) | 142.5 (140.9–147.4) | 115.0 (115.0–121.0) | 100.0 (97.0–101.0) | 3.27 (2.95–3.38) | 2.64 (2.44–2.84) |
| search | 79.3 (78.6–79.4) | 84.6 (83.8–86.0) | 33.0 (32.0–34.0) | 40.0 (39.0–40.0) | 0.30 (0.25–0.37) | 0.36 (0.30–0.37) |
| viewers | 71.4 (71.3–71.5) | 76.0 (75.7–76.1) | 27.0 (27.0–27.0) | 30.0 (30.0–31.0) | 0.37 (0.30–0.37) | 0.37 (0.30–0.37) |
| workspaces | 63.4 (63.3–63.5) | — | 22.0 (22.0–22.0) | — | 0.38 (0.31–0.39) | — |
| teams | 67.7 (67.4–67.9) | — | 23.0 (23.0–23.0) | — | 0.36 (0.31–0.37) | — |
| edge | — | 65.9 (65.9–66.4) | — | 25.0 (25.0–25.0) | — | 0.38 (0.31–0.38) |
| gateway | — | 77.5 (77.4–77.7) | — | 31.0 (31.0–32.0) | — | 0.37 (0.30–0.38) |
| models | — | 71.5 (71.2–71.8) | — | 27.0 (27.0–27.0) | — | 0.37 (0.30–0.37) |
| updater | — | 84.6 (84.3–85.6) | — | 26.0 (25.0–26.0) | — | 0.37 (0.31–0.38) |
| **total** | **517.9** (514.7–519.8) | **675.3** (672.2–680.2) | **240.0** (239.0–244.0) | **298.0** (295.0–299.0) | **4.68** (4.20–4.92) | **4.95** (4.31–5.12) |

### Start-up (`harness start` on a fresh machine)

Milliseconds from spawning `harness start`. Medians of 3 runs (range).

| | 0.3.60 | main |
|---|---|---|
| core answers /api/health | 1821 (1708–4219) | 929 (791–985) |
| `harness start` exits | 2019 (1762–4400) | 956 (952–1033) |
| first agent_create succeeds | 2652 (2619–5355) | 1901 (1817–2307) |

### Load average during each run

1/5/15-minute load at the start of each measurement window, and the 1-minute load at its end.

| build | run | start-up | (a) | (b) | (c) |
|---|---|---|---|---|---|
| 0.3.60 | 1 | 27.28 / 25.25 / 39.15 | 27.34 / 25.41 / 38.17 → 32.44 | 32.42 / 30.76 / 36.23 → 56 | 45.9 / 45.1 / 41.37 → 60.31 |
| 0.3.60 | 2 | 65.69 / 57.61 / 48.34 | 67.94 / 60.43 / 50.11 → 51.04 | 54.27 / 55.89 / 51.56 → 40.83 | 40.84 / 48.4 / 50 → 32.46 |
| 0.3.60 | 3 | 23.13 / 38.08 / 44.92 | 21.46 / 34.94 / 43.28 → 11.59 | 14.27 / 19.96 / 33.01 → 10.89 | 9.96 / 13.53 / 25.41 → 18.84 |
| main | 1 | 27.45 / 24.7 / 39.71 | 25.3 / 24.92 / 38.71 → 33.86 | 34.79 / 30.98 / 36.65 → 58.23 | 53.02 / 45.51 / 41.28 → 63.46 |
| main | 2 | 67.93 / 59.67 / 49.54 | 67.27 / 60.85 / 50.72 → 49.61 | 54.47 / 55.82 / 51.74 → 36.61 | 35.51 / 46.06 / 49.06 → 32.21 |
| main | 3 | 30.91 / 41.66 / 46.49 | 22.7 / 37.25 / 44.5 → 11.17 | 11.71 / 20.36 / 33.84 → 12.29 | 10.03 / 14.12 / 26.25 → 24.89 |

### Raw numbers

Per run, per scenario, per process: pid, RSS MiB, footprint MiB, CPU seconds at the window's start and end, and their difference.

```
0.3.60 run 1 startup: core answering 1821 ms, start exited 2019 ms, first agent 2619 ms, start exit 0, load [27.28, 25.25, 39.15]
0.3.60 run 1 (a) load [27.34, 25.41, 38.17] -> [32.44, 30.23, 36.52]; changed during window: none; manifest requests so far 6
    master      pid 25335  rss   58.5  footprint   18.0  cpu 0.28 -> 0.32 = 0.04
    core        pid 25778  rss  159.1  footprint   99.0  cpu 1.05 -> 3.28 = 2.23
    search      pid 25780  rss   75.4  footprint   33.0  cpu 0.34 -> 0.72 = 0.38
    viewers     pid 25797  rss   69.8  footprint   26.0  cpu 0.23 -> 0.60 = 0.37
    workspaces  pid 25809  rss   61.5  footprint   20.0  cpu 0.19 -> 0.58 = 0.39
    teams       pid 25829  rss   66.3  footprint   22.0  cpu 0.20 -> 0.57 = 0.37
0.3.60 run 1 (b) load [32.42, 30.76, 36.23] -> [56, 45.66, 41.26]; changed during window: none; manifest requests so far 12
    master      pid 25335  rss   59.6  footprint   19.0  cpu 0.33 -> 0.37 = 0.04
    core        pid 25778  rss  180.2  footprint  120.0  cpu 5.07 -> 8.72 = 3.65
    search      pid 25780  rss   74.3  footprint   29.0  cpu 0.82 -> 1.36 = 0.54
    viewers     pid 25797  rss   71.0  footprint   26.0  cpu 0.68 -> 1.06 = 0.38
    workspaces  pid 25809  rss   63.0  footprint   22.0  cpu 0.67 -> 1.06 = 0.39
    teams       pid 25829  rss   67.6  footprint   23.0  cpu 0.66 -> 1.04 = 0.38
0.3.60 run 1 (c) load [45.9, 45.1, 41.37] -> [60.31, 56.32, 47.78]; changed during window: none; manifest requests so far 18
    master      pid 25335  rss   60.4  footprint   20.0  cpu 0.38 -> 0.42 = 0.04
    core        pid 25778  rss  173.2  footprint  115.0  cpu 9.46 -> 12.84 = 3.38
    search      pid 25780  rss   78.6  footprint   33.0  cpu 1.44 -> 1.81 = 0.37
    viewers     pid 25797  rss   71.3  footprint   27.0  cpu 1.13 -> 1.50 = 0.37
    workspaces  pid 25809  rss   63.3  footprint   22.0  cpu 1.14 -> 1.53 = 0.39
    teams       pid 25829  rss   67.9  footprint   23.0  cpu 1.11 -> 1.48 = 0.37
0.3.60 run 2 startup: core answering 4219 ms, start exited 4400 ms, first agent 5355 ms, start exit 0, load [65.69, 57.61, 48.34]
0.3.60 run 2 (a) load [67.94, 60.43, 50.11] -> [51.04, 56.26, 51.33]; changed during window: none; manifest requests so far 6
    master      pid 48499  rss   58.2  footprint   16.0  cpu 0.29 -> 0.34 = 0.05
    core        pid 50680  rss  161.8  footprint  107.0  cpu 1.06 -> 3.05 = 1.99
    search      pid 50714  rss   75.2  footprint   32.0  cpu 0.41 -> 0.78 = 0.37
    viewers     pid 50765  rss   69.9  footprint   25.0  cpu 0.24 -> 0.61 = 0.37
    workspaces  pid 50820  rss   61.5  footprint   20.0  cpu 0.21 -> 0.60 = 0.39
    teams       pid 50822  rss   66.1  footprint   25.0  cpu 0.22 -> 0.59 = 0.37
0.3.60 run 2 (b) load [54.27, 55.89, 51.56] -> [40.83, 50.31, 50.75]; changed during window: none; manifest requests so far 12
    master      pid 48499  rss   59.3  footprint   17.0  cpu 0.35 -> 0.40 = 0.05
    core        pid 50680  rss  170.7  footprint  109.0  cpu 5.03 -> 8.34 = 3.31
    search      pid 50714  rss   74.0  footprint   30.0  cpu 0.89 -> 1.35 = 0.46
    viewers     pid 50765  rss   71.1  footprint   26.0  cpu 0.70 -> 1.07 = 0.37
    workspaces  pid 50820  rss   63.2  footprint   22.0  cpu 0.69 -> 1.07 = 0.38
    teams       pid 50822  rss   67.4  footprint   23.0  cpu 0.67 -> 1.03 = 0.36
0.3.60 run 2 (c) load [40.84, 48.4, 50] -> [32.46, 43.69, 47.43]; changed during window: none; manifest requests so far 18
    master      pid 48499  rss   60.1  footprint   18.0  cpu 0.40 -> 0.45 = 0.05
    core        pid 50680  rss  175.9  footprint  115.0  cpu 8.99 -> 12.26 = 3.27
    search      pid 50714  rss   79.4  footprint   34.0  cpu 1.41 -> 1.66 = 0.25
    viewers     pid 50765  rss   71.4  footprint   27.0  cpu 1.14 -> 1.51 = 0.37
    workspaces  pid 50820  rss   63.4  footprint   22.0  cpu 1.15 -> 1.53 = 0.38
    teams       pid 50822  rss   67.7  footprint   23.0  cpu 1.10 -> 1.46 = 0.36
0.3.60 run 3 startup: core answering 1708 ms, start exited 1762 ms, first agent 2652 ms, start exit 0, load [23.13, 38.08, 44.92]
0.3.60 run 3 (a) load [21.46, 34.94, 43.28] -> [11.59, 20.92, 34.36]; changed during window: none; manifest requests so far 6
    master      pid 47698  rss   58.0  footprint   17.0  cpu 0.24 -> 0.27 = 0.03
    core        pid 48252  rss  156.8  footprint   97.0  cpu 1.05 -> 2.95 = 1.90
    search      pid 48253  rss   77.8  footprint   35.0  cpu 0.33 -> 0.62 = 0.29
    viewers     pid 48254  rss   70.0  footprint   29.0  cpu 0.21 -> 0.50 = 0.29
    workspaces  pid 48255  rss   61.7  footprint   20.0  cpu 0.19 -> 0.49 = 0.30
    teams       pid 48256  rss   65.8  footprint   25.0  cpu 0.21 -> 0.50 = 0.29
0.3.60 run 3 (b) load [14.27, 19.96, 33.01] -> [10.89, 14.49, 26.6]; changed during window: none; manifest requests so far 12
    master      pid 47698  rss   59.1  footprint   18.0  cpu 0.28 -> 0.30 = 0.02
    core        pid 48252  rss  172.9  footprint  114.0  cpu 4.33 -> 7.10 = 2.77
    search      pid 48253  rss   78.3  footprint   31.0  cpu 0.69 -> 1.11 = 0.42
    viewers     pid 48254  rss   71.2  footprint   26.0  cpu 0.57 -> 0.86 = 0.29
    workspaces  pid 48255  rss   63.2  footprint   22.0  cpu 0.55 -> 0.86 = 0.31
    teams       pid 48256  rss   67.1  footprint   23.0  cpu 0.57 -> 0.86 = 0.29
0.3.60 run 3 (c) load [9.96, 13.53, 25.41] -> [18.84, 22.17, 26.22]; changed during window: none; manifest requests so far 18
    master      pid 47698  rss   59.9  footprint   19.0  cpu 0.31 -> 0.34 = 0.03
    core        pid 48252  rss  178.2  footprint  121.0  cpu 7.66 -> 10.61 = 2.95
    search      pid 48253  rss   79.3  footprint   32.0  cpu 1.17 -> 1.47 = 0.30
    viewers     pid 48254  rss   71.5  footprint   27.0  cpu 0.92 -> 1.22 = 0.30
    workspaces  pid 48255  rss   63.5  footprint   22.0  cpu 0.92 -> 1.23 = 0.31
    teams       pid 48256  rss   67.4  footprint   23.0  cpu 0.91 -> 1.22 = 0.31
main run 1 startup: core answering 929 ms, start exited 956 ms, first agent 1901 ms, start exit 0, load [27.45, 24.7, 39.71]
main run 1 (a) load [25.3, 24.92, 38.71] -> [33.86, 30.02, 36.79]; changed during window: none; manifest requests so far 6
    master      pid 71302  rss   69.9  footprint   17.0  cpu 0.41 -> 0.47 = 0.06
    core        pid 73193  rss  131.5  footprint   85.0  cpu 0.84 -> 3.04 = 2.20
    search      pid 73254  rss   81.5  footprint   40.0  cpu 0.36 -> 0.74 = 0.38
    viewers     pid 73287  rss   74.2  footprint   29.0  cpu 0.25 -> 0.63 = 0.38
    edge        pid 73340  rss   63.8  footprint   23.0  cpu 0.22 -> 0.60 = 0.38
    gateway     pid 73363  rss   75.8  footprint   30.0  cpu 0.34 -> 0.71 = 0.37
    models      pid 73631  rss   70.0  footprint   29.0  cpu 0.22 -> 0.59 = 0.37
    updater     pid 73651  rss   65.9  footprint   24.0  cpu 0.20 -> 0.62 = 0.42
main run 1 (b) load [34.79, 30.98, 36.65] -> [58.23, 44.39, 40.6]; changed during window: none; manifest requests so far 12
    master      pid 71302  rss   71.1  footprint   19.0  cpu 0.48 -> 0.54 = 0.06
    core        pid 73193  rss  139.8  footprint   95.0  cpu 4.83 -> 8.00 = 3.17
    search      pid 73254  rss   81.8  footprint   39.0  cpu 0.83 -> 1.35 = 0.52
    viewers     pid 73287  rss   75.4  footprint   31.0  cpu 0.71 -> 1.10 = 0.39
    edge        pid 73340  rss   65.5  footprint   25.0  cpu 0.70 -> 1.10 = 0.40
    gateway     pid 73363  rss   77.1  footprint   32.0  cpu 0.80 -> 1.19 = 0.39
    models      pid 73631  rss   71.2  footprint   27.0  cpu 0.68 -> 1.05 = 0.37
    updater     pid 73651  rss   83.8  footprint   31.0  cpu 0.71 -> 1.10 = 0.39
main run 1 (c) load [53.02, 45.51, 41.28] -> [63.46, 56.03, 47.21]; changed during window: none; manifest requests so far 18
    master      pid 71302  rss   71.6  footprint   19.0  cpu 0.55 -> 0.61 = 0.06
    core        pid 73193  rss  140.9  footprint   97.0  cpu 8.64 -> 11.28 = 2.64
    search      pid 73254  rss   84.6  footprint   40.0  cpu 1.43 -> 1.80 = 0.37
    viewers     pid 73287  rss   75.7  footprint   30.0  cpu 1.18 -> 1.55 = 0.37
    edge        pid 73340  rss   65.9  footprint   25.0  cpu 1.18 -> 1.56 = 0.38
    gateway     pid 73363  rss   77.4  footprint   31.0  cpu 1.26 -> 1.64 = 0.38
    models      pid 73631  rss   71.5  footprint   27.0  cpu 1.13 -> 1.50 = 0.37
    updater     pid 73651  rss   84.6  footprint   26.0  cpu 1.18 -> 1.56 = 0.38
main run 2 startup: core answering 985 ms, start exited 1033 ms, first agent 2307 ms, start exit 0, load [67.93, 59.67, 49.54]
main run 2 (a) load [67.27, 60.85, 50.72] -> [49.61, 55.26, 51.19]; changed during window: none; manifest requests so far 6
    master      pid 11883  rss   70.7  footprint   17.0  cpu 0.41 -> 0.47 = 0.06
    core        pid 14868  rss  135.9  footprint   86.0  cpu 0.86 -> 3.04 = 2.18
    search      pid 14977  rss   80.0  footprint   39.0  cpu 0.41 -> 0.78 = 0.37
    viewers     pid 15031  rss   74.6  footprint   31.0  cpu 0.26 -> 0.64 = 0.38
    edge        pid 15109  rss   64.1  footprint   23.0  cpu 0.23 -> 0.62 = 0.39
    gateway     pid 15216  rss   75.9  footprint   30.0  cpu 0.36 -> 0.73 = 0.37
    models      pid 15322  rss   69.7  footprint   26.0  cpu 0.25 -> 0.62 = 0.37
    updater     pid 15443  rss   65.8  footprint   24.0  cpu 0.22 -> 0.64 = 0.42
main run 2 (b) load [54.47, 55.82, 51.74] -> [36.61, 48.16, 49.95]; changed during window: none; manifest requests so far 12
    master      pid 11883  rss   71.9  footprint   19.0  cpu 0.49 -> 0.55 = 0.06
    core        pid 14868  rss  143.9  footprint   95.0  cpu 4.61 -> 7.68 = 3.07
    search      pid 14977  rss   80.4  footprint   37.0  cpu 0.87 -> 1.39 = 0.52
    viewers     pid 15031  rss   75.8  footprint   31.0  cpu 0.72 -> 1.09 = 0.37
    edge        pid 15109  rss   66.0  footprint   25.0  cpu 0.72 -> 1.11 = 0.39
    gateway     pid 15216  rss   77.2  footprint   32.0  cpu 0.82 -> 1.20 = 0.38
    models      pid 15322  rss   70.8  footprint   27.0  cpu 0.70 -> 1.07 = 0.37
    updater     pid 15443  rss   84.8  footprint   24.0  cpu 0.73 -> 1.11 = 0.38
main run 2 (c) load [35.51, 46.06, 49.06] -> [32.21, 42.09, 46.67]; changed during window: none; manifest requests so far 18
    master      pid 11883  rss   72.3  footprint   19.0  cpu 0.56 -> 0.62 = 0.06
    core        pid 14868  rss  147.4  footprint  101.0  cpu 8.27 -> 11.11 = 2.84
    search      pid 14977  rss   83.8  footprint   39.0  cpu 1.47 -> 1.83 = 0.36
    viewers     pid 15031  rss   76.0  footprint   31.0  cpu 1.16 -> 1.53 = 0.37
    edge        pid 15109  rss   66.4  footprint   25.0  cpu 1.19 -> 1.57 = 0.38
    gateway     pid 15216  rss   77.5  footprint   32.0  cpu 1.27 -> 1.64 = 0.37
    models      pid 15322  rss   71.2  footprint   27.0  cpu 1.15 -> 1.52 = 0.37
    updater     pid 15443  rss   85.6  footprint   25.0  cpu 1.19 -> 1.56 = 0.37
main run 3 startup: core answering 791 ms, start exited 952 ms, first agent 1817 ms, start exit 0, load [30.91, 41.66, 46.49]
main run 3 (a) load [22.7, 37.25, 44.5] -> [11.17, 22.37, 35.57]; changed during window: none; manifest requests so far 6
    master      pid 31787  rss   69.3  footprint   17.0  cpu 0.36 -> 0.40 = 0.04
    core        pid 32640  rss  133.1  footprint   88.0  cpu 0.73 -> 2.56 = 1.83
    search      pid 32641  rss   83.4  footprint   41.0  cpu 0.36 -> 0.67 = 0.31
    viewers     pid 32644  rss   74.6  footprint   29.0  cpu 0.24 -> 0.55 = 0.31
    edge        pid 32663  rss   63.8  footprint   23.0  cpu 0.21 -> 0.53 = 0.32
    gateway     pid 32665  rss   76.1  footprint   30.0  cpu 0.32 -> 0.62 = 0.30
    models      pid 32666  rss   70.4  footprint   28.0  cpu 0.22 -> 0.53 = 0.31
    updater     pid 32668  rss   65.9  footprint   24.0  cpu 0.20 -> 0.55 = 0.35
main run 3 (b) load [11.71, 20.36, 33.84] -> [12.29, 15.29, 27.52]; changed during window: none; manifest requests so far 12
    master      pid 31787  rss   70.6  footprint   18.0  cpu 0.41 -> 0.44 = 0.03
    core        pid 32640  rss  141.6  footprint   98.0  cpu 3.84 -> 6.39 = 2.55
    search      pid 32641  rss   83.8  footprint   38.0  cpu 0.74 -> 1.14 = 0.40
    viewers     pid 32644  rss   75.8  footprint   30.0  cpu 0.61 -> 0.91 = 0.30
    edge        pid 32663  rss   65.5  footprint   24.0  cpu 0.60 -> 0.91 = 0.31
    gateway     pid 32665  rss   77.5  footprint   31.0  cpu 0.68 -> 0.98 = 0.30
    models      pid 32666  rss   71.5  footprint   28.0  cpu 0.59 -> 0.89 = 0.30
    updater     pid 32668  rss   83.5  footprint   25.0  cpu 0.61 -> 0.92 = 0.31
main run 3 (c) load [10.03, 14.12, 26.25] -> [24.89, 23.76, 26.98]; changed during window: none; manifest requests so far 18
    master      pid 31787  rss   71.0  footprint   19.0  cpu 0.45 -> 0.50 = 0.05
    core        pid 32640  rss  142.5  footprint  100.0  cpu 6.87 -> 9.31 = 2.44
    search      pid 32641  rss   86.0  footprint   40.0  cpu 1.20 -> 1.50 = 0.30
    viewers     pid 32644  rss   76.1  footprint   30.0  cpu 0.97 -> 1.27 = 0.30
    edge        pid 32663  rss   65.9  footprint   25.0  cpu 0.97 -> 1.28 = 0.31
    gateway     pid 32665  rss   77.7  footprint   31.0  cpu 1.03 -> 1.33 = 0.30
    models      pid 32666  rss   71.8  footprint   27.0  cpu 0.94 -> 1.24 = 0.30
    updater     pid 32668  rss   84.3  footprint   26.0  cpu 0.97 -> 1.28 = 0.31
```


---

# Models and the gateway on demand: scenario (a) against main 16469660b

PRs #971 (models on demand) and #972 (the gateway on demand), both merged.

**Builds:**
- `main16`: main 16469660b.
- `models`: #971 at f5a7c2a3e.
- `gateway`: #972 at 9c3c08d26, with #971 under it.

All three builds ran from the bundle with the same harness (main 16469660b's e2e harness). The scenario is (a): idle, no agents, signed out, no grid, nothing paired. Each run gives 60 s to settle, then measures, then a 5-minute CPU window.

**Pairing:** 3 runs. The three builds ran at the same time, 20 s apart, from 00:10 to 00:35. The 1-minute load was 10 to 39 in runs 1 and 2, and up to 88 by the end of run 3 as other suites started.

An earlier set run beside the semi-space runs (below) gave the same story. Its run 3 was under memory pressure, with lower RSS for every build. Its raw numbers were not committed.

## Summary

| | main 16469660b | models on demand | models and gateway on demand |
|---|---|---|---|
| processes at idle | 8 | 7 | 6 |
| all processes' footprint | 245 MiB (242–246) | 222 MiB (221–228) | **190 MiB** (185–193) |
| all processes' RSS | 607.6 MiB (606.5–609.6) | 540.3 MiB (537.7–540.3) | **459.5 MiB** (458.1–462.8) |
| all processes' CPU over 5 min | 4.50 s | 4.20 s | 3.94 s |
| models' process (main) | 69.3 RSS / 25 fp / 0.36 s | — | — |
| the gateway's process (main) | 75.1 RSS / 29 fp / 0.34 s | 75.3 / 31 / 0.35 s | — |

- **Footprint:** −55 MiB across all processes (−23 for models, −32 for the gateway). With 16469660b's own savings in the core, the total (190 MiB) is now below 0.3.60's 223 MiB, measured earlier with the same harness.
- **RSS:** −148 MiB, which counts each process's shared pages.
- **Every remaining process is within noise of main.** That includes the core (57–61 MiB footprint).
- **A phone reaches a signed-in machine no later than on main.** Median from the daemon's start to the phone's first session over 10 runs: 912 ms on main, 743 ms on the branch.

## Tables


### (a) idle, no agents

Medians of 3 runs (range in brackets). RSS and footprint in MiB after 60 s settled; CPU in seconds over the next 5 minutes.

| process | RSS main16 | RSS models | RSS gateway | footprint main16 | footprint models | footprint gateway | CPU s main16 | CPU s models | CPU s gateway |
|---|---|---|---|---|---|---|---|---|---|
| master | 70.0 (69.6–70.4) | 69.3 (68.8–69.7) | 67.7 (67.7–67.8) | 19.0 (17.0–19.0) | 17.0 (17.0–20.0) | 17.0 (17.0–17.0) | 0.05 (0.04–0.06) | 0.05 (0.04–0.06) | 0.05 (0.03–0.05) |
| core | 109.9 (106.0–112.1) | 109.7 (108.8–112.0) | 108.3 (106.9–109.0) | 57.0 (57.0–58.0) | 60.0 (59.0–61.0) | 56.0 (55.0–60.0) | 2.28 (2.09–2.49) | 2.29 (2.09–2.51) | 2.39 (2.07–2.51) |
| search | 80.2 (79.6–83.9) | 82.3 (79.9–84.5) | 81.8 (79.5–83.9) | 38.0 (38.0–41.0) | 40.0 (38.0–41.0) | 41.0 (37.0–42.0) | 0.35 (0.26–0.35) | 0.34 (0.26–0.36) | 0.35 (0.27–0.36) |
| viewers | 73.7 (73.3–73.9) | 73.8 (73.7–74.4) | 74.0 (73.1–74.0) | 29.0 (28.0–30.0) | 31.0 (28.0–31.0) | 30.0 (29.0–31.0) | 0.35 (0.26–0.35) | 0.35 (0.26–0.36) | 0.36 (0.27–0.36) |
| edge | 63.4 (63.3–63.8) | 63.6 (63.3–63.9) | 63.2 (63.1–63.7) | 22.0 (22.0–22.0) | 23.0 (22.0–23.0) | 22.0 (22.0–23.0) | 0.36 (0.27–0.38) | 0.37 (0.27–0.38) | 0.37 (0.28–0.37) |
| gateway | 75.1 (75.0–75.3) | 75.3 (74.7–75.3) | — | 29.0 (29.0–30.0) | 31.0 (28.0–32.0) | — | 0.34 (0.26–0.35) | 0.35 (0.26–0.36) | — |
| models | 69.3 (69.3–69.3) | — | — | 25.0 (25.0–27.0) | — | — | 0.36 (0.26–0.36) | — | — |
| updater | 65.8 (65.5–66.0) | 65.0 (64.8–65.5) | 65.6 (65.4–65.7) | 24.0 (23.0–24.0) | 23.0 (23.0–23.0) | 23.0 (23.0–23.0) | 0.41 (0.31–0.41) | 0.40 (0.31–0.41) | 0.40 (0.31–0.42) |
| **total** | **607.6** (606.5–609.6) | **540.3** (537.7–540.3) | **459.5** (458.1–462.8) | **245.0** (242.0–246.0) | **222.0** (221.0–228.0) | **190.0** (185.0–193.0) | **4.50** (3.75–4.75) | **4.20** (3.49–4.39) | **3.94** (3.23–4.05) |

### Start-up (`harness start` on a fresh machine)

Milliseconds from spawning `harness start`. Medians of 3 runs (range).

| | main16 | models | gateway |
|---|---|---|---|
| core answers /api/health | 3445 (3336–4577) | 3304 (2983–6256) | 3264 (1730–5391) |
| `harness start` exits | 3510 (3499–4604) | 3513 (3143–6374) | 3486 (1723–5485) |
| first agent_create succeeds | 4387 (4095–6392) | 4255 (4097–7806) | 4034 (2508–7971) |

### Load average during each run

1/5/15-minute load at the start of each measurement window, and the 1-minute load at its end.

| build | run | start-up | (a) |
|---|---|---|---|
| main16 | 1 | 10.27 / 16.25 / 18.72 | 10.25 / 15.23 / 18.17 → 9.31 |
| main16 | 2 | 10.24 / 11.37 / 15.28 | 21.56 / 13.9 / 15.91 → 67.03 |
| main16 | 3 | 82.65 / 50.22 / 31.99 | 87.69 / 58.8 / 36.6 → 93.12 |
| models | 1 | 9.79 / 15.74 / 18.48 | 11.19 / 15.12 / 18.06 → 9.11 |
| models | 2 | 10.52 / 11.36 / 15.19 | 31.55 / 16.67 / 16.85 → 74.07 |
| models | 3 | 93.13 / 54.74 / 34.04 | 78.37 / 58.93 / 37.29 → 103.35 |
| gateway | 1 | 11.78 / 15.83 / 18.45 | 10.16 / 14.62 / 17.82 → 9.91 |
| gateway | 2 | 10.04 / 11.2 / 15.04 | 38.56 / 19.22 / 17.76 → 78.32 |
| gateway | 3 | 91.05 / 57.4 / 35.6 | 70.93 / 58.52 / 37.65 → 108.82 |

### Raw numbers

Per run, per scenario, per process: pid, RSS MiB, footprint MiB, CPU seconds at the window's start and end, and their difference.

```
main16 run 1 startup: core answering 3336 ms, start exited 3510 ms, first agent 4095 ms, start exit 0, load [10.27, 16.25, 18.72]
main16 run 1 (a) load [10.25, 15.23, 18.17] -> [9.31, 11.47, 15.53]; changed during window: none; manifest requests so far 6
    master      pid 4879   rss   69.6  footprint   19.0  cpu 0.35 -> 0.39 = 0.04
    core        pid 5511   rss  106.0  footprint   57.0  cpu 0.74 -> 2.83 = 2.09
    search      pid 5512   rss   83.9  footprint   41.0  cpu 0.34 -> 0.60 = 0.26
    viewers     pid 5513   rss   73.9  footprint   29.0  cpu 0.20 -> 0.46 = 0.26
    edge        pid 5514   rss   63.8  footprint   22.0  cpu 0.17 -> 0.44 = 0.27
    gateway     pid 5524   rss   75.1  footprint   29.0  cpu 0.28 -> 0.54 = 0.26
    models      pid 5526   rss   69.3  footprint   25.0  cpu 0.18 -> 0.44 = 0.26
    updater     pid 5555   rss   66.0  footprint   24.0  cpu 0.17 -> 0.48 = 0.31
main16 run 2 startup: core answering 3445 ms, start exited 3499 ms, first agent 4387 ms, start exit 0, load [10.24, 11.37, 15.28]
main16 run 2 (a) load [21.56, 13.9, 15.91] -> [67.03, 42.25, 28.25]; changed during window: none; manifest requests so far 6
    master      pid 3544   rss   70.0  footprint   17.0  cpu 0.37 -> 0.42 = 0.05
    core        pid 6283   rss  109.9  footprint   57.0  cpu 0.77 -> 3.05 = 2.28
    search      pid 6362   rss   80.2  footprint   38.0  cpu 0.37 -> 0.72 = 0.35
    viewers     pid 6483   rss   73.3  footprint   28.0  cpu 0.23 -> 0.58 = 0.35
    edge        pid 6572   rss   63.3  footprint   22.0  cpu 0.19 -> 0.55 = 0.36
    gateway     pid 6600   rss   75.0  footprint   30.0  cpu 0.31 -> 0.65 = 0.34
    models      pid 6601   rss   69.3  footprint   27.0  cpu 0.20 -> 0.56 = 0.36
    updater     pid 6623   rss   65.5  footprint   23.0  cpu 0.19 -> 0.60 = 0.41
main16 run 3 startup: core answering 4577 ms, start exited 4604 ms, first agent 6392 ms, start exit 0, load [82.65, 50.22, 31.99]
main16 run 3 (a) load [87.69, 58.8, 36.6] -> [93.12, 68.85, 47.09]; changed during window: none; manifest requests so far 6
    master      pid 48298  rss   70.4  footprint   19.0  cpu 0.40 -> 0.46 = 0.06
    core        pid 51000  rss  112.1  footprint   58.0  cpu 0.82 -> 3.31 = 2.49
    search      pid 51008  rss   79.6  footprint   38.0  cpu 0.37 -> 0.72 = 0.35
    viewers     pid 51029  rss   73.7  footprint   30.0  cpu 0.25 -> 0.60 = 0.35
    edge        pid 51067  rss   63.4  footprint   22.0  cpu 0.21 -> 0.59 = 0.38
    gateway     pid 51151  rss   75.3  footprint   29.0  cpu 0.30 -> 0.65 = 0.35
    models      pid 51192  rss   69.3  footprint   25.0  cpu 0.21 -> 0.57 = 0.36
    updater     pid 51318  rss   65.8  footprint   24.0  cpu 0.21 -> 0.62 = 0.41
models run 1 startup: core answering 3304 ms, start exited 3513 ms, first agent 4097 ms, start exit 0, load [9.79, 15.74, 18.48]
models run 1 (a) load [11.19, 15.12, 18.06] -> [9.11, 11.29, 15.37]; changed during window: none; manifest requests so far 6
    master      pid 59840  rss   69.3  footprint   20.0  cpu 0.34 -> 0.38 = 0.04
    core        pid 60964  rss  112.0  footprint   60.0  cpu 0.74 -> 2.83 = 2.09
    search      pid 60981  rss   82.3  footprint   40.0  cpu 0.35 -> 0.61 = 0.26
    viewers     pid 60982  rss   73.7  footprint   31.0  cpu 0.21 -> 0.47 = 0.26
    edge        pid 60983  rss   63.3  footprint   23.0  cpu 0.18 -> 0.45 = 0.27
    gateway     pid 60984  rss   74.7  footprint   31.0  cpu 0.28 -> 0.54 = 0.26
    updater     pid 60985  rss   65.0  footprint   23.0  cpu 0.18 -> 0.49 = 0.31
models run 2 startup: core answering 2983 ms, start exited 3143 ms, first agent 4255 ms, start exit 0, load [10.52, 11.36, 15.19]
models run 2 (a) load [31.55, 16.67, 16.85] -> [74.07, 45.47, 29.73]; changed during window: none; manifest requests so far 6
    master      pid 57771  rss   68.8  footprint   17.0  cpu 0.37 -> 0.42 = 0.05
    core        pid 59156  rss  108.8  footprint   59.0  cpu 0.80 -> 3.09 = 2.29
    search      pid 59209  rss   84.5  footprint   41.0  cpu 0.36 -> 0.72 = 0.36
    viewers     pid 59238  rss   73.8  footprint   31.0  cpu 0.25 -> 0.61 = 0.36
    edge        pid 59264  rss   63.6  footprint   22.0  cpu 0.20 -> 0.57 = 0.37
    gateway     pid 59350  rss   75.3  footprint   28.0  cpu 0.33 -> 0.69 = 0.36
    updater     pid 59352  rss   65.5  footprint   23.0  cpu 0.20 -> 0.61 = 0.41
models run 3 startup: core answering 6256 ms, start exited 6374 ms, first agent 7806 ms, start exit 0, load [93.13, 54.74, 34.04]
models run 3 (a) load [78.37, 58.93, 37.29] -> [103.35, 72.71, 48.97]; changed during window: none; manifest requests so far 6
    master      pid 72751  rss   69.7  footprint   17.0  cpu 0.38 -> 0.44 = 0.06
    core        pid 74951  rss  109.7  footprint   61.0  cpu 0.84 -> 3.35 = 2.51
    search      pid 74962  rss   79.9  footprint   38.0  cpu 0.39 -> 0.73 = 0.34
    viewers     pid 75071  rss   74.4  footprint   28.0  cpu 0.26 -> 0.61 = 0.35
    edge        pid 75079  rss   63.9  footprint   23.0  cpu 0.22 -> 0.60 = 0.38
    gateway     pid 75143  rss   75.3  footprint   32.0  cpu 0.32 -> 0.67 = 0.35
    updater     pid 75177  rss   64.8  footprint   23.0  cpu 0.20 -> 0.60 = 0.40
gateway run 1 startup: core answering 3264 ms, start exited 3486 ms, first agent 4034 ms, start exit 0, load [11.78, 15.83, 18.45]
gateway run 1 (a) load [10.16, 14.62, 17.82] -> [9.91, 11.33, 15.29]; changed during window: none; manifest requests so far 6
    master      pid 4042   rss   67.8  footprint   17.0  cpu 0.33 -> 0.36 = 0.03
    core        pid 4841   rss  108.3  footprint   60.0  cpu 0.71 -> 2.78 = 2.07
    search      pid 4845   rss   83.9  footprint   42.0  cpu 0.32 -> 0.59 = 0.27
    viewers     pid 4846   rss   74.0  footprint   29.0  cpu 0.21 -> 0.48 = 0.27
    edge        pid 4847   rss   63.1  footprint   22.0  cpu 0.18 -> 0.46 = 0.28
    updater     pid 4859   rss   65.7  footprint   23.0  cpu 0.17 -> 0.48 = 0.31
gateway run 2 startup: core answering 1730 ms, start exited 1723 ms, first agent 2508 ms, start exit 0, load [10.04, 11.2, 15.04]
gateway run 2 (a) load [38.56, 19.22, 17.76] -> [78.32, 48.32, 31.11]; changed during window: none; manifest requests so far 6
    master      pid 87877  rss   67.7  footprint   17.0  cpu 0.37 -> 0.42 = 0.05
    core        pid 87955  rss  106.9  footprint   55.0  cpu 0.84 -> 3.23 = 2.39
    search      pid 87956  rss   81.8  footprint   41.0  cpu 0.40 -> 0.75 = 0.35
    viewers     pid 87972  rss   74.0  footprint   31.0  cpu 0.24 -> 0.60 = 0.36
    edge        pid 88000  rss   63.7  footprint   23.0  cpu 0.21 -> 0.58 = 0.37
    updater     pid 88006  rss   65.4  footprint   23.0  cpu 0.20 -> 0.62 = 0.42
gateway run 3 startup: core answering 5391 ms, start exited 5485 ms, first agent 7971 ms, start exit 0, load [91.05, 57.4, 35.6]
gateway run 3 (a) load [70.93, 58.52, 37.65] -> [108.82, 75.92, 50.67]; changed during window: none; manifest requests so far 7
    master      pid 1231   rss   67.7  footprint   17.0  cpu 0.39 -> 0.44 = 0.05
    core        pid 3452   rss  109.0  footprint   56.0  cpu 0.89 -> 3.40 = 2.51
    search      pid 3539   rss   79.5  footprint   37.0  cpu 0.39 -> 0.75 = 0.36
    viewers     pid 3571   rss   73.1  footprint   30.0  cpu 0.26 -> 0.62 = 0.36
    edge        pid 3670   rss   63.2  footprint   22.0  cpu 0.23 -> 0.60 = 0.37
    updater     pid 3934   rss   65.6  footprint   23.0  cpu 0.22 -> 0.62 = 0.40
```


---

# The semi-space flag: 16469660b against its parent d03750d4f

16469660b makes the master start the core and every service with `--max-semi-space-size=4`, and escapes the bundle's characters above U+00FF. This compares it against its parent, with the same harness and the same scenario (a).

**The busy scenario:** both agents take turns back to back for the whole 5-minute window. Each prompt is `!flood 32 …`: a turn that prints 32 KiB to the agent's terminal, as a build log does. A window has the Claude Code agent's terminal open and keeps it alive as the app does.

**Pairing:** 3 runs. Both builds ran at the same time, 45 s apart, with the order alternating. The 1-minute load was 8 to 22.

## Summary

| | parent d03750d4f | 16469660b | change |
|---|---|---|---|
| core CPU per turn, busy | 0.180 s (0.180–0.183) | 0.193 s (0.188–0.197) | **+7%** |
| turns completed in 5 min, busy | 334 (317–344) | 309 (294–310) | **−7.5%** |
| core CPU over the busy window | 60.2 s | 58.0 s | −4% (fewer turns) |
| core footprint at the end of the busy window | 204 MiB | 158 MiB | −46 MiB |
| core RSS at the end of the busy window | 225 MiB | 192 MiB | −33 MiB |
| core CPU over 5 min, idle | 1.95 s | 2.01 s | +3%, within noise |
| core footprint, idle | 96 MiB | 73 MiB | −23 MiB |
| all processes' footprint, busy (end) | 405 MiB | 354 MiB | −51 MiB |

**What it says:**
- **Busy CPU rises:** the flag costs the busy core about 7% more CPU per turn.
- **Busy throughput drops:** in the same 5 minutes the agents got through about 7.5% fewer turns. A turn here is fast and paced by the core, so the extra scavenges sit on the turn's path. The per-turn cost is the cleaner number.
- **Idle cost is none:** core CPU at idle is the same within noise, and the other processes' CPU is unchanged either way.
- **The memory saving is real:** 46 MiB less core footprint under load, 23 MiB idle.
- **This is the teammate's call.** It is reported, not reverted.

Per-run core CPU per turn:

| run | parent | 16469660b |
|---|---|---|
| 1 | 60.24 s / 334 turns = 0.1804 | 57.97 s / 309 turns = 0.1876 |
| 2 | 62.07 s / 344 turns = 0.1804 | 61.20 s / 310 turns = 0.1974 |
| 3 | 58.15 s / 317 turns = 0.1834 | 56.80 s / 294 turns = 0.1932 |

## Tables


### (a) idle, no agents

Medians of 3 runs (range in brackets). RSS and footprint in MiB after 60 s settled; CPU in seconds over the next 5 minutes.

| process | RSS parent | RSS main16 | footprint parent | footprint main16 | CPU s parent | CPU s main16 |
|---|---|---|---|---|---|---|
| master | 70.9 (47.3–71.1) | 70.0 (50.0–70.7) | 17.0 (17.0–26.0) | 27.0 (17.0–27.0) | 0.05 (0.04–0.05) | 0.04 (0.04–0.05) |
| core | 135.1 (115.4–142.6) | 111.3 (96.3–111.3) | 96.0 (88.0–102.0) | 73.0 (61.0–74.0) | 1.95 (1.86–1.99) | 2.01 (1.95–2.20) |
| search | 81.4 (69.8–81.7) | 81.8 (68.4–82.0) | 40.0 (40.0–41.0) | 40.0 (40.0–41.0) | 0.32 (0.32–0.35) | 0.31 (0.30–0.34) |
| viewers | 74.3 (66.1–74.4) | 73.5 (63.9–73.7) | 29.0 (29.0–33.0) | 31.0 (28.0–32.0) | 0.32 (0.32–0.36) | 0.31 (0.30–0.35) |
| edge | 63.8 (59.5–63.9) | 63.2 (55.5–63.3) | 23.0 (23.0–23.0) | 23.0 (22.0–23.0) | 0.33 (0.32–0.38) | 0.32 (0.32–0.36) |
| gateway | 76.1 (68.9–76.5) | 74.9 (65.0–75.1) | 32.0 (30.0–35.0) | 33.0 (30.0–33.0) | 0.32 (0.32–0.36) | 0.32 (0.31–0.35) |
| models | 69.8 (61.6–70.1) | 69.4 (59.4–70.0) | 27.0 (26.0–29.0) | 29.0 (28.0–30.0) | 0.32 (0.31–0.36) | 0.31 (0.30–0.35) |
| updater | 65.2 (63.4–65.9) | 65.1 (61.1–65.5) | 24.0 (23.0–24.0) | 23.0 (23.0–23.0) | 0.37 (0.36–0.40) | 0.36 (0.36–0.40) |
| **total** | **637.7** (552.0–645.1) | **609.7** (519.6–611.1) | **284.0** (280.0–313.0) | **281.0** (249.0–281.0) | **3.96** (3.87–4.25) | **3.98** (3.88–4.40) |

### busy: both agents taking turns back to back for the whole window, each printing 32 KiB, a window with the Claude Code agent's terminal open

Medians of 3 runs (range in brackets). RSS and footprint in MiB after 60 s settled, read at the end of the busy window; CPU in seconds over the next 5 minutes.

*parent: turns per run (claude+codex) [334, 344, 317], window [303, 302, 302] s*
*main16: turns per run (claude+codex) [309, 310, 294], window [302, 301, 302] s*

| process | RSS parent | RSS main16 | footprint parent | footprint main16 | CPU s parent | CPU s main16 |
|---|---|---|---|---|---|---|
| master | 53.0 (50.3–72.8) | 52.9 (52.3–72.4) | 19.0 (19.0–19.0) | 19.0 (19.0–19.0) | 0.05 (0.05–0.06) | 0.05 (0.05–0.07) |
| core | 224.7 (223.1–230.0) | 192.2 (191.3–198.8) | 204.0 (191.0–207.0) | 158.0 (150.0–166.0) | 60.24 (58.15–62.07) | 57.97 (56.80–61.20) |
| search | 81.5 (79.7–85.0) | 80.0 (79.2–85.1) | 40.0 (39.0–40.0) | 39.0 (38.0–40.0) | 1.14 (1.11–1.15) | 1.12 (1.10–1.17) |
| viewers | 67.7 (65.6–75.9) | 65.7 (59.0–74.9) | 30.0 (30.0–30.0) | 29.0 (29.0–30.0) | 0.39 (0.38–0.40) | 0.39 (0.38–0.40) |
| edge | 64.7 (64.7–68.6) | 62.7 (61.6–67.8) | 26.0 (25.0–27.0) | 26.0 (24.0–26.0) | 0.94 (0.93–0.96) | 0.88 (0.85–0.92) |
| gateway | 71.2 (66.0–78.0) | 66.9 (61.3–76.7) | 32.0 (32.0–32.0) | 30.0 (30.0–31.0) | 0.39 (0.38–0.40) | 0.39 (0.38–0.40) |
| models | 63.3 (61.3–71.3) | 61.1 (58.2–71.5) | 27.0 (27.0–28.0) | 27.0 (27.0–27.0) | 0.40 (0.38–0.41) | 0.39 (0.38–0.40) |
| updater | 81.3 (70.4–84.4) | 80.0 (62.5–83.9) | 25.0 (24.0–26.0) | 25.0 (24.0–25.0) | 0.41 (0.38–0.41) | 0.40 (0.38–0.41) |
| **total** | **710.0** (683.8–760.7) | **660.7** (633.7–723.6) | **405.0** (389.0–405.0) | **354.0** (342.0–362.0) | **63.86** (61.89–65.83) | **61.54** (60.57–64.77) |

### Start-up (`harness start` on a fresh machine)

Milliseconds from spawning `harness start`. Medians of 3 runs (range).

| | parent | main16 |
|---|---|---|
| core answers /api/health | 2657 (2044–4124) | 2690 (1767–2909) |
| `harness start` exits | 2776 (2062–4223) | 2753 (1943–3047) |
| first agent_create succeeds | 3541 (3105–5001) | 3510 (2619–3839) |

### Load average during each run

1/5/15-minute load at the start of each measurement window, and the 1-minute load at its end.

| build | run | start-up | (a) | (busy) |
|---|---|---|---|---|
| parent | 1 | 8.01 / 17.74 / 32.27 | 7.51 / 15.75 / 30.45 → 9.33 | 14.81 / 12.62 / 23.52 → 18.89 |
| parent | 2 | 24 / 19.38 / 23.32 | 18.07 / 18.22 / 22.61 → 11.6 | 9.79 / 13.69 / 18.98 → 22.74 |
| parent | 3 | 13.13 / 15.31 / 17.86 | 10.1 / 14.08 / 17.23 → 11.97 | 22.17 / 16.42 / 17.04 → 15.92 |
| main16 | 1 | 8.69 / 19.38 / 33.6 | 7.89 / 17.08 / 31.69 → 10.01 | 9.18 / 11.6 / 23.85 → 22.32 |
| main16 | 2 | 16.83 / 18.08 / 22.67 | 15.45 / 17.61 / 22.16 → 9.77 | 9.53 / 13.08 / 18.51 → 18.56 |
| main16 | 3 | 18.11 / 16.49 / 18.4 | 12.84 / 15.13 / 17.75 → 14.05 | 18.27 / 15.21 / 16.7 → 19.17 |

### Raw numbers

Per run, per scenario, per process: pid, RSS MiB, footprint MiB, CPU seconds at the window's start and end, and their difference.

```
parent run 1 startup: core answering 2044 ms, start exited 2062 ms, first agent 3105 ms, start exit 0, load [8.01, 17.74, 32.27]
parent run 1 (a) load [7.51, 15.75, 30.45] -> [9.33, 11.79, 24.21]; changed during window: none; manifest requests so far 6
    master      pid 36677  rss   70.9  footprint   17.0  cpu 0.40 -> 0.45 = 0.05
    core        pid 37049  rss  135.1  footprint   88.0  cpu 0.79 -> 2.74 = 1.95
    search      pid 37124  rss   81.4  footprint   40.0  cpu 0.38 -> 0.70 = 0.32
    viewers     pid 37126  rss   74.3  footprint   29.0  cpu 0.23 -> 0.55 = 0.32
    edge        pid 37129  rss   63.9  footprint   23.0  cpu 0.21 -> 0.54 = 0.33
    gateway     pid 37167  rss   76.1  footprint   32.0  cpu 0.31 -> 0.63 = 0.32
    models      pid 37207  rss   70.1  footprint   27.0  cpu 0.21 -> 0.52 = 0.31
    updater     pid 37209  rss   65.9  footprint   24.0  cpu 0.19 -> 0.55 = 0.36
parent run 1 (busy) load [14.81, 12.62, 23.52] -> [18.89, 18.3, 23]; changed during window: none; manifest requests so far 12
    master      pid 36677  rss   52.5  footprint   18.0  cpu 0.46 -> 0.51 = 0.05
    core        pid 37049  rss  131.0  footprint  103.0  cpu 4.38 -> 64.62 = 60.24
    search      pid 37124  rss   65.4  footprint   38.0  cpu 0.80 -> 1.91 = 1.11
    viewers     pid 37126  rss   65.3  footprint   30.0  cpu 0.64 -> 1.02 = 0.38
    edge        pid 37129  rss   60.3  footprint   25.0  cpu 0.65 -> 1.59 = 0.94
    gateway     pid 37167  rss   65.7  footprint   31.0  cpu 0.72 -> 1.10 = 0.38
    models      pid 37207  rss   61.0  footprint   27.0  cpu 0.60 -> 0.98 = 0.38
    updater     pid 37209  rss   69.7  footprint   24.0  cpu 0.64 -> 1.02 = 0.38
parent run 2 startup: core answering 4124 ms, start exited 4223 ms, first agent 5001 ms, start exit 0, load [24, 19.38, 23.32]
parent run 2 (a) load [18.07, 18.22, 22.61] -> [11.6, 14.9, 19.8]; changed during window: none; manifest requests so far 6
    master      pid 53705  rss   47.3  footprint   26.0  cpu 0.38 -> 0.42 = 0.04
    core        pid 55902  rss  115.4  footprint  102.0  cpu 0.71 -> 2.57 = 1.86
    search      pid 56012  rss   69.8  footprint   41.0  cpu 0.33 -> 0.65 = 0.32
    viewers     pid 56013  rss   66.1  footprint   33.0  cpu 0.23 -> 0.55 = 0.32
    edge        pid 56032  rss   59.5  footprint   23.0  cpu 0.20 -> 0.52 = 0.32
    gateway     pid 56078  rss   68.9  footprint   35.0  cpu 0.31 -> 0.63 = 0.32
    models      pid 56164  rss   61.6  footprint   29.0  cpu 0.20 -> 0.52 = 0.32
    updater     pid 56184  rss   63.4  footprint   24.0  cpu 0.20 -> 0.57 = 0.37
parent run 2 (busy) load [9.79, 13.69, 18.98] -> [22.74, 16.94, 18.66]; changed during window: none; manifest requests so far 13
    master      pid 53705  rss   49.7  footprint   19.0  cpu 0.43 -> 0.48 = 0.05
    core        pid 55902  rss  138.0  footprint  100.0  cpu 3.88 -> 65.95 = 62.07
    search      pid 56012  rss   70.8  footprint   40.0  cpu 0.73 -> 1.87 = 1.14
    viewers     pid 56013  rss   67.4  footprint   30.0  cpu 0.63 -> 1.03 = 0.40
    edge        pid 56032  rss   61.7  footprint   25.0  cpu 0.60 -> 1.56 = 0.96
    gateway     pid 56078  rss   70.7  footprint   31.0  cpu 0.70 -> 1.10 = 0.40
    models      pid 56164  rss   62.9  footprint   29.0  cpu 0.60 -> 1.00 = 0.40
    updater     pid 56184  rss   80.7  footprint   30.0  cpu 0.64 -> 1.05 = 0.41
parent run 3 startup: core answering 2657 ms, start exited 2776 ms, first agent 3541 ms, start exit 0, load [13.13, 15.31, 17.86]
parent run 3 (a) load [10.1, 14.08, 17.23] -> [11.97, 13.79, 16.24]; changed during window: none; manifest requests so far 6
    master      pid 65712  rss   71.1  footprint   17.0  cpu 0.37 -> 0.42 = 0.05
    core        pid 67258  rss  142.6  footprint   96.0  cpu 0.72 -> 2.71 = 1.99
    search      pid 67281  rss   81.7  footprint   40.0  cpu 0.34 -> 0.69 = 0.35
    viewers     pid 67282  rss   74.4  footprint   29.0  cpu 0.23 -> 0.59 = 0.36
    edge        pid 67283  rss   63.8  footprint   23.0  cpu 0.19 -> 0.57 = 0.38
    gateway     pid 67294  rss   76.5  footprint   30.0  cpu 0.32 -> 0.68 = 0.36
    models      pid 67295  rss   69.8  footprint   26.0  cpu 0.20 -> 0.56 = 0.36
    updater     pid 67297  rss   65.2  footprint   23.0  cpu 0.19 -> 0.59 = 0.40
parent run 3 (busy) load [22.17, 16.42, 17.04] -> [15.92, 17.56, 17.61]; changed during window: none; manifest requests so far 13
    master      pid 65712  rss   72.3  footprint   18.0  cpu 0.43 -> 0.49 = 0.06
    core        pid 67258  rss  148.3  footprint  102.0  cpu 4.26 -> 62.41 = 58.15
    search      pid 67281  rss   82.0  footprint   39.0  cpu 0.79 -> 1.94 = 1.15
    viewers     pid 67282  rss   75.6  footprint   30.0  cpu 0.68 -> 1.07 = 0.39
    edge        pid 67283  rss   65.6  footprint   25.0  cpu 0.67 -> 1.60 = 0.93
    gateway     pid 67294  rss   77.8  footprint   32.0  cpu 0.77 -> 1.16 = 0.39
    models      pid 67295  rss   71.0  footprint   27.0  cpu 0.64 -> 1.05 = 0.41
    updater     pid 67297  rss   83.8  footprint   24.0  cpu 0.68 -> 1.09 = 0.41
main16 run 1 startup: core answering 1767 ms, start exited 1943 ms, first agent 2619 ms, start exit 0, load [8.69, 19.38, 33.6]
main16 run 1 (a) load [7.89, 17.08, 31.69] -> [10.01, 12.31, 25.06]; changed during window: none; manifest requests so far 8
    master      pid 15501  rss   70.0  footprint   27.0  cpu 0.37 -> 0.41 = 0.04
    core        pid 15812  rss  111.3  footprint   73.0  cpu 0.81 -> 2.76 = 1.95
    search      pid 15813  rss   82.0  footprint   41.0  cpu 0.34 -> 0.64 = 0.30
    viewers     pid 15839  rss   73.7  footprint   32.0  cpu 0.25 -> 0.55 = 0.30
    edge        pid 15840  rss   63.3  footprint   23.0  cpu 0.20 -> 0.52 = 0.32
    gateway     pid 15871  rss   74.9  footprint   33.0  cpu 0.34 -> 0.65 = 0.31
    models      pid 15899  rss   69.4  footprint   29.0  cpu 0.21 -> 0.51 = 0.30
    updater     pid 15925  rss   65.1  footprint   23.0  cpu 0.20 -> 0.56 = 0.36
main16 run 1 (busy) load [9.18, 11.6, 23.85] -> [22.32, 18.49, 23.31]; changed during window: none; manifest requests so far 14
    master      pid 15501  rss   51.8  footprint   19.0  cpu 0.43 -> 0.48 = 0.05
    core        pid 15812  rss  102.6  footprint   72.0  cpu 4.34 -> 62.31 = 57.97
    search      pid 15813  rss   62.8  footprint   39.0  cpu 0.72 -> 1.84 = 1.12
    viewers     pid 15839  rss   58.5  footprint   30.0  cpu 0.63 -> 1.01 = 0.38
    edge        pid 15840  rss   58.4  footprint   24.0  cpu 0.62 -> 1.50 = 0.88
    gateway     pid 15871  rss   60.7  footprint   30.0  cpu 0.73 -> 1.11 = 0.38
    models      pid 15899  rss   57.1  footprint   29.0  cpu 0.59 -> 0.97 = 0.38
    updater     pid 15925  rss   61.8  footprint   24.0  cpu 0.64 -> 1.02 = 0.38
main16 run 2 startup: core answering 2909 ms, start exited 3047 ms, first agent 3839 ms, start exit 0, load [16.83, 18.08, 22.67]
main16 run 2 (a) load [15.45, 17.61, 22.16] -> [9.77, 14.03, 19.26]; changed during window: none; manifest requests so far 6
    master      pid 54447  rss   50.0  footprint   27.0  cpu 0.37 -> 0.41 = 0.04
    core        pid 55618  rss   96.3  footprint   74.0  cpu 0.80 -> 2.81 = 2.01
    search      pid 55619  rss   68.4  footprint   40.0  cpu 0.35 -> 0.66 = 0.31
    viewers     pid 55620  rss   63.9  footprint   31.0  cpu 0.24 -> 0.55 = 0.31
    edge        pid 55638  rss   55.5  footprint   23.0  cpu 0.20 -> 0.52 = 0.32
    gateway     pid 55661  rss   65.0  footprint   33.0  cpu 0.32 -> 0.64 = 0.32
    models      pid 55670  rss   59.4  footprint   30.0  cpu 0.22 -> 0.53 = 0.31
    updater     pid 55687  rss   61.1  footprint   23.0  cpu 0.20 -> 0.56 = 0.36
main16 run 2 (busy) load [9.53, 13.08, 18.51] -> [18.56, 16.55, 18.43]; changed during window: none; manifest requests so far 13
    master      pid 54447  rss   52.3  footprint   19.0  cpu 0.42 -> 0.47 = 0.05
    core        pid 55618  rss  102.8  footprint   65.0  cpu 4.34 -> 65.54 = 61.20
    search      pid 55619  rss   69.1  footprint   38.0  cpu 0.75 -> 1.85 = 1.10
    viewers     pid 55620  rss   65.4  footprint   29.0  cpu 0.63 -> 1.02 = 0.39
    edge        pid 55638  rss   58.9  footprint   24.0  cpu 0.61 -> 1.46 = 0.85
    gateway     pid 55661  rss   66.6  footprint   30.0  cpu 0.72 -> 1.11 = 0.39
    models      pid 55670  rss   60.7  footprint   27.0  cpu 0.61 -> 1.00 = 0.39
    updater     pid 55687  rss   79.3  footprint   28.0  cpu 0.63 -> 1.03 = 0.40
main16 run 3 startup: core answering 2690 ms, start exited 2753 ms, first agent 3510 ms, start exit 0, load [18.11, 16.49, 18.4]
main16 run 3 (a) load [12.84, 15.13, 17.75] -> [14.05, 14.32, 16.55]; changed during window: none; manifest requests so far 6
    master      pid 38861  rss   70.7  footprint   17.0  cpu 0.37 -> 0.42 = 0.05
    core        pid 39901  rss  111.3  footprint   61.0  cpu 0.78 -> 2.98 = 2.20
    search      pid 39902  rss   81.8  footprint   40.0  cpu 0.37 -> 0.71 = 0.34
    viewers     pid 39903  rss   73.5  footprint   28.0  cpu 0.23 -> 0.58 = 0.35
    edge        pid 39904  rss   63.2  footprint   22.0  cpu 0.20 -> 0.56 = 0.36
    gateway     pid 39958  rss   75.1  footprint   30.0  cpu 0.31 -> 0.66 = 0.35
    models      pid 39985  rss   70.0  footprint   28.0  cpu 0.21 -> 0.56 = 0.35
    updater     pid 39986  rss   65.5  footprint   23.0  cpu 0.20 -> 0.60 = 0.40
main16 run 3 (busy) load [18.27, 15.21, 16.7] -> [19.17, 18.38, 17.89]; changed during window: none; manifest requests so far 12
    master      pid 38861  rss   71.9  footprint   18.0  cpu 0.43 -> 0.50 = 0.07
    core        pid 39901  rss  115.6  footprint   62.0  cpu 4.60 -> 61.40 = 56.80
    search      pid 39902  rss   82.1  footprint   38.0  cpu 0.80 -> 1.97 = 1.17
    viewers     pid 39903  rss   74.7  footprint   29.0  cpu 0.65 -> 1.05 = 0.40
    edge        pid 39904  rss   64.9  footprint   24.0  cpu 0.64 -> 1.56 = 0.92
    gateway     pid 39958  rss   76.4  footprint   30.0  cpu 0.74 -> 1.14 = 0.40
    models      pid 39985  rss   71.2  footprint   27.0  cpu 0.63 -> 1.03 = 0.40
    updater     pid 39986  rss   83.1  footprint   24.0  cpu 0.67 -> 1.08 = 0.41
```
