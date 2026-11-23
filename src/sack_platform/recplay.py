"""Play recorded videos in the browser (tab 8): the file itself with seeking (Range requests), or, when the browser
cannot decode it (the NVR records HEVC, which many browsers cannot play), a copy converted to H.264 on the fly from a
chosen start time. One ffmpeg per viewer; it stops when the viewer closes the player or picks another time."""
import re, subprocess
from config import ffmpeg_bin


def probe(f):
    try:
        txt = subprocess.run([ffmpeg_bin(), "-hide_banner", "-i", str(f)], capture_output=True, text=True, timeout=30).stderr
    except Exception as e:
        return dict(ok=False, error=str(e))
    out = dict(ok=True)
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", txt)
    if m: out["duration_s"] = round(int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]), 1)
    m = re.search(r"Video: (\w+).*?, (\d{2,5})x(\d{2,5})", txt)
    if m: out.update(codec=m[1], width=int(m[2]), height=int(m[3]))
    return out


def send_file(h, f, ct, attachment=None):
    """Serve a file with Range support so the browser's player can seek."""
    size = f.stat().st_size; rng = h.headers.get("Range")
    if rng and rng.startswith("bytes="):
        a, _, b = rng[6:].partition("-"); a = int(a or 0); b = min(int(b) if b else size - 1, size - 1)
        if a > b: h.send_response(416); h.send_header("Content-Range", f"bytes */{size}"); h.end_headers(); return
        h.send_response(206); h.send_header("Content-Range", f"bytes {a}-{b}/{size}")
    else:
        a, b = 0, size - 1; h.send_response(200)
    h.send_header("Content-Type", ct); h.send_header("Accept-Ranges", "bytes"); h.send_header("Content-Length", str(b - a + 1))
    if attachment: h.send_header("Content-Disposition", f'attachment; filename="{attachment}"')
    h.end_headers()
    try:
        with open(f, "rb") as fh:
            fh.seek(a); left = b - a + 1
            while left > 0:
                chunk = fh.read(min(1 << 20, left))
                if not chunk: break
                h.wfile.write(chunk); left -= len(chunk)
    except Exception:
        pass


def send_converted(h, f, t=0.0, width=1280):
    """Stream the video from t seconds as H.264 fragmented MP4 (no sound), scaled to `width` pixels wide."""
    width = width if width in (640, 960, 1280, 1920) else 1280
    cmd = ["nice", "-n", "10", ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", f"{max(0.0, t):.2f}", "-i", str(f),
           "-map", "0:v:0", "-an", "-vf", f"scale={width}:-2", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
           "-crf", "26", "-g", "50", "-pix_fmt", "yuv420p", "-threads", "3",
           "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        h.send_response(200); h.send_header("Content-Type", "video/mp4"); h.send_header("Cache-Control", "no-store")
        h.send_header("Connection", "close"); h.end_headers()
        while True:
            chunk = p.stdout.read(1 << 16)
            if not chunk: break
            h.wfile.write(chunk)
    except Exception:
        pass
    finally:
        p.kill(); p.wait()
