# Real hardware and the data contract

NutRadar is a free, open-source 3D viewer and signal dashboard. With only a supported laptop, its local reader can display actual Wi-Fi RSSI (received signal strength) and optional noise measurements. Those readings do not detect people or presence, measure distance, or locate anything in 3D. A phone browser cannot provide Wi-Fi RSSI or raw CSI to NutRadar.

The built-in 3D demo is simulated. The browser cannot turn an ordinary laptop's Wi-Fi connection into a through-wall 3D sensor. This repository does not include a trained CSI-to-position model, calibrated localization algorithm, or production ESP32 firmware. A single CSI/RSSI stream does not provide an unambiguous person's 3D position.

The software and public GitHub Pages hosting have no required subscription. The laptop signal reader runs locally using the computer's existing Wi-Fi interface. Advanced CSI or position inputs require separate compatible hardware and software. No paid API or cloud sensing service is required.

## Choose an input path

| Path | Works on GitHub Pages? | What is required |
| --- | --- | --- |
| Built-in simulation | Yes | A supported modern browser |
| Import a recording | Yes | A NutRadar JSON recording or NDJSON file |
| Laptop Wi-Fi signal reader | Use the localhost page | Python 3 and a supported laptop Wi-Fi interface; macOS also needs Swift |
| USB Web Serial | Yes, in supporting browsers | A user-selected serial device that emits the schema below |
| Local HTTP/SSE bridge | Open the locally served page | Python 3 and an upstream JSON producer or UDP device |

Web Serial requires a secure context and is not supported by every browser. Use a current browser that exposes navigator.serial, choose the device explicitly, and match the firmware's baud rate. Close other serial monitors before connecting. NutRadar expects one complete JSON frame per line, with a newline after each frame. Ordinary serial log lines are not sensing frames.

Existing Espressif and RuView firmware do **not** automatically emit this schema. Espressif CSI CSV, its HMS-prefixed JSON diagnostics, and RuView binary UDP packets need a deliberate adapter or firmware change. Neither connecting a board nor changing a source label implements localization.

## Use only your laptop

Start the bridge from the repository folder:

~~~sh
python3 tools/bridge.py
~~~

Keep it running. In a second terminal, start the real signal reader:

~~~sh
python3 tools/wifi_source.py
~~~

Open **http://127.0.0.1:8765** and choose **Connect sensor → Local bridge**. The reader sends RSSI about once per second, with noise when available. These frames clear spatial tracks, so a signal-only connection never creates people or position markers. Signal changes can have many causes and are not a presence detector.

- **macOS:** The reader uses Apple's CoreWLAN framework through a small Swift helper, compiled in a temporary directory at startup. Apple's Swift compiler is required; install Xcode Command Line Tools if it is missing. The laptop must be connected to Wi-Fi and the operating system must make the readings available.
- **Linux:** The reader uses `/proc/net/wireless` only when the driver exposes actual negative dBm values. Drivers that supply only a quality score, or no measurements, fail clearly instead of having their values converted into invented dBm.
- **Windows:** The included reader does not support Windows. A `netsh` signal percentage is not a measured dBm value.
- **Phone browser:** It can view the hosted dashboard and recordings, but cannot read Wi-Fi RSSI or raw CSI through this app.

Unavailable Wi-Fi, disconnections, and reader errors are reported instead of replaced with simulated measurements. Keep both processes running for a live connection. The helper never exports SSID, BSSID, or a device MAC address. GitHub Pages cannot run the reader or bridge; use the locally served dashboard for this path.

To inspect a single real frame without sending it to the bridge, run `python3 tools/wifi_source.py --once`. Use `--interval 2` to sample every two seconds; intervals from 0.25 to 60 seconds are supported. The default destination is `http://127.0.0.1:8765/frame`; an alternate `--url` must still point to a loopback `/frame` endpoint.

## Coordinate and source rules

Every frame requires version 1, kind, source, and a finite timestamp measured in milliseconds since the Unix epoch. The source field must be hardware or simulation. It describes the producer's claim; it is not hardware authentication. Imported hardware-labelled recordings remain recordings. A connected transport without fresh valid frames is not a live sensor.

