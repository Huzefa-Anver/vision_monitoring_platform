# Sack labelling platform

A small web app for building the sack-segmentation dataset from CCTV (Dahua NVR) footage. It runs as a single
Python server with no web framework and serves one page with eight tabs:

| Tab | What it does |
|---|---|
| 1 Find recordings | Open an RTSP playback URL, seek, preview, save "moments" as sources, scan recordings for events |
| 2 Watch & capture | Run a YOLO model live on a stream; one click saves the current frame + predictions for correction |
| 3 Correct | Fix predicted classes/masks on captured frames |
| 4 Review later | Frames parked for a second look |
| 5 Review & add | Final check, then add the labels to a dataset version |
| 6 History | Everything added before, restorable |
| 7 Datasets | Browse every dataset on disk with its labels and the runs trained on it |
| 8 Record RTSP | Record one or more cameras at once into video files (start / stop) |

## Layout
```
src/sack_platform/
  app.py        HTTP server + API routes
  config.py     paths and settings (environment variables, see below)
  core.py       sources, captures, queue, datasets, model list (MODELS)
  capture.py    live-watch worker (YOLO on a stream)
  preview.py    RTSP playback preview worker
  scan.py       scan a recording for events
  recorder.py   RTSP recorder (tab 8)
  hsv_detect.py seam-colour helper
  static/       ui.html, ui.js
deploy/sack-platform.service   systemd user unit
run.sh                         starts the server, loads .env
```

## Setup
```
python3 -m venv .venv && . .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cu130   # match your CUDA
pip install -r requirements.txt
cp .env.example .env      # set SACK_PROJECT_ROOT to the training project (models/, datasets/, runs/, eval/)
./run.sh                  # open http://<server>:8120
```

## Settings (`.env`)
| Variable | Meaning | Default |
|---|---|---|
| `PORT` | HTTP port | 8120 |
| `SACK_PLATFORM_DATA` | where captures, frames, crops, labels, scan events, recordings and `state/` are written | `./data` |
| `SACK_PROJECT_ROOT` | training project folder with `models/`, `datasets/`, `runs/`, `eval/` | parent of the repo |
| `PYTHON` | interpreter with ultralytics + torch | `python3` |
| `FFMPEG_BIN` | ffmpeg for the recorder | `ffmpeg` on PATH, else imageio-ffmpeg |

Model weights are **not** in the repo. The model list is `MODELS` in `core.py` (paths relative to `SACK_PROJECT_ROOT`).

## Record RTSP (tab 8)
- Add one row per camera (name + RTSP link) and set **fps**:
  - Leave it empty to copy the stream as-is: no re-encoding, lowest server load, the camera's own frame rate.
  - Set a number (e.g. 5) to re-encode with libx264 at that frame rate: smaller files, but CPU use grows with cameras × resolution.
- **Frame size** works the same way. "original" keeps the camera resolution; choosing a width (1920, 1280, 1024, 832, 640 or custom) resizes every frame, and the height follows the camera's aspect ratio. Changing fps or size re-encodes on the CPU.
- **Start** launches one ffmpeg per camera. **Stop** finalises every file. The files appear under the recording session with download links.
- Files are saved to `<SACK_PLATFORM_DATA>/recordings/<YYYYmmdd_HHMMSS>/<camera>_partNNN.mp4`, with a `session.json` and one log per camera.
- Files are fragmented MP4 with a keyframe at least every 2 s in fps mode, so a clip stays playable even if the server dies mid-recording.
- If a stream drops, the camera reconnects by itself into a new `partNNN` file, up to 50 times, every 3 s.
- Only one recording session runs at a time, with at most 16 cameras.
- Each session's `session.json` keeps the camera links exactly as entered (password included), shown in the Recordings list with a "use these links again" button. Live status and logs mask passwords (`***`). The data folder is git-ignored; keep it private.

## Datasets (tab 7): labelled datasets, raw videos, raw frames
- **Labelled datasets**: the YOLO datasets under `SACK_PROJECT_ROOT/datasets`. A YOLO `.zip` (`images/`, `labels/`, optional `data.yaml`) can be uploaded; it becomes a new `datasets/<name>_upload_vNNN` with an `upload_manifest.json` and is never merged into a training set.
- **Raw videos**: `RTSP_VIDEO_DIR`, the tab 8 recordings, and `<data>/raw_videos/` (uploads and videos made from frames, each with a `<name>.json` saying where it came from). ▶ play, *use in Serve RTSP*.
- **Raw frames**: capture events (`<data>/captures/`), saved frames (`<data>/frames/`), uploaded sets (`<data>/raw_frames/<set>/`, images or a zip of images) and the image splits of labelled datasets. Tick sets and **make video** (each frame held N s at 5 fps, or N frames per second; other picture sizes get black bars) to serve them as RTSP.
- Uploads are streamed to disk, never overwrite an existing name, keep 5 GB free, and zips are unpacked with every path checked (images / labels / yaml only).
- Every uploaded or made set is checked against the benchmark images (`eval/v21_hard_pilot_v001`, by md5) and the reserved eval days in `eval/EVAL_RESERVED.json`; hits are shown as a warning. Frames captured from a stream made of benchmark frames must never be used for training.
- Only uploads and videos made here can be deleted from the page.

## Serve RTSP (tab 12)
- MediaMTX in Docker (`RTSP_CONTAINER`, port `RTSP_PORT`, published on `RTSP_HOST`), config written to `<data>/rtsp_serve/live/` and hot-reloaded; only changed streams restart.
- Per stream: start on connect or always playing; at the end stop / loop / freeze then stop / freeze then loop; start and end point (picked in a player); re-encode; sync group (streams in one group are one ffmpeg: they start, loop and freeze together).
- Loops that start inside a video play a frame-exact clip cut once into `<data>/rtsp_serve/live/clips/` (never deleted automatically).

## Data: moving it to a new machine (OneDrive)

The data (about 80–110 GB) is not in git. `scripts/data_sync.sh` moves it through OneDrive with rclone.

1. On each machine, install rclone, run `rclone config` once, add a remote named `onedrive` (type `onedrive`) and log in in the browser.
2. On the server that has the data: `scripts/data_sync.sh upload`. It copies the platform data, the Serve RTSP videos, and models/, datasets/, eval/ and the key files of runs/ to `onedrive:sack_platform_data`. It never deletes anything, and it can be re-run to continue.
3. On a fresh clone: `scripts/data_sync.sh download`. It fills `data/` and `project/`, writes `.env` if there is none, and rewrites the old server's paths in the saved state.
4. Check `PYTHON` and `RTSP_HOST` in `.env`, then run `./run.sh`.

Options: `REMOTE=...` uses another folder or remote; `FULL_RUNS=1` uploads all of runs/ (31 GB); `NO_VIDEOS=1` skips the videos. The data holds camera and viewer logins, so keep the OneDrive folder private and do not share it by link.

## Security notes
- `data/state/sources.json` contains RTSP links **with credentials**. `data/` is git-ignored; never commit it.
- The server has no authentication. Run it on a trusted LAN only, or behind a reverse proxy with auth.
