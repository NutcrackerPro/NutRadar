import * as THREE from '../vendor/three.module.min.js';

const INK = 0x090d10;
const MINT = 0x83f6c8;
const TEAL = 0x2eab91;
const TAU = Math.PI * 2;

function randomFor(seed) {
  let n = seed >>> 0;
  return () => { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; };
}
function seedFor(value) {
  return [...String(value)].reduce((n, c) => ((n << 5) - n + c.charCodeAt(0)) >>> 0, 17);
}
function makeGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
  gradient.addColorStop(0, 'rgba(220,255,242,1)');
  gradient.addColorStop(.17, 'rgba(147,255,208,.95)');
  gradient.addColorStop(.44, 'rgba(98,237,184,.23)');
  gradient.addColorStop(1, 'rgba(98,237,184,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}
function line(points, color, opacity = 1) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p)));
  return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}
function circle(radius, color, opacity = 1, segments = 160) {
  const points = [];
  for (let i = 0; i <= segments; i++) points.push([Math.cos(i / segments * TAU) * radius, 0, Math.sin(i / segments * TAU) * radius]);
  return line(points, color, opacity);
}
function makeBody(id) {
  const rand = randomFor(seedFor(id));
  // Anatomical ellipsoids form a stable, sparse point-cloud silhouette.
  const parts = [
    [0, 1.65, 0, .115, .15, .105, 44],
    [0, 1.27, 0, .235, .27, .12, 105],
    [0, .91, 0, .18, .15, .115, 45],
    [-.275, 1.19, 0, .066, .24, .065, 35], [.275, 1.19, 0, .066, .24, .065, 35],
    [-.31, .86, .015, .055, .16, .055, 25], [.31, .86, .015, .055, .16, .055, 25],
    [-.11, .63, 0, .085, .23, .085, 45], [.11, .63, 0, .085, .23, .085, 45],
    [-.115, .235, 0, .061, .235, .061, 38], [.115, .235, 0, .061, .235, .061, 38],
    [-.115, .045, .055, .075, .045, .13, 14], [.115, .045, .055, .075, .045, .13, 14],
  ];
  const positions = [], phases = [], limb = [];
  parts.forEach(([x, y, z, rx, ry, rz, count], part) => {
    for (let i = 0; i < count; i++) {
      const azimuth = rand() * TAU, v = rand() * 2 - 1;
      const r = .72 + rand() * .28, flat = Math.sqrt(1 - v * v);
      positions.push(x + Math.cos(azimuth) * flat * rx * r, y + v * ry * r, z + Math.sin(azimuth) * flat * rz * r);
      phases.push(rand() * TAU);
      limb.push(part);
    }
  });
  return { positions: new Float32Array(positions), phases, limb };
}