Tracks use meters in a local room coordinate system: X and Z describe the floor, Y points upward, and the origin is defined by the upstream system. The displayed avatar's feet sit at the reported x/y/z position, so use y = 0 for a target standing on the reference floor. If your estimator reports a torso center, convert it to a foot/base position before displaying an avatar. The avatar's body shape and pose are illustrative, not measured. Sensor nodes use their physical mounting position. NutRadar bounds coordinates to ±100 meters. The viewer's room range is a display setting; changing it does not calibrate the sensor or improve physical sensing distance.

IDs are cleaned and limited to 80 characters. There are at most 64 tracks and 64 sensor nodes per frame. Optional telemetry includes rssiDbm (-200 to 50), channel (integer 1–233), fps (0.001–10,000), and sampleRateHz (0.001–1,000,000). These broad input limits do not imply a board supports every channel or rate. A supplied confidence must be between 0 and 1 and comes from the producer; it is not a measured NutRadar accuracy score. Omitted or null confidence means unknown and stays null after validation, rather than becoming a perfect score.

### Laptop RSSI telemetry

An `rssi` packet contains signal strength and optional noise from an actual interface reading. The local reader emits this format; `noiseDbm` is omitted when unavailable. No CSI samples or target positions are inferred from RSSI.

~~~json
{
  "version": 1,
  "kind": "rssi",
  "source": "hardware",
  "timestamp": 1792233600000,
  "nodeId": "laptop-wifi",
  "rssiDbm": -52,
  "noiseDbm": -94,
  "sampleRateHz": 1,
  "tracks": [],
  "nodes": []
}
~~~

The sample timestamp is illustrative; the reader supplies the current capture time. RSSI is measured in dBm and is not a calibrated distance estimate. Noise is a separate optional measurement, not a reconstructed CSI waveform.

### Already localized tracks

A tracks packet means your upstream system has already estimated coordinates. NutRadar displays those external estimates; it does not derive them from the sample below.

~~~json
{
  "version": 1,
  "kind": "tracks",
  "source": "hardware",
  "timestamp": 1792233600000,
  "coordinateSystem": "room-meters-y-up",
  "tracks": [
    { "id": "target-1", "x": 1.2, "y": 0, "z": -2.1, "confidence": 0.84 }
  ],
  "nodes": [
    { "id": "receiver-1", "x": -3, "y": 1, "z": -3, "rssiDbm": -54, "channel": 6 }
  ],
  "fps": 20
}
~~~

Nodes are optional; a telemetry-only node can omit all three coordinates. If any node coordinate is supplied, all three are required. Nodes are receiver locations supplied by your setup, not automatically discovered routers.

### Raw CSI telemetry

A csi packet provides signed imaginary/real byte pairs. The array must contain an even number of values, between 2 and 4096; every value must be an integer in -128 through 127. This order follows Espressif's documented CSI output.

~~~json
{
  "version": 1,
  "kind": "csi",
  "source": "hardware",
  "timestamp": 1792233600000,
  "nodeId": "esp32-1",
  "rssiDbm": -54,
  "channel": 6,
  "sampleRateHz": 100,
  "iqOrder": "imaginary-real",
  "firstWordInvalid": false,
  "iq": [3, 4, 0, 10, -2, 7, 4, 8]
}
~~~

NutRadar computes subcarrier amplitude as sqrt(imaginary² + real²). Its normalized variation value is the amplitude standard deviation divided by mean amplitude, capped at 1. This is cross-subcarrier signal spread, not temporal motion detection, presence probability, distance, or a medical measurement. When firstWordInvalid is true, the first four bytes are preserved in the raw packet but omitted from amplitude calculations. CSI frames always clear spatial tracks; raw signals never generate invented people.

## Run the local bridge

From the repository folder:

~~~sh
python3 tools/bridge.py
~~~

Open http://127.0.0.1:8765 and connect the local bridge input in NutRadar. The bridge serves this same static app, receives validated frames at POST /frame, and streams them from GET /events using Server-Sent Events. It also accepts one complete JSON frame per UDP datagram at 127.0.0.1:5500. It uses only Python's standard library and requires no serial package.

