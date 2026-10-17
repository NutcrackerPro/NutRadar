#!/usr/bin/env python3
"""NutRadar local-only HTTP/SSE bridge. Uses the Python standard library only."""
import argparse
import json
import math
import mimetypes
import queue
import re
import signal
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

MAX_BODY = 1024 * 1024
MAX_ITEMS = 64
MAX_QUEUE = 32
COORDINATE_SYSTEM = "room-meters-y-up"


def _number(value, label, minimum, maximum, integer=False):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not minimum <= value <= maximum or not math.isfinite(value)
            or (integer and int(value) != value)):
        raise ValueError("{} must be {} between {} and {}".format(
            label, "an integer" if integer else "a finite number", minimum, maximum))
    return value


def _text(value, label):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError(label + " must be text")
    if isinstance(value, (int, float)) and (not -1.7976931348623157e308 <= value <= 1.7976931348623157e308 or not math.isfinite(value)):
        raise ValueError(label + " must be text")
    cleaned = re.sub(r"[\x00-\x1f\x7f-\x9f<>]", "", str(value)).strip()[:80]
    if not cleaned:
        raise ValueError(label + " must contain visible text")
    return cleaned


def _list(value, label):
    if not isinstance(value, list) or len(value) > MAX_ITEMS:
        raise ValueError(label + " must be an array of at most 64 items")
    return value


def _telemetry(source, target, label):
    for key, minimum, maximum, integer in [
        ("rssiDbm", -200, 50, False), ("noiseDbm", -200, 50, False), ("channel", 1, 233, True),
        ("fps", 0.001, 10000, False), ("sampleRateHz", 0.001, 1000000, False),
    ]:
        if key in source:
            target[key] = _number(source[key], label + "." + key, minimum, maximum, integer)


def _position(source, target, label, required=True):
    if not required and not any(key in source for key in ("x", "y", "z")):
        return
    for key in ("x", "y", "z"):
        target[key] = _number(source.get(key), label + "." + key, -100, 100)


def validate_frame(frame):
    """Return a fresh validated frame; never infer spatial tracks from raw signal levels."""
    if not isinstance(frame, dict):
        raise ValueError("Frame must be an object")
    if isinstance(frame.get("version"), bool) or frame.get("version") != 1:
        raise ValueError("Frame.version must be 1")
    if frame.get("kind") not in ("tracks", "csi", "rssi"):
        raise ValueError("Frame.kind must be tracks, csi, or rssi")
    if frame.get("source") not in ("hardware", "simulation"):
        raise ValueError("Frame.source must be hardware or simulation")
    if frame.get("coordinateSystem", COORDINATE_SYSTEM) != COORDINATE_SYSTEM:
        raise ValueError("Coordinates must use room-meters-y-up")
    result = {
        "version": 1, "kind": frame["kind"], "source": frame["source"],
        "timestamp": _number(frame.get("timestamp"), "Frame.timestamp (epoch milliseconds)", 0, 8640000000000000),
        "coordinateSystem": COORDINATE_SYSTEM, "tracks": [], "nodes": [],
        "amplitudes": [], "variation": 0,
    }
    _telemetry(frame, result, "Frame")
    if frame["kind"] == "rssi":
        result["rssiDbm"] = _number(frame.get("rssiDbm"), "Frame.rssiDbm", -200, 50)
    if "nodeId" in frame:
        result["nodeId"] = _text(frame["nodeId"], "Frame.nodeId")
    tracks = []
    for index, item in enumerate(_list(frame.get("tracks", []), "Frame.tracks")):
        label = "Track {}".format(index + 1)
        if not isinstance(item, dict):
            raise ValueError(label + " must be an object")
        track = {"id": _text(item.get("id"), label + ".id")}
        _position(item, track, label)
        confidence = item.get("confidence")
        track["confidence"] = None if confidence is None else _number(confidence, label + ".confidence", 0, 1)
        if "label" in item:
            track["label"] = _text(item["label"], label + ".label")
        tracks.append(track)
    if len({track["id"] for track in tracks}) != len(tracks):
        raise ValueError("Track IDs must be unique after sanitization")
    if frame["kind"] == "tracks":
        result["tracks"] = tracks
    for index, item in enumerate(_list(frame.get("nodes", []), "Frame.nodes")):
        label = "Node {}".format(index + 1)
        if not isinstance(item, dict):
            raise ValueError(label + " must be an object")
        node = {"id": _text(item.get("id"), label + ".id")}
        _position(item, node, label, required=False)
        _telemetry(item, node, label)
        if "label" in item:
            node["label"] = _text(item["label"], label + ".label")
        result["nodes"].append(node)
    if len({node["id"] for node in result["nodes"]}) != len(result["nodes"]):
        raise ValueError("Node IDs must be unique after sanitization")
    if frame["kind"] == "csi":
        iq = frame.get("iq")
        if not isinstance(iq, list) or not 2 <= len(iq) <= 4096 or len(iq) % 2:
            raise ValueError("CSI iq must contain an even number of signed bytes, between 2 and 4096")
        if frame.get("iqOrder", "imaginary-real") != "imaginary-real":
            raise ValueError("CSI iqOrder must be imaginary-real")
        if "firstWordInvalid" in frame and not isinstance(frame["firstWordInvalid"], bool):
            raise ValueError("CSI firstWordInvalid must be boolean")
        result["iq"] = [_number(value, "CSI iq[{}]".format(index), -128, 127, True)
                        for index, value in enumerate(iq)]
        result["iqOrder"] = "imaginary-real"
        result["firstWordInvalid"] = frame.get("firstWordInvalid", False)
        start = 4 if result["firstWordInvalid"] else 0
        amplitudes = [math.hypot(iq[index], iq[index + 1]) for index in range(start, len(iq), 2)]
        result["amplitudes"] = amplitudes
        if amplitudes:
            mean = sum(amplitudes) / len(amplitudes)
            variance = sum((value - mean) ** 2 for value in amplitudes) / len(amplitudes)
            result["variation"] = min(1, math.sqrt(variance) / (mean + 1e-9))
    return result


