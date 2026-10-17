"""Test real RSSI collection contracts without needing a specific Wi-Fi adapter."""
import argparse
import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

SPEC = importlib.util.spec_from_file_location("nutradar_wifi", Path(__file__).resolve().parents[1] / "tools" / "wifi_source.py")
wifi = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wifi)


class MeasurementTests(unittest.TestCase):
    def test_linux_uses_dbm_fields_and_omits_identifiers(self):
        contents = """Inter-| sta-|   Quality        | Discarded packets
 face |tus | link level noise | nwid crypt frag retry misc
 wlan-private: 0000 70. -49. -96. 0 0 0 0 0
"""
        self.assertEqual(wifi.parse_linux_reading(contents), {"rssiDbm": -49, "noiseDbm": -96})

    def test_linux_unavailable_noise_omitted_and_no_quality_conversion(self):
        self.assertEqual(wifi.parse_linux_reading("wlan0: 0000 70. -56. -256. 0"), {"rssiDbm": -56})
        for contents in ["", "wlan0: 0000 70. 56. 0. 0", "wlan0: 0000 70. 0. 0. 0",
                         "wlan0: 0000 70. -256. -256. 0", "wlan0: 0000 70. nan 0 0"]:
            with self.subTest(contents=contents), self.assertRaises(wifi.WiFiError):
                wifi.parse_linux_reading(contents)

    def test_linux_skips_invalid_interfaces_until_actual_reading(self):
        contents = "first: incomplete\nsecond: 0000 30. 60. 0.\nthird: 0000 40. -70. -95."
        self.assertEqual(wifi.parse_linux_reading(contents), {"rssiDbm": -70, "noiseDbm": -95})

    def test_macos_allowlists_measured_fields(self):
        result = wifi.parse_macos_reading('{"rssiDbm":-53,"noiseDbm":-91,"ssid":"do-not-export","x":3}')
        self.assertEqual(result, {"rssiDbm": -53, "noiseDbm": -91})

    def test_macos_disconnected_sentinel_and_non_measurements_rejected(self):
        for value in [0, 1, -201, True, None, "-52", float("nan"), float("inf")]:
            with self.subTest(value=value), self.assertRaises(wifi.WiFiError):
                wifi.parse_macos_reading(json.dumps({"rssiDbm": value}))
        for output in ["[]", "not json", "null", "{}"]:
            with self.subTest(output=output), self.assertRaises(wifi.WiFiError):
                wifi.parse_macos_reading(output)

    def test_frame_is_hardware_rssi_without_positions_or_identifiers(self):
        result = wifi.frame_for({"rssiDbm": -48, "noiseDbm": -93, "ssid": "do-not-export"}, 2, 12345)
        self.assertEqual(result, {
            "version": 1, "kind": "rssi", "source": "hardware", "timestamp": 12345,
            "nodeId": "laptop-wifi", "sampleRateHz": 0.5, "rssiDbm": -48,
            "noiseDbm": -93, "tracks": [], "nodes": [],
        })

    def test_bad_signal_is_never_turned_into_a_frame(self):
        with self.assertRaises(wifi.WiFiError):
            wifi.frame_for({"rssiDbm": 0})


class ReaderTests(unittest.TestCase):
    def test_linux_reads_current_file_each_time(self):
        with patch.object(Path, "read_text", side_effect=["wlan: 0000 70. -50. -90.", "wlan: 0000 70. -59. -90."]):
            with wifi.WiFiReader("Linux") as reader:
                self.assertEqual(reader.read()["rssiDbm"], -50)
                self.assertEqual(reader.read()["rssiDbm"], -59)

    def test_missing_linux_source_is_an_error(self):
        with patch.object(Path, "read_text", side_effect=OSError("not available")):
            with wifi.WiFiReader("Linux") as reader, self.assertRaises(wifi.WiFiError):
                reader.read()

    def test_macos_compiles_once_and_cleans_temporary_build(self):
        compile_result = SimpleNamespace(returncode=0, stdout="", stderr="")
        read_result = SimpleNamespace(returncode=0, stdout='{"rssiDbm":-58}', stderr="")
        with patch.object(wifi.shutil, "which", return_value="/usr/bin/swiftc"), \
                patch.object(wifi.subprocess, "run", side_effect=[compile_result, read_result, read_result]) as run:
            with wifi.WiFiReader("Darwin") as reader:
                directory = Path(reader.temporary.name)
                self.assertTrue(directory.is_dir())
                self.assertEqual(reader.read(), {"rssiDbm": -58})
                self.assertEqual(reader.read(), {"rssiDbm": -58})
            self.assertFalse(directory.exists())
            self.assertEqual(run.call_count, 3)
            command = run.call_args_list[0].args[0]
            self.assertIn("-module-cache-path", command)
            self.assertEqual(command[0], "/usr/bin/swiftc")

    def test_missing_macos_compiler_does_not_fallback(self):
        with patch.object(wifi.shutil, "which", return_value=None), self.assertRaisesRegex(wifi.WiFiError, "Swift compiler"):
            wifi.WiFiReader("Darwin").__enter__()

    def test_macos_compile_failure_cleans_up(self):
        reader = wifi.WiFiReader("Darwin")
        with patch.object(wifi.shutil, "which", return_value="/usr/bin/swiftc"), \
                patch.object(wifi.subprocess, "run", return_value=SimpleNamespace(returncode=1)), \
                self.assertRaisesRegex(wifi.WiFiError, "compile"):
            reader.__enter__()
        self.assertIsNone(reader.temporary)
        self.assertIsNone(reader.executable)

    def test_macos_measurement_failure_and_timeout_are_clear(self):
        reader = wifi.WiFiReader("Darwin")
        reader.executable = Path("/temporary/helper")
        with patch.object(wifi.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr="Wi-Fi is off.")), \
                self.assertRaisesRegex(wifi.WiFiError, "Wi-Fi is off"):
            reader.read()
        with patch.object(wifi.subprocess, "run", side_effect=subprocess.TimeoutExpired("helper", 5)), \
                self.assertRaises(wifi.WiFiError):
            reader.read()

    def test_unsupported_platform_never_simulates_a_signal(self):
        with self.assertRaisesRegex(wifi.WiFiError, "unsupported"):
            wifi.WiFiReader("Windows").__enter__()


