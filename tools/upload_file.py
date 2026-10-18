"""把一个本地文件传到素材库，调试和补数据用。

用法：python tools/upload_file.py <文件路径> [分类名]
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8420"
CHUNK = 8 * 1024 * 1024


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


def find_folder(name: str) -> int:
    def walk(nodes):
        for node in nodes:
            if node["name"] == name:
                return node
            found = walk(node["children"])
            if found:
                return found
        return None

    node = walk(api("/api/folders")["folders"])
    if not node:
        raise SystemExit(f"找不到分类：{name}")
    return node["id"]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("用法：python tools/upload_file.py <文件路径> [分类名]")

    path = Path(sys.argv[1]).expanduser()
    if not path.is_file():
        raise SystemExit(f"文件不存在：{path}")
    folder = find_folder(sys.argv[2] if len(sys.argv) > 2 else "素材包")

    init = api(
        "/api/uploads",
        {"folder_id": folder, "name": path.name, "size": path.stat().st_size},
        "POST",
    )
    upload_id = init["upload_id"]
    data = path.read_bytes()
    for index, start in enumerate(range(0, len(data), CHUNK)):
        request = urllib.request.Request(
            f"{BASE}/api/uploads/{upload_id}/{index}",
            data=data[start : start + CHUNK],
            method="PUT",
            headers={"Content-Type": "application/octet-stream"},
        )
        urllib.request.urlopen(request, timeout=120).read()

    file = api(f"/api/uploads/{upload_id}/complete", {}, "POST")["file"]
    print(json.dumps({"id": file["id"], "name": file["name"], "kind": file["kind"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
