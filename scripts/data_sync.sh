#!/usr/bin/env bash
# Move the platform's data through OneDrive (or any rclone remote).
#
#   scripts/data_sync.sh upload     on the server that has the data: copies it to OneDrive
#   scripts/data_sync.sh download   on a fresh clone: fetches it into ./data and ./project and writes .env
#
# One-time setup on each machine: install rclone, then run `rclone config`, add a remote named
# "onedrive" (type onedrive) and log in in the browser. On a server without a browser, run
# `rclone authorize "onedrive"` on a laptop and paste the result. No password goes in this script.
#
# Settings (environment variables):
#   REMOTE      where the data lives in OneDrive      default onedrive:sack_platform_data
#   RCLONE      rclone binary                        default rclone on PATH
#   FULL_RUNS=1 upload every file of runs/ (31 GB); default only best.pt, args.yaml, results.csv per run
#   NO_VIDEOS=1 skip the Serve RTSP video folder (23 GB)
#
# Upload only ever copies (rclone copy): it never deletes anything, here or in OneDrive.
# Re-running either direction continues where it stopped and skips files already copied.
# The data contains camera and viewer logins (data/state). Keep the OneDrive folder private.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
REMOTE=${REMOTE:-onedrive:sack_platform_data}
RCLONE=${RCLONE:-rclone}
FLAGS=(--progress --transfers 4 --checkers 8 --filter "- __pycache__/**")
command -v "$RCLONE" >/dev/null || { echo "rclone not found: install it (https://rclone.org/install/) or set RCLONE=/path/to/rclone"; exit 1; }

case "${1:-}" in
upload)
  [ -f .env ] && set -a && . ./.env && set +a
  DATA=$(realpath "${SACK_PLATFORM_DATA:-$REPO/data}")
  PROJ=$(realpath "${SACK_PROJECT_ROOT:-$REPO/..}")
  VIDS=$(realpath -m "${RTSP_VIDEO_DIR:-$DATA/incoming_videos}")
  echo "data     $DATA"; echo "project  $PROJ (models, datasets, eval, runs)"; echo "videos   $VIDS"; echo "to       $REMOTE"
  "$RCLONE" copy "${FLAGS[@]}" "$DATA/" "$REMOTE/data/" --filter "- /incoming_videos/**"
  if [ -z "${NO_VIDEOS:-}" ] && [ -d "$VIDS" ]; then "$RCLONE" copy "${FLAGS[@]}" "$VIDS/" "$REMOTE/data/incoming_videos/"; fi
  for d in models datasets eval; do [ -d "$PROJ/$d" ] && "$RCLONE" copy "${FLAGS[@]}" --copy-links "$PROJ/$d/" "$REMOTE/project/$d/"; done
  if [ -n "${FULL_RUNS:-}" ]; then "$RCLONE" copy "${FLAGS[@]}" --copy-links "$PROJ/runs/" "$REMOTE/project/runs/"
  else "$RCLONE" copy "${FLAGS[@]}" --copy-links --filter "+ /*/weights/best.pt" --filter "+ /*/args.yaml" --filter "+ /*/results.csv" --filter "- **" "$PROJ/runs/" "$REMOTE/project/runs/"; fi
  # remember the old absolute paths so a download can rewrite them in the saved state
  printf 'DATA=%s\nPROJ=%s\nVIDS=%s\n' "$DATA" "$PROJ" "$VIDS" | "$RCLONE" rcat "$REMOTE/meta/old_paths.txt"
  echo "upload done"
  ;;
download)
  mkdir -p data project
  "$RCLONE" copy "${FLAGS[@]}" "$REMOTE/data/" data/
  "$RCLONE" copy "${FLAGS[@]}" "$REMOTE/project/" project/
  "$RCLONE" copy "$REMOTE/meta/" data/.sync_meta/
  if [ ! -f .env ]; then
    sed -e "s#^SACK_PLATFORM_DATA=.*#SACK_PLATFORM_DATA=$REPO/data#" -e "s#^SACK_PROJECT_ROOT=.*#SACK_PROJECT_ROOT=$REPO/project#" .env.example > .env
    echo "RTSP_VIDEO_DIR=$REPO/data/incoming_videos" >> .env
    echo "wrote .env (check PYTHON and RTSP_HOST in it)"
  else echo ".env already exists: left unchanged; point SACK_PLATFORM_DATA, SACK_PROJECT_ROOT and RTSP_VIDEO_DIR at data/, project/ and data/incoming_videos/"; fi
  # saved state holds absolute paths from the old server; point them at the new folders (originals kept as *.orig)
  python3 - "$REPO" <<'PY'
import sys, pathlib
repo = pathlib.Path(sys.argv[1]); meta = repo / "data/.sync_meta/old_paths.txt"
if not meta.exists(): sys.exit("no old_paths.txt; paths not rewritten")
old = dict(l.split("=", 1) for l in meta.read_text().split("\n") if "=" in l)
new = {"DATA": repo / "data", "PROJ": repo / "project", "VIDS": repo / "data/incoming_videos"}
pairs = sorted(((old[k], str(new[k])) for k in old if old[k]), key=lambda p: -len(p[0]))  # longest first
n = 0
for f in (repo / "data").rglob("*.json"):
    if f.stat().st_size > 50_000_000: continue
    t = f.read_text(errors="surrogateescape"); u = t
    for a, b in pairs: u = u.replace(a, b)
    if u != t:
        f.with_suffix(f.suffix + ".orig").write_text(t, errors="surrogateescape"); f.write_text(u, errors="surrogateescape"); n += 1
print(f"rewrote old paths in {n} files")
PY
  echo "download done. Start the platform with ./run.sh"
  ;;
*) sed -n '2,20p' "$0"; exit 1 ;;
esac
