#!/usr/bin/env bash
# Resource-bounded runner for the startup-timeline profiler. Operates ONLY on a
# synthetic temp vault — never a real Obsidian vault. Caps memory/CPU/wall-clock
# so a large synthetic run cannot overload the host.
#
# Usage:
#   scripts/profile-timeline.sh                       # defaults (300 files, 10 cps)
#   OG_PROFILE_FILES=2000 OG_PROFILE_CHECKPOINTS=30 scripts/profile-timeline.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# --- resource limits (best-effort; ignored if the shell forbids them) -------
# NB: do NOT cap address space with `ulimit -v` — Node/V8/WASM reserve huge
# VIRTUAL memory regardless of real use, so a -v cap OOMs the runtime spuriously.
# We bound the V8 HEAP (real memory), CPU seconds, file size, and wall-clock.
ulimit -t 240     2>/dev/null || true   # 240s CPU seconds
ulimit -f 4194304 2>/dev/null || true   # ~4 GiB max file size

export OG_PROFILE=1
export OG_PROFILE_FILES="${OG_PROFILE_FILES:-300}"
export OG_PROFILE_CHECKPOINTS="${OG_PROFILE_CHECKPOINTS:-10}"
# Real-memory ceiling for the Node process (heap), plus bounded synthetic data.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=1536"

echo "profiling: files=$OG_PROFILE_FILES checkpoints=$OG_PROFILE_CHECKPOINTS (synthetic vault)"

# Hard wall-clock cap on top of the CPU ulimit. Single worker, no file
# parallelism (one test file anyway) to keep memory/CPU bounded.
timeout --signal=KILL 600 \
  pnpm --filter @obsidian-guardian/engine exec \
  vitest run test/timeline-perf.profile.test.ts \
  --no-file-parallelism --maxWorkers=1
