#!/usr/bin/env bash
# Build, verify and publish the deployment.
#
# Three steps, and the middle one is the point: nothing is published until it
# has been proved.
#
#   1. build   - fetch the product source at the pinned ref and build dist/
#   2. verify  - the tree is deployable, and the worker routes every path
#   3. deploy  - npx wrangler deploy
#
# The credentials for the third step are the operator's. Nothing here reads
# them or stores them: wrangler finds them the way it always has, from the
# environment or from its own login.
#
# Usage:
#   ./deploy.sh                     build from the pinned ref and publish
#   TRYCORD_REF=release/3.0.0 ./deploy.sh
#   ./deploy.sh --no-deploy         build and verify only
#
set -euo pipefail

cd "$(dirname "$0")"

DEPLOY=1
for arg in "$@"; do
  case "$arg" in
    --no-deploy) DEPLOY=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

REF="${TRYCORD_REF:-main}"
export TRYCORD_REF="$REF"

echo "==> building from $REF"
node build.js

echo "==> verifying the tree"
node verify-dist.js

# The worker verifier runs the real worker against a simulated asset binding,
# so it needs the built tree staged where it looks for it.
echo "==> verifying the worker"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r dist "$STAGE/dist"
cp -r cloudflare "$STAGE/cloudflare"
CF_STAGE="$STAGE" node verify-worker.mjs

if [ "$DEPLOY" -eq 0 ]; then
  echo "==> not deploying (--no-deploy)"
  exit 0
fi

echo "==> publishing"
npx wrangler deploy

echo "==> published"
