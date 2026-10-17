"""Run with: python3 -m unittest discover -s tests -p 'test_bridge.py' -v"""
import copy
import http.client
import importlib.util
import json
import math
import queue
import socket
import tempfile
import threading
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("nutradar_bridge", Path(__file__).resolve().parents[1] / "tools" / "bridge.py")
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


def track_frame():
    return {"version": 1, "kind": "tracks", "source": "hardware", "timestamp": 1792233600000,
            "tracks": [{"id": "target-1", "x": 1, "y": 0.9, "z": -2, "confidence": 0.8}]}


class ValidationTests(unittest.TestCase):
    def test_valid_frame_copied_sanitized_and_y_up(self):
        original = track_frame()
        original["tracks"][0]["id"] = "  <target>\x00-1  "
        before = copy.deepcopy(original)
        frame = bridge.validate_frame(original)
        self.assertEqual(frame["tracks"][0]["id"], "target-1")
        self.assertEqual(frame["coordinateSystem"], "room-meters-y-up")
        self.assertEqual(original, before)
        self.assertIsNot(frame["tracks"], original["tracks"])

    def test_csi_has_no_fabricated_tracks_and_calculates_amplitudes(self):
        frame = track_frame()
        frame.update(kind="csi", iq=[3, 4, 0, 0], iqOrder="imaginary-real")
        validated = bridge.validate_frame(frame)
        self.assertEqual(validated["tracks"], [])
        self.assertEqual(validated["amplitudes"], [5, 0])
        self.assertAlmostEqual(validated["variation"], 1, places=8)

    def test_rssi_preserves_levels_nodes_and_never_fabricates_positions_or_csi(self):
        frame = track_frame()
        frame.update(kind="rssi", rssiDbm=-54, noiseDbm=-92, nodeId="<laptop>", sampleRateHz=1,
                     nodes=[{"id": "laptop", "rssiDbm": -54, "noiseDbm": -92},
                            {"id": "fixed", "x": 1, "y": 2, "z": 3}],
                     iq=[3, 4], amplitudes=[5], variation=1)
        before = copy.deepcopy(frame)
        validated = bridge.validate_frame(frame)
        self.assertEqual(validated["kind"], "rssi")
        self.assertEqual(validated["source"], "hardware")
        self.assertEqual(validated["rssiDbm"], -54)
        self.assertEqual(validated["noiseDbm"], -92)
        self.assertEqual(validated["nodeId"], "laptop")
        self.assertEqual(validated["sampleRateHz"], 1)
        self.assertEqual(validated["tracks"], [])
        self.assertEqual(validated["amplitudes"], [])
        self.assertEqual(validated["variation"], 0)
        self.assertNotIn("iq", validated)
        self.assertEqual(validated["nodes"], frame["nodes"])
        self.assertEqual(frame, before)
        self.assertEqual(bridge.validate_frame(json.loads(json.dumps(validated))), validated)
        frame["source"] = "simulation"
        self.assertEqual(bridge.validate_frame(frame)["source"], "simulation")

    def test_rssi_requires_finite_rssi_and_constrains_optional_noise(self):
        frame = track_frame()
        frame["kind"] = "rssi"
        with self.assertRaisesRegex(ValueError, "rssiDbm"):
            bridge.validate_frame(frame)
        for invalid in [None, float("nan"), float("inf"), -float("inf"), True, "-54", -200.01, 50.01]:
            with self.subTest(invalid=invalid):
                frame["rssiDbm"] = invalid
                with self.assertRaisesRegex(ValueError, "rssiDbm"):
                    bridge.validate_frame(frame)
                frame["rssiDbm"] = -54
                frame["noiseDbm"] = invalid
                with self.assertRaisesRegex(ValueError, "noiseDbm"):
                    bridge.validate_frame(frame)
                del frame["noiseDbm"]
                frame["nodes"] = [{"id": "laptop", "noiseDbm": invalid}]
                with self.assertRaisesRegex(ValueError, "noiseDbm"):
                    bridge.validate_frame(frame)
                del frame["nodes"]
        for rssi, noise in [(-200, 50), (50, -200)]:
            frame.update(rssiDbm=rssi, noiseDbm=noise)
            validated = bridge.validate_frame(frame)
            self.assertEqual((validated["rssiDbm"], validated["noiseDbm"]), (rssi, noise))
        del frame["noiseDbm"]
        self.assertNotIn("noiseDbm", bridge.validate_frame(frame))

    def test_invalid_initial_bytes_omitted_from_amplitudes(self):
        frame = track_frame()
        frame.update(kind="csi", iq=[127, 127, 127, 127, 3, 4], firstWordInvalid=True)
        self.assertEqual(bridge.validate_frame(frame)["amplitudes"], [5])

    def test_bad_coordinates_source_timestamp_and_limits_rejected(self):
        for bad in [
            {"timestamp": float("nan")}, {"timestamp": True}, {"timestamp": -1},
            {"source": "live"}, {"source": "esp32"}, {"coordinateSystem": "z-up"},
            {"nodes": [{"id": "node", "x": 0}]},
            {"tracks": [{"id": "x", "x": 101, "y": 0, "z": 0}]},
            {"tracks": [{"id": "x", "x": float("inf"), "y": 0, "z": 0}]},
            {"tracks": [{"id": "x", "x": 0, "y": 0, "z": 0, "confidence": 2}]},
            {"tracks": track_frame()["tracks"] * 65},
            {"nodes": [{"id": str(i)} for i in range(65)]},
        ]:
            with self.subTest(bad=bad):
                frame = track_frame()
                frame.update(bad)
                with self.assertRaises(ValueError):
                    bridge.validate_frame(frame)

    def test_duplicate_sanitized_ids_rejected(self):
        frame = track_frame()
        frame["tracks"].append({"id": "<target-1>", "x": 0, "y": 0, "z": 0})
        with self.assertRaisesRegex(ValueError, "unique"):
            bridge.validate_frame(frame)

    def test_missing_confidence_stays_unknown_and_survives_round_trip(self):
        frame = track_frame()
        del frame["tracks"][0]["confidence"]
        validated = bridge.validate_frame(frame)
        self.assertIsNone(validated["tracks"][0]["confidence"])
        self.assertIsNone(bridge.validate_frame(validated)["tracks"][0]["confidence"])
        frame["tracks"][0]["confidence"] = 0.9
        self.assertEqual(bridge.validate_frame(frame)["tracks"][0]["confidence"], 0.9)

    def test_iq_constraints(self):
        for iq in [[], [1], [1, 2, 3], [128, 0], [-129, 0], [True, 0], [0.1, 0], [0, 0] * 2049]:
            with self.subTest(iq_length=len(iq)):
                frame = track_frame()
                frame.update(kind="csi", iq=iq)
                with self.assertRaises(ValueError):
                    bridge.validate_frame(frame)


