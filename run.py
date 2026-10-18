"""素材台启动器。

双击「启动.bat」或者运行 `python run.py`。
默认只监听 127.0.0.1，别人访问不到；加 --lan 可以让同一局域网的手机访问。
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import webbrowser

from app import config, db

BANNER = r"""
   __  __    _    ___  ____  _____  _      ____  _____ ____  _  __
  |  \/  |  / \  |_ _|/ ___||_   _|| |    |  _ \| ____|  _ \| |/ /
  | |\/| | / _ \  | | \___ \  | |  | |    | | | |  _| | | | | ' /
  | |  | |/ ___ \ | |  ___) | | |  | |___ | |_| | |___| |_| | . \
  |_|  |_/_/   \_\___||____/  |_|  |_____||____/|_____|____/|_|\_\
"""


def pick_port(preferred: int) -> int:
    for port in range(preferred, preferred + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("找不到可用端口，请修改 data/config.json 里的 port")


def main() -> None:
    parser = argparse.ArgumentParser(description="素材台")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--lan", action="store_true", help="允许局域网访问")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    config.ensure_all()
    db.init_db()

    conf = config.load()
    preferred = args.port or int(conf.get("port") or 8420)
    port = pick_port(preferred)
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    url = f"http://127.0.0.1:{port}"

    print(BANNER)
    print(f"  素材库目录   {config.library_root()}")
    print(f"  本地地址     {url}")
    if args.lan:
        try:
            lan_ip = socket.gethostbyname(socket.gethostname())
            print(f"  局域网地址   http://{lan_ip}:{port}")
        except OSError:
            pass
    print("  关闭这个窗口即停止服务\n")

    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    import uvicorn
    from app.main import app

    try:
        uvicorn.run(app, host=host, port=port, log_level="warning", access_log=False)
    except KeyboardInterrupt:
        pass
    print("\n服务已停止。")


if __name__ == "__main__":
    main()
