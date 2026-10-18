"""干净环境自检：分类初始化、上传、缩略图、回收站。

用法：先启动服务，再执行 python tools/selfcheck.py
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from fixtures import ensure

BASE = "http://127.0.0.1:8420"
ROOT = Path(__file__).resolve().parent.parent
FAILED: list[str] = []


def api(path: str, payload=None, method: str = "GET"):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read()
        return json.loads(body.decode("utf-8")) if body[:1] in (b"{", b"[") else body


def check(label: str, ok: bool, detail=""):
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        FAILED.append(label)


def main() -> None:
    ensure()
    boot = api("/api/bootstrap")
    names = [folder["name"] for folder in boot["folders"]]
    check("默认四个分类", names == ["视频", "音频", "图片", "素材包"], names)
    check("统计可读", isinstance(boot["stats"]["count"], int), boot["stats"])
    check("FFmpeg 可用", boot["stats"]["ffmpeg"]["available"], boot["stats"]["ffmpeg"])
    for folder in boot["folders"]:
        check(f"目录已建好：{folder['name']}", (ROOT / "library" / folder["name"]).is_dir())

    target = next(folder["id"] for folder in boot["folders"] if folder["name"] == "图片")
    source = ROOT / "testdata" / "photo.png"
    init = api("/api/uploads", {"folder_id": target, "name": source.name, "size": source.stat().st_size}, "POST")
    upload_id = init["upload_id"]
    api.__dict__.setdefault("_", None)
    request = urllib.request.Request(
        f"{BASE}/api/uploads/{upload_id}/0",
        data=source.read_bytes(),
        method="PUT",
        headers={"Content-Type": "application/octet-stream"},
    )
    urllib.request.urlopen(request, timeout=60).read()
    uploaded = api(f"/api/uploads/{upload_id}/complete", {}, "POST")["file"]
    check("上传成功", uploaded["kind"] == "image" and uploaded["size"] == source.stat().st_size, uploaded)

    detail = {}
    deadline = time.time() + 30
    while time.time() < deadline:
        detail = api(f"/api/files/{uploaded['id']}")
        if detail["thumb_state"] == "ok" and detail["probe_state"] == "ok":
            break
        time.sleep(0.6)
    check("探测尺寸", detail.get("width") == 1600 and detail.get("height") == 900, detail.get("width"))
    check("缩略图生成", detail.get("thumb_state") == "ok", detail.get("thumb_state"))
    check("时长不误报", not detail.get("duration"), detail.get("duration"))

    thumb = api(f"/api/files/{uploaded['id']}/thumb")
    check("缩略图可访问", isinstance(thumb, bytes) and len(thumb) > 2000, len(thumb) if isinstance(thumb, bytes) else thumb)

    trash_before = api("/api/files?folder=trash")["total"]
    api("/api/files/bulk", {"action": "trash", "ids": [uploaded["id"]]}, "POST")
    check("移入回收站", api("/api/files?folder=trash")["total"] == trash_before + 1)
    api("/api/files/bulk", {"action": "restore", "ids": [uploaded["id"]]}, "POST")
    check("还原", api("/api/files?folder=trash")["total"] == trash_before)
    api("/api/files/bulk", {"action": "trash", "ids": [uploaded["id"]]}, "POST")
    api("/api/files/bulk", {"action": "purge", "ids": [uploaded["id"]]}, "POST")
    try:
        api(f"/api/files/{uploaded['id']}")
        still_there = True
    except urllib.error.HTTPError as exc:
        still_there = exc.code != 404
    check("彻底删除", not still_there)

    print()
    print("失败项：", FAILED if FAILED else "无")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
