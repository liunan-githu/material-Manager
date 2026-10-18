"""FastAPI 应用：目录树、素材、标签、分片上传、媒体流。"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, jobs, media

log = logging.getLogger("material.api")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

CHUNK_SIZE = 8 * 1024 * 1024
config.WEB_DIR.mkdir(parents=True, exist_ok=True)

for _ext, _type in {
    ".mkv": "video/x-matroska",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".opus": "audio/ogg",
    ".aiff": "audio/aiff",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".avif": "image/avif",
}.items():
    mimetypes.add_type(_type, _ext)


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.ensure_all()
    db.init_db()
    jobs.start()
    log.info("素材台已启动，素材库：%s", config.library_root())
    try:
        yield
    finally:
        await jobs.stop()


app = FastAPI(title="素材台", lifespan=lifespan)


@app.middleware("http")
async def log_mutations(request: Request, call_next):
    """记录会改数据的请求，排查误操作时直接看 data/requests.log。"""
    if request.method in {"POST", "PUT", "PATCH", "DELETE"} and "/api/uploads/" not in request.url.path:
        try:
            body = await request.body()
            line = (
                f"{db.now()} {request.method} {request.url.path} "
                f"{request.client.host if request.client else '-'} "
                f"ua={request.headers.get('user-agent', '')[:48]} "
                f"body={body[:300].decode('utf-8', 'replace')}\n"
            )
            with open(config.DATA_DIR / "requests.log", "a", encoding="utf-8") as handle:
                handle.write(line)
        except Exception:  # noqa: BLE001
            pass
    return await call_next(request)


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------

def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _no_cache(path: Path, media_type: str | None = None) -> FileResponse:
    return FileResponse(path, media_type=media_type or mimetypes.guess_type(path.name)[0])


def _etag(path: Path) -> str:
    stat = path.stat()
    return f'W/"{int(stat.st_mtime)}-{stat.st_size}"'


def _stats(conn) -> dict[str, Any]:
    row = conn.execute(
        """SELECT COUNT(*) AS total, COALESCE(SUM(size), 0) AS bytes FROM files
           WHERE deleted_at IS NULL"""
    ).fetchone()
    trash = conn.execute(
        "SELECT COUNT(*) AS total, COALESCE(SUM(size), 0) AS bytes FROM files WHERE deleted_at IS NOT NULL"
    ).fetchone()
    by_kind = {
        item["kind"]: item["count"]
        for item in conn.execute(
            "SELECT kind, COUNT(*) AS count FROM files WHERE deleted_at IS NULL GROUP BY kind"
        )
    }
    kind_bytes = {
        item["kind"]: item["bytes"]
        for item in conn.execute(
            """SELECT kind, COALESCE(SUM(size), 0) AS bytes FROM files
               WHERE deleted_at IS NULL GROUP BY kind"""
        )
    }
    favorites = conn.execute(
        "SELECT COUNT(*) FROM files WHERE deleted_at IS NULL AND favorite = 1"
    ).fetchone()[0]
    return {
        "count": row["total"],
        "bytes": row["bytes"],
        "trash_count": trash["total"],
        "trash_bytes": trash["bytes"],
        "favorites": favorites,
        "kinds": by_kind,
        "kind_bytes": kind_bytes,
        "ffmpeg": media.status(),
    }


def _folder_rows(conn) -> list[dict[str, Any]]:
    counts = {
        row["folder_id"]: row["count"]
        for row in conn.execute(
            "SELECT folder_id, COUNT(*) AS count FROM files WHERE deleted_at IS NULL GROUP BY folder_id"
        )
    }
    nodes = [
        {
            "id": row["id"],
            "parent_id": row["parent_id"],
            "name": row["name"],
            "count": counts.get(row["id"], 0),
            "total": 0,
            "children": [],
        }
        for row in conn.execute("SELECT id, parent_id, name FROM folders ORDER BY id")
    ]
    index = {node["id"]: node for node in nodes}
    roots: list[dict[str, Any]] = []
    for node in nodes:
        parent = index.get(node["parent_id"])
        if parent is not None:
            parent["children"].append(node)
        else:
            roots.append(node)

    def rollup(node: dict[str, Any]) -> int:
        total = node["count"] + sum(rollup(child) for child in node["children"])
        node["total"] = total
        return total

    for node in roots:
        rollup(node)
    return roots


def _tags(conn) -> list[dict[str, Any]]:
    return [
        {"id": row["id"], "name": row["name"], "color": row["color"], "count": row["count"]}
        for row in conn.execute(
            """SELECT t.id, t.name, t.color, COUNT(ft.file_id) AS count
               FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id
               LEFT JOIN files f ON f.id = ft.file_id AND f.deleted_at IS NULL
               GROUP BY t.id ORDER BY t.name COLLATE NOCASE"""
        )
    ]


# --------------------------------------------------------------------------
# 元信息
# --------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "app": "material-desk", "version": 1}


@app.get("/api/bootstrap")
def bootstrap() -> dict[str, Any]:
    with db.connect() as conn:
        return {
            "folders": _folder_rows(conn),
            "tags": _tags(conn),
            "stats": _stats(conn),
            "settings": {
                "library_root": str(config.library_root()),
                "proxy_height": config.load()["proxy_height"],
                "chunk_size": CHUNK_SIZE,
            },
        }


@app.get("/api/stats")
def stats() -> dict[str, Any]:
    with db.connect() as conn:
        return _stats(conn)


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    conf = config.load()
    return {
        "library_root": str(config.library_root()),
        "ffmpeg_path": conf["ffmpeg_path"],
        "ffmpeg": media.status(),
        "proxy_height": conf["proxy_height"],
        "port": conf["port"],
        "data_dir": str(config.DATA_DIR),
    }


@app.put("/api/settings")
async def put_settings(request: Request) -> dict[str, Any]:
    payload = await request.json()
    patch: dict[str, Any] = {}
    if "ffmpeg_path" in payload:
        patch["ffmpeg_path"] = str(payload["ffmpeg_path"] or "").strip()
    if "proxy_height" in payload:
        patch["proxy_height"] = max(240, min(2160, _int(payload["proxy_height"], 720)))
    config.update(patch)
    media.locate(force=True)
    return get_settings()


@app.post("/api/settings/reveal")
def reveal_library() -> dict[str, Any]:
    try:
        subprocess.Popen(["explorer", str(config.library_root())])
        return {"ok": True}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}


@app.get("/api/events")
async def events(request: Request) -> StreamingResponse:
    queue = jobs.bus.subscribe()

    async def stream() -> Iterator[str]:
        try:
            yield "retry: 4000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield f"data: {json.dumps(message, ensure_ascii=False)}\n\n"
        finally:
            jobs.bus.unsubscribe(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# --------------------------------------------------------------------------
# 目录
# --------------------------------------------------------------------------

@app.get("/api/folders")
def list_folders() -> dict[str, Any]:
    with db.connect() as conn:
        return {"folders": _folder_rows(conn)}


@app.post("/api/folders")
async def create_folder(request: Request) -> dict[str, Any]:
    payload = await request.json()
    name = db.safe_name(str(payload.get("name") or ""))
    parent_id = payload.get("parent_id")
    parent_id = _int(parent_id, 0) or None
    if not name:
        raise HTTPException(400, "目录名不能为空")

    with db.connect() as conn:
        if parent_id and not conn.execute("SELECT 1 FROM folders WHERE id = ?", (parent_id,)).fetchone():
            raise HTTPException(404, "上级目录不存在")
        exists = conn.execute(
            "SELECT 1 FROM folders WHERE COALESCE(parent_id, 0) = ? AND name = ?",
            (parent_id or 0, name),
        ).fetchone()
        if exists:
            raise HTTPException(409, "同级已有同名目录")
        target = db.folder_abs(conn, parent_id) / name
        target.mkdir(parents=True, exist_ok=True)
        cursor = conn.execute(
            "INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)",
            (parent_id, name, db.now()),
        )
        folder_id = cursor.lastrowid
        folders = _folder_rows(conn)
    jobs.bus.publish({"type": "folders"})
    return {"id": folder_id, "folders": folders}


@app.patch("/api/folders/{folder_id}")
async def update_folder(folder_id: int, request: Request) -> dict[str, Any]:
    payload = await request.json()
    new_name = db.safe_name(str(payload.get("name"))) if payload.get("name") else None
    has_parent = "parent_id" in payload
    new_parent = _int(payload.get("parent_id"), 0) or None if has_parent else None

    with db.connect() as conn:
        row = conn.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "目录不存在")
        parent = new_parent if has_parent else row["parent_id"]
        name = new_name or row["name"]

        if parent and (parent == folder_id or db.is_descendant(conn, parent, folder_id)):
            raise HTTPException(400, "不能把目录移动到它自己里面")
        if parent and not conn.execute("SELECT 1 FROM folders WHERE id = ?", (parent,)).fetchone():
            raise HTTPException(404, "目标目录不存在")

        clash = conn.execute(
            "SELECT 1 FROM folders WHERE COALESCE(parent_id, 0) = ? AND name = ? AND id != ?",
            (parent or 0, name, folder_id),
        ).fetchone()
        if clash:
            raise HTTPException(409, "目标目录下已有同名目录")

        old_path = db.folder_abs(conn, folder_id)
        new_path = (db.folder_abs(conn, parent) / name) if parent else (config.library_root() / name)
        if old_path != new_path:
            if new_path.exists():
                raise HTTPException(409, "磁盘上已存在同名目录")
            old_path.parent.mkdir(parents=True, exist_ok=True)
            new_path.parent.mkdir(parents=True, exist_ok=True)
            if old_path.exists():
                shutil.move(str(old_path), str(new_path))
            else:
                new_path.mkdir(parents=True, exist_ok=True)

        conn.execute(
            "UPDATE folders SET name = ?, parent_id = ? WHERE id = ?", (name, parent, folder_id)
        )
        folders = _folder_rows(conn)
    jobs.bus.publish({"type": "folders"})
    return {"folders": folders}


@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: int) -> dict[str, Any]:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "目录不存在")

        subtree: list[int] = []

        def collect(node_id: int) -> None:
            subtree.append(node_id)
            for child in conn.execute("SELECT id FROM folders WHERE parent_id = ?", (node_id,)):
                collect(child["id"])

        collect(folder_id)
        placeholders = ",".join("?" for _ in subtree)
        files = conn.execute(
            f"SELECT * FROM files WHERE folder_id IN ({placeholders}) AND deleted_at IS NULL",
            subtree,
        ).fetchall()
        removed = 0
        for file_row in files:
            _trash_file(conn, file_row)
            removed += 1

        root_path = db.folder_abs(conn, folder_id)
        conn.execute(f"DELETE FROM folders WHERE id IN ({placeholders})", subtree)
        if root_path.exists():
            shutil.rmtree(root_path, ignore_errors=True)
        folders = _folder_rows(conn)
        stats_payload = _stats(conn)
    jobs.bus.publish({"type": "folders"})
    jobs.bus.publish({"type": "stats", "stats": stats_payload})
    return {"folders": folders, "trashed": removed}


# --------------------------------------------------------------------------
# 素材列表
# --------------------------------------------------------------------------

SORTS = {
    "recent": "f.created_at DESC, f.id DESC",
    "oldest": "f.created_at ASC, f.id ASC",
    "name": "f.name COLLATE NOCASE ASC",
    "name_desc": "f.name COLLATE NOCASE DESC",
    "size": "f.size DESC",
    "size_asc": "f.size ASC",
    "duration": "COALESCE(f.duration, 0) DESC",
}


@app.get("/api/files")
def list_files(
    folder: str = "all",
    kind: str = "all",
    tag: int = 0,
    q: str = "",
    sort: str = "recent",
    limit: int = 240,
    offset: int = 0,
) -> dict[str, Any]:
    limit = max(1, min(1000, limit))
    offset = max(0, offset)
    trash = folder == "trash"
    favorite = folder == "favorite"

    where = ["f.deleted_at IS NOT NULL" if trash else "f.deleted_at IS NULL"]
    params: list[Any] = []
    child_folders: list[dict[str, Any]] = []
    crumbs: list[dict[str, Any]] = []

    with db.connect() as conn:
        if folder not in ("all", "trash", "favorite") and _int(folder, 0):
            folder_id = _int(folder)
            row = conn.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)).fetchone()
            if row is None:
                raise HTTPException(404, "目录不存在")
            where.append("f.folder_id = ?")
            params.append(folder_id)
            crumbs = [
                {"id": item["id"], "name": item["name"]}
                for item in db.folder_chain(conn, folder_id)
            ]
            child_folders = [
                {
                    "id": child["id"],
                    "name": child["name"],
                    "count": conn.execute(
                        "SELECT COUNT(*) FROM files WHERE folder_id = ? AND deleted_at IS NULL",
                        (child["id"],),
                    ).fetchone()[0],
                }
                for child in conn.execute(
                    "SELECT id, name FROM folders WHERE parent_id = ? ORDER BY id",
                    (folder_id,),
                )
            ]
        elif favorite:
            where.append("f.favorite = 1")

        if kind in ("video", "audio", "image", "other"):
            where.append("f.kind = ?")
            params.append(kind)

        if tag:
            where.append("EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id AND ft.tag_id = ?)")
            params.append(tag)

        q = (q or "").strip()
        if q:
            like = f"%{q.replace('%', '\\%').replace('_', '\\_')}%"
            where.append(
                """(f.name LIKE ? ESCAPE '\\' OR f.note LIKE ? ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
                               WHERE ft.file_id = f.id AND t.name LIKE ? ESCAPE '\\'))"""
            )
            params.extend([like, like, like])

        clause = " AND ".join(where)
        total = conn.execute(f"SELECT COUNT(*) FROM files f WHERE {clause}", params).fetchone()[0]
        order = SORTS.get(sort, SORTS["recent"])
        rows = conn.execute(
            f"SELECT f.* FROM files f WHERE {clause} ORDER BY {order} LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        items = db.rows_to_files(conn, rows)

    return {
        "items": items,
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(items) < total,
        "folders": child_folders,
        "crumbs": crumbs,
        "folder": folder,
    }


@app.get("/api/files/{file_id}")
def get_file(file_id: int) -> dict[str, Any]:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "素材不存在")
        payload = db.rows_to_files(conn, [row])[0]
        payload["crumbs"] = [
            {"id": item["id"], "name": item["name"]}
            for item in db.folder_chain(conn, row["folder_id"])
        ]
        payload["abs_path"] = str(db.file_abs(conn, row))
        payload["proxy_ready"] = jobs.proxy_path(file_id).exists()
        payload["browser_playable"] = media.browser_playable(
            row["ext"],
            {
                "codec": row["codec"],
                "acodec": row["acodec"],
            },
        )
    return payload


# --------------------------------------------------------------------------
# 素材修改 / 批量操作
# --------------------------------------------------------------------------

def _trash_file(conn, row) -> None:
    src = db.file_abs(conn, row)
    config.TRASH_DIR.mkdir(parents=True, exist_ok=True)
    target = config.TRASH_DIR / f"{row['id']}_{row['name']}"
    if src.exists():
        try:
            shutil.move(str(src), str(target))
        except OSError as exc:
            raise HTTPException(500, f"移入回收站失败：{exc}") from exc
    conn.execute(
        "UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?", (db.now(), db.now(), row["id"])
    )


def _restore_file(conn, row) -> None:
    folder_id = row["folder_id"]
    folder = conn.execute("SELECT 1 FROM folders WHERE id = ?", (folder_id,)).fetchone()
    if folder is None:
        raise HTTPException(409, "原目录已删除，无法还原")
    target_dir = db.folder_abs(conn, folder_id)
    target = db.unique_path(target_dir, row["name"])
    source = config.TRASH_DIR / f"{row['id']}_{row['name']}"
    if source.exists():
        shutil.move(str(source), str(target))
    conn.execute(
        "UPDATE files SET name = ?, deleted_at = NULL, updated_at = ? WHERE id = ?",
        (target.name, db.now(), row["id"]),
    )


def _purge_file(row) -> None:
    source = config.TRASH_DIR / f"{row['id']}_{row['name']}"
    if source.exists():
        source.unlink(missing_ok=True)
    # 彻底删除时把缓存也清掉，避免 thumbs/proxies 越积越多
    for cache in (jobs.thumb_path(row["id"]), jobs.proxy_path(row["id"])):
        cache.unlink(missing_ok=True)


@app.patch("/api/files/{file_id}")
async def update_file(file_id: int, request: Request) -> dict[str, Any]:
    payload = await request.json()
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "素材不存在")

        new_name = db.safe_name(str(payload["name"])) if payload.get("name") else row["name"]
        target_folder = _int(payload["folder_id"], row["folder_id"]) if "folder_id" in payload else row["folder_id"]
        note = str(payload.get("note", row["note"]))[:2000]
        favorite = 1 if payload.get("favorite", bool(row["favorite"])) else 0

        renamed = new_name != row["name"]
        moved = target_folder != row["folder_id"]
        requeue = False

        if renamed or moved:
            if not conn.execute("SELECT 1 FROM folders WHERE id = ?", (target_folder,)).fetchone():
                raise HTTPException(404, "目标目录不存在")
            source = db.file_abs(conn, row)
            target_dir = db.folder_abs(conn, target_folder)
            target = db.unique_path(target_dir, new_name)
            if source.exists():
                shutil.move(str(source), str(target))
            new_name = target.name
            ext = db.split_ext(new_name)[1]
            kind = db.kind_of(ext)
            if ext != row["ext"] or kind != row["kind"]:
                requeue = True
            conn.execute(
                """UPDATE files SET name = ?, folder_id = ?, ext = ?, kind = ?, note = ?,
                   favorite = ?, updated_at = ? WHERE id = ?""",
                (new_name, target_folder, ext, kind, note, favorite, db.now(), file_id),
            )
            if requeue:
                conn.execute(
                    "UPDATE files SET thumb_state = 'pending', probe_state = 'pending' WHERE id = ?",
                    (file_id,),
                )
                jobs.thumb_path(file_id).unlink(missing_ok=True)
        else:
            conn.execute(
                "UPDATE files SET note = ?, favorite = ?, updated_at = ? WHERE id = ?",
                (note, favorite, db.now(), file_id),
            )

        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        result = db.rows_to_files(conn, [row])[0]

    if requeue:
        jobs.enqueue_fast(file_id)
    jobs.bus.publish({"type": "file", "id": file_id, "patch": result})
    return result


@app.post("/api/files/bulk")
async def bulk_action(request: Request) -> dict[str, Any]:
    payload = await request.json()
    action = str(payload.get("action") or "")
    ids = [_int(value) for value in payload.get("ids") or [] if _int(value)]
    if not ids and action != "empty_trash":
        raise HTTPException(400, "没有选中素材")
    placeholders = ",".join("?" for _ in ids) or "NULL"
    changed = 0

    with db.connect() as conn:
        rows = conn.execute(f"SELECT * FROM files WHERE id IN ({placeholders})", ids).fetchall()

        if action == "trash":
            for row in rows:
                if not row["deleted_at"]:
                    _trash_file(conn, row)
                    changed += 1
        elif action == "restore":
            for row in rows:
                if row["deleted_at"]:
                    _restore_file(conn, row)
                    changed += 1
        elif action == "purge":
            for row in rows:
                if row["deleted_at"]:
                    _purge_file(row)
                    changed += 1
            conn.execute(f"DELETE FROM files WHERE id IN ({placeholders})", ids)
        elif action == "empty_trash":
            trash_rows = conn.execute("SELECT * FROM files WHERE deleted_at IS NOT NULL").fetchall()
            for row in trash_rows:
                _purge_file(row)
            conn.execute("DELETE FROM files WHERE deleted_at IS NOT NULL")
            changed = len(trash_rows)
        elif action == "move":
            folder_id = _int(payload.get("folder_id"))
            folder = conn.execute("SELECT 1 FROM folders WHERE id = ?", (folder_id,)).fetchone()
            if folder is None:
                raise HTTPException(404, "目标目录不存在")
            target_dir = db.folder_abs(conn, folder_id)
            for row in rows:
                if row["deleted_at"] or row["folder_id"] == folder_id:
                    continue
                source = db.file_abs(conn, row)
                target = db.unique_path(target_dir, row["name"])
                if source.exists():
                    shutil.move(str(source), str(target))
                conn.execute(
                    "UPDATE files SET folder_id = ?, name = ?, updated_at = ? WHERE id = ?",
                    (folder_id, target.name, db.now(), row["id"]),
                )
                changed += 1
        elif action in ("tag", "untag"):
            tag_ids = [_int(value) for value in payload.get("tag_ids") or [] if _int(value)]
            for tag_id in tag_ids:
                if not conn.execute("SELECT 1 FROM tags WHERE id = ?", (tag_id,)).fetchone():
                    continue
                for row in rows:
                    if action == "tag":
                        conn.execute(
                            "INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)",
                            (row["id"], tag_id),
                        )
                    else:
                        conn.execute(
                            "DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?",
                            (row["id"], tag_id),
                        )
            changed = len(rows)
        elif action == "favorite":
            value = 1 if payload.get("value", True) else 0
            conn.execute(
                f"UPDATE files SET favorite = ?, updated_at = ? WHERE id IN ({placeholders})",
                [value, db.now(), *ids],
            )
            changed = len(rows)
        else:
            raise HTTPException(400, "未知操作")

        stats_payload = _stats(conn)
        tags_payload = _tags(conn)

    jobs.bus.publish({"type": "refresh"})
    jobs.bus.publish({"type": "stats", "stats": stats_payload})
    return {"changed": changed, "stats": stats_payload, "tags": tags_payload}


@app.delete("/api/files/{file_id}")
def delete_file(file_id: int) -> dict[str, Any]:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "素材不存在")
        _trash_file(conn, row)
        stats_payload = _stats(conn)
    jobs.bus.publish({"type": "refresh"})
    jobs.bus.publish({"type": "stats", "stats": stats_payload})
    return {"ok": True, "stats": stats_payload}


@app.post("/api/files/{file_id}/proxy")
def request_proxy(file_id: int, force: bool = False) -> dict[str, Any]:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "素材不存在")
        if row["kind"] != "video":
            raise HTTPException(400, "只有视频能生成代理")
        if not media.status()["available"]:
            raise HTTPException(400, "还没找到 ffmpeg，无法生成代理")
        if force or row["proxy_state"] in ("fail", "none") or not jobs.proxy_path(file_id).exists():
            conn.execute(
                "UPDATE files SET proxy_state = 'queued', updated_at = ? WHERE id = ?",
                (db.now(), file_id),
            )
            jobs.enqueue_slow(file_id)
    jobs.bus.publish({"type": "file", "id": file_id, "proxy_state": "queued"})
    return {"ok": True, "state": "queued"}


# --------------------------------------------------------------------------
# 标签
# --------------------------------------------------------------------------

@app.get("/api/tags")
def list_tags() -> dict[str, Any]:
    with db.connect() as conn:
        return {"tags": _tags(conn)}


@app.post("/api/tags")
async def create_tag(request: Request) -> dict[str, Any]:
    payload = await request.json()
    name = str(payload.get("name") or "").strip()[:40]
    color = str(payload.get("color") or "#66ccff")
    if not name:
        raise HTTPException(400, "标签名不能为空")
    with db.connect() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)",
                (name, color, db.now()),
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(409, "标签已存在") from exc
        tag_id = cursor.lastrowid
        file_ids = [_int(value) for value in payload.get("file_ids") or [] if _int(value)]
        for file_id in file_ids:
            conn.execute(
                "INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)", (file_id, tag_id)
            )
        tags = _tags(conn)
    jobs.bus.publish({"type": "tags"})
    return {"id": tag_id, "tags": tags}


@app.patch("/api/tags/{tag_id}")
async def update_tag(tag_id: int, request: Request) -> dict[str, Any]:
    payload = await request.json()
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM tags WHERE id = ?", (tag_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "标签不存在")
        name = str(payload.get("name") or row["name"]).strip()[:40]
        color = str(payload.get("color") or row["color"])
        try:
            conn.execute("UPDATE tags SET name = ?, color = ? WHERE id = ?", (name, color, tag_id))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(409, "标签已存在") from exc
        tags = _tags(conn)
    jobs.bus.publish({"type": "tags"})
    return {"tags": tags}


@app.delete("/api/tags/{tag_id}")
def delete_tag(tag_id: int) -> dict[str, Any]:
    with db.connect() as conn:
        conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
        tags = _tags(conn)
    jobs.bus.publish({"type": "tags"})
    jobs.bus.publish({"type": "refresh"})
    return {"tags": tags}


# --------------------------------------------------------------------------
# 上传（分片）
# --------------------------------------------------------------------------

def _upload_dir(upload_id: str) -> Path:
    return config.UPLOAD_DIR / upload_id


def _upload_meta_path(upload_id: str) -> Path:
    return _upload_dir(upload_id) / "meta.json"


def _read_upload(upload_id: str) -> dict[str, Any]:
    meta_path = _upload_meta_path(upload_id)
    if not meta_path.exists():
        raise HTTPException(404, "上传任务不存在或已过期")
    try:
        return json.loads(meta_path.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(500, "上传任务损坏") from exc


@app.post("/api/uploads")
async def create_upload(request: Request) -> dict[str, Any]:
    payload = await request.json()
    name = db.safe_name(str(payload.get("name") or "未命名"))
    size = max(0, _int(payload.get("size")))
    folder_id = _int(payload.get("folder_id"))
    with db.connect() as conn:
        if not conn.execute("SELECT 1 FROM folders WHERE id = ?", (folder_id,)).fetchone():
            raise HTTPException(404, "目标目录不存在")

    upload_id = uuid.uuid4().hex
    directory = _upload_dir(upload_id)
    directory.mkdir(parents=True, exist_ok=True)
    meta = {
        "id": upload_id,
        "name": name,
        "size": size,
        "folder_id": folder_id,
        "chunk_size": CHUNK_SIZE,
        "received": [],
        "created_at": db.now(),
    }
    _upload_meta_path(upload_id).write_text(json.dumps(meta, ensure_ascii=False), "utf-8")
    return {"upload_id": upload_id, "chunk_size": CHUNK_SIZE, "received": []}


@app.get("/api/uploads/{upload_id}")
def get_upload(upload_id: str) -> dict[str, Any]:
    meta = _read_upload(upload_id)
    received = sorted(
        int(part.stem) for part in _upload_dir(upload_id).glob("*.part") if part.stem.isdigit()
    )
    return {"upload_id": upload_id, "chunk_size": meta["chunk_size"], "received": received}


@app.put("/api/uploads/{upload_id}/{index}")
async def put_chunk(upload_id: str, index: int, request: Request) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{32}", upload_id):
        raise HTTPException(400, "上传 ID 不合法")
    directory = _upload_dir(upload_id)
    if not _upload_meta_path(upload_id).exists():
        raise HTTPException(404, "上传任务不存在")
    if index < 0 or index > 100000:
        raise HTTPException(400, "分片序号不合法")

    part = directory / f"{index}.part"
    temp = directory / f"{index}.tmp"
    written = 0
    with temp.open("wb") as handle:
        async for chunk in request.stream():
            if chunk:
                handle.write(chunk)
                written += len(chunk)
    if written == 0:
        temp.unlink(missing_ok=True)
        raise HTTPException(400, "空分片")
    os.replace(temp, part)
    return {"ok": True, "index": index, "bytes": written}


@app.post("/api/uploads/{upload_id}/complete")
async def complete_upload(upload_id: str, request: Request) -> dict[str, Any]:
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    meta = _read_upload(upload_id)
    directory = _upload_dir(upload_id)
    parts = sorted(
        (int(part.stem), part) for part in directory.glob("*.part") if part.stem.isdigit()
    )
    if not parts:
        raise HTTPException(400, "没有收到任何分片")

    assembled = directory / "assembled.bin"
    total = 0
    with assembled.open("wb") as out:
        for _, part in parts:
            with part.open("rb") as handle:
                shutil.copyfileobj(handle, out, 1024 * 1024)
            total += part.stat().st_size

    name = db.safe_name(str(payload.get("name") or meta["name"]))
    folder_id = _int(meta["folder_id"])
    with db.connect() as conn:
        if not conn.execute("SELECT 1 FROM folders WHERE id = ?", (folder_id,)).fetchone():
            assembled.unlink(missing_ok=True)
            raise HTTPException(404, "目标目录已被删除")
        target = db.unique_path(db.folder_abs(conn, folder_id), name)
        shutil.move(str(assembled), str(target))
        stem, ext = db.split_ext(target.name)
        kind = db.kind_of(ext)
        cursor = conn.execute(
            """INSERT INTO files (folder_id, name, ext, kind, size, thumb_state, probe_state,
               proxy_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'none', ?, ?)""",
            (
                folder_id, target.name, ext, kind, total,
                "pending" if kind in ("video", "audio", "image") else "none",
                db.now(), db.now(),
            ),
        )
        file_id = cursor.lastrowid
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        result = db.rows_to_files(conn, [row])[0]
        stats_payload = _stats(conn)

    shutil.rmtree(directory, ignore_errors=True)
    jobs.enqueue_fast(file_id)
    jobs.bus.publish({"type": "created", "file": result})
    jobs.bus.publish({"type": "stats", "stats": stats_payload})
    return {"file": result, "stats": stats_payload}


@app.delete("/api/uploads/{upload_id}")
def cancel_upload(upload_id: str) -> dict[str, Any]:
    if re.fullmatch(r"[0-9a-f]{32}", upload_id or ""):
        shutil.rmtree(_upload_dir(upload_id), ignore_errors=True)
    return {"ok": True}


# --------------------------------------------------------------------------
# 媒体文件
# --------------------------------------------------------------------------

def _iter_range(path: Path, start: int, length: int, block: int = 1024 * 512) -> Iterator[bytes]:
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = length
        while remaining > 0:
            data = handle.read(min(block, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def _stream_file(path: Path, request: Request) -> Response:
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "文件不存在")
    size = path.stat().st_size
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    range_header = request.headers.get("range") or request.headers.get("Range")
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0, must-revalidate",
        "Content-Disposition": "inline",
    }

    if range_header:
        match = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
        if match:
            start_raw, end_raw = match.groups()
            if start_raw:
                start = int(start_raw)
                end = int(end_raw) if end_raw else size - 1
            else:
                suffix = int(end_raw or 0)
                start = max(0, size - suffix)
                end = size - 1
            end = min(end, size - 1)
            if start > end or start >= size:
                return Response(
                    status_code=416, headers={"Content-Range": f"bytes */{size}"}
                )
            length = end - start + 1
            headers.update(
                {
                    "Content-Range": f"bytes {start}-{end}/{size}",
                    "Content-Length": str(length),
                }
            )
            return StreamingResponse(
                _iter_range(path, start, length), status_code=206, headers=headers, media_type=media_type
            )

    headers["Content-Length"] = str(size)
    return StreamingResponse(_iter_range(path, 0, size), status_code=200, headers=headers, media_type=media_type)


@app.get("/api/files/{file_id}/stream")
def stream_file(file_id: int, request: Request, proxy: int = 0) -> Response:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "素材不存在")
        source = jobs.proxy_path(file_id) if proxy else db.file_abs(conn, row)
    return _stream_file(source, request)


@app.get("/api/files/{file_id}/download")
def download_file(file_id: int) -> FileResponse:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "素材不存在")
        path = db.file_abs(conn, row)
        name = row["name"]
    if not path.exists():
        raise HTTPException(404, "磁盘上找不到这个文件")
    return FileResponse(
        path,
        media_type=mimetypes.guess_type(name)[0] or "application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"},
    )


@app.get("/api/files/{file_id}/thumb")
def file_thumb(file_id: int, request: Request) -> Response:
    path = jobs.thumb_path(file_id)
    if not path.exists():
        raise HTTPException(404, "缩略图还没生成")
    response = FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=604800"},
    )
    etag = _etag(path)
    response.headers["ETag"] = etag
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return response


@app.post("/api/maintenance/rebuild")
async def rebuild_thumbs(request: Request) -> dict[str, Any]:
    payload = {}
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        pass
    folder_id = _int(payload.get("folder_id"), 0)
    count = jobs.rebuild([folder_id] if folder_id else None)
    jobs.bus.publish({"type": "refresh"})
    return {"queued": count}


@app.post("/api/reveal/{file_id}")
def reveal_file(file_id: int) -> dict[str, Any]:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "素材不存在")
        path = db.file_abs(conn, row)
    try:
        if path.exists():
            subprocess.Popen(["explorer", "/select,", str(path)])
            return {"ok": True}
        return {"ok": False, "error": "文件不存在"}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}


# --------------------------------------------------------------------------
# 前端静态文件
# --------------------------------------------------------------------------

app.mount("/assets", StaticFiles(directory=config.WEB_DIR), name="assets")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(
        config.WEB_DIR / "index.html",
        headers={"Cache-Control": "no-store"},
    )


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
