"""SQLite 数据层。

一张表管目录树，一张表管文件，标签是多对多。
物理文件位置 = library_root / 目录链路 / 文件名，所以目录名即磁盘目录名。
"""

from __future__ import annotations

import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id   INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id    INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    ext          TEXT NOT NULL DEFAULT '',
    kind         TEXT NOT NULL DEFAULT 'other',
    size         INTEGER NOT NULL DEFAULT 0,
    duration     REAL,
    width        INTEGER,
    height       INTEGER,
    codec        TEXT,
    acodec       TEXT,
    fps          REAL,
    bitrate      INTEGER,
    has_audio    INTEGER NOT NULL DEFAULT 0,
    thumb_state  TEXT NOT NULL DEFAULT 'pending',
    probe_state  TEXT NOT NULL DEFAULT 'pending',
    proxy_state  TEXT NOT NULL DEFAULT 'none',
    favorite     INTEGER NOT NULL DEFAULT 0,
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#66ccff',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_tags (
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (file_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
"""

VIDEO_EXT = {
    "mp4", "m4v", "mov", "mkv", "avi", "wmv", "flv", "webm", "mpg", "mpeg",
    "m2v", "ts", "mts", "m2ts", "3gp", "ogv", "rmvb", "rm", "asf", "vob", "f4v",
}
AUDIO_EXT = {
    "mp3", "wav", "flac", "aac", "m4a", "ogg", "oga", "wma", "aiff", "aif",
    "ape", "opus", "wv", "amr", "mid", "midi", "mka", "ac3", "dts",
}
IMAGE_EXT = {
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif",
    "avif", "svg", "ico", "jfif", "psd", "ai", "tga", "dds",
}

_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(config.DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    config.ensure_all()
    with connect() as conn:
        conn.executescript(SCHEMA)
        count = conn.execute("SELECT COUNT(*) FROM folders").fetchone()[0]
        if count == 0 and config.load()["seed_folders"]:
            for name in ("视频", "音频", "图片", "素材包"):
                conn.execute(
                    "INSERT INTO folders (parent_id, name, created_at) VALUES (NULL, ?, ?)",
                    (name, now()),
                )
        # 文件夹和磁盘目录保持一一对应，启动时补齐缺失的目录
        for row in conn.execute("SELECT id FROM folders").fetchall():
            folder_abs(conn, row["id"]).mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------
# 文件名与路径
# --------------------------------------------------------------------------

def split_ext(name: str) -> tuple[str, str]:
    path = Path(name)
    ext = path.suffix.lower().lstrip(".")
    return (path.stem or name), ext


def kind_of(ext: str) -> str:
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    if ext in IMAGE_EXT:
        return "image"
    return "other"


def safe_name(name: str, fallback: str = "未命名") -> str:
    name = _INVALID_CHARS.sub("_", (name or "").strip())
    name = name.strip(" .")
    if not name:
        name = fallback
    stem, ext = split_ext(name)
    if stem.upper() in _RESERVED:
        stem = f"_{stem}"
    if len(stem) > 120:
        stem = stem[:120]
    return f"{stem}.{ext}" if ext else stem


def unique_path(directory: Path, name: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    candidate = directory / name
    if not candidate.exists():
        return candidate
    stem, ext = split_ext(name)
    for index in range(2, 10000):
        suffix = f" ({index})"
        candidate = directory / (f"{stem[:120 - len(suffix)]}{suffix}.{ext}" if ext else f"{stem}{suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError("无法生成不重复的文件名")


def folder_chain(conn: sqlite3.Connection, folder_id: int | None) -> list[sqlite3.Row]:
    chain: list[sqlite3.Row] = []
    current = folder_id
    guard = 0
    while current:
        row = conn.execute("SELECT id, parent_id, name FROM folders WHERE id = ?", (current,)).fetchone()
        if row is None:
            break
        chain.append(row)
        current = row["parent_id"]
        guard += 1
        if guard > 64:
            break
    chain.reverse()
    return chain


def folder_rel(conn: sqlite3.Connection, folder_id: int | None) -> Path:
    return Path(*[row["name"] for row in folder_chain(conn, folder_id)]) if folder_id else Path()


def folder_abs(conn: sqlite3.Connection, folder_id: int | None) -> Path:
    return config.library_root() / folder_rel(conn, folder_id)


def file_abs(conn: sqlite3.Connection, row: sqlite3.Row | dict[str, Any]) -> Path:
    return folder_abs(conn, row["folder_id"]) / row["name"]


def is_descendant(conn: sqlite3.Connection, folder_id: int, maybe_parent: int) -> bool:
    current = folder_id
    guard = 0
    while current:
        if current == maybe_parent:
            return True
        row = conn.execute("SELECT parent_id FROM folders WHERE id = ?", (current,)).fetchone()
        current = row["parent_id"] if row else None
        guard += 1
        if guard > 64:
            break
    return False


# --------------------------------------------------------------------------
# 序列化
# --------------------------------------------------------------------------

def row_to_file(row: sqlite3.Row, tags: Iterable[dict[str, Any]] = ()) -> dict[str, Any]:
    data = dict(row)
    data["tags"] = list(tags)
    data["has_audio"] = bool(data.get("has_audio"))
    data["favorite"] = bool(data.get("favorite"))
    return data


def rows_to_files(conn: sqlite3.Connection, rows: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    rows = list(rows)
    if not rows:
        return []
    ids = [row["id"] for row in rows]
    placeholders = ",".join("?" for _ in ids)
    tag_map: dict[int, list[dict[str, Any]]] = {}
    for tag_row in conn.execute(
        f"""SELECT ft.file_id, t.id, t.name, t.color
            FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
            WHERE ft.file_id IN ({placeholders}) ORDER BY t.name""",
        ids,
    ):
        tag_map.setdefault(tag_row["file_id"], []).append(
            {"id": tag_row["id"], "name": tag_row["name"], "color": tag_row["color"]}
        )
    return [row_to_file(row, tag_map.get(row["id"], [])) for row in rows]