class DeliveryTests(unittest.TestCase):
    def test_only_local_bridge_urls_accepted(self):
        for url in [wifi.DEFAULT_URL, "http://localhost:9999/frame"]:
            self.assertEqual(wifi.local_url(url), url)
        for url in ["https://127.0.0.1:8765/frame", "http://example.test:8765/frame", "http://127.0.0.1.evil:8765/frame",
                    "http://user@127.0.0.1:8765/frame", "http://127.0.0.1/frame", "http://127.0.0.1:8765/frame?key=x",
                    "http://127.0.0.1:8765/frame#x", "http://127.0.0.1:8765/other", "http://[", "http://localhost:0/frame",
                    "http://localhost:99999/frame", "http://localhost:8765/frame\n"]:
            with self.subTest(url=url), self.assertRaises(argparse.ArgumentTypeError):
                wifi.local_url(url)

    def test_sampling_interval_has_sensible_finite_limits(self):
        for value in ["0.25", "1", "60"]:
            self.assertEqual(wifi.sample_interval(value), float(value))
        for value in ["0", "-1", "0.24", "61", "nan", "inf", "oops"]:
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                wifi.sample_interval(value)

    def test_post_delivers_json_and_requires_acceptance(self):
        opener = MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.status = 202
        frame = wifi.frame_for({"rssiDbm": -54}, timestamp=1234)
        wifi.post_frame(wifi.DEFAULT_URL, frame, opener)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(json.loads(request.data), frame)
        self.assertEqual(request.get_header("Content-type"), "application/json")
        response.status = 200
        with self.assertRaises(wifi.WiFiError):
            wifi.post_frame(wifi.DEFAULT_URL, frame, opener)

    def test_post_failure_never_falls_back_to_other_destination(self):
        frame = wifi.frame_for({"rssiDbm": -54})
        for error in [URLError("refused"), HTTPError(wifi.DEFAULT_URL, 400, "invalid", {}, None)]:
            with self.subTest(error=type(error).__name__):
                opener = MagicMock()
                opener.open.side_effect = error
                with self.assertRaises(wifi.WiFiError):
                    wifi.post_frame(wifi.DEFAULT_URL, frame, opener)
                self.assertEqual(opener.open.call_count, 1)

    def test_redirects_cannot_forward_telemetry(self):
        with self.assertRaises(wifi.WiFiError):
            wifi.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://remote.test")

    def test_once_prints_only_hardware_frame_without_posting(self):
        reader = MagicMock()
        reader.__enter__.return_value.read.return_value = {"rssiDbm": -63}
        with patch.object(wifi, "WiFiReader", return_value=reader), patch.object(wifi, "post_frame") as post, \
                patch("builtins.print") as output:
            self.assertEqual(wifi.main(["--once"]), 0)
        frame = json.loads(output.call_args.args[0])
        self.assertEqual(frame["kind"], "rssi")
        self.assertEqual(frame["rssiDbm"], -63)
        self.assertEqual(frame["tracks"], [])
        post.assert_not_called()

    def test_no_signal_cli_returns_failure_and_no_json(self):
        reader = MagicMock()
        reader.__enter__.return_value.read.side_effect = wifi.WiFiError("No measured RSSI")
        with patch.object(wifi, "WiFiReader", return_value=reader), patch("builtins.print") as output:
            self.assertEqual(wifi.main(["--once"]), 1)
        self.assertIn("No measured RSSI", output.call_args.args[0])
        self.assertIs(output.call_args.kwargs["file"], wifi.sys.stderr)


if __name__ == "__main__":
    unittest.main()