class FrameHub:
    """Bounded per-browser queues; slow viewers cannot grow memory indefinitely."""
    def __init__(self):
        self.lock = threading.Lock()
        self.clients = set()
        self.closed = False

    def subscribe(self):
        with self.lock:
            if self.closed:
                raise RuntimeError("Bridge is shutting down")
            if len(self.clients) >= 16:
                raise RuntimeError("Too many browser streams (maximum 16)")
            client = queue.Queue(maxsize=MAX_QUEUE)
            self.clients.add(client)
            return client

    def unsubscribe(self, client):
        with self.lock:
            self.clients.discard(client)

    def publish(self, frame):
        payload = json.dumps(frame, separators=(",", ":"), allow_nan=False)
        with self.lock:
            if self.closed:
                return
            for client in self.clients:
                if client.full():
                    try:
                        client.get_nowait()
                    except queue.Empty:
                        pass
                client.put_nowait(payload)

    def close(self):
        with self.lock:
            self.closed = True
            for client in self.clients:
                if client.full():
                    client.get_nowait()
                client.put_nowait(None)


class NutRadarServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address=("127.0.0.1", 8765), root=None, hub=None):
        self.root = Path(root or Path(__file__).resolve().parent.parent).resolve()
        self.hub = hub or FrameHub()
        super().__init__(address, BridgeHandler)

    def server_close(self):
        self.hub.close()
        super().server_close()


