/** NutRadar interchange protocol. Coordinates are meters, with Y pointing up. */
export const MAX_FRAMES = 18000;
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_ITEMS = 64;
const MAX_IQ = 4096;
const COORDINATE_SYSTEM = 'room-meters-y-up';

function fail(message) { throw new Error(message); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object.');
  return value;
}
function number(value, label, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(label + ' must be ' + (integer ? 'an integer' : 'a finite number') + ' between ' + min + ' and ' + max + '.');
  }
  return value;
}
function text(value, label) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) fail(label + ' must be text.');
  const cleaned = String(value).replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').trim().slice(0, 80);
  if (!cleaned) fail(label + ' must contain visible text.');
  return cleaned;
}
function list(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail(label + ' must be an array of at most ' + MAX_ITEMS + ' items.');
  return value;
}
function telemetry(input, output, label) {
  if (input.rssiDbm !== undefined) output.rssiDbm = number(input.rssiDbm, label + '.rssiDbm', -200, 50);
  if (input.noiseDbm !== undefined) output.noiseDbm = number(input.noiseDbm, label + '.noiseDbm', -200, 50);
  if (input.channel !== undefined) output.channel = number(input.channel, label + '.channel', 1, 233, true);
  if (input.fps !== undefined) output.fps = number(input.fps, label + '.fps', 0.001, 10000);
  if (input.sampleRateHz !== undefined) output.sampleRateHz = number(input.sampleRateHz, label + '.sampleRateHz', 0.001, 1000000);
}
function position(input, output, label, required = true) {
  if (!required && !['x', 'y', 'z'].some(key => input[key] !== undefined)) return;
  for (const key of ['x', 'y', 'z']) output[key] = number(input[key], label + '.' + key, -100, 100);
}

/** Validate and copy a frame. A transport must independently identify whether it is live. */
export function validateFrame(input) {
  object(input, 'Frame');
  if (input.version !== 1) fail('Frame.version must be 1.');
  if (!['tracks', 'csi', 'rssi'].includes(input.kind)) fail('Frame.kind must be tracks, csi, or rssi.');
  if (!['hardware', 'simulation'].includes(input.source)) fail('Frame.source must be hardware or simulation; a source label alone does not verify hardware.');
  if (input.coordinateSystem !== undefined && input.coordinateSystem !== COORDINATE_SYSTEM) fail('Coordinates must use room-meters-y-up.');
  const result = {
    version: 1,
    kind: input.kind,
    source: input.source,
    timestamp: number(input.timestamp, 'Frame.timestamp (epoch milliseconds)', 0, 8640000000000000),
    coordinateSystem: COORDINATE_SYSTEM,
    tracks: [],
    nodes: [],
    amplitudes: [],
    variation: 0,
  };
  telemetry(input, result, 'Frame');
  if (input.kind === 'rssi') result.rssiDbm = number(input.rssiDbm, 'Frame.rssiDbm', -200, 50);
  if (input.nodeId !== undefined) result.nodeId = text(input.nodeId, 'Frame.nodeId');
  const incomingTracks = list(input.tracks, 'Frame.tracks');
  // Raw signal frames cannot carry spatial tracks; ignored fields still undergo validation.
  const tracks = Array.from(incomingTracks, (item, index) => {
    const label = 'Track ' + (index + 1);
    object(item, label);
    const track = { id: text(item.id, label + '.id') };
    position(item, track, label);
    track.confidence = item.confidence === undefined || item.confidence === null ? null : number(item.confidence, label + '.confidence', 0, 1);
    if (item.label !== undefined) track.label = text(item.label, label + '.label');
    return track;
  });
  if (new Set(tracks.map(track => track.id)).size !== tracks.length) fail('Track IDs must be unique after sanitization.');
  if (input.kind === 'tracks') result.tracks = tracks;
  result.nodes = Array.from(list(input.nodes, 'Frame.nodes'), (item, index) => {
    const label = 'Node ' + (index + 1);
    object(item, label);
    const node = { id: text(item.id, label + '.id') };
    position(item, node, label, false);
    telemetry(item, node, label);
    if (item.label !== undefined) node.label = text(item.label, label + '.label');
    return node;
  });
  if (new Set(result.nodes.map(node => node.id)).size !== result.nodes.length) fail('Node IDs must be unique after sanitization.');
  if (input.kind === 'csi') {
    if (!Array.isArray(input.iq) || input.iq.length < 2 || input.iq.length > MAX_IQ || input.iq.length % 2) fail('CSI iq must contain an even number of signed bytes, between 2 and 4096.');
    if (input.iqOrder !== undefined && input.iqOrder !== 'imaginary-real') fail('CSI iqOrder must be imaginary-real.');
    if (input.firstWordInvalid !== undefined && typeof input.firstWordInvalid !== 'boolean') fail('CSI firstWordInvalid must be boolean.');
    result.iq = Array.from(input.iq, (value, index) => number(value, 'CSI iq[' + index + ']', -128, 127, true));
    result.iqOrder = 'imaginary-real';
    result.firstWordInvalid = input.firstWordInvalid === true;
    // ESP32 can flag its first four CSI bytes as invalid; preserve raw bytes and omit them from plots.
    for (let index = result.firstWordInvalid ? 4 : 0; index < result.iq.length; index += 2) {
      result.amplitudes.push(Math.hypot(result.iq[index], result.iq[index + 1]));
    }
    if (result.amplitudes.length) {
      const mean = result.amplitudes.reduce((sum, value) => sum + value, 0) / result.amplitudes.length;
      const variance = result.amplitudes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / result.amplitudes.length;
      // Cross-subcarrier amplitude spread, NOT a human-presence probability or localization result.
      result.variation = Math.min(1, Math.sqrt(variance) / (mean + 1e-9));
    }
  }
  return result;
}

/** Parse a recording envelope or newline-delimited frames without altering the original objects. */
export function parseRecording(contents) {
  if (typeof contents !== 'string') fail('Recording input must be text.');
  if (new TextEncoder().encode(contents).byteLength > MAX_INPUT_BYTES) fail('Recording exceeds the 20 MB limit.');
  const trimmed = contents.replace(/^\uFEFF/, '').trim();
  if (!trimmed) fail('Recording is empty.');
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { /* A multi-line NDJSON stream is parsed below. */ }
  let frames;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.format === 'nutradar-recording') {
    if (parsed.version !== 1) fail('Recording.version must be 1.');
    if (!Array.isArray(parsed.frames)) fail('Recording.frames must be an array.');
    frames = parsed.frames;
  } else if (parsed !== undefined) {
    if (Array.isArray(parsed)) fail('Use a NutRadar recording envelope or newline-delimited frames.');
    frames = [parsed];
  } else {
    const lines = trimmed.split(/\r?\n/).filter(line => line.trim());
    if (lines.length > MAX_FRAMES) fail('Recording exceeds the 18000 frame limit.');
    frames = lines.map((line, index) => {
      try { return JSON.parse(line); } catch { fail('Recording line ' + (index + 1) + ' is not valid JSON.'); }
    });
  }
  if (!frames.length) fail('Recording contains no frames.');
  if (frames.length > MAX_FRAMES) fail('Recording exceeds the 18000 frame limit.');
  let previousTimestamp = -Infinity;
  return frames.map((frame, index) => {
    try {
      const normalized = validateFrame(frame);
      if (normalized.timestamp < previousTimestamp) fail('Recording timestamps must be in chronological order (equal timestamps are allowed).');
      previousTimestamp = normalized.timestamp;
      return normalized;
    } catch (error) { fail('Recording frame ' + (index + 1) + ': ' + error.message); }
  });
}
