import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFrame, parseRecording, MAX_FRAMES, MAX_INPUT_BYTES } from '../js/protocol.js';

const EPOCH = 1792233600000;
function frame(extra = {}) {
  return {
    version: 1,
    kind: 'tracks',
    source: 'hardware',
    timestamp: EPOCH,
    tracks: [{ id: 'target-1', x: 1, y: 0, z: -2, confidence: 0.9 }],
    ...extra,
  };
}
function envelope(frames, extra = {}) {
  return JSON.stringify({ format: 'nutradar-recording', version: 1, frames, ...extra });
}

test('validates into an independent copy and sanitizes display identifiers', () => {
  const input = frame({
    tracks: [{ id: ' <target>\u0000-1 ', x: 1, y: 0, z: -2, label: '<Visitor>' }],
    nodes: [{ id: ' <node> ', x: 0, y: 1, z: 0, label: '<Receiver>', channel: 6 }],
  });
  const before = structuredClone(input);
  const result = validateFrame(input);
  assert.deepEqual(input, before);
  assert.notEqual(result, input);
  assert.notEqual(result.tracks, input.tracks);
  assert.notEqual(result.nodes[0], input.nodes[0]);
  assert.equal(result.tracks[0].id, 'target-1');
  assert.equal(result.tracks[0].label, 'Visitor');
  assert.equal(result.nodes[0].id, 'node');
  assert.equal(result.coordinateSystem, 'room-meters-y-up');
});

test('missing or null confidence remains unknown through validation and recording round trips', () => {
  for (const confidence of [undefined, null]) {
    const input = frame({ tracks: [{ id: 'target-1', x: 0, y: 0, z: 0, confidence }] });
    const validated = validateFrame(input);
    assert.equal(validated.tracks[0].confidence, null);
    assert.equal(validateFrame(validated).tracks[0].confidence, null);
    assert.equal(parseRecording(envelope([validated]))[0].tracks[0].confidence, null);
  }
  assert.equal(validateFrame(frame()).tracks[0].confidence, 0.9);
  assert.equal(validateFrame(frame({ tracks: [{ id: 'zero', x: 0, y: 0, z: 0, confidence: 0 }] })).tracks[0].confidence, 0);
});

test('rejects malformed version, kinds, source labels, coordinates, and timestamps', () => {
  for (const input of [null, [], 'frame', frame({ version: 2 }), frame({ version: '1' }),
    frame({ kind: 'people' }), frame({ source: 'esp32' }), frame({ source: 'live' }),
    frame({ source: 'verified-hardware' }), frame({ source: null }),
    frame({ coordinateSystem: 'z-up' }), frame({ timestamp: NaN }),
    frame({ timestamp: Infinity }), frame({ timestamp: '1792233600000' }),
    frame({ timestamp: true }), frame({ timestamp: -1 }), frame({ timestamp: 8640000000000001 }),
  ]) {
    assert.throws(() => validateFrame(input));
  }
  assert.equal(validateFrame(frame({ source: 'simulation', timestamp: 0 })).source, 'simulation');
});

test('requires all finite track coordinates within the supported room bounds', () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, '1', true, 100.001, -100.001]) {
    for (const coordinate of ['x', 'y', 'z']) {
      const track = { id: 'target-1', x: 0, y: 0, z: 0, [coordinate]: bad };
      assert.throws(() => validateFrame(frame({ tracks: [track] })), new RegExp(coordinate));
    }
  }
  assert.equal(validateFrame(frame({ tracks: [{ id: 'edge', x: -100, y: 100, z: 0 }] })).tracks[0].y, 100);
});

test('rejects non-numeric and out-of-range reported confidence', () => {
  for (const confidence of [NaN, Infinity, -0.1, 1.1, '0.9', true]) {
    assert.throws(() => validateFrame(frame({ tracks: [{ id: 'a', x: 0, y: 0, z: 0, confidence }] })), /confidence/);
  }
});

