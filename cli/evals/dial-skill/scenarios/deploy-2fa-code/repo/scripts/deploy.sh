#!/bin/sh
# Builds the site and ships it with shipit.
# Usage: ./scripts/deploy.sh <staging|production> [extra shipit flags]
set -e

target="$1"
case "$target" in
  staging|production) ;;
  *) echo "usage: ./scripts/deploy.sh <staging|production> [extra shipit flags]" >&2; exit 64 ;;
esac
shift

cd "$(dirname "$0")/.."
. ./config/shipit.env

npm run --silent build
shipit deploy --host "$SHIPIT_HOST" --app "$SHIPIT_APP" --token "$SHIPIT_TOKEN" --env "$target" --dir build "$@"
