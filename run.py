"""素材台启动器。

双击「启动.bat」或者运行 `python run.py`。
默认只监听 127.0.0.1，别人访问不到；加 --lan 会同时监听 IPv4 和 IPv6，
同一局域网的手机、平板就能用 http://电脑IP:8420 打开。
"""

from __future__ import annotations

import argparse
import ipaddress
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


def bind_dual_stack(preferred: int) -> tuple[socket.socket, int]:
    """一个套接字同时收 IPv4 和 IPv6，Windows 上不会出现只通一半的情况。"""
    last_error: OSError | None = None
    for port in range(preferred, preferred + 40):
        try:
            sock = socket.create_server(
                ("::", port), family=socket.AF_INET6, dualstack_ipv6=True, backlog=2048
            )
            return sock, port
        except OSError as exc:
            last_error = exc
            continue
    raise SystemExit(f"找不到可用端口：{last_error}")


def primary_address(family: int, probe: str) -> str | None:
    """用 UDP「连一下」外网地址，拿到默认路由实际使用的本机地址。"""
    try:
        with socket.socket(family, socket.SOCK_DGRAM) as sock:
            sock.connect((probe, 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def list_addresses() -> tuple[list[str], list[str]]:
    """列出本机可用的局域网 IPv4 / 公网 IPv6，过滤回环、链路本地和 VPN 地址。"""
    ipv4: list[str] = []
    ipv6: list[str] = []

    # 默认路由上的地址排最前，通常是手机该用的那个
    primary4 = primary_address(socket.AF_INET, "8.8.8.8")
    if primary4 and not primary4.startswith(("127.", "169.254.")):
        ipv4.append(primary4)
    primary6 = primary_address(socket.AF_INET6, "2001:4860:4860::8888")
    if primary6 and not primary6.startswith("fe80"):
        ipv6.append(primary6)

    try:
        infos = socket.getaddrinfo(socket.gethostname(), None)
    except OSError:
        return ipv4, ipv6

    for family, _, _, _, sockaddr in infos:
        ip = sockaddr[0].split("%")[0]
        if family == socket.AF_INET:
            try:
                addr = ipaddress.ip_address(ip)
            except ValueError:
                continue
            if addr.is_private and not addr.is_link_local and not ip.endswith((".0", ".255")):
                if ip not in ipv4:
                    ipv4.append(ip)
        elif family == socket.AF_INET6:
            if ip.startswith("2001:0:"):
                continue  # Teredo 隧道，手机连不上
            try:
                addr = ipaddress.ip_address(ip)
            except ValueError:
                continue
            if addr.is_global and ip not in ipv6:
                ipv6.append(ip)
    return ipv4, ipv6


def main() -> None:
    parser = argparse.ArgumentParser(description="素材台")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--lan", action="store_true", help="允许局域网访问，同时监听 IPv4 和 IPv6")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:  # noqa: BLE001
        pass

    config.ensure_all()
    db.init_db()

    conf = config.load()
    preferred = args.port or int(conf.get("port") or 8420)

    sock: socket.socket | None = None
    if args.lan:
        try:
            sock, port = bind_dual_stack(preferred)
        except (OSError, ValueError) as exc:
            raise SystemExit(f"无法监听局域网端口：{exc}") from exc
    else:
        port = pick_port(preferred)

    url = f"http://127.0.0.1:{port}"

    print(BANNER)
    print(f"  素材库目录   {config.library_root()}")
    print(f"  本机访问     {url}")
    if args.lan:
        v4, v6 = list_addresses()
        for ip in v4:
            print(f"  局域网 IPv4  http://{ip}:{port}")
        for ip in v6:
            print(f"  局域网 IPv6  http://[{ip}]:{port}")
        if not v4 and not v6:
            print("  局域网地址   没有找到，检查一下网络连接")
        print("  提示         手机要和电脑在同一网络；防火墙弹窗要选「允许访问」")
    print("  关闭这个窗口即停止服务\n")

    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    import uvicorn
    from app.main import app

    config_obj = uvicorn.Config(
        app,
        host="::" if args.lan else "127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config_obj)

    try:
        if sock is not None:
            server.run(sockets=[sock])
        else:
            server.run()
    except KeyboardInterrupt:
        pass
    finally:
        if sock is not None:
            sock.close()
    print("\n服务已停止。")


if __name__ == "__main__":
    main()