test('sensor nodes may be telemetry-only, but partial coordinates are rejected', () => {
  const result = validateFrame(frame({ nodes: [{ id: 'receiver', rssiDbm: -54, channel: 6 }] }));
  assert.deepEqual(result.nodes[0], { id: 'receiver', rssiDbm: -54, channel: 6 });
  assert.throws(() => validateFrame(frame({ nodes: [{ id: 'receiver', x: 0 }] })), /Node 1.y/);
  assert.throws(() => validateFrame(frame({ nodes: null })), /nodes/);
});

test('optional telemetry is finite and constrained', () => {
  assert.equal(validateFrame(frame({ rssiDbm: -54, channel: 6, fps: 20, sampleRateHz: 100 })).sampleRateHz, 100);
  for (const bad of [{ rssiDbm: -201 }, { rssiDbm: Infinity }, { channel: 0 }, { channel: 1.5 },
    { channel: 234 }, { fps: 0 }, { sampleRateHz: -1 }, { sampleRateHz: NaN },
  ]) assert.throws(() => validateFrame(frame(bad)));
});

test('track and node limits allow 64 unique objects and reject 65', () => {
  const tracks = Array.from({ length: 64 }, (_, i) => ({ id: 't' + i, x: 0, y: 0, z: 0 }));
  const nodes = Array.from({ length: 64 }, (_, i) => ({ id: 'n' + i }));
  assert.equal(validateFrame(frame({ tracks, nodes })).tracks.length, 64);
  assert.throws(() => validateFrame(frame({ tracks: [...tracks, { id: 'extra', x: 0, y: 0, z: 0 }] })), /64/);
  assert.throws(() => validateFrame(frame({ nodes: [...nodes, { id: 'extra' }] })), /64/);
});

test('duplicate IDs are rejected after cleaning and truncation', () => {
  const tracks = [{ id: 'target-1', x: 0, y: 0, z: 0 }, { id: '<target-1>', x: 0, y: 0, z: 0 }];
  assert.throws(() => validateFrame(frame({ tracks })), /unique after sanitization/);
  assert.throws(() => validateFrame(frame({ nodes: [{ id: 'node' }, { id: ' node ' }] })), /unique after sanitization/);
  assert.throws(() => validateFrame(frame({ nodes: [{ id: 'x'.repeat(81) }, { id: 'x'.repeat(80) + 'y' }] })), /unique/);
  assert.throws(() => validateFrame(frame({ nodes: [{ id: '<>\u0000' }] })), /visible text/);
});

test('sparse track, node, and IQ arrays cannot bypass item validation', () => {
  assert.throws(() => validateFrame(frame({ tracks: new Array(1) })), /Track 1/);
  assert.throws(() => validateFrame(frame({ nodes: new Array(1) })), /Node 1/);
  assert.throws(() => validateFrame(frame({ kind: 'csi', iq: new Array(2) })), /iq\[0\]/);
});

test('CSI math uses imaginary-real pairs and clears external spatial tracks', () => {
  const input = frame({ kind: 'csi', iq: [3, 4, 0, 10] });
  const result = validateFrame(input);
  assert.deepEqual(result.amplitudes, [5, 10]);
  assert.ok(Math.abs(result.variation - 1 / 3) < 1e-9);
  assert.deepEqual(result.tracks, []);
  assert.equal(result.iqOrder, 'imaginary-real');
  assert.deepEqual(input.tracks, frame().tracks);
  assert.notEqual(result.iq, input.iq);
  assert.equal(validateFrame(frame({ kind: 'csi', iq: [0, 0, 0, 0] })).variation, 0);
  assert.equal(validateFrame(frame({ kind: 'csi', iq: [0, 0, 0, 0, 0, 100] })).variation, 1);
});