class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "NutRadar/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, message, *args):
        # Never log uploaded payloads or device identifiers.
        if args and isinstance(args[0], str) and args[0].startswith("GET /events"):
            return
        super().log_message(message, *args)

    def _json(self, status, body):
        payload = json.dumps(body, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)

    def _local_authority(self, authority):
        try:
            parsed = urlsplit("http://" + authority)
            return (parsed.hostname in ("localhost", "127.0.0.1")
                    and parsed.port == self.server.server_port
                    and not parsed.username and not parsed.password
                    and not parsed.path and not parsed.query and not parsed.fragment)
        except ValueError:
            return False

    def _host_allowed(self):
        if not self._local_authority(self.headers.get("Host", "")):
            self._json(403, {"error": "Use the bridge through localhost or 127.0.0.1 at its configured port"})
            return False
        return True

    def do_GET(self):
        if not self._host_allowed():
            return
        path = urlsplit(self.path).path
        if path == "/events":
            self._events()
            return
        if path == "/health":
            self._json(200, {"status": "ok", "version": 1})
            return
        self._static(path)

    def _static(self, raw_path):
        try:
            decoded = unquote(raw_path, errors="strict")
            parts = decoded.split("/")
            if "\\" in decoded or "\x00" in decoded or any(part == ".." or part.startswith(".") for part in parts if part):
                raise ValueError("Unsafe path")
            target = (self.server.root / decoded.lstrip("/")).resolve()
            target.relative_to(self.server.root)
            if target.is_dir():
                target = (target / "index.html").resolve()
                target.relative_to(self.server.root)
            if not target.is_file():
                self._json(404, {"error": "File not found"})
                return
            payload = target.read_bytes()
        except (ValueError, UnicodeError):
            self._json(403, {"error": "Path is outside the static root"})
            return
        except OSError:
            self._json(404, {"error": "File not found"})
            return
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)

    def _events(self):
        try:
            client = self.server.hub.subscribe()
        except RuntimeError as error:
            self._json(503, {"error": str(error)})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(b'event: ready\ndata: {"status":"ready"}\n\n')
            self.wfile.flush()
            while True:
                try:
                    payload = client.get(timeout=5)
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                else:
                    if payload is None:
                        break
                    self.wfile.write(("data: " + payload + "\n\n").encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass
        finally:
            self.server.hub.unsubscribe(client)

    def do_POST(self):
        # Close mutation connections so rejected/unread bodies cannot become a second request.
        self.close_connection = True
        if not self._host_allowed():
            return
        if urlsplit(self.path).path != "/frame":
            self._json(404, {"error": "Use POST /frame"})
            return
        origin = self.headers.get("Origin")
        if origin is not None:
            try:
                parsed = urlsplit(origin)
                allowed_origin = (parsed.scheme == "http" and not parsed.path
                                  and not parsed.query and not parsed.fragment
                                  and self._local_authority(parsed.netloc))
            except ValueError:
                allowed_origin = False
            if not allowed_origin:
                self._json(403, {"error": "Only the local NutRadar origin may submit frames"})
                return
        if self.headers.get("Transfer-Encoding"):
            self._json(400, {"error": "Use Content-Length, not Transfer-Encoding"})
            return
        try:
            length = int(self.headers["Content-Length"])
        except (TypeError, ValueError):
            self._json(411, {"error": "A valid Content-Length is required"})
            return
        if not 0 < length <= MAX_BODY:
            self._json(413, {"error": "Frame body must be between 1 byte and 1 MB"})
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            self._json(415, {"error": "Use Content-Type: application/json"})
            return
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("Incomplete request body")
            frame = validate_frame(json.loads(body.decode("utf-8")))
        except (ValueError, UnicodeError, RecursionError, TimeoutError, OSError) as error:
            self._json(400, {"error": "Invalid frame: " + str(error)[:250]})
            return
        self.server.hub.publish(frame)
        self._json(202, {"accepted": True, "kind": frame["kind"], "source": frame["source"]})

    def do_OPTIONS(self):
        self._json(405, {"error": "Cross-origin writes are not supported"})


class UDPReceiver:
    def __init__(self, hub, host="127.0.0.1", port=5500):
        self.hub = hub
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            self.socket.bind((host, port))
        except OSError:
            self.socket.close()
            raise
        self.socket.settimeout(0.5)
        self.address = self.socket.getsockname()
        self.stopped = threading.Event()
        self.accepted = 0
        self.rejected = 0
        self.thread = threading.Thread(target=self._run, name="nutradar-udp", daemon=True)

    def start(self):
        self.thread.start()

    def _run(self):
        while not self.stopped.is_set():
            try:
                payload, _address = self.socket.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                frame = validate_frame(json.loads(payload.decode("utf-8")))
                self.hub.publish(frame)
                self.accepted += 1
            except (ValueError, UnicodeError, RecursionError):
                self.rejected += 1

    def stop(self):
        self.stopped.set()
        self.socket.close()
        if self.thread.is_alive():
            self.thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--http-port", type=int, default=8765, help="Local UI/SSE port (default: 8765)")
    parser.add_argument("--udp-port", type=int, default=5500, help="UDP JSON ingest port (default: 5500)")
    parser.add_argument("--udp-host", default="127.0.0.1", help="UDP bind address; use your LAN IP for an ESP32")
    args = parser.parse_args()
    server = NutRadarServer(("127.0.0.1", args.http_port))
    receiver = None
    try:
        receiver = UDPReceiver(server.hub, args.udp_host, args.udp_port)
        receiver.start()
        signal.signal(signal.SIGTERM, lambda *_args: (_ for _ in ()).throw(KeyboardInterrupt()))
        print("NutRadar: http://127.0.0.1:{}".format(server.server_port), flush=True)
        print("UDP JSON: {}:{}".format(*receiver.address), flush=True)
        if args.udp_host not in ("127.0.0.1", "localhost"):
            print("LAN UDP is unauthenticated. Use only a trusted network; restrict senders in your firewall.", flush=True)
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.hub.close()
        if receiver is not None:
            receiver.stop()
        server.server_close()


if __name__ == "__main__":
    main()
