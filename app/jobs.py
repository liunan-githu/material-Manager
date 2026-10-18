"""后台任务：探测元数据、出缩略图、转代理文件。

两条队列：快队列（探测 + 缩略图）和慢队列（代理转码），互不阻塞。
每个任务结束通过 SSE 把文件的新状态推给前端。
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Callable

from . import config, db, media

log = logging.getLogger("material.jobs")

_state: dict[str, Any] = {
    "fast": None,
    "slow": None,
    "tasks": [],
    "loop": None,
    "fast_active": set(),
    "slow_active": set(),
    "lock": threading.Lock(),
    "bus": None,
}


class Bus:
    """极简 SSE 广播，线程安全。"""

    def __init__(self) -> None:
        self.subscribers: set[asyncio.Queue] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    def attach(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=1024)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.subscribers.discard(queue)

    def publish(self, message: dict[str, Any]) -> None:
        loop = self.loop
        if loop is None or loop.is_closed():
            return

        def _push() -> None:
            for queue in list(self.subscribers):
                try:
                    queue.put_nowait(message)
                except asyncio.QueueFull:
                    try:
                        queue.get_nowait()
                        queue.put_nowait(message)
                    except (asyncio.QueueEmpty, asyncio.QueueFull):
                        pass

        try:
            loop.call_soon_threadsafe(_push)
        except RuntimeError:
            pass


bus = Bus()


def start() -> None:
    loop = asyncio.get_running_loop()
    _state["loop"] = loop
    bus.attach(loop)
    _state["fast"] = asyncio.Queue()
    _state["slow"] = asyncio.Queue()
    _state["tasks"] = [
        loop.create_task(_worker(_state["fast"], _fast_job), name="fast-worker"),
        loop.create_task(_worker(_state["slow"], _slow_job), name="slow-worker"),
    ]
    loop.create_task(_resume_pending(), name="resume-pending")


async def stop() -> None:
    for task in _state["tasks"]:
        task.cancel()
    _state["tasks"] = []


async def _resume_pending() -> None:
    await asyncio.sleep(0.4)
    try:
        with db.connect() as conn:
            rows = conn.execute(
                """SELECT id FROM files
                   WHERE deleted_at IS NULL
                     AND kind IN ('video', 'audio', 'image')
                     AND (probe_state != 'ok' OR thumb_state IN ('pending', 'fail'))
                   ORDER BY id LIMIT 2000"""
            ).fetchall()
        for row in rows:
            enqueue_fast(row["id"])
        if rows:
            log.info("恢复了 %s 个待处理任务", len(rows))
    except Exception:  # noqa: BLE001
        log.exception("恢复任务失败")


async def _worker(queue: asyncio.Queue, handler: Callable[[int], None]) -> None:
    while True:
        file_id = await queue.get()
        try:
            await asyncio.to_thread(handler, file_id)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("任务失败 file_id=%s", file_id)
        finally:
            with _state["lock"]:
                _state["fast_active"].discard(file_id)
                _state["slow_active"].discard(file_id)
            queue.task_done()


def enqueue_fast(file_id: int) -> None:
    queue = _state["fast"]
    if queue is None:
        return
    with _state["lock"]:
        if file_id in _state["fast_active"]:
            return
        _state["fast_active"].add(file_id)
    queue.put_nowait(file_id)


def enqueue_slow(file_id: int) -> None:
    queue = _state["slow"]
    if queue is None:
        return
    with _state["lock"]:
        if file_id in _state["slow_active"]:
            return
        _state["slow_active"].add(file_id)
    queue.put_nowait(file_id)


def thumb_path(file_id: int):
    return config.THUMB_DIR / f"{file_id}.jpg"


def proxy_path(file_id: int):
    return config.PROXY_DIR / f"{file_id}.mp4"


def _published(file_id: int, extra: dict[str, Any] | None = None) -> None:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    if row is None:
        return
    payload = {
        "type": "file",
        "id": file_id,
        "thumb_state": row["thumb_state"],
        "probe_state": row["probe_state"],
        "proxy_state": row["proxy_state"],
        "duration": row["duration"],
        "width": row["width"],
        "height": row["height"],
        "codec": row["codec"],
        "acodec": row["acodec"],
        "fps": row["fps"],
        "bitrate": row["bitrate"],
        "has_audio": bool(row["has_audio"]),
    }
    if extra:
        payload.update(extra)
    bus.publish(payload)


def _fast_job(file_id: int) -> None:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None or row["deleted_at"]:
            return
        src = db.file_abs(conn, row)
    if not src.exists():
        return

    kind = row["kind"]
    info: dict[str, Any] | None = None
    probe_ok = row["probe_state"] == "ok"

    if not probe_ok:
        info = media.probe(src)
        with db.connect() as conn:
            if info:
                # 图片也会被 ffmpeg 报一个很短的时长，存着没意义，清掉
                if kind == "image":
                    info["duration"] = None
                conn.execute(
                    """UPDATE files SET duration = ?, width = ?, height = ?, codec = ?,
                       acodec = ?, fps = ?, bitrate = ?, has_audio = ?, probe_state = 'ok',
                       updated_at = ? WHERE id = ?""",
                    (
                        info["duration"], info["width"], info["height"], info["codec"],
                        info["acodec"], info["fps"], info["bitrate"], 1 if info["has_audio"] else 0,
                        db.now(), file_id,
                    ),
                )
            else:
                conn.execute(
                    "UPDATE files SET probe_state = 'fail', updated_at = ? WHERE id = ?",
                    (db.now(), file_id),
                )
        _published(file_id)

    if kind == "other" or row["thumb_state"] == "ok":
        return

    target = thumb_path(file_id)
    duration = info["duration"] if info else row["duration"]
    ok = media.make_thumb(src, kind, target, duration)
    with db.connect() as conn:
        conn.execute(
            "UPDATE files SET thumb_state = ?, updated_at = ? WHERE id = ?",
            ("ok" if ok else "fail", db.now(), file_id),
        )
        if not ok and target.exists():
            target.unlink(missing_ok=True)
    _published(file_id)


def _slow_job(file_id: int) -> None:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None or row["deleted_at"]:
            return
        src = db.file_abs(conn, row)
        if not src.exists():
            return
        conn.execute(
            "UPDATE files SET proxy_state = 'working', updated_at = ? WHERE id = ?",
            (db.now(), file_id),
        )
    _published(file_id)

    target = proxy_path(file_id)
    ok = media.make_proxy(src, target, int(config.load()["proxy_height"]))
    with db.connect() as conn:
        conn.execute(
            "UPDATE files SET proxy_state = ?, updated_at = ? WHERE id = ?",
            ("ok" if ok else "fail", db.now(), file_id),
        )
    if not ok:
        target.unlink(missing_ok=True)
    _published(file_id)


def rebuild(folder_ids: list[int] | None = None) -> int:
    """把缩略图/探测状态重置为待处理，返回受影响条数。"""
    with db.connect() as conn:
        if folder_ids:
            placeholders = ",".join("?" for _ in folder_ids)
            rows = conn.execute(
                f"SELECT id FROM files WHERE folder_id IN ({placeholders}) AND deleted_at IS NULL",
                folder_ids,
            ).fetchall()
        else:
            rows = conn.execute("SELECT id FROM files WHERE deleted_at IS NULL").fetchall()
        conn.execute(
            "UPDATE files SET thumb_state = 'pending', probe_state = 'pending' WHERE deleted_at IS NULL"
        )
    for row in rows:
        enqueue_fast(row["id"])
    return len(rows)
