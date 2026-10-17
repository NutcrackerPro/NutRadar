#!/usr/bin/env python3
"""Send actual laptop Wi-Fi signal measurements to the local NutRadar bridge.

macOS uses the bundled read-only CoreWLAN helper; Linux uses /proc/net/wireless.
RSSI does not provide positions or identify people. No simulated fallback exists.
"""
import argparse
import json
import math
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

DEFAULT_URL = "http://127.0.0.1:8765/frame"


class WiFiError(RuntimeError):
    """An unavailable measurement or failed delivery, never a synthetic reading."""


def measured_dbm(value, label="RSSI"):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or not -200 <= value < 0):
        raise WiFiError("{} must be a measured negative dBm value (unavailable readings are not used)".format(label))
    return value


def parse_macos_reading(output):
    """Allowlist telemetry so helper output cannot accidentally export identifiers."""
    try:
        payload = json.loads(output)
        if not isinstance(payload, dict):
            raise ValueError("not an object")
        reading = {"rssiDbm": measured_dbm(payload.get("rssiDbm"))}
        if "noiseDbm" in payload:
            reading["noiseDbm"] = measured_dbm(payload["noiseDbm"], "Noise")
        return reading
    except (ValueError, TypeError) as error:
        raise WiFiError("CoreWLAN returned an invalid measurement") from error


def parse_linux_reading(contents):
    """Read dBm fields only; link-quality values are never converted to dBm."""
    for line in contents.splitlines():
        if ":" not in line:
            continue
        fields = line.split(":", 1)[1].split()
        if len(fields) < 4:
            continue
        try:
            rssi = measured_dbm(float(fields[2].rstrip(".")))
        except (WiFiError, ValueError):
            continue
        reading = {"rssiDbm": rssi}
        try:
            reading["noiseDbm"] = measured_dbm(float(fields[3].rstrip(".")), "Noise")
        except (WiFiError, ValueError):
            pass  # Many Linux drivers expose an unavailable noise sentinel.
        return reading
    raise WiFiError("No measured Wi-Fi RSSI is available in /proc/net/wireless. Connect to Wi-Fi; this driver must expose negative dBm readings.")


class WiFiReader:
    """Prepare the platform source once, then return fresh device measurements."""
    def __init__(self, system=None):
        self.system = system or platform.system()
        self.temporary = None
        self.executable = None

    def __enter__(self):
        if self.system == "Darwin":
            compiler = shutil.which("swiftc")
            if not compiler:
                raise WiFiError("macOS needs the Swift compiler supplied by Apple's Command Line Tools or Xcode. Install it, then run NutRadar again.")
            self.temporary = tempfile.TemporaryDirectory(prefix="nutradar-wifi-")
            directory = Path(self.temporary.name)
            self.executable = directory / "wifi_rssi"
            source = Path(__file__).resolve().with_name("wifi_rssi.swift")
            try:
                result = subprocess.run(
                    [compiler, "-module-cache-path", str(directory / "module-cache"),
                     str(source), "-o", str(self.executable)],
                    capture_output=True, text=True, timeout=90, check=False)
                if result.returncode:
                    raise WiFiError("Could not compile the CoreWLAN helper. A working Apple Swift compiler and macOS SDK are required.")
            except (OSError, subprocess.TimeoutExpired) as error:
                self.close()
                raise WiFiError("Could not start the CoreWLAN helper compiler. Check the installed Apple Command Line Tools.") from error
            except Exception:
                self.close()
                raise
        elif self.system != "Linux":
            raise WiFiError("Real laptop RSSI currently supports macOS and Linux. This platform is unsupported; Wi-Fi quality percentages are not measured dBm.")
        return self

    def read(self):
        if self.system == "Linux":
            try:
                return parse_linux_reading(Path("/proc/net/wireless").read_text(encoding="utf-8"))
            except OSError as error:
                raise WiFiError("Cannot read /proc/net/wireless; this Linux system does not expose Wi-Fi RSSI there.") from error
        if self.system != "Darwin" or self.executable is None:
            raise WiFiError("The Wi-Fi measurement source has not been prepared")
        try:
            result = subprocess.run([str(self.executable)], capture_output=True, text=True, timeout=5, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise WiFiError("The CoreWLAN helper could not read the Wi-Fi measurement") from error
        if result.returncode:
            # The bundled helper emits only fixed error text, never network data.
            raise WiFiError(result.stderr.strip()[:300] or "CoreWLAN could not read the Wi-Fi measurement")
        return parse_macos_reading(result.stdout)

    def close(self):
        if self.temporary is not None:
            self.temporary.cleanup()
            self.temporary = None
        self.executable = None

    def __exit__(self, *_args):
        self.close()


def local_url(value):
    try:
        if not isinstance(value, str) or any(ord(char) <= 32 or ord(char) == 127 for char in value):
            raise ValueError("URL contains whitespace or controls")
        url = urlsplit(value)
        if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost")
                or not url.port or url.username is not None or url.password is not None
                or url.path != "/frame" or url.query or url.fragment):
            raise ValueError("not a local bridge URL")
    except ValueError as error:
        raise argparse.ArgumentTypeError("Use http://127.0.0.1:PORT/frame or http://localhost:PORT/frame") from error
    return value