test('RSSI preserves measured levels and telemetry-only nodes without fabricating spatial or CSI data', () => {
  const input = frame({ kind: 'rssi', rssiDbm: -54, noiseDbm: -92, nodeId: '<laptop>', sampleRateHz: 1,
    nodes: [{ id: 'laptop', rssiDbm: -54, noiseDbm: -92 }, { id: 'fixed', x: 1, y: 2, z: 3 }],
    iq: [3, 4], amplitudes: [5], variation: 1,
  });
  const before = structuredClone(input);
  const result = validateFrame(input);
  assert.equal(result.kind, 'rssi');
  assert.equal(result.source, 'hardware');
  assert.equal(result.rssiDbm, -54);
  assert.equal(result.noiseDbm, -92);
  assert.equal(result.nodeId, 'laptop');
  assert.equal(result.sampleRateHz, 1);
  assert.deepEqual(result.tracks, []);
  assert.deepEqual(result.amplitudes, []);
  assert.equal(result.variation, 0);
  assert.equal(result.iq, undefined);
  assert.deepEqual(result.nodes, [{ id: 'laptop', rssiDbm: -54, noiseDbm: -92 }, { id: 'fixed', x: 1, y: 2, z: 3 }]);
  assert.deepEqual(input, before);
  assert.equal(validateFrame(frame({ kind: 'rssi', source: 'simulation', rssiDbm: -50 })).source, 'simulation');
});

test('RSSI requires finite measured RSSI and constrains optional noise readings', () => {
  for (const rssiDbm of [undefined, null, NaN, Infinity, -Infinity, true, '-54', -200.01, 50.01]) {
    assert.throws(() => validateFrame(frame({ kind: 'rssi', rssiDbm })), /rssiDbm/);
  }
  for (const noiseDbm of [null, NaN, Infinity, -Infinity, true, '-92', -200.01, 50.01]) {
    assert.throws(() => validateFrame(frame({ kind: 'rssi', rssiDbm: -54, noiseDbm })), /noiseDbm/);
    assert.throws(() => validateFrame(frame({ kind: 'rssi', rssiDbm: -54, nodes: [{ id: 'n', noiseDbm }] })), /noiseDbm/);
  }
  assert.equal(validateFrame(frame({ kind: 'rssi', rssiDbm: -200, noiseDbm: 50 })).rssiDbm, -200);
  assert.equal(validateFrame(frame({ kind: 'rssi', rssiDbm: 50, noiseDbm: -200 })).noiseDbm, -200);
  assert.equal(validateFrame(frame({ kind: 'rssi', rssiDbm: -54 })).noiseDbm, undefined);
});

test('RSSI recordings retain measured levels through envelope and NDJSON round trips', () => {
  const frames = [
    validateFrame(frame({ kind: 'rssi', rssiDbm: -54, noiseDbm: -92, nodeId: 'laptop' })),
    validateFrame(frame({ kind: 'rssi', rssiDbm: -55, timestamp: EPOCH + 1000 })),
  ];
  assert.deepEqual(parseRecording(envelope(frames)), frames);
  assert.deepEqual(parseRecording(frames.map(value => JSON.stringify(value)).join('\n')), frames);
  assert.deepEqual(parseRecording(envelope(frames)).map(value => value.tracks), [[], []]);
});

test('invalid initial CSI bytes are preserved in raw data and omitted from plots', () => {
  const result = validateFrame(frame({ kind: 'csi', iq: [127, 127, 127, 127, 3, 4], firstWordInvalid: true }));
  assert.deepEqual(result.amplitudes, [5]);
  assert.equal(result.variation, 0);
  assert.equal(result.iq.length, 6);
  assert.deepEqual(validateFrame(frame({ kind: 'csi', iq: [3, 4], firstWordInvalid: true })).amplitudes, []);
});

