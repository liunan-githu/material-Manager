"""生成一批示例素材并上传，用来预览界面效果。

用法：先启动 python run.py，再执行 python tools/seed_demo.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8420"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "testdata" / "seed"
CHUNK = 4 * 1024 * 1024


def api(path: str, payload=None, method: str = "GET"):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = response.read()
        return json.loads(body.decode("utf-8")) if body[:1] in (b"{", b"[") else body


def ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def make(name: str, args: list[str]) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / name
    if target.exists() and target.stat().st_size > 0:
        return target
    result = subprocess.run(
        [ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", *args, str(target)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("ffmpeg 失败", name, result.stderr[-300:])
    return target


def folders() -> list[dict]:
    return api("/api/folders")["folders"]


def root_id(name: str) -> int:
    for folder in folders():
        if folder["name"] == name:
            return folder["id"]
    raise SystemExit(f"找不到分类 {name}")


def ensure_folder(name: str, parent_id: int | None = None) -> int:
    try:
        return api("/api/folders", {"name": name, "parent_id": parent_id}, "POST")["id"]
    except urllib.error.HTTPError as exc:
        if exc.code != 409:
            raise

    def walk(nodes, parent):
        for node in nodes:
            if node["name"] == name and node["parent_id"] == parent:
                return node["id"]
            found = walk(node["children"], node["id"])
            if found:
                return found
        return None

    found = walk(folders(), parent_id)
    if not found:
        raise SystemExit(f"建不了目录 {name}")
    return found


def upload(path: Path, target_folder: int) -> dict:
    init = api(
        "/api/uploads",
        {"folder_id": target_folder, "name": path.name, "size": path.stat().st_size},
        "POST",
    )
    upload_id = init["upload_id"]
    data = path.read_bytes()
    for index, start in enumerate(range(0, len(data), CHUNK)):
        piece = data[start : start + CHUNK]
        request = urllib.request.Request(
            f"{BASE}/api/uploads/{upload_id}/{index}",
            data=piece,
            method="PUT",
            headers={"Content-Type": "application/octet-stream"},
        )
        urllib.request.urlopen(request, timeout=120).read()
    return api(f"/api/uploads/{upload_id}/complete", {}, "POST")["file"]


def main() -> None:
    video = root_id("视频")
    audio = root_id("音频")
    image = root_id("图片")
    other = root_id("素材包")

    scenes = ensure_folder("空镜", video)
    people = ensure_folder("人物", video)
    bgm = ensure_folder("BGM", audio)
    refs = ensure_folder("参考图", image)

    jobs = [
        ("城市空镜.mp4", video, [
            "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=8",
            "-f", "lavfi", "-i", "sine=frequency=220:duration=8",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
        ]),
        ("竖屏口播参考.mp4", video, [
            "-f", "lavfi", "-i", "mandelbrot=size=1080x1920:rate=25",
            "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        ]),
        ("慢动作测试.mp4", video, [
            "-f", "lavfi", "-i", "life=size=1280x720:rate=30:life_color=#66ccff:death_color=#0a2b3d:mold=20",
            "-t", "9", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        ]),
        ("节奏鼓点.wav", audio, [
            "-f", "lavfi", "-i", "sine=frequency=110:duration=12,tremolo=f=3:d=0.9",
        ]),
        ("氛围铺底.mp3", audio, [
            "-f", "lavfi", "-i", "sine=frequency=330:duration=18,tremolo=f=0.5:d=0.6",
            "-c:a", "libmp3lame", "-b:a", "128k",
        ]),
        ("人声测试.m4a", audio, [
            "-f", "lavfi", "-i", "sine=frequency=520:duration=6",
            "-c:a", "aac", "-b:a", "96k",
        ]),
        ("蓝天渐变.jpg", image, [
            "-f", "lavfi", "-i", "gradients=s=1920x1080:c0=0x66ccff:c1=0xffffff:x0=0:y0=0:x1=1920:y1=1080",
            "-frames:v", "1", "-q:v", "2",
        ]),
        ("几何测试图.png", image, [
            "-f", "lavfi", "-i", "testsrc2=size=1400x1400:rate=1",
            "-frames:v", "1",
        ]),
        ("分镜说明.txt", other, []),
    ]

    uploaded: dict[str, dict] = {}
    for name, target, args in jobs:
        if name.endswith(".txt"):
            path = OUT / name
            OUT.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text("第一场：城市清晨，远景推近。\n第二场：街角咖啡店，手持跟拍。\n", "utf-8")
        else:
            path = make(name, args)
        if not path.exists() or not path.stat().st_size:
            print("跳过", name)
            continue
        try:
            file = upload(path, target)
            uploaded[name] = file
            print("已上传", name, "->", file["kind"])
        except Exception as exc:  # noqa: BLE001
            print("上传失败", name, exc)

    # 摆一个像真实使用的结构：子分类 + 标签
    moves = {
        "城市空镜.mp4": scenes,
        "竖屏口播参考.mp4": people,
        "氛围铺底.mp3": bgm,
        "几何测试图.png": refs,
    }
    for name, folder in moves.items():
        file = uploaded.get(name)
        if file:
            api("/api/files/bulk", {"action": "move", "ids": [file["id"]], "folder_id": folder}, "POST")

    tag_map = {
        "待剪": ["城市空镜.mp4", "氛围铺底.mp3", "慢动作测试.mp4"],
        "已调色": ["蓝天渐变.jpg", "竖屏口播参考.mp4"],
    }
    for tag_name, names in tag_map.items():
        ids = [uploaded[name]["id"] for name in names if name in uploaded]
        if not ids:
            continue
        try:
            api("/api/tags", {"name": tag_name, "file_ids": ids}, "POST")
        except urllib.error.HTTPError as exc:
            if exc.code != 409:
                raise

    stats = api("/api/stats")
    print(f"\n素材总数 {stats['count']}，共 {stats['bytes'] / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