def sample_interval(value):
    try:
        interval = float(value)
        if not math.isfinite(interval) or not 0.25 <= interval <= 60:
            raise ValueError("outside range")
        return interval
    except ValueError as error:
        raise argparse.ArgumentTypeError("Interval must be between 0.25 and 60 seconds") from error


def frame_for(reading, interval=1, timestamp=None):
    """RSSI has no spatial coordinates. Do not manufacture nodes or tracks."""
    frame = {
        "version": 1, "kind": "rssi", "source": "hardware",
        "timestamp": int(time.time() * 1000) if timestamp is None else timestamp,
        "nodeId": "laptop-wifi", "sampleRateHz": 1 / interval,
        "rssiDbm": measured_dbm(reading.get("rssiDbm")), "tracks": [], "nodes": [],
    }
    if "noiseDbm" in reading:
        frame["noiseDbm"] = measured_dbm(reading["noiseDbm"], "Noise")
    return frame


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise WiFiError("The local bridge redirected the request; Wi-Fi data was not forwarded")


def post_frame(url, frame, opener=None):
    local_url(url)
    # Ignore system proxy configuration and reject redirects: telemetry stays local.
    client = opener or build_opener(ProxyHandler({}), NoRedirect())
    request = Request(url, data=json.dumps(frame, allow_nan=False).encode("utf-8"),
                      headers={"Content-Type": "application/json"}, method="POST")
    try:
        with client.open(request, timeout=5) as response:
            if response.status != 202:
                raise WiFiError("The local bridge did not accept the Wi-Fi measurement (HTTP {})".format(response.status))
            response.read(4096)
    except HTTPError as error:
        raise WiFiError("The local bridge rejected the Wi-Fi measurement (HTTP {}). Update NutRadar and restart tools/bridge.py.".format(error.code)) from error
    except (URLError, OSError) as error:
        raise WiFiError("Cannot reach the local NutRadar bridge. Run python3 tools/bridge.py first.") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", type=local_url, default=DEFAULT_URL, help="Local bridge /frame URL (default: %(default)s)")
    parser.add_argument("--interval", type=sample_interval, default=1, help="Sampling interval in seconds, 0.25–60 (default: 1)")
    parser.add_argument("--once", action="store_true", help="Print one measured frame as JSON without posting to the bridge")
    args = parser.parse_args(argv)
    try:
        with WiFiReader() as reader:
            if args.once:
                print(json.dumps(frame_for(reader.read(), args.interval), allow_nan=False, sort_keys=True), flush=True)
                return 0
            opener = build_opener(ProxyHandler({}), NoRedirect())
            print("Sending actual Wi-Fi signal strength to {}. RSSI does not measure positions. Ctrl+C to stop.".format(args.url), file=sys.stderr, flush=True)
            while True:
                started = time.monotonic()
                post_frame(args.url, frame_for(reader.read(), args.interval), opener)
                time.sleep(max(0, args.interval - (time.monotonic() - started)))
    except KeyboardInterrupt:
        return 0
    except WiFiError as error:
        print("NutRadar Wi-Fi source: {}".format(error), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
