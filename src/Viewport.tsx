import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { blackHoleQuad, quadSize } from './blackhole';
import { eclipseMaterial, isLight, updateEclipse } from './eclipse';
import { accelerations, type Body, type BodyType, type Vec3 } from './physics/engine';
import { advance, ghost, launchWithVelocity, predictLaunch, sample, useStore, world } from './sim';

/** Drag-to-launch: probe speed per scene unit of drag in the body's horizontal plane. */
export const LAUNCH_SCALE = 0.2;
import { atmosphere, bodyTexture } from './textures';

const TRAIL = 2500; // points kept per body (one per rendered frame)
// shortcut: vector overlays draw the first 1024 bodies only, grow the buffer if body counts go past that
const MAX_VECTORS = 1024;
/** Visual spin in rad per second of viewing. Cosmetic only; rotation has no effect on the dynamics. */
const SPIN: Partial<Record<BodyType, number>> = { star: 0.05, planet: 0.4, 'gas giant': 0.7, moon: 0.1 };

/** One line segment per body, all in a single draw call. */
function vectorLines(color: number): THREE.LineSegments {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_VECTORS * 6), 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
  lines.frustumCulled = false;
  return lines;
}

function fillVectors(lines: THREE.LineSegments, on: boolean, tip: (i: number) => Vec3): void {
  lines.visible = on;
  if (!on) return;
  const attr = lines.geometry.attributes.position as THREE.BufferAttribute;
  const n = Math.min(world.bodies.length, MAX_VECTORS);
  for (let i = 0; i < n; i++) {
    const p = world.bodies[i].pos, d = tip(i);
    attr.array.set([p[0], p[1], p[2], p[0] + d[0], p[1] + d[1], p[2] + d[2]], i * 6);
  }
  lines.geometry.setDrawRange(0, n * 2);
  attr.needsUpdate = true;
}

interface View {
  mesh: THREE.Mesh;
  trail: THREE.Line;
  points: Float32Array;
  count: number;
  spin: number;
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.2, 'rgba(255,255,255,0.4)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function starfield(): THREE.Points {
  const n = 6000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.randomDirection().multiplyScalar(6000);
    // concentrate a third of the stars near a tilted plane for a faint galactic band
    if (i % 3 === 0) v.y *= 0.12;
    v.applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.5).toArray(pos, i * 3);
    const b = 0.35 + Math.random() * 0.65, tint = Math.random();
    col.set([b * (0.8 + 0.2 * tint), b * 0.9, b * (1 - 0.2 * tint)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true }));
}

