"""FFmpeg 封装：探测、缩略图、代理文件。

查找顺序：设置页里填的路径 -> 系统 PATH -> imageio-ffmpeg 自带的便携版。
找不到也不会让网站崩掉，只是没有缩略图和转码。
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from . import config

_cache: dict[str, Any] = {"path": None, "source": "none", "checked": False}

SOURCE_LABEL = {
    "custom": "设置中指定的路径",
    "path": "系统 PATH",
    "bundled": "内置便携版",
    "none": "未找到",
}

BROWSER_VIDEO = {"mp4", "m4v", "mov", "webm"}
BROWSER_AUDIO = {"mp3", "m4a", "aac", "wav", "ogg", "oga", "flac", "opus"}


def _valid(path: str | Path | None) -> str | None:
    if not path:
        return None
    candidate = Path(path)
    if candidate.is_dir():
        candidate = candidate / "ffmpeg.exe"
    try:
        if candidate.is_file():
            return str(candidate)
    except OSError:
        return None
    return None


def locate(force: bool = False) -> dict[str, Any]:
    global _cache
    if _cache["checked"] and not force:
        return dict(_cache)

    path = _valid(config.load().get("ffmpeg_path"))
    source = "custom" if path else "none"

    if not path:
        found = shutil.which("ffmpeg")
        if found:
            path, source = found, "path"

    if not path:
        try:
            import imageio_ffmpeg  # type: ignore

            path, source = imageio_ffmpeg.get_ffmpeg_exe(), "bundled"
        except Exception:
            path, source = None, "none"

    version = None
    if path:
        try:
            result = subprocess.run(
                [path, "-hide_banner", "-version"],
                capture_output=True, text=True, errors="replace", timeout=10,
            )
            first = (result.stdout or "").splitlines()
            version = first[0].strip() if first else None
        except (OSError, subprocess.SubprocessError):
            path, source = None, "none"

    _cache = {"path": path, "source": source, "checked": True, "version": version}
    return dict(_cache)


def path_or_none() -> str | None:
    return locate()["path"]


def status() -> dict[str, Any]:
    info = locate()
    return {
        "available": bool(info["path"]),
        "path": info["path"] or "",
        "source": info["source"],
        "source_label": SOURCE_LABEL.get(info["source"], "未找到"),
        "version": info.get("version") or "",
    }


def _run(args: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


# --------------------------------------------------------------------------
# 探测
# --------------------------------------------------------------------------

_DURATION = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_VIDEO_LINE = re.compile(r"Stream #\d+:\d+.*?: Video: ([A-Za-z0-9_\-]+)")
_AUDIO_LINE = re.compile(r"Stream #\d+:\d+.*?: Audio: ([A-Za-z0-9_\-]+)")
_DIMS = re.compile(r"[,\s](\d{2,5})x(\d{2,5})[\s,]")
_FPS = re.compile(r"([\d.]+)\s+fps")
_TBR = re.compile(r"([\d.]+)\s+tbr")
_KBPS = re.compile(r"(\d+)\s+kb/s")
_SAMPLE = re.compile(r"(\d+)\s+Hz")
_ROTATE = re.compile(r"rotate\s*:\s*(-?\d+)")
_ROTATE_MATRIX = re.compile(r"rotation of (-?[\d.]+) degrees")


def probe(path: str | Path) -> dict[str, Any] | None:
    ffmpeg = path_or_none()
    if not ffmpeg:
        return None
    try:
        result = _run([ffmpeg, "-hide_banner", "-nostdin", "-i", str(path)], timeout=25)
    except (OSError, subprocess.SubprocessError):
        return None
    text = (result.stderr or "") + (result.stdout or "")
    if "No such file" in text or not text:
        return None

    info: dict[str, Any] = {
        "duration": None, "width": None, "height": None, "codec": None,
        "acodec": None, "fps": None, "bitrate": None, "has_audio": False,
    }

    if match := _DURATION.search(text):
        hours, minutes, seconds = match.groups()
        info["duration"] = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    if match := re.search(r"bitrate:\s*(\d+)\s*kb/s", text):
        info["bitrate"] = int(match.group(1))

    for line in text.splitlines():
        if video := _VIDEO_LINE.search(line):
            if info["codec"] is None:
                info["codec"] = video.group(1)
                if dims := _DIMS.search(line):
                    info["width"], info["height"] = int(dims.group(1)), int(dims.group(2))
                if fps := _FPS.search(line) or _TBR.search(line):
                    try:
                        value = float(fps.group(1))
                        info["fps"] = round(value, 3) if value < 1000 else round(value / 1000, 3)
                    except ValueError:
                        pass
        if audio := _AUDIO_LINE.search(line):
            info["has_audio"] = True
            if info["acodec"] is None:
                info["acodec"] = audio.group(1)

    rotation = 0
    if match := _ROTATE.search(text):
        rotation = abs(int(match.group(1))) % 180
    elif match := _ROTATE_MATRIX.search(text):
        rotation = int(abs(float(match.group(1)))) % 180
    if rotation == 90 and info["width"] and info["height"]:
        info["width"], info["height"] = info["height"], info["width"]

    if info["duration"] is not None and info["duration"] <= 0:
        info["duration"] = None
    return info


# --------------------------------------------------------------------------
# 缩略图
# --------------------------------------------------------------------------

def _thumb_scale(width: int, height: int) -> str:
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=white,format=rgb24"
    )


def make_thumb(src: Path, kind: str, out: Path, duration: float | None = None) -> bool:
    ffmpeg = path_or_none()
    if not ffmpeg:
        return False
    conf = config.load()
    width, height = int(conf["thumb_width"]), int(conf["thumb_height"])
    out.parent.mkdir(parents=True, exist_ok=True)
    scale = _thumb_scale(width, height)
    base = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
    target = str(out)

    attempts: list[list[str]] = []

    if kind == "video":
        stamp = 1.0
        if duration:
            stamp = min(max(duration * 0.1, 0.5), 8.0)
        attempts.append(["-ss", f"{stamp:.2f}", "-i", str(src), "-frames:v", "1", "-vf", scale, "-q:v", "3", target])
        attempts.append(["-ss", "0", "-i", str(src), "-frames:v", "1", "-vf", scale, "-q:v", "3", target])
    elif kind == "image":
        attempts.append(["-i", str(src), "-frames:v", "1", "-vf", scale, "-q:v", "3", target])
    elif kind == "audio":
        attempts.append(["-i", str(src), "-map", "0:v:0", "-frames:v", "1", "-vf", scale, "-q:v", "3", target])
        wave = (
            f"color=c=white:s={width}x{height}[bg];"
            f"[0:a]showwavespic=s={width}x{height}:colors=#66ccff:scale=sqrt[wave];"
            f"[bg][wave]overlay=shortest=1,format=rgb24"
        )
        attempts.append(["-i", str(src), "-filter_complex", wave, "-frames:v", "1", "-q:v", "3", target])

    for args in attempts:
        try:
            result = _run(base + args, timeout=90)
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0 and out.exists() and out.stat().st_size > 0:
            return True

    if out.exists() and out.stat().st_size == 0:
        out.unlink(missing_ok=True)
    return False


# --------------------------------------------------------------------------
# 代理文件
# --------------------------------------------------------------------------

def browser_playable(ext: str, info: dict[str, Any] | None) -> bool:
    if ext in BROWSER_AUDIO:
        return True
    if ext not in BROWSER_VIDEO:
        return False
    if not info:
        return True
    codec = (info.get("codec") or "").lower()
    acodec = (info.get("acodec") or "").lower()
    if codec and codec not in {"h264", "vp8", "vp9", "av1"}:
        return False
    if acodec and acodec not in {"aac", "mp3", "opus", "vorbis", "flac"}:
        return False
    return True


def make_proxy(src: Path, out: Path, height: int = 720) -> bool:
    ffmpeg = path_or_none()
    if not ffmpeg:
        return False
    out.parent.mkdir(parents=True, exist_ok=True)
    attempts = [
        f"scale=-2:'min({height},ih)'",
        f"scale=-2:{height}",
    ]
    for scale in attempts:
        args = [
            ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
            "-i", str(src),
            "-map", "0:v:0", "-map", "0:a:0?",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
            "-vf", scale, "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-movflags", "+faststart",
            str(out),
        ]
        try:
            result = _run(args, timeout=7200)
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0 and out.exists() and out.stat().st_size > 0:
            return True
    out.unlink(missing_ok=True)
    return False


def ensure_probe(path: str | Path) -> dict[str, Any] | None:
    return probe(path)
