"""运行时配置。

配置只在 data/config.json 里，删掉这个文件就会回到默认值。
素材库位置固定为项目下的 library/，方便整体拷贝迁移。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
WEB_DIR = BASE_DIR / "web"
DB_PATH = DATA_DIR / "library.db"
CONFIG_PATH = DATA_DIR / "config.json"

THUMB_DIR = DATA_DIR / "thumbs"
PROXY_DIR = DATA_DIR / "proxies"
UPLOAD_DIR = DATA_DIR / "uploads"
TRASH_DIR = DATA_DIR / "trash"

DEFAULTS: dict[str, Any] = {
    "library_root": str(BASE_DIR / "library"),
    "ffmpeg_path": "",
    "thumb_width": 640,
    "thumb_height": 360,
    "proxy_height": 720,
    "port": 8420,
    "seed_folders": True,
    "last_folder": 0,
}

_cache: dict[str, Any] | None = None


def _ensure_dirs() -> None:
    for path in (DATA_DIR, THUMB_DIR, PROXY_DIR, UPLOAD_DIR, TRASH_DIR, BASE_DIR / "library"):
        path.mkdir(parents=True, exist_ok=True)


def load(refresh: bool = False) -> dict[str, Any]:
    global _cache
    if _cache is not None and not refresh:
        return _cache

    _ensure_dirs()
    values = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            stored = json.loads(CONFIG_PATH.read_text("utf-8"))
            if isinstance(stored, dict):
                values.update({k: v for k, v in stored.items() if k in DEFAULTS})
        except (OSError, ValueError):
            pass

    # 整个项目被搬走或换盘后，旧路径可能不存在，回落到项目内的 library
    try:
        if not Path(values["library_root"]).exists():
            values["library_root"] = DEFAULTS["library_root"]
    except OSError:
        values["library_root"] = DEFAULTS["library_root"]

    _cache = values
    if not CONFIG_PATH.exists():
        save(values)
    return values


def save(values: dict[str, Any]) -> dict[str, Any]:
    global _cache
    merged = dict(DEFAULTS)
    merged.update({k: v for k, v in values.items() if k in DEFAULTS})
    _ensure_dirs()
    CONFIG_PATH.write_text(json.dumps(merged, ensure_ascii=False, indent=2), "utf-8")
    _cache = merged
    return merged


def update(patch: dict[str, Any]) -> dict[str, Any]:
    current = dict(load())
    current.update({k: v for k, v in patch.items() if k in DEFAULTS})
    return save(current)


def library_root() -> Path:
    path = Path(load()["library_root"])
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_all() -> None:
    _ensure_dirs()
    library_root()