class HubTests(unittest.TestCase):
    def test_slow_viewer_queue_is_bounded_and_retains_latest(self):
        hub = bridge.FrameHub()
        client = hub.subscribe()
        for i in range(100):
            frame = track_frame()
            frame["timestamp"] += i
            hub.publish(frame)
        self.assertEqual(client.qsize(), bridge.MAX_QUEUE)
        messages = [json.loads(client.get_nowait()) for _ in range(client.qsize())]
        self.assertEqual(messages[-1]["timestamp"], 1792233600099)
        hub.close()
        self.assertIsNone(client.get_nowait())
        with self.assertRaises(RuntimeError):
            hub.subscribe()


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "public"
        self.root.mkdir()
        (self.root / "index.html").write_text("<title>NutRadar test</title>")
        (Path(self.temporary.name) / "secret.txt").write_text("secret")
        (self.root / "escape.txt").symlink_to(Path(self.temporary.name) / "secret.txt")
        self.server = bridge.NutRadarServer(("127.0.0.1", 0), self.root)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.hub.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        status, data, response_headers = response.status, response.read(), dict(response.getheaders())
        connection.close()
        return status, data, response_headers

    def post(self, frame=None, origin=None, **headers):
        headers["Content-Type"] = "application/json"
        if origin is not None:
            headers["Origin"] = origin
        return self.request("POST", "/frame", json.dumps(frame if frame is not None else track_frame()), headers)

    def test_static_site_health_and_missing_file(self):
        status, body, headers = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"NutRadar test", body)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.request("GET", "/not-here")[0], 404)
        self.assertEqual(json.loads(self.request("GET", "/health")[1])["status"], "ok")

    def test_traversal_and_symlink_escape_rejected(self):
        for path in ["/../secret.txt", "/%2e%2e/secret.txt", "/escape.txt", "/.git/config", "/%5c..%5csecret.txt"]:
            with self.subTest(path=path):
                status, body, _ = self.request("GET", path)
                self.assertEqual(status, 403)
                self.assertNotIn(b'"secret"', body)

    def test_local_post_accepted_remote_origin_and_rebinding_rejected(self):
        self.assertEqual(self.post()[0], 202)
        self.assertEqual(self.post(origin="http://localhost:{}".format(self.port))[0], 202)
        for origin in ["https://evil.test", "null", "http://[", "http://localhost:1", "http://127.0.0.1.evil.test:{}".format(self.port),
                       "http://localhost:{}@evil.test".format(self.port)]:
            with self.subTest(origin=origin):
                self.assertEqual(self.post(origin=origin)[0], 403)
        self.assertEqual(self.request("GET", "/health", headers={"Host": "evil.test:{}".format(self.port)})[0], 403)
        self.assertEqual(self.request("OPTIONS", "/frame")[0], 405)

    def test_bad_frames_content_type_and_large_body_rejected(self):
        frame = track_frame()
        frame["source"] = "verified-hardware"
        self.assertEqual(self.post(frame)[0], 400)
        self.assertEqual(self.request("POST", "/frame", "not json", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/frame", "{}", {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/frame", "", {"Content-Type": "application/json", "Content-Length": str(bridge.MAX_BODY + 1)})[0], 413)
        self.assertEqual(self.request("POST", "/unknown", "{}")[0], 404)

    def test_sse_stream_gets_validated_frame(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("GET", "/events")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
        self.assertEqual(response.readline(), b"event: ready\n")
        self.assertIn(b'"ready"', response.readline())
        self.assertEqual(response.readline(), b"\n")
        self.assertEqual(self.post()[0], 202)
        line = response.readline().decode()
        self.assertTrue(line.startswith("data: "))
        frame = json.loads(line[6:])
        self.assertEqual(frame["coordinateSystem"], "room-meters-y-up")
        self.assertEqual(frame["tracks"][0]["id"], "target-1")
        self.assertEqual(response.readline(), b"\n")
        rssi = track_frame()
        rssi.update(kind="rssi", rssiDbm=-54, noiseDbm=-92)
        self.assertEqual(self.post(rssi)[0], 202)
        measured = json.loads(response.readline().decode()[6:])
        self.assertEqual(measured["kind"], "rssi")
        self.assertEqual(measured["rssiDbm"], -54)
        self.assertEqual(measured["noiseDbm"], -92)
        self.assertEqual(measured["tracks"], [])
        self.assertEqual(measured["amplitudes"], [])
        self.assertNotIn("iq", measured)
        self.server.hub.close()
        response.close()
        connection.close()


class UDPTests(unittest.TestCase):
    def test_udp_json_ingest_uses_same_validation(self):
        hub = bridge.FrameHub()
        client = hub.subscribe()
        receiver = bridge.UDPReceiver(hub, "127.0.0.1", 0)
        receiver.start()
        sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sender.sendto(b'{"bad":"packet"}', receiver.address)
            sender.sendto(json.dumps(track_frame()).encode(), receiver.address)
            frame = json.loads(client.get(timeout=3))
            self.assertEqual(frame["source"], "hardware")
            self.assertEqual(frame["tracks"][0]["x"], 1)
            self.assertEqual(receiver.accepted, 1)
            self.assertEqual(receiver.rejected, 1)
        finally:
            sender.close()
            receiver.stop()
            hub.close()
        self.assertFalse(receiver.thread.is_alive())


if __name__ == "__main__":
    unittest.main()
