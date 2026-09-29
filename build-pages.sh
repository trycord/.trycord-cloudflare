#!/usr/bin/env bash
# Thin wrapper so the existing Cloudflare build entry point keeps working.
#
# The logic lives in build.js deliberately: this script and verify-dist.js once
# had separate bash and Node implementations, they drifted, and the verifier
# went on passing while asserting a tree the build no longer produced. Both
# entry points now run the same Node code.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    echo "FATAL: node is required to build" >&2
    exit 1
fi

node build.js
node verify-dist.js