export class RadarScene {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.options = { trails: true, heatmap: true, sweep: true, grid: true };
    this.targets = new Map();
    this.anchors = new Map();
    this.selected = null;
    this.elapsed = 0;
    this.disposed = false;
    this.yaw = .76;
    this.pitch = .58;
    this.distance = 18.6;
    this.lookAt = new THREE.Vector3(0, .55, 0);
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.lastFrame = { tracks: [], nodes: [], time: 0 };
    this.labels = document.createElement('div');
    Object.assign(this.labels.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (error) {
      this.makeFallback();
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(INK, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Interactive 3D radar. Drag to rotate, scroll to zoom, arrow keys to rotate, plus or minus to zoom. Select a target to inspect it.');
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none', outlineOffset: '-3px' });
    container.append(this.canvas, this.labels);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(INK, .022);
    this.camera = new THREE.PerspectiveCamera(43, 1, .1, 100);
    this.glowTexture = makeGlowTexture();
    this.scene.add(new THREE.AmbientLight(0xd7fff1, 1.5));
    const light = new THREE.DirectionalLight(0xd0ffe9, 2);
    light.position.set(5, 12, 4);
    this.scene.add(light);
    this.makeRoom();
    this.bindInteractions();
    this.resize();
    this.update(this.lastFrame, 0);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(container);
    }
  }

  makeRoom() {
    this.room = new THREE.Group();
    this.scene.add(this.room);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 10), new THREE.MeshBasicMaterial({ color: 0x0c1519, transparent: true, opacity: .82, side: THREE.DoubleSide }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -.025;
    this.room.add(floor);
    this.grid = new THREE.Group();
    for (let x = -6; x <= 6; x += .5) this.grid.add(line([[x, 0, -5], [x, 0, 5]], x % 1 ? 0x18312f : 0x264740, x % 1 ? .32 : .45));
    for (let z = -5; z <= 5; z += .5) this.grid.add(line([[-6, 0, z], [6, 0, z]], z % 1 ? 0x18312f : 0x264740, z % 1 ? .32 : .45));
    this.room.add(this.grid);
    this.room.add(line([[-6, .015, -5], [6, .015, -5], [6, .015, 5], [-6, .015, 5], [-6, .015, -5]], 0x5ba18e, .7));
    this.room.add(line([[-6, 2.8, -5], [6, 2.8, -5], [6, 2.8, 5]], 0x3e6961, .3));
    this.room.add(line([[-6, 2.8, -5], [-6, 2.8, 5]], 0x3e6961, .26));
    for (const [x, z] of [[-6, -5], [6, -5], [-6, 5], [6, 5]]) {
      this.room.add(line([[x, 0, z], [x, 2.8, z]], 0x4c8273, .43));
      for (let y = .5; y <= 2.5; y += .5) this.room.add(line([[x, y, z], [x + (x < 0 ? .13 : -.13), y, z]], 0x7db6a4, .42));
    }
    for (let x = -6; x <= 6; x++) {
      this.room.add(line([[x, .012, 5], [x, .012, 5.16]], 0x759f91, .55));
      if (x % 2 === 0) this.addRoomLabel(`${Math.abs(x)}m`, [x, 0, 5.32]);
    }
    for (let z = -4; z <= 4; z += 2) this.room.add(line([[-6, .012, z], [-6.16, .012, z]], 0x759f91, .45));
    this.sweeps = new THREE.Group();
    this.sweeps.position.y = .025;
    for (const radius of [1.5, 3, 4.5]) this.sweeps.add(circle(radius, 0x4d977f, .22));
    this.sweeps.add(line([[-.22, .01, 0], [.22, .01, 0]], MINT, .6));
    this.sweeps.add(line([[0, .01, -.22], [0, .01, .22]], MINT, .6));
    this.sweepWedge = new THREE.Group();
    const sweepGeometry = new THREE.BufferGeometry();
    const vertices = [], colors = [];
    for (let i = 0; i < 36; i++) {
      const a = i / 36 * .67, b = (i + 1) / 36 * .67;
      vertices.push(0, 0, 0, Math.cos(a) * 4.7, 0, Math.sin(a) * 4.7, Math.cos(b) * 4.7, 0, Math.sin(b) * 4.7);
      const intensity = Math.pow(i / 36, 2) * .12;
      for (let j = 0; j < 3; j++) colors.push(.24 * intensity, .92 * intensity, .65 * intensity);
    }
    sweepGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    sweepGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.sweepWedge.add(new THREE.Mesh(sweepGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: .85, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })));
    const end = .67;
    this.sweepWedge.add(line([[0, .006, 0], [Math.cos(end) * 4.7, .006, Math.sin(end) * 4.7]], MINT, .32));
    this.sweeps.add(this.sweepWedge);
    this.room.add(this.sweeps);
    this.roomLabels = this.roomLabels || [];
  }

  addRoomLabel(text, position) {
    if (!this.roomLabels) this.roomLabels = [];
    const label = document.createElement('span');
    label.textContent = text;
    Object.assign(label.style, { position: 'absolute', color: '#4e766a', font: '9px "SFMono-Regular", Consolas, monospace', transform: 'translate(-50%, -50%)', letterSpacing: '.04em' });
    this.labels.append(label);
    this.roomLabels.push({ element: label, position: new THREE.Vector3(...position) });
  }

  makeTarget(track) {
    const group = new THREE.Group();
    const body = makeBody(track.id);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(body.positions.slice(), 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: MINT, size: .105, map: this.glowTexture, transparent: true, opacity: .95, depthWrite: false, blending: THREE.AdditiveBlending }));
    group.add(points);
    const ring = circle(.5, MINT, .72, 72);
    ring.position.y = .035;
    group.add(ring);
    const inside = circle(.39, TEAL, .23, 64);
    inside.position.y = .03;
    group.add(inside);
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * TAU;
      group.add(line([[Math.cos(a) * .54, .04, Math.sin(a) * .54], [Math.cos(a) * .7, .04, Math.sin(a) * .7]], MINT, .72));
    }
    group.add(line([[0, .02, 0], [0, 2.12, 0]], TEAL, .15));
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(.42, .42, 1.9, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = .95;
    hit.userData.trackId = track.id;
    group.add(hit);
    const heat = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), new THREE.MeshBasicMaterial({ map: this.glowTexture, color: 0x3df5aa, transparent: true, opacity: .2, blending: THREE.AdditiveBlending, depthWrite: false }));
    heat.rotation.x = -Math.PI / 2;
    heat.position.y = .016;
    group.add(heat);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(80 * 3), 3));
    trailGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(80 * 3), 3));
    trailGeometry.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .7, depthWrite: false }));
    trail.frustumCulled = false;
    this.scene.add(group, trail);
    const label = document.createElement('div');
    label.textContent = String(track.id).toUpperCase();
    Object.assign(label.style, { position: 'absolute', color: '#a5f9d9', background: 'rgba(9,20,21,.78)', border: '1px solid rgba(111,239,184,.26)', padding: '3px 6px', borderRadius: '3px', font: '9px "SFMono-Regular",Consolas,monospace', letterSpacing: '.09em', transform: 'translate(-50%, -50%)', whiteSpace: 'nowrap' });
    this.labels.append(label);
    const target = { group, body, points, ring, heat, hit, trail, trailGeometry, label, history: [], lastTrail: -Infinity, previous: new THREE.Vector3(track.x || 0, track.y || 0, track.z || 0), speed: 0, heading: 0 };
    this.targets.set(track.id, target);
    return target;
  }

  makeAnchor(node) {
    const group = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(.24, .12, .24), new THREE.MeshStandardMaterial({ color: 0x6eaf9f, metalness: .5, roughness: .4 }));
    base.position.y = .06;
    group.add(base);
    const light = new THREE.Mesh(new THREE.SphereGeometry(.045, 8, 8), new THREE.MeshBasicMaterial({ color: 0xbbffe3 }));
    light.position.y = .15;
    group.add(light);
    const ring = circle(.35, MINT, .25, 48);
    ring.position.y = .015;
    group.add(ring);
    group.add(line([[0, .12, 0], [0, .43, 0]], MINT, .56));
    this.scene.add(group);
    const label = document.createElement('div');
    label.textContent = String(node.id).toUpperCase();
    Object.assign(label.style, { position: 'absolute', color: '#688f84', font: '9px "SFMono-Regular",Consolas,monospace', transform: 'translate(-50%, -50%)', whiteSpace: 'nowrap', letterSpacing: '.06em' });
    this.labels.append(label);
    const anchor = { group, label, ring };
    this.anchors.set(node.id, anchor);
    return anchor;
  }

  update(frame = {}, dt = 1 / 60) {
    if (this.disposed) return;
    this.lastFrame = frame;
    this.elapsed += Math.min(Math.max(dt, 0), .1);
    if (!this.renderer) { this.drawFallback(frame); return; }
    const time = Number.isFinite(frame.time) ? frame.time : this.elapsed;
    const ids = new Set();
    for (const track of (frame.tracks || [])) {
      if (!Number.isFinite(track.x) || !Number.isFinite(track.z)) continue;
      ids.add(track.id);
      const target = this.targets.get(track.id) || this.makeTarget(track);
      const position = new THREE.Vector3(track.x, Number.isFinite(track.y) ? track.y : 0, track.z);
      const movement = position.clone().sub(target.previous);
      const speed = dt > 0 ? Math.min(movement.length() / dt, 2) : 0;
      target.speed = THREE.MathUtils.lerp(target.speed, speed, .09);
      if (movement.lengthSq() > .000006) target.heading = Math.atan2(movement.x, movement.z);
      target.group.position.copy(position);
      target.points.rotation.y = target.heading;
      target.previous.copy(position);
      const positions = target.points.geometry.attributes.position;
      const stride = time * Math.min(8, 3 + target.speed * 2.5);
      for (let i = 0; i < target.body.phases.length; i++) {
        const offset = i * 3, part = target.body.limb[i];
        let x = target.body.positions[offset], y = target.body.positions[offset + 1], z = target.body.positions[offset + 2];
        const sway = Math.sin(stride + (part % 2 ? 0 : Math.PI)) * Math.min(target.speed * .09, .12);
        if (part >= 7) z += sway * (1 - Math.min(y, .9));
        if (part >= 3 && part <= 6) z -= sway * .6;
        y += Math.sin(time * 1.5 + target.body.phases[i]) * .006;
        positions.setXYZ(i, x, y, z);
      }
      positions.needsUpdate = true;
      target.heat.visible = this.options.heatmap;
      target.trail.visible = this.options.trails;
      const selected = this.selected === track.id;
      target.ring.material.opacity = selected ? 1 : .6;
      target.ring.scale.setScalar(selected ? 1.13 : 1);
      target.points.material.opacity = .65 + Math.max(0, Math.min(1, track.confidence ?? 1)) * .3;
      target.label.style.borderColor = selected ? '#82f3c4' : 'rgba(111,239,184,.26)';
      target.label.style.color = selected ? '#e3fff2' : '#a5f9d9';
      const lastTrailPoint = target.history[target.history.length - 1];
      const movedSinceTrail = !lastTrailPoint || Math.hypot(position.x - lastTrailPoint.x, position.z - lastTrailPoint.z) > .035;
      if (this.elapsed - target.lastTrail > .075 && movedSinceTrail) {
        target.history.push(position.clone().add(new THREE.Vector3(0, .055, 0)));
        if (target.history.length > 80) target.history.shift();
        target.lastTrail = this.elapsed;
        const pos = target.trailGeometry.attributes.position, color = target.trailGeometry.attributes.color;
        target.history.forEach((p, i) => {
          pos.setXYZ(i, p.x, p.y, p.z);
          const alpha = Math.pow((i + 1) / target.history.length, 1.7);
          color.setXYZ(i, .27 * alpha, .81 * alpha, .61 * alpha);
        });
        pos.needsUpdate = color.needsUpdate = true;
        target.trailGeometry.setDrawRange(0, target.history.length);
      }
    }
    for (const [id, target] of this.targets) if (!ids.has(id)) {
      this.removeObject(target.group);
      this.removeObject(target.trail);
      target.label.remove();
      this.targets.delete(id);
      if (this.selected === id) this.selected = null;
    }
    const nodeIds = new Set();
    for (const node of frame.nodes || []) {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.z)) continue;
      nodeIds.add(node.id);
      const anchor = this.anchors.get(node.id) || this.makeAnchor(node);
      anchor.group.position.set(node.x, Number.isFinite(node.y) ? node.y : 0, node.z);
      anchor.ring.material.opacity = .22 + Math.sin(this.elapsed * 2.4) * .08;
    }
    for (const [id, anchor] of this.anchors) if (!nodeIds.has(id)) {
      this.removeObject(anchor.group);
      anchor.label.remove();
      this.anchors.delete(id);
    }
    this.sweeps.visible = this.options.sweep;
    this.sweepWedge.rotation.y = -this.elapsed * .38;
    this.grid.visible = this.options.grid;
    this.updateCamera();
    for (const { element, position } of this.roomLabels) this.positionLabel(element, position);
    for (const target of this.targets.values()) this.positionLabel(target.label, target.group.position.clone().add(new THREE.Vector3(0, 2.1, 0)));
    for (const anchor of this.anchors.values()) this.positionLabel(anchor.label, anchor.group.position.clone().add(new THREE.Vector3(0, .72, 0)));
    this.renderer.render(this.scene, this.camera);
  }

  positionLabel(element, point) {
    const projected = point.clone().project(this.camera);
    element.style.display = projected.z > 1 || projected.z < -1 ? 'none' : '';
    element.style.left = `${(projected.x * .5 + .5) * this.width}px`;
    element.style.top = `${(-projected.y * .5 + .5) * this.height}px`;
  }

  updateCamera() {
    const sinYaw = Math.sin(this.yaw), cosYaw = Math.cos(this.yaw);
    const sinPitch = Math.sin(this.pitch), cosPitch = Math.cos(this.pitch);
    const direction = new THREE.Vector3(sinYaw * cosPitch, sinPitch, cosYaw * cosPitch);
    const right = new THREE.Vector3(cosYaw, 0, -sinYaw);
    const up = new THREE.Vector3(-sinYaw * sinPitch, cosPitch, -cosYaw * sinPitch);
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * .93;
    const tanHorizontal = tanVertical * this.camera.aspect;
    let fittedDistance = 0;
    // Project the room bounds into this camera's axes. This accounts for both
    // the narrower mobile viewport and the near corners of the elevated room.
    for (const x of [-6.35, 6.35]) for (const y of [-.1, 3]) for (const z of [-5.45, 5.45]) {
      const corner = new THREE.Vector3(x, y, z).sub(this.lookAt);
      const depth = corner.dot(direction);
      fittedDistance = Math.max(fittedDistance,
        depth + Math.abs(corner.dot(right)) / tanHorizontal,
        depth + Math.abs(corner.dot(up)) / tanVertical);
    }
    // Keep wheel zoom relative to the fitted default rather than imposing a
    // hard minimum that would prevent the user from moving closer.
    const distance = this.distance * Math.max(1, fittedDistance / 18.6);
    this.camera.position.set(
      this.lookAt.x + direction.x * distance,
      this.lookAt.y + direction.y * distance,
      this.lookAt.z + direction.z * distance,
    );
    this.camera.lookAt(this.lookAt);
    this.camera.updateMatrixWorld();
  }

  bindInteractions() {
    this.down = event => {
      if (event.button !== 0) return;
      this.canvas.focus({ preventScroll: true });
      this.drag = { x: event.clientX, y: event.clientY, total: 0 };
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = 'grabbing';
    };
    this.move = event => {
      if (!this.drag) return;
      const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y;
      this.drag.total += Math.abs(dx) + Math.abs(dy);
      this.yaw -= dx * .006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * .006, .09, 1.54);
      this.drag.x = event.clientX;
      this.drag.y = event.clientY;
      this.refresh();
    };
    this.up = event => {
      if (!this.drag) return;
      const clicked = this.drag.total < 5;
      this.drag = null;
      this.canvas.style.cursor = 'grab';
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (clicked) {
        const bounds = this.canvas.getBoundingClientRect();
        this.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects([...this.targets.values()].map(target => target.hit));
        this.selected = hits.length ? hits[0].object.userData.trackId : null;
        this.onSelect?.(this.selected);
        this.refresh();
      }
    };
    this.wheel = event => {
      event.preventDefault();
      this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(event.deltaY * .001), 7, 32);
      this.refresh();
    };
    this.key = event => {
      let handled = true;
      if (event.key === 'ArrowLeft') this.yaw += .09;
      else if (event.key === 'ArrowRight') this.yaw -= .09;
      else if (event.key === 'ArrowUp') this.pitch = Math.min(1.54, this.pitch + .07);
      else if (event.key === 'ArrowDown') this.pitch = Math.max(.09, this.pitch - .07);
      else if (event.key === '+' || event.key === '=') this.distance = Math.max(7, this.distance - 1);
      else if (event.key === '-') this.distance = Math.min(32, this.distance + 1);
      else handled = false;
      if (handled) { event.preventDefault(); this.refresh(); }
    };
    this.canvas.addEventListener('pointerdown', this.down);
    this.canvas.addEventListener('pointermove', this.move);
    this.canvas.addEventListener('pointerup', this.up);
    this.canvas.addEventListener('pointercancel', this.up);
    this.canvas.addEventListener('wheel', this.wheel, { passive: false });
    this.canvas.addEventListener('keydown', this.key);
  }

  refresh() { this.update(this.lastFrame, 0); }

  setOptions(options = {}) {
    Object.assign(this.options, options);
    this.refresh();
  }

  setView(view) {
    if (view === 'top') { this.pitch = Math.PI / 2 - .001; this.yaw = 0; this.distance = 18; }
    else if (view === 'front') { this.pitch = .15; this.yaw = 0; this.distance = 18.6; }
    else { this.pitch = .58; this.yaw = .76; this.distance = 18.6; }
    this.refresh();
  }

  resize() {
    if (this.disposed) return;
    this.width = this.container.clientWidth || 800;
    this.height = this.container.clientHeight || 570;
    if (this.renderer) {
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(this.width, this.height, false);
      this.refresh();
    } else if (this.fallbackCanvas) {
      this.fallbackCanvas.width = this.width * Math.min(window.devicePixelRatio || 1, 2);
      this.fallbackCanvas.height = this.height * Math.min(window.devicePixelRatio || 1, 2);
      this.drawFallback(this.lastFrame);
    }
  }

  makeFallback() {
    this.fallbackCanvas = document.createElement('canvas');
    Object.assign(this.fallbackCanvas.style, { display: 'block', width: '100%', height: '100%', background: '#090d10' });
    this.fallbackCanvas.setAttribute('aria-label', '2D radar fallback. WebGL is unavailable.');
    this.container.append(this.fallbackCanvas);
    this.resize();
    this.fallbackNote = document.createElement('div');
    this.fallbackNote.textContent = '2D FALLBACK · WebGL unavailable';
    Object.assign(this.fallbackNote.style, { position: 'absolute', bottom: '18px', left: '18px', color: '#6c9988', font: '10px monospace', letterSpacing: '.08em' });
    this.container.append(this.fallbackNote);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.container);
    }
  }

  drawFallback(frame = {}) {
    const canvas = this.fallbackCanvas, ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const ratio = canvas.width / this.width;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#090d10'; ctx.fillRect(0, 0, this.width, this.height);
    const scale = Math.min((this.width - 70) / 12, (this.height - 90) / 10);
    const cx = this.width / 2, cy = this.height / 2;
    if (this.options.grid) {
      ctx.strokeStyle = '#19332b'; ctx.lineWidth = .7;
      for (let x = -6; x <= 6; x++) { ctx.beginPath(); ctx.moveTo(cx + x * scale, cy - 5 * scale); ctx.lineTo(cx + x * scale, cy + 5 * scale); ctx.stroke(); }
      for (let z = -5; z <= 5; z++) { ctx.beginPath(); ctx.moveTo(cx - 6 * scale, cy + z * scale); ctx.lineTo(cx + 6 * scale, cy + z * scale); ctx.stroke(); }
    }
    if (this.options.sweep) {
      ctx.strokeStyle = '#326c54';
      for (const r of [1.5, 3, 4.5]) { ctx.beginPath(); ctx.arc(cx, cy, r * scale, 0, TAU); ctx.stroke(); }
      const a = this.elapsed * .38; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * 4.5 * scale, cy + Math.sin(a) * 4.5 * scale); ctx.stroke();
    }
    ctx.font = '10px monospace';
    for (const node of frame.nodes || []) {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.z)) continue;
      const x = cx + node.x * scale, y = cy + node.z * scale;
      ctx.fillStyle = '#628d7c'; ctx.fillRect(x - 4, y - 4, 8, 8); ctx.fillText(String(node.id), x + 9, y + 3);
    }
    for (const track of frame.tracks || []) {
      if (!Number.isFinite(track.x) || !Number.isFinite(track.z)) continue;
      const x = cx + track.x * scale, y = cy + track.z * scale;
      ctx.strokeStyle = '#83f6c8'; ctx.fillStyle = '#b3ffdc';
      ctx.beginPath(); ctx.arc(x, y, .5 * scale, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fill(); ctx.fillText(String(track.id), x + .6 * scale, y + 3);
    }
  }

  removeObject(object) {
    object.removeFromParent();
    object.traverse(child => {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach(material => material.dispose());
      else child.material?.dispose();
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    if (this.canvas) {
      for (const [event, handler] of [['pointerdown', this.down], ['pointermove', this.move], ['pointerup', this.up], ['pointercancel', this.up], ['wheel', this.wheel], ['keydown', this.key]]) this.canvas.removeEventListener(event, handler);
      this.removeObject(this.scene);
      this.glowTexture.dispose();
      this.renderer.dispose();
      this.canvas.remove();
    }
    this.labels.remove();
    this.fallbackCanvas?.remove();
    this.fallbackNote?.remove();
    this.targets.clear();
    this.anchors.clear();
  }
}