export function Viewport() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current!;
    const renderer = new THREE.WebGLRenderer();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
    camera.position.set(0, 80, 150);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const velLines = vectorLines(0x7dffb0), forceLines = vectorLines(0xffb454);
    const hole = blackHoleQuad();
    // chaos lab overlay: a dot per twin body and a line from each body to its twin
    const twinLinks = vectorLines(0xffffff);
    const twinDots = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_VECTORS * 3), 3)),
      new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, color: 0xffffff }),
    );
    twinDots.frustumCulled = false;
    scene.add(new THREE.AmbientLight(0xffffff, 0.25), starfield(), velLines, forceLines, twinLinks, twinDots, hole);

    // Post-processing: half-float buffers so stars and the disk can exceed 1.0 and bloom; MSAA on the scene pass.
    const target = (samples: number) => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    const composer = new EffectComposer(renderer, target(4));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.3, 0.85); // strength, radius, threshold
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    const behindHole = target(0); // the scene without the hole, which the lensing shader samples
    behindHole.depthTexture = new THREE.DepthTexture(1, 1); // lets the shader tell foreground from background

    const sphere = new THREE.SphereGeometry(1, 48, 24);
    const glow = glowTexture();
    const views = new Map<number, View>();

    const addView = (b: Body): View => {
      const map = bodyTexture(b.type, b.color);
      let material: THREE.Material;
      if (b.type === 'star') {
        // above 1.0 on purpose: only emitters cross the bloom threshold
        material = new THREE.MeshBasicMaterial(map ? { map, color: new THREE.Color(1.15, 1.15, 1.15) } : { color: b.color });
      } else if (b.type === 'black hole') {
        // Drawn by the lensing quad instead. Kept as a mesh for click-selection and to carry the
        // light, but it must not write colour or depth or the shader would see it as a foreground body.
        material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
      } else if (map) {
        material = eclipseMaterial(map); // planets, gas giants, moons: lit by every star, with eclipses
      } else {
        material = new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.85 }); // asteroids, comets
      }
      const mesh = new THREE.Mesh(sphere, material);
      mesh.userData.id = b.id;

      if (b.type === 'star') {
        mesh.add(new THREE.PointLight(b.color, 2.5, 0, 0)); // decay 0: sim units are not metres
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glow, color: b.color, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.4,
        }));
        halo.scale.setScalar(6);
        mesh.add(halo);
      }
      if (b.type === 'black hole') mesh.add(new THREE.PointLight(0xff8a3c, 1.6, 0, 0)); // disk glow lights nearby bodies
      if (b.type === 'planet') mesh.add(atmosphere(b.color, 1.09));
      if (b.type === 'gas giant') mesh.add(atmosphere(b.color, 1.05));

      const points = new Float32Array(TRAIL * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(points, 3));
      const trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: b.color, transparent: true, opacity: 0.7 }));
      trail.frustumCulled = false; // bounding sphere is never recomputed
      scene.add(mesh, trail);
      return { mesh, trail, points, count: 0, spin: SPIN[b.type] ?? 0 };
    };

    const removeView = (id: number, v: View) => {
      scene.remove(v.mesh, v.trail);
      // surface textures are cached and shared across bodies, so only materials and trail geometry are freed
      v.mesh.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        m?.dispose();
        if (o !== v.mesh) (o as THREE.Mesh).geometry?.dispose();
      });
      v.trail.geometry.dispose();
      (v.trail.material as THREE.Material).dispose();
      views.delete(id);
    };

    const buffer = new THREE.Vector2();
    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      composer.setSize(w, h);
      renderer.getDrawingBufferSize(buffer);
      behindHole.setSize(buffer.x, buffer.y);
      hole.material.uniforms.uRes.value.copy(buffer);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize(); // do not wait for the observer: it does not fire while the tab is hidden
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const ray = new THREE.Raycaster();
    const aimAt = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    };
    const pick = (e: PointerEvent): number | null => {
      aimAt(e);
      const hit = ray.intersectObjects([...views.values()].map((v) => v.mesh), false)[0];
      return hit ? hit.object.userData.id : null;
    };

    // click (not drag) selects a body
    let down = [0, 0];
    const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      useStore.setState({ selectedId: pick(e) });
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    // Shift-drag from a body launches a probe: the arrow in the body's horizontal plane is the
    // launch velocity relative to the body (LAUNCH_SCALE speed per unit), with a predicted path.
    const aim = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)),
      new THREE.LineBasicMaterial({ color: 0xffffff }),
    );
    const pathPoints = new Float32Array(300 * 3);
    const path = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pathPoints, 3)),
      new THREE.LineBasicMaterial({ color: 0x7dffb0, transparent: true, opacity: 0.8 }),
    );
    aim.frustumCulled = path.frustumCulled = false;
    aim.visible = path.visible = false;
    scene.add(aim, path);
    const label = document.createElement('div');
    label.className = 'launch-label';
    label.hidden = true;
    el.appendChild(label);

    let drag: { id: number; off: THREE.Vector3 } | null = null;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0)), onPlane = new THREE.Vector3();
    const endDrag = () => {
      drag = null;
      aim.visible = path.visible = false;
      label.hidden = true;
      controls.enabled = true;
    };
    const dragDown = (e: PointerEvent) => {
      if (!e.shiftKey || e.button !== 0) return;
      const id = pick(e);
      if (id === null) return;
      e.stopPropagation(); // capture phase on the container: orbit controls never see this drag
      controls.enabled = false;
      try {
        el.setPointerCapture(e.pointerId); // keeps the drag alive if the pointer leaves the view
      } catch {
        // best-effort: throws for pointers the browser no longer tracks; the drag still works inside the view
      }
      drag = { id, off: new THREE.Vector3() };
    };
    const dragMove = (e: PointerEvent) => {
      if (!drag) return;
      const b = world.bodies.find((x) => x.id === drag!.id);
      if (!b) return endDrag();
      aimAt(e);
      plane.constant = -b.pos[1];
      if (ray.ray.intersectPlane(plane, onPlane)) drag.off.set(onPlane.x - b.pos[0], 0, onPlane.z - b.pos[2]);
      label.style.transform = `translate(${e.clientX - el.getBoundingClientRect().left + 14}px, ${e.clientY - el.getBoundingClientRect().top + 14}px)`;
    };
    const dragUp = (e: PointerEvent) => {
      if (!drag) return;
      e.stopPropagation();
      const v = drag.off.clone().multiplyScalar(LAUNCH_SCALE);
      if (v.length() > 0.05) launchWithVelocity(drag.id, [v.x, v.y, v.z]);
      endDrag();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && drag) endDrag(); };
    el.addEventListener('pointerdown', dragDown, { capture: true });
    el.addEventListener('pointermove', dragMove);
    el.addEventListener('pointerup', dragUp, { capture: true });
    window.addEventListener('keydown', onKey);

    let raf = 0, lastSample = performance.now(), lastFrame = lastSample, frames = 0, stepMs = 0, epoch = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const s = useStore.getState();
      const elapsed = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;
      if (s.running) stepMs = advance();

      if (s.trailEpoch !== epoch) {
        epoch = s.trailEpoch;
        for (const v of views.values()) {
          v.count = 0;
          v.trail.geometry.setDrawRange(0, 0);
        }
      }

      const alive = new Set<number>();
      const lights = world.bodies.filter(isLight);
      let holeBody: Body | undefined;
      for (const b of world.bodies) {
        alive.add(b.id);
        // shortcut: only the first black hole gets the lensing quad; more would each need their own pass
        if (b.type === 'black hole') holeBody ??= b;
        let v = views.get(b.id);
        if (!v) views.set(b.id, (v = addView(b)));
        v.mesh.position.fromArray(b.pos);
        v.mesh.scale.setScalar(b.radius);
        if (v.mesh.material instanceof THREE.ShaderMaterial) updateEclipse(v.mesh.material, b, world.bodies, lights);
        // a hole's own trail sits at the lens centre and would be smeared into a fake ring
        v.trail.visible = s.showTrails && b.type !== 'black hole';
        if (s.running) {
          v.mesh.rotation.y += v.spin * elapsed;
          v.points.copyWithin(3, 0, (TRAIL - 1) * 3);
          v.points.set(b.pos, 0);
          v.count = Math.min(v.count + 1, TRAIL);
          v.trail.geometry.setDrawRange(0, v.count);
          v.trail.geometry.attributes.position.needsUpdate = true;
        }
      }
      for (const [id, v] of views) if (!alive.has(id)) removeView(id, v);

      // velocity: length = speed (1:1 in scene units)
      fillVectors(velLines, s.showVelocity, (i) => world.bodies[i].vel);
      // gravitational acceleration (force per unit mass): true direction, log-scaled length,
      // because magnitudes span many orders between a star and an asteroid
      if (s.showForce) {
        const acc = world.acc?.length === world.bodies.length ? world.acc : accelerations(world.bodies, s.G, s.softening);
        fillVectors(forceLines, true, (i) => {
          const a = acc[i], mag = Math.hypot(a[0], a[1], a[2]);
          const k = mag > 0 ? (3 * Math.log10(1 + 10 * mag)) / mag : 0;
          return [a[0] * k, a[1] * k, a[2] * k];
        });
      } else forceLines.visible = false;

      if (drag) {
        const b = world.bodies.find((x) => x.id === drag!.id);
        if (!b) endDrag();
        else {
          const p = b.pos, o = drag.off;
          (aim.geometry.attributes.position as THREE.BufferAttribute).array.set([p[0], p[1], p[2], p[0] + o.x, p[1] + o.y, p[2] + o.z]);
          aim.geometry.attributes.position.needsUpdate = true;
          const v = o.clone().multiplyScalar(LAUNCH_SCALE);
          const n = predictLaunch(b.id, [v.x, v.y, v.z], pathPoints);
          path.geometry.setDrawRange(0, n);
          path.geometry.attributes.position.needsUpdate = true;
          aim.visible = true;
          path.visible = n > 1;
          label.hidden = false;
          label.textContent = `speed ${v.length().toFixed(2)} rel. to ${b.name}${n > 1 ? '' : ' (no preview: too many bodies)'}`;
        }
      }

      twinLinks.visible = twinDots.visible = !!ghost;
      if (ghost) {
        const mine = new Map(world.bodies.map((b) => [b.id, b]));
        const dots = twinDots.geometry.attributes.position as THREE.BufferAttribute;
        const links = twinLinks.geometry.attributes.position as THREE.BufferAttribute;
        const n = Math.min(ghost.bodies.length, MAX_VECTORS);
        for (let i = 0; i < n; i++) {
          const g = ghost.bodies[i], b = mine.get(g.id) ?? g; // no partner left (merged away): zero-length link
          dots.array.set(g.pos, i * 3);
          links.array.set([b.pos[0], b.pos[1], b.pos[2], g.pos[0], g.pos[1], g.pos[2]], i * 6);
        }
        twinDots.geometry.setDrawRange(0, n);
        twinLinks.geometry.setDrawRange(0, n * 2);
        dots.needsUpdate = links.needsUpdate = true;
      }

      // camera follows the selected body
      const sel = views.get(s.selectedId ?? -1);
      if (sel) {
        camera.position.add(sel.mesh.position).sub(controls.target);
        controls.target.copy(sel.mesh.position);
      }
      controls.update();

      hole.visible = false;
      if (holeBody) {
        // pass 1: everything except the hole, for the lensing shader to sample
        renderer.setRenderTarget(behindHole);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        const u = hole.material.uniforms;
        u.tBg.value = behindHole.texture;
        u.tDepth.value = behindHole.depthTexture;
        camera.getWorldDirection(u.uFwd.value);
        u.uNear.value = camera.near;
        u.uFar.value = camera.far;
        u.uHole.value.fromArray(holeBody.pos);
        u.uRs.value = holeBody.radius;
        u.uCam.value.copy(camera.position).sub(u.uHole.value).divideScalar(holeBody.radius);
        u.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        u.uTime.value = world.time; // disk animation follows sim time, so it pauses and rewinds too
        hole.position.fromArray(holeBody.pos);
        hole.quaternion.copy(camera.quaternion);
        hole.scale.setScalar(quadSize(holeBody.radius));
        hole.visible = true;
      }
      bloom.enabled = s.bloom;
      composer.render();

      frames++;
      if (now - lastSample >= 250) {
        sample((frames * 1000) / (now - lastSample), stepMs);
        frames = 0;
        lastSample = now;
      }
    };
    raf = requestAnimationFrame(frame);
    // dev-only seam: lets a script drive frames when the tab is hidden and rAF is suspended
    if (import.meta.env.DEV) Object.assign(window, { __orbital: { frame, renderer, camera, controls, resize } });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      ro.disconnect();
      controls.dispose();
      composer.dispose();
      behindHole.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={ref} className="viewport" />;
}