For example, save one valid frame as frame.json, then send it from your local producer:

~~~sh
curl -X POST http://127.0.0.1:8765/frame \
  -H 'Content-Type: application/json' \
  --data-binary @frame.json
~~~

A timestamp in an old example is not a fresh live reading. Replace it with the capture time when producing actual data, and send a continuous stream for a live display. The browser clears targets when it has received no valid frame for three seconds; this timeout measures arrival time, not the truth of a producer's clock or hardware claim. The bridge does not authenticate a producer, estimate capture latency, or prove that a hardware-labelled packet came from a sensor.

If a device needs to send from the LAN, bind the UDP listener to your computer's actual LAN address:

~~~sh
python3 tools/bridge.py --http-port 8765 --udp-port 5500 --udp-host 192.168.1.20
~~~

Replace the example address with your own. Configure your device to send NutRadar JSON to that address and port. The browser/HTTP listener remains bound to 127.0.0.1. LAN UDP is unauthenticated; use a trusted network and restrict senders with your firewall. Do not expose the bridge as a public server. UDP cannot guarantee delivery or ordering.

The bridge limits POST bodies to 1 MB, validates frames before broadcasting, bounds browser queues, and blocks static-file traversal. Browser-origin POST requests must come from localhost or 127.0.0.1 on the bridge's port. Remote CORS writes are not enabled. Read-only stream connections do not certify sensor accuracy or identity.

GitHub Pages cannot execute this Python service. Open the localhost page for this bridge path; do not depend on an HTTPS Pages site connecting to insecure LAN services. Browser mixed-content and local-network permissions vary. Web Serial remains the direct hardware path on compatible hosted browsers.

## Recording files

The viewer accepts this envelope or one valid frame per line (NDJSON):

~~~json
{
  "format": "nutradar-recording",
  "version": 1,
  "frames": [
    {
      "version": 1,
      "kind": "tracks",
      "source": "simulation",
      "timestamp": 1792233600000,
      "tracks": [{ "id": "demo-1", "x": 1, "y": 0, "z": 2 }]
    }
  ]
}
~~~

Limits are 18,000 frames and 20 MB of UTF-8 input. Every frame is validated. Frames must already be in chronological timestamp order; equal timestamps are allowed, and decreasing timestamps are rejected. Uploading raw ESP32 CSV or a RuView recording without adapting its format is not supported. Do not upload private room recordings to a public repository unless you intend to publish them.

## A practical ESP32 starting point

1. Use Espressif's official ESP-CSI examples with supported boards to obtain real channel measurements. Their receiver/router example can work with one receiver and a router; the sender/receiver example uses two boards. Acquisition quality depends on the radio, placement, environment, and configuration.
2. Preserve the CSI imaginary/real byte order and metadata, including invalid-byte flags. Map the result into the NutRadar csi schema and send newline-delimited JSON over USB serial, or one JSON UDP datagram per frame to the bridge. Keep the producer rate within the transport's capacity.
3. Verify signal plots against a stationary baseline and known changes. No person count or position is inferred by this viewer.
4. For 3D tracks, separately develop or connect a validated localization system using calibrated sensor geometry and suitable measurements. Emit tracks packets with its actual confidence estimates and coordinate reference.

## Official references

- [GitHub Pages is static hosting and is available for public repositories with GitHub Free](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
- [Network Information API specification](https://wicg.github.io/netinfo/) exposes connection characteristics, not raw CSI.
- [Web Serial API requirements and compatibility](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API).
- [Espressif ESP-CSI examples](https://github.com/espressif/esp-csi/tree/master/examples).
- [Espressif CSI data format](https://github.com/espressif/esp-csi/blob/master/examples/get-started/README.md).
- [Espressif's sensing demo and Web Serial diagnostics](https://github.com/espressif/esp-csi/tree/master/examples/esp-radar/wifi_sensing_demo).
- [RuView](https://github.com/ruvnet/RuView), the inspiration for the Wi-Fi sensing workflow. NutRadar is an independent implementation and makes no claim to reproduce its pose estimation or advanced sensing capabilities.
