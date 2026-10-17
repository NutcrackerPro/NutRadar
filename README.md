# NutRadar

A free, open-source **3D Wi-Fi visualization and live signal dashboard** that runs in your browser and publishes directly to GitHub Pages.

NutRadar combines an interactive room view, radar sweeps, point clouds, signal charts, recording, and live data connections. It runs as a static website: no paid API, cloud server, account, build step, or runtime CDN is required.

**With just a laptop, NutRadar can display real Wi-Fi signal strength.** The included local reader sends the current Wi-Fi connection's RSSI, plus noise when the operating system supplies it. This does not measure people, presence, distance, or 3D positions. A phone browser cannot supply Wi-Fi RSSI or raw CSI to this app.

**The 3D demo is simulated.** An ordinary laptop or phone cannot become a 3D Wi-Fi scanner through a website. Real 3D positions must come from an external estimation pipeline with compatible hardware. Raw channel state information (CSI) can be displayed as signal amplitude and variation; connecting it does not produce localized people.

## What you can do

- Explore **Room occupancy**, **Single target**, and **Empty room** scenarios with simulated tracks and point clouds.
- Orbit, zoom, and change the 3D view; toggle the radar sweep, spatial grid, motion trails, and density field.
- Inspect a live signal display alongside the room view.
- Read actual laptop Wi-Fi signal strength through the included local reader on supported systems; signal-only input clears all target positions.
- Record and export JSON sessions; import and replay JSON recordings or newline-delimited JSON locally in your browser.
- Connect compatible newline-delimited JSON firmware over Web Serial.
- Stream data through an EventSource connection to the included local bridge.

Your recordings stay in the browser until you export them. NutRadar does not upload sensing data to a service.

## Run it locally

### Read your laptop's real Wi-Fi signal

From the repository folder, start the bridge in one terminal:

```sh
python3 tools/bridge.py
```

In a second terminal, start the signal reader:

```sh
python3 tools/wifi_source.py
```

Open **http://127.0.0.1:8765**, choose **Connect sensor → Local bridge**, and inspect the live signal readings. Keep both terminals running and connect the laptop to Wi-Fi. The reader sends measurements about once per second and reports unavailable or disconnected Wi-Fi instead of generating substitute data. It does not export your network name, access point address, or device MAC address.

macOS uses CoreWLAN and needs Apple's Swift compiler, supplied by Xcode Command Line Tools. Linux reads `/proc/net/wireless` when the Wi-Fi driver exposes measurements in negative dBm. Windows is not supported by the included reader. See [the hardware and data guide](docs/HARDWARE.md) for platform details and the limits of these readings.

### Open the standalone website

Use Python 3 from the repository folder:

```sh
python3 -m http.server 8080
```

Open **http://localhost:8080** in a browser with WebGL support. The site uses JavaScript modules, so serve it over HTTP instead of opening `index.html` as a file. With Node.js installed, `npm run serve` is a shortcut for the same command. No `npm install` is needed.

## Publish on GitHub Pages

1. Put this project in a public GitHub repository named **NutRadar**.
2. Keep the main branch named **main**, or update the deployment workflow's branch setting.
3. Open the repository's **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Push to `main`, or run **Deploy GitHub Pages** from the **Actions** tab.
5. Open the deployment URL shown in the workflow. For `NutcrackerPro/NutRadar`, it will normally be **https://nutcrackerpro.github.io/NutRadar/**.

The workflow publishes only the website files and vendored assets. Python tools, tests, and repository metadata are excluded. All frontend paths work under the `/NutRadar/` project path.

The software is free under the MIT License. Public GitHub Pages hosting can be used without a paid hosting service. Pages hosts the dashboard, demo, and recording viewer; the laptop signal reader and bridge run on your own computer. Open the localhost page for live laptop measurements. No extra sensing hardware is needed for supported laptop signal readings; 3D localization requires a separate sensing system.

## Connect real data

See [the hardware and data guide](docs/HARDWARE.md) for the supported frame format, compatible connection paths, and local bridge setup.

Choose the connection that matches your source:

| Source | What NutRadar displays |
| --- | --- |
| Built-in demo | Synthetic targets and synthetic signals, labeled as a demo |
| Local laptop Wi-Fi reader | Actual RSSI and optional noise; no targets, presence, distance, or localization |
| JSON session | Recorded frames replayed locally |
| Raw CSI frames | Signal amplitude without invented target positions |
| Estimated XYZ tracks | 3D target positions supplied by your own hardware or estimator |

Web Serial needs a supported desktop browser and a secure context, such as GitHub Pages or `localhost`. Browser support varies. Use the local bridge when your source is a file, another process, or hardware reached outside the browser. Hosting the frontend on Pages does not host that bridge or supply a CSI estimation model.

NutRadar visualizes the data it receives. It is not a medical tool and does not claim reliable through-wall localization.

## Project layout

```text
index.html       Dashboard entry point
css/             Dashboard styling
js/              Browser modules and data handling
vendor/          Local Three.js modules and license
assets/          Website assets
examples/        Sample data
tools/           Local data bridge and laptop Wi-Fi reader
tests/           Browser-module and bridge checks
docs/            Hardware and data documentation
.github/         Checks and Pages deployment
```

## Checks

With Node.js 22 or later and Python 3 installed:

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

`npm test` runs the browser-module checks. There are no third-party Node.js packages to install.

## Credits and license

Inspired by [RuView](https://github.com/ruvnet/RuView), with an independent frontend implementation and an explicit distinction between simulated visualization and real sensor data. No RuView source, model weights, or datasets are included.

The 3D renderer uses [Three.js](https://threejs.org/), vendored locally under its MIT License. See [third-party notices](THIRD_PARTY_NOTICES.md).

Copyright © 2026 NutcrackerPro. Released under the [MIT License](LICENSE).
