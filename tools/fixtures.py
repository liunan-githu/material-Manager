"""测试用的示例素材，第一次跑测试时自动生成。

生成物都在 testdata/ 下，这个目录不进版本库。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "testdata"

_JOBS = [
    (
        "clip.mp4",
        [
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=6",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
        ],
    ),
    ("tone.wav", ["-f", "lavfi", "-i", "sine=frequency=523:duration=5"]),
    (
        "photo.png",
        [
            "-f", "lavfi", "-i", "gradients=s=1600x900:c0=0x66ccff:c1=0xffffff:d=1",
            "-frames:v", "1",
        ],
    ),
    ("notes.txt", None),
]


def ensure() -> Path:
    """补齐 testdata 下的示例文件，返回目录。"""
    FIXTURES.mkdir(parents=True, exist_ok=True)
    try:
        import imageio_ffmpeg
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("缺少 imageio-ffmpeg，先执行 python -m pip install -r requirements.txt") from exc

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    for name, args in _JOBS:
        target = FIXTURES / name
        if target.exists() and target.stat().st_size > 0:
            continue
        if args is None:
            target.write_text("素材说明测试\n", "utf-8")
            continue
        result = subprocess.run(
            [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", *args, str(target)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise SystemExit(f"生成 {name} 失败：{result.stderr[-300:]}")
    return FIXTURES


if __name__ == "__main__":
    print(ensure())