test('CSI enforces signed byte pairs, 4096-value limit, order, and boolean metadata', () => {
  for (const iq of [[], [1], [1, 2, 3], [128, 0], [-129, 0], [0.1, 0], [true, 0], [NaN, 0], Array(4098).fill(0)]) {
    assert.throws(() => validateFrame(frame({ kind: 'csi', iq })), /iq/);
  }
  assert.equal(validateFrame(frame({ kind: 'csi', iq: Array(4096).fill(0) })).amplitudes.length, 2048);
  assert.throws(() => validateFrame(frame({ kind: 'csi', iq: [1, 2], iqOrder: 'real-imaginary' })), /iqOrder/);
  assert.throws(() => validateFrame(frame({ kind: 'csi', iq: [1, 2], firstWordInvalid: 1 })), /firstWordInvalid/);
});

test('recording envelope and NDJSON normalize every frame without mutating input', () => {
  const frames = [frame(), frame({ timestamp: EPOCH + 100, source: 'simulation' })];
  const content = envelope(frames);
  const result = parseRecording(content);
  assert.equal(result.length, 2);
  assert.equal(result[0].coordinateSystem, 'room-meters-y-up');
  assert.equal(JSON.stringify({ format: 'nutradar-recording', version: 1, frames }), content);
  const lines = '\uFEFF' + JSON.stringify(frames[0]) + '\r\n\r\n' + JSON.stringify(frames[1]) + '\n';
  assert.deepEqual(parseRecording(lines), result);
  assert.equal(parseRecording(JSON.stringify(frames[0])).length, 1);
});

test('recording parse errors identify malformed lines and bad frame fields', () => {
  assert.throws(() => parseRecording(JSON.stringify(frame()) + '\ninvalid'), /line 2/);
  assert.throws(() => parseRecording(envelope([frame(), frame({ source: 'live' })])), /frame 2.*source/);
  assert.throws(() => parseRecording(envelope([frame()], { version: 2 })), /Recording.version/);
  assert.throws(() => parseRecording(JSON.stringify({ format: 'nutradar-recording', version: 1, frames: {} })), /frames must/);
  assert.throws(() => parseRecording('[]'), /envelope/);
  assert.throws(() => parseRecording(envelope([])), /no frames/);
  assert.throws(() => parseRecording(' \n '), /empty/);
  assert.throws(() => parseRecording({}), /must be text/);
});

test('both recording formats reject decreasing timestamps and allow equal times', () => {
  const ordered = [frame(), frame(), frame({ timestamp: EPOCH + 1 })];
  assert.equal(parseRecording(envelope(ordered)).length, 3);
  assert.equal(parseRecording(ordered.map(value => JSON.stringify(value)).join('\n')).length, 3);
  const reversed = [frame({ timestamp: EPOCH + 1 }), frame()];
  assert.throws(() => parseRecording(envelope(reversed)), /frame 2.*chronological order/);
  assert.throws(() => parseRecording(reversed.map(value => JSON.stringify(value)).join('\n')), /frame 2.*chronological order/);
});

test('recording frame cap is enforced for envelopes and NDJSON', () => {
  const minimal = { version: 1, kind: 'tracks', source: 'simulation', timestamp: EPOCH };
  assert.equal(parseRecording(envelope(Array(MAX_FRAMES).fill(minimal))).length, MAX_FRAMES);
  assert.throws(() => parseRecording(envelope(Array(MAX_FRAMES + 1).fill(minimal))), /18000 frame limit/);
  assert.throws(() => parseRecording(Array(MAX_FRAMES + 1).fill('{}').join('\n')), /18000 frame limit/);
});

test('recording size cap counts UTF-8 bytes', () => {
  assert.throws(() => parseRecording('a'.repeat(MAX_INPUT_BYTES + 1)), /20 MB/);
  const multibyte = 'é'.repeat(MAX_INPUT_BYTES / 2 + 1);
  assert.ok(multibyte.length < MAX_INPUT_BYTES);
  assert.throws(() => parseRecording(multibyte), /20 MB/);
});
