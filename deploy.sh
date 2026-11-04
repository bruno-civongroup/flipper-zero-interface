#!/usr/bin/env bash
#
# Flipper Zero Web Interface — safe deploy to Cloudflare Pages
#
#   bash deploy.sh            # stage, gate, deploy to production, verify
#   bash deploy.sh --dry-run  # stage and gate only, print the manifest
#
# WHY THIS EXISTS
#
# `wrangler pages deploy .` from the repo root uploads EVERYTHING. Cloudflare
# Pages honors neither .gitignore nor .assetsignore, so docs, notes, keys and
# unpublished drafts ship to the public web. That is not hypothetical: a
# 2026-11-04 audit of every EchoForge/Civon property found README.md, flipper/README.md and LICENSE
# publicly served on this site, reachable by anyone who guessed the URL.
#
# This script copies the repo into a staging directory minus everything that
# is not a web asset, hard-aborts if anything unexpected survives, deploys the
# staging dir, then probes the live site to confirm nothing leaked.
#
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="flipper-zero-interface"
BRANCH="master"
DOMAIN="projects.brunomalnovic.com"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# --- 1. Stage --------------------------------------------------------------

echo "==> Staging a clean copy (excluding everything the site does not serve)"
tar cf - \
  --exclude='./.git'              --exclude='*/.git' \
  --exclude='./.githooks'         --exclude='./.wrangler' \
  --exclude='./.claude'           --exclude='./.superpowers' \
  --exclude='*/node_modules'      --exclude='*/.playwright-mcp' \
  --exclude='./.vscode'           --exclude='./.idea' \
  --exclude='./.github'           --exclude='./docs' \
  --exclude='*.md'                --exclude='*.md.txt' \
  --exclude='./.gitignore'        --exclude='./.gitattributes' \
  --exclude='./.assetsignore'     --exclude='./.editorconfig' \
  --exclude='./.env'              --exclude='./.env.*' \
  --exclude='*.pem'  --exclude='*.key'  --exclude='*.crt' \
  --exclude='*.p12'  --exclude='*.ppk'  --exclude='*.pfx' \
  --exclude='*.map' \
  --exclude='*.sql'  --exclude='*.zip'  --exclude='*.tar.gz' \
  --exclude='*.docx' --exclude='*.xlsx' --exclude='*.pptx' \
  --exclude='*.bak'  --exclude='*.old'  --exclude='*.orig' \
  --exclude='*.save' --exclude='*.swp'  --exclude='*.log' \
  --exclude='*.DS_Store'          --exclude='*Thumbs.db' \
  --exclude='./deploy.sh' \
  --exclude='./package.json'      --exclude='./package-lock.json' \
  --exclude='./tsconfig.json'     --exclude='./wrangler.toml' \
  --exclude='./wrangler.json'     --exclude='./wrangler.jsonc' \
  --exclude='./LICENSE' \
  . | tar xf - -C "$STAGE"

# --- 2. Gate ---------------------------------------------------------------
#
# Allowlist by file type. A new doc, note or config added to this repo is
# excluded by default rather than shipping because nobody updated a denylist.

echo "==> Gate"
VIOLATIONS=0

while IFS= read -r f; do
  case "${f,,}" in
    *.html|*.htm|*.css|*.js|*.mjs|*.json|*.xml|*.txt|*.webmanifest) ;;
    *.png|*.jpg|*.jpeg|*.gif|*.svg|*.webp|*.avif|*.ico|*.pdf) ;;
    *.woff|*.woff2|*.ttf|*.otf|*.eot) ;;
    *.mp3|*.ogg|*.wav|*.m4a|*.mp4|*.webm|*.wasm|*.pck) ;;
    */_headers|*/_redirects) ;;
    *) echo "    UNEXPECTED FILE: ${f#$STAGE/}"; VIOLATIONS=1 ;;
  esac
done < <(find "$STAGE" -type f)

if find "$STAGE" \( -name '*.md' -o -name '.env*' -o -name '*.map' -o -name '*.pem' \
                 -o -name '*.key' -o -name '.gitignore' -o -name 'package.json' \
                 -o -name 'deploy.sh' -o -name '.git' \) -print -quit | grep -q .; then
  echo "    FORBIDDEN PATH SURVIVED STAGING:"
  find "$STAGE" \( -name '*.md' -o -name '.env*' -o -name '*.map' -o -name '*.pem' \
                -o -name '*.key' -o -name '.gitignore' -o -name 'package.json' \
                -o -name 'deploy.sh' -o -name '.git' \) | sed "s|$STAGE/|      |"
  VIOLATIONS=1
fi

if [[ "$VIOLATIONS" -ne 0 ]]; then
  echo
  echo "Gate FAILED — nothing deployed. Add an exclude above, or widen the allowlist"
  echo "if this really is a file the site serves."
  exit 1
fi

FILES=$(find "$STAGE" -type f | wc -l | tr -d ' ')
echo "    OK — $FILES files"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "==> Dry run. Manifest:"
  find "$STAGE" -type f | sed "s|$STAGE/|    |" | sort
  exit 0
fi

# --- 3. Deploy -------------------------------------------------------------

echo "==> Deploying $FILES files to Cloudflare Pages ($PROJECT, branch $BRANCH)"
npx wrangler pages deploy "$STAGE" --project-name="$PROJECT" --branch="$BRANCH" --commit-dirty=true

# --- 4. Post-deploy canary -------------------------------------------------
#
# This site answers unknown paths with 200 + index.html, so a status code alone
# proves nothing. A real leak is a 200 whose body is NOT the HTML shell.

echo "==> Post-deploy check: confirming sensitive paths are not served"
LEAK=0
for p in /README.md /flipper/README.md /LICENSE /CLAUDE.md /ARCHITECTURE.md /CONVENTIONS.md /.env /deploy.sh /package.json; do
  body="$(curl -s --max-time 20 "https://${DOMAIN}${p}" || true)"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://${DOMAIN}${p}" || echo 000)"
  if [[ "$code" == "200" ]] && ! grep -qiE '<!doctype html|<html' <<<"$body"; then
    echo "    ✗ LEAK: https://${DOMAIN}${p} serves a real file"; LEAK=1
  else
    echo "    ✓ ${p}"
  fi
done

if [[ "$LEAK" -ne 0 ]]; then
  echo
  echo "!! SENSITIVE CONTENT IS PUBLIC — purge the Cloudflare cache and investigate."
  exit 1
fi

echo
echo "==> Done. https://${DOMAIN}/"
