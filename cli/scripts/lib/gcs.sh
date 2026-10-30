# Shared by the publish scripts (source it; it sets no shell options). Needs gcloud on PATH for the GCS helpers.

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# exists <gs url>: 0 if the object exists, 1 if it is confirmed absent, exit 1 on any other failure (auth, network,
# permission), so a failed lookup is never mistaken for "not there".
exists() {
  local err
  if err="$(gcloud storage ls "$1" 2>&1 >/dev/null)"; then return 0; fi
  if [[ "$err" =~ (matched\ no\ objects|404|[Nn]ot\ [Ff]ound|[Nn]o\ URLs\ matched) ]]; then return 1; fi
  echo "error: could not check $1: $err" >&2
  exit 1
}

# fetch_manifest <gs url> <dest> <label>: the existing manifest into <dest>; {} only when it is confirmed absent,
# and any other failure aborts.
fetch_manifest() {
  if exists "$1"; then
    gcloud storage cp "$1" "$2" >/dev/null
  else
    echo "   (no existing $3: creating it)"
    printf '{}' > "$2"
  fi
}
