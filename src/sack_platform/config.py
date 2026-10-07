"""Paths and settings, all overridable by environment variables (see .env.example).

APP_DIR       this package (code + static UI files)
DATA_DIR      runtime data written by the platform: captures/, frames/, crops/, state/, scan_events/,
              out_labels/, recordings/   (default: <repo>/data)
PROJECT_ROOT  the training project the platform reads from and writes into: models/, datasets/, runs/, eval/
              (default: the parent folder of the repo)
FFMPEG_BIN    ffmpeg executable used by the RTSP recorder (default: ffmpeg on PATH, else imageio-ffmpeg's binary)
"""
import os, shutil
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
REPO_DIR = APP_DIR.parent.parent

DATA_DIR = Path(os.environ.get("SACK_PLATFORM_DATA", REPO_DIR / "data")).expanduser().resolve()
PROJECT_ROOT = Path(os.environ.get("SACK_PROJECT_ROOT", REPO_DIR.parent)).expanduser().resolve()
PORT = int(os.environ.get("PORT", "8120"))
DATA_DIR.mkdir(parents=True, exist_ok=True)


def ffmpeg_bin():
    b = os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg")
    if b:
        return b
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None
