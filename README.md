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

## Security notes
- `data/state/sources.json` contains RTSP links **with credentials**. `data/` is git-ignored; never commit it.
- The server has no authentication. Run it on a trusted LAN only, or behind a reverse proxy with auth.
