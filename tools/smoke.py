"""接口冒烟测试。

用法：先 python run.py --no-browser，再 python tools/smoke.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from fixtures import ensure

BASE = os.environ.get("BASE", "http://127.0.0.1:8420")
ROOT = Path(__file__).resolve().parent.parent
FAILED: list[str] = []


def call(method: str, path: str, payload: dict | None = None, raw: bytes | None = None,
         headers: dict | None = None) -> tuple[int, dict | bytes]:
    url = BASE + path
    data = None
    hdrs = dict(headers or {})
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    if raw is not None:
        data = raw
    request = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        body = exc.read()
        status = exc.code
    if body[:1] in (b"{", b"["):
        return status, json.loads(body.decode("utf-8"))
    return status, body


def check(label: str, condition: bool, detail: object = "") -> None:
    mark = "OK  " if condition else "FAIL"
    print(f"[{mark}] {label}" + ("" if condition else f"  -> {detail}"))
    if not condition:
        FAILED.append(label)


def upload(folder_id: int, path: Path, chunk: int) -> dict:
    status, payload = call(
        "POST", "/api/uploads", {"folder_id": folder_id, "name": path.name, "size": path.stat().st_size}
    )
    check(f"init upload {path.name}", status == 200 and "upload_id" in payload, payload)
    upload_id = payload["upload_id"]
    data = path.read_bytes()
    for index, start in enumerate(range(0, len(data), chunk)):
        piece = data[start:start + chunk]
        status, _ = call("PUT", f"/api/uploads/{upload_id}/{index}", raw=piece,
                         headers={"Content-Type": "application/octet-stream"})
        if status != 200:
            check(f"chunk {index} {path.name}", False, status)
            break
    status, payload = call("POST", f"/api/uploads/{upload_id}/complete", {})
    check(f"complete upload {path.name}", status == 200 and payload.get("file"), payload)
    return payload.get("file", {})


def main() -> None:
    ensure()
    status, boot = call("GET", "/api/bootstrap")
    check("bootstrap", status == 200 and boot.get("folders"), status)
    if status != 200:
        return

    status, payload = call("POST", "/api/folders", {"name": "测试目录", "parent_id": boot["folders"][0]["id"]})
    if status == 409:
        folders = call("GET", "/api/folders")[1]["folders"]

        def find(nodes):
            for node in nodes:
                if node["name"] == "测试目录":
                    return node
                found = find(node["children"])
                if found:
                    return found
            return None

        folder_id = find(folders)["id"]
    else:
        check("create folder", status == 200, payload)
        folder_id = payload["id"]

    target = call("GET", f"/api/folders")[1]["folders"][0]["id"]
    chunk = 2 * 1024 * 1024

    video = upload(folder_id, ROOT / "testdata" / "clip.mp4", chunk)
    audio = upload(folder_id, ROOT / "testdata" / "tone.wav", chunk)
    image = upload(folder_id, ROOT / "testdata" / "photo.png", chunk)
    other = upload(folder_id, ROOT / "testdata" / "notes.txt", chunk)
    check("kinds detected", video.get("kind") == "video" and audio.get("kind") == "audio"
          and image.get("kind") == "image" and other.get("kind") == "other",
          (video.get("kind"), audio.get("kind"), image.get("kind"), other.get("kind")))

    deadline = time.time() + 45
    detail = {}
    while time.time() < deadline:
        status, detail = call("GET", f"/api/files/{video['id']}")
        if detail.get("thumb_state") == "ok" and detail.get("probe_state") == "ok":
            break
        time.sleep(0.7)
    check("video probed", detail.get("width") == 1280 and detail.get("height") == 720,
          (detail.get("width"), detail.get("height")))
    check("video duration", abs((detail.get("duration") or 0) - 6) < 0.3, detail.get("duration"))
    check("video codec", detail.get("codec") == "h264", detail.get("codec"))
    check("video thumb", detail.get("thumb_state") == "ok", detail.get("thumb_state"))

    status, thumb = call("GET", f"/api/files/{video['id']}/thumb")
    check("thumb bytes", status == 200 and len(thumb) > 3000, (status, len(thumb)))

    time.sleep(1.5)
    status, audio_detail = call("GET", f"/api/files/{audio['id']}")
    status, image_detail = call("GET", f"/api/files/{image['id']}")
    check("audio thumb", audio_detail.get("thumb_state") == "ok", audio_detail.get("thumb_state"))
    check("image dims", image_detail.get("width") == 1600, image_detail.get("width"))

    status, body = call("GET", f"/api/files/{video['id']}/stream",
                        headers={"Range": "bytes=0-1023"})
    check("range stream 206", status == 206 and len(body) == 1024, (status, len(body)))

    status, listing = call("GET", f"/api/files?folder={folder_id}")
    check("list folder", status == 200 and listing["total"] == 4, listing.get("total"))
    check("folder tiles", len(listing.get("folders", [])) == 0, listing.get("folders"))

    status, tag = call("POST", "/api/tags", {"name": "测试标签", "file_ids": [video["id"]]})
    if status == 409:
        tags = call("GET", "/api/tags")[1]["tags"]
        tag_id = next((t["id"] for t in tags if t["name"] == "测试标签"), None)
    else:
        check("create tag", status == 200, tag)
        tag_id = tag["id"]

    status, listing = call("GET", f"/api/files?tag={tag_id}")
    check("filter by tag", status == 200 and listing["total"] == 1, listing.get("total"))

    status, listing = call("GET", "/api/files?q=tone")
    check("search", status == 200 and listing["total"] == 1, listing.get("total"))

    status, moved = call("POST", "/api/files/bulk",
                         {"action": "move", "ids": [image["id"]], "folder_id": target})
    check("bulk move", status == 200 and moved["changed"] == 1, moved)

    status, trashed = call("POST", "/api/files/bulk", {"action": "trash", "ids": [other["id"]]})
    check("bulk trash", status == 200 and trashed["changed"] == 1, trashed)
    status, listing = call("GET", "/api/files?folder=trash")
    check("trash list", status == 200 and listing["total"] == 1, listing.get("total"))
    status, restored = call("POST", "/api/files/bulk", {"action": "restore", "ids": [other["id"]]})
    check("restore", status == 200 and restored["changed"] == 1, restored)

    status, proxy = call("POST", f"/api/files/{video['id']}/proxy")
    check("proxy queued", status == 200, proxy)
    deadline = time.time() + 90
    state = "queued"
    while time.time() < deadline:
        status, detail = call("GET", f"/api/files/{video['id']}")
        state = detail.get("proxy_state")
        if state in ("ok", "fail"):
            break
        time.sleep(1.5)
    check("proxy ready", state == "ok", state)

    status, listing = call("GET", "/api/files?kind=video")
    check("kind filter", status == 200 and listing["total"] >= 1, listing.get("total"))

    status, renamed = call("PATCH", f"/api/files/{video['id']}", {"name": "改名片段.mp4", "note": "测试备注"})
    check("rename + note", status == 200 and renamed["name"] == "改名片段.mp4" and renamed["note"] == "测试备注",
          renamed)

    print()
    print("失败项：", FAILED if FAILED else "无")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
