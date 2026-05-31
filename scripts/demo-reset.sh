#!/usr/bin/env bash
# Reset the example demo to its pristine, committed state (stop the container,
# drop review output + git-database contents, restore the seed vault files).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
reset_demo
pass "demo reset to pristine"
