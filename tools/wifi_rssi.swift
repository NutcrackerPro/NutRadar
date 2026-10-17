// Read-only CoreWLAN telemetry. Never scans networks or reads network identifiers.
import CoreWLAN
import Foundation

func stop(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard let interface = CWWiFiClient.shared().interface() else {
    stop("No Wi-Fi interface is available.")
}
guard interface.powerOn() else {
    stop("Wi-Fi is off or the operating system did not allow access.")
}

// CoreWLAN documents zero as an unavailable/error/disconnected reading.
let rssi = interface.rssiValue()
guard (-200 ... -1).contains(rssi) else {
    stop("No measured Wi-Fi RSSI is available. Connect to Wi-Fi and allow access if macOS requests it.")
}
var reading: [String: Int] = ["rssiDbm": rssi]
let noise = interface.noiseMeasurement()
if (-200 ... -1).contains(noise) {
    reading["noiseDbm"] = noise
}
guard let data = try? JSONSerialization.data(withJSONObject: reading, options: [.sortedKeys]),
      let output = String(data: data, encoding: .utf8) else {
    stop("Could not encode the measured Wi-Fi signal.")
}
print(output)
