// Sphere.js — the World centerpiece. A GPU particle sphere: points on a Fibonacci
// lattice, displaced by 3D simplex noise in the vertex shader, colored by a slowly-
// sweeping gradient. All motion is on the GPU (uniforms only per frame) so it holds
// framerate. A tiny state machine — idle / thinking / talking — lerps the driving
// uniforms so transitions are smooth, never a jump.
//
// The scene holds a FORMATION of such bodies: Cortana and her companions arrange together
// in rings of at most five. A sixth live orb starts a staggered ring one layer higher
// instead of widening the first circle forever; later groups repeat that pattern. Every
// roster change reflows the formation (positions lerp there; nothing snaps). A faint cyan
// perspective grid floor sits under the formation's centre. The camera never free-orbits:
// it parks behind whichever orb has focus, lowering its elevation when raised layers exist
// so they remain visible, and a focus switch arcs it OVER THE TOP of the spheres with a
// fast-then-decelerating tween (click an orb, or window.cortana.sphere.focus(i)). There
// is no drag — the orbs' own slow self-rotation carries the motion.
//
// Depends on the vendored global THREE (static/vendor/three.min.js, r128).

import { vivid } from './color.js';

const THREE = window.THREE;

// Ashima 3D simplex noise (public domain) — embedded so the shader has GPU noise.
const SIMPLEX_GLSL = `
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x,289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+1.0*C.xxx; vec3 x2=x0-i2+2.0*C.xxx; vec3 x3=x0-1.0+3.0*C.xxx;
  i=mod(i,289.0);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=1.0/7.0; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const VERT = `
precision highp float;
attribute float aRand;
uniform float uTime;          // noise time (accumulated w/ per-state speed)
uniform float uAmp;           // base breathing amplitude (fraction of radius)
uniform float uFreq;          // noise spatial frequency
uniform float uRadius;
uniform float uSize;
uniform float uPixelRatio;
uniform float uRipple;        // 0..1 thinking ripple intensity
uniform vec3  uRippleOrigin;  // unit-sphere origin of the current wavefront
uniform float uRippleR;       // current wavefront radius (advances then resets)
uniform float uTalk;          // 0..1 talking blend
uniform float uAudio;         // live speech loudness (0..1, from the daemon's PCM)
uniform float uFirePull;      // 0..1 delegation bulge toward the live receiver
uniform vec3  uFireDir;       // receiver direction in the orb's rotating local frame
uniform vec3  uImpactDir;     // impact point in the receiver's rotating local frame
uniform float uStreamOn;      // 0..1 while a delegation jet is landing
uniform float uCutT;          // seconds since the stream cut; <0 when inactive
uniform float uHitT;          // seconds since the leading edge struck; <0 when inactive
uniform float uRingClock;     // monotonic landing-ripple clock
uniform float uImpactAmp;     // tuned delegation ripple strength
uniform vec3  uGradA;         // rotating gradient axis
uniform vec3  uColA;          // blue
uniform vec3  uColB;          // magenta
uniform vec3  uLightDir;      // rotating light — one side sits in shadow
varying vec3  vColor;
varying float vFade;
varying float vShade;
varying float vImpact;
${SIMPLEX_GLSL}
void main(){
  vec3 n = normalize(position);
  // 1) low-frequency breathing surface. A single low-frequency octave is deliberate:
  //    neighbouring points then share almost the same displacement, so the cloud reads
  //    as one continuous skin flexing — never a cracked shell of diverging points.
  float noise = snoise(n * uFreq + uTime);
  float disp = noise * uAmp;
  // 2) thinking swell — a BROAD gaussian wavefront rolling out from a moving origin.
  //    Wide (soft falloff) on purpose: a narrow ring used to split the surface into a
  //    visible tear; this passes through as a gentle bulge that the whole skin follows.
  if (uRipple > 0.001) {
    float d = distance(n, uRippleOrigin);
    float wave = exp(-pow((d - uRippleR) * 1.55, 2.0));
    disp += wave * uRipple * 0.085;
  }
  // 3) talking — her ACTUAL voice drives the body. uAudio is the live loudness
  //    envelope of the audio playing right now; it scales one coherent higher-octave
  //    flex of the whole skin, so a loud syllable pushes the surface further out and
  //    silence relaxes back to the breathing body. Same single-octave rule as the
  //    breathing: the skin deforms as one piece, it never shatters into bands.
  if (uTalk > 0.001) {
    // WHOLE-BODY morph, not surface bumps: near-DC noise (one or two lobes across
    // the entire body) and SIGNED displacement — one side swells while the other
    // draws in, so at full voice the sphere reads as a different shape entirely
    // (stretched, lopsided), relaxing back to a sphere between words. A smaller
    // mid-frequency term keeps the surface alive inside the big shape.
    float shapeN  = snoise(n * 0.75 + uTime * 1.9);
    float detailN = snoise(n * 1.8  - uTime * 1.3);
    disp += uTalk * uAudio * (0.36 * shapeN + 0.10 * detailN);
  }

  // Delegation launch: the sender reaches toward the muzzle instead of remaining a
  // disconnected ball behind the jet. Kept local to the facing cap so the whole orb
  // does not swell.
  if (uFirePull > 0.001) {
    float face = max(0.0, dot(n, uFireDir));
    disp += uFirePull * pow(face, 3.0) * 0.07;
  }

  float impact = 0.0;
  // Sustained landing: two overlapping wave packets and a pressure dimple stay locked
  // to the live sender direction while the jet is playing on the receiver shell.
  if (uStreamOn > 0.001) {
    float d = distance(n, uImpactDir);
    float w1 = sin(d * 7.0  - uRingClock * 6.0);
    float w2 = sin(d * 11.0 - uRingClock * 9.0 + 1.7);
    float envl = exp(-pow(d * 2.2, 2.0));
    impact += uStreamOn * envl * (0.018 * w1 + 0.012 * w2);
    impact -= uStreamOn * exp(-pow(d * 3.2, 2.0)) * 0.03;
  }
  // The leading edge striking the shell is its own sharp beat; it fires at contact,
  // not later when the burst ends.
  if (uHitT >= 0.0) {
    float d = distance(n, uImpactDir);
    float phase = d - uHitT * 2.1;
    impact += 0.07 * exp(-3.4 * uHitT) * exp(-pow(phase * 2.8, 2.0))
              * cos(10.0 * phase);
    impact -= 0.045 * exp(-9.0 * uHitT) * exp(-pow(d * 3.4, 2.0));
  }
  // Once the tail clears, one larger damped ring closes the surface and rebounds.
  if (uCutT >= 0.0) {
    float d = distance(n, uImpactDir);
    float phase = d - uCutT * 1.7;
    float wave = exp(-2.5 * uCutT) * exp(-pow(phase * 2.4, 2.0))
                 * cos(9.0 * phase);
    impact += 0.11 * wave;
    impact += 0.05 * exp(-6.0 * uCutT) * exp(-pow(d * 3.2, 2.0));
  }
  impact *= uImpactAmp;
  disp += impact;
  vImpact = impact;
  vec3 pos = position + n * disp * uRadius;

  // gradient: project point onto the (rotating) gradient axis → [0,1] → blue→magenta
  float g = clamp(dot(n, uGradA) * 0.5 + 0.5, 0.0, 1.0);
  g = smoothstep(0.1, 0.9, g);
  vColor = mix(uColA, uColB, g);
  vFade  = 0.55 + 0.45 * aRand;   // subtle per-point brightness variation
  // directional shade: the hemisphere facing away from the (rotating) light dims,
  // giving a soft moving terminator — but the floor is kept high enough that the shadow
  // side still shows its colour/gradient rather than going near-black.
  float lit = dot(normalize(pos), uLightDir);
  vShade = mix(0.5, 1.0, smoothstep(-0.55, 0.85, lit));

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  // uSize is ~CSS-px; ×DPR for the hi-dpi framebuffer; the ~3.0 baseline is the
  // camera's resting distance, so points hold a near-constant on-screen size.
  gl_PointSize = uSize * uPixelRatio * (3.0 / -mv.z);
}`;

const FRAG = `
precision highp float;
uniform float uBrightness;
varying vec3 vColor;
varying float vFade;
varying float vShade;
varying float vImpact;
void main(){
  // soft circular sprite — round point with a feathered edge, no square GL dots
  vec2 c = gl_PointCoord - vec2(0.5);
  float r = length(c);
  float alpha = smoothstep(0.5, 0.2, r) * 0.99;   // solid enough to read on the dark world
  if (alpha < 0.01) discard;
  float crest = clamp(vImpact, 0.0, 1.0);
  vec3 col = vColor * uBrightness * vFade * vShade * (1.0 + crest * 7.0)
             + vec3(0.45, 0.28, 0.12) * crest * 3.0;
  gl_FragColor = vec4(col, alpha * (0.6 + 0.4 * vShade));     // shadow side stays visible, just dimmer
}`;

// --- the grid floor: a flat plane of faint cyan lines that fade radially, so it only
// reads under/around the primary sphere and dissolves before the frame edges. Constant
// world-fraction line width (no derivatives extension needed) — distant lines naturally
// thin out under perspective, which is exactly the receding-floor cue we want.
const GRID_VERT = `
precision highp float;
varying vec2 vXZ;
void main(){
  vXZ = position.xy;                                 // plane's local coords (pre-rotation)
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const GRID_FRAG = `
precision highp float;
varying vec2 vXZ;
uniform float uCell;
uniform vec3  uColor;
uniform float uOpacity;
uniform float uFade;
uniform float uTime;
void main(){
  vec2 gg = vXZ / uCell;
  vec2 gf = abs(fract(gg - 0.5) - 0.5);              // 0 on a gridline, →0.5 between
  float line = 1.0 - smoothstep(0.0, 0.04, min(gf.x, gf.y));
  float d = length(vXZ);
  float radial = 1.0 - smoothstep(uFade * 0.16, uFade, d);   // strong under the centre, gone by uFade
  // animation: a soft ring of light rolls out from the centre every few seconds (holotable
  // scan), over a slow whole-grid breath. Both ride ON uOpacity so the grid stays faint.
  float pulseR = mod(uTime * 1.5, uFade * 1.25);              // travelling wavefront radius
  float pulse  = exp(-pow((d - pulseR) * 0.9, 2.0));          // wide gaussian ring
  float breath = 0.85 + 0.15 * sin(uTime * 0.45);
  float a = line * radial * uOpacity * (breath + pulse * 1.6);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
}`;

// Per-state targets the uniforms lerp toward. Kept small and readable on purpose.
// Morphing is the dominant motion cue. `thinking` is deliberately LOW frequency + modest
// amplitude with a gentle ripple, so the body deforms as one fluid blob (see the shader
// notes) instead of tearing. Brightness stays low so the cloud reads as a dim, subtle body.
const STATES = {
  idle:     { amp: 0.110, freq: 1.50, noiseSpeed: 0.24, gradSpeed: 0.09, rotSpeed: 0.100, ripple: 0.0, talk: 0.0, bright: 1.99 },
  thinking: { amp: 0.150, freq: 1.15, noiseSpeed: 0.52, gradSpeed: 0.26, rotSpeed: 0.110, ripple: 0.9, talk: 0.0, bright: 1.10 },
  talking:  { amp: 0.120, freq: 1.70, noiseSpeed: 0.32, gradSpeed: 0.15, rotSpeed: 0.070, ripple: 0.0, talk: 1.0, bright: 1.06 },
};
// Jonathan's chosen delegation-demo settings, baked into the production animation.
const DELEGATION_JET = Object.freeze({
  speed: 0.80, density: 1600, burst: 0.50, head: 0.30, ripple: 2.00,
});

// One particle body: its own geometry, shader uniforms, state machine and a group we can
// position/scale in the shared scene. An invisible proxy mesh rides in the group so the
// orb is clickable (raycast target) at whatever scale it currently sits.
class Orb {
  constructor(scene, cfg, opts = {}) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.state = 'idle';
    this.working = false; this.thinkingUntil = 0;
    this.cur = { ...STATES.idle };
    this.noiseT = Math.random() * 100;      // desync the orbs' morphs
    this.gradPhase = Math.random() * 6.283;
    this.rotY = 0; this.lightPhase = Math.random() * 6.283;
    this.rippleR = 2.0; this.rippleTimer = Math.random() * 1.5;
    this.ringClock = 0;
    this.env = null; this.envT = 0; this.envDur = 0;   // live speech envelope playback
    this.audioLevel = 0; this.audioLast = 0;
    this.analyser = null; this.freqData = null;
    this.curScale = cfg.restScale;          // lerps between restScale (unfocused) and focusScale
    this.focusBright = cfg.dim;             // lerps toward full (focused) or dim (unfocused)
    // --- spawn/absorb lifecycle: every orb is born at Cortana's centre and glides out to its
    // layout slot; `appear` (0→1) scales + brightens it in so it morphs bigger along the way,
    // and on absorb it runs back to 0 while sliding to the centre, then the loop reaps it.
    this.targetPos = new THREE.Vector3(0, 0, 0);
    this.appear = opts.spawn ? 0.001 : 1;
    this.appearTarget = 1;
    this.dying = false;
    this.bodyPos = new THREE.Vector3();
    // Delegation launch/landing state is keyed by stream, so overlapping handoffs cannot
    // make one another snap back to rest when only one stream ends.
    this.fireStreams = new Map(); this.landingStreams = new Map();
    this.firePull = 0; this.firePullTarget = 0; this.fireBright = 0;
    this.fireBrightTarget = 0;
    this.fireWorld = new THREE.Vector3(1, 0, 0);
    this.recoilCur = new THREE.Vector3(); this.recoilTarget = new THREE.Vector3();
    this.streamOn = 0; this.streamOnTarget = 0; this.cutT = -1; this.hitT = -1;
    this.impactWorld = new THREE.Vector3(0, 0, 1);
    this._fireLocal = new THREE.Vector3(); this._impactLocal = new THREE.Vector3();

    const N = cfg.count, radius = 1.0;
    const pos = new Float32Array(N * 3), rnd = new Float32Array(N);
    const gold = Math.PI * (3 - Math.sqrt(5));           // golden angle — even Fibonacci lattice
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;                    // y ∈ [1,-1]
      const rr = Math.sqrt(1 - y * y);
      const th = gold * i;
      pos[i*3] = Math.cos(th) * rr * radius;
      pos[i*3+1] = y * radius;
      pos[i*3+2] = Math.sin(th) * rr * radius;
      rnd[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));

    const col = c => new THREE.Color(vivid(c));   // painted colour gets the lightness floor
    this.uniforms = {
      uTime: { value: 0 }, uAmp: { value: 0.03 }, uFreq: { value: 1.5 },
      uRadius: { value: radius }, uSize: { value: cfg.size },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uRipple: { value: 0 }, uRippleOrigin: { value: new THREE.Vector3(0, 1, 0) }, uRippleR: { value: 2 },
      uTalk: { value: 0 }, uAudio: { value: 0 },
      uFirePull: { value: 0 }, uFireDir: { value: new THREE.Vector3(1, 0, 0) },
      uImpactDir: { value: new THREE.Vector3(0, 0, 1) }, uStreamOn: { value: 0 },
      uCutT: { value: -1 }, uHitT: { value: -1 }, uRingClock: { value: 0 },
      uImpactAmp: { value: DELEGATION_JET.ripple },
      uGradA: { value: new THREE.Vector3(1, 0.2, 0.3).normalize() },
      uLightDir: { value: new THREE.Vector3(1, 0.3, 0.5).normalize() },
      uColA: { value: col(cfg.colA) }, uColB: { value: col(cfg.colB) },
      uBrightness: { value: 1.0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);

    this.group = new THREE.Group();
    this.group.position.set(0, 0, 0);              // addOrb seats a spawn at its formation slot
    this.group.scale.setScalar(cfg.restScale * this.appear);
    this.group.add(this.points);
    // invisible raycast proxy — radius 1 in group space → tracks the point cloud at any scale
    this.proxy = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12),
      new THREE.MeshBasicMaterial({ visible: false }));
    this.proxy.userData.orb = this;
    this.group.add(this.proxy);
    scene.add(this.group);
  }

  setState(s) { if (STATES[s]) this.state = s; }
  setWorking(on) { this.working = !!on; }
  activateThinking(ms = 1600) {
    this.thinkingUntil = Math.max(this.thinkingUntil, performance.now() + ms);
  }

  _lastDirection(streams, out) {
    for (const dir of streams.values()) out.copy(dir);
    return out;
  }
  beginFiring(stream, dir) {
    const tracked = this.fireStreams.get(stream);
    if (tracked) tracked.copy(dir); else this.fireStreams.set(stream, dir.clone());
    this.fireWorld.copy(dir); this.firePullTarget = 1; this.fireBrightTarget = 0.25;
    this.recoilTarget.copy(dir).multiplyScalar(-0.06);
  }
  endFiring(stream) {
    this.fireStreams.delete(stream);
    if (this.fireStreams.size) {
      this._lastDirection(this.fireStreams, this.fireWorld);
      this.recoilTarget.copy(this.fireWorld).multiplyScalar(-0.06);
    } else {
      this.firePullTarget = 0; this.fireBrightTarget = 0; this.recoilTarget.set(0, 0, 0);
    }
  }
  beginLanding(stream, impactDir) {
    const tracked = this.landingStreams.get(stream);
    if (tracked) tracked.copy(impactDir);
    else this.landingStreams.set(stream, impactDir.clone());
    this.impactWorld.copy(impactDir); this.streamOnTarget = 1; this.cutT = -1;
  }
  impactStrike(impactDir) {
    this.impactWorld.copy(impactDir); this.hitT = 0;
  }
  endLanding(stream) {
    this.landingStreams.delete(stream);
    if (this.landingStreams.size) {
      this._lastDirection(this.landingStreams, this.impactWorld);
    } else {
      this.streamOnTarget = 0; this.cutT = 0;
    }
  }

  // Live speech envelope from the daemon: `env` is an array of ~50ms loudness values
  // (0..1) covering `dur` seconds of the audio that just started playing. update()
  // walks through it in real time so the morph tracks her actual syllables.
  setAudio(env, dur) {
    this.env = env && env.length ? env : null;
    this.envDur = Math.max(dur || 0, 0.05);
    this.envT = 0;
    this.audioLast = performance.now();
  }

  // advance this orb's morph + push its uniforms. `focused` drives the scale/brightness
  // lerp so the hero orb is bright and large while the other sits back, small and dim.
  update(dt, focused) {
    const visualState = this.working || performance.now() < this.thinkingUntil
      ? 'thinking' : this.state;
    const tgt = STATES[visualState], k = 1 - Math.pow(0.001, dt);   // ~exp smoothing
    for (const key of ['amp','freq','noiseSpeed','gradSpeed','rotSpeed','ripple','talk','bright'])
      this.cur[key] += (tgt[key] - this.cur[key]) * k;

    this.noiseT += dt * this.cur.noiseSpeed;
    this.gradPhase += dt * this.cur.gradSpeed;
    this.rotY += dt * this.cur.rotSpeed;
    this.lightPhase += dt * 0.055;
    this.ringClock += dt;
    this.firePull += (this.firePullTarget - this.firePull) * k;
    this.fireBright += (this.fireBrightTarget - this.fireBright) * k;
    this.recoilCur.lerp(this.recoilTarget, k);
    this.streamOn += (this.streamOnTarget - this.streamOn) * k;
    if (this.cutT >= 0) { this.cutT += dt; if (this.cutT > 2.6) this.cutT = -1; }
    if (this.hitT >= 0) { this.hitT += dt; if (this.hitT > 1.6) this.hitT = -1; }

    // thinking swell: roll a wavefront out, then relaunch from a new random origin
    this.rippleTimer -= dt;
    this.rippleR += dt * 1.4;
    if (this.rippleTimer <= 0) {
      this.rippleTimer = 1.8;
      this.rippleR = 0;
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u*u);
      this.uniforms.uRippleOrigin.value.set(Math.cos(a)*s, u, Math.sin(a)*s);
    }

    // speech envelope → uAudio. Fast attack / slower release so each loud syllable
    // lands as a distinct push instead of a smear. If she's talking but no envelope
    // is flowing (afplay fallback path has no PCM tap), a gentle pulse keeps the
    // body alive rather than frozen.
    let aTgt = 0;
    if (this.env) {
      this.envT += dt;
      if (this.envT >= this.envDur) this.env = null;
      else aTgt = this.env[Math.min(this.env.length - 1,
                                    Math.floor(this.envT / this.envDur * this.env.length))];
    }
    if (this.cur.talk > 0.02 && !this.env
        && performance.now() - (this.audioLast || 0) > 600) {
      aTgt = 0.28 + 0.14 * Math.sin(this.noiseT * 6.0);
    }
    // tight time constants (20ms attack / 60ms release) so each syllable reads as
    // its own push — the old slow release smeared words into one continuous wobble
    const ka = 1 - Math.exp(-dt / (aTgt > this.audioLevel ? 0.02 : 0.06));
    this.audioLevel += (aTgt - this.audioLevel) * ka;

    // focus lerp — scale toward focusScale/restScale, brightness toward full/dim
    const fScale = focused ? this.cfg.focusScale : this.cfg.restScale;
    const fBright = focused ? 1.0 : this.cfg.dim;
    this.curScale += (fScale - this.curScale) * k;
    this.focusBright += (fBright - this.focusBright) * k;
    // glide toward the layout slot (spawn emerges from centre, absorb slides back into it);
    // `appear` grows/shrinks the body + fades brightness so it morphs as it travels.
    // a plain scale/brightness fade rides `appear` (no summon flash) — 1 at rest; only used to
    // ease an absorbing orb out to nothing on delete.
    this.bodyPos.lerp(this.targetPos, k);
    this.group.position.copy(this.bodyPos).add(this.recoilCur);
    this.appear += (this.appearTarget - this.appear) * k;
    this.group.scale.setScalar(this.curScale * this.appear);

    // Counter-rotate the world-fixed launch/impact directions into the point lattice's
    // local frame. The orb can keep spinning without dragging the muzzle or ripple around.
    const c = Math.cos(-this.rotY), s = Math.sin(-this.rotY);
    this._fireLocal.set(this.fireWorld.x * c + this.fireWorld.z * s, this.fireWorld.y,
                        -this.fireWorld.x * s + this.fireWorld.z * c);
    this._impactLocal.set(this.impactWorld.x * c + this.impactWorld.z * s, this.impactWorld.y,
                          -this.impactWorld.x * s + this.impactWorld.z * c);

    const U = this.uniforms;
    U.uTime.value = this.noiseT; U.uAmp.value = this.cur.amp; U.uFreq.value = this.cur.freq;
    U.uRipple.value = this.cur.ripple; U.uRippleR.value = this.rippleR;
    U.uTalk.value = this.cur.talk; U.uAudio.value = this.audioLevel;
    U.uFirePull.value = this.firePull; U.uFireDir.value.copy(this._fireLocal);
    U.uStreamOn.value = this.streamOn; U.uImpactDir.value.copy(this._impactLocal);
    U.uCutT.value = this.cutT; U.uHitT.value = this.hitT; U.uRingClock.value = this.ringClock;
    // her voice also lifts the glow a touch — brightness breathes with the audio
    U.uBrightness.value = this.cur.bright * (1 + this.cur.talk * this.audioLevel * 0.30)
                          * (1 + this.fireBright) * this.focusBright * this.appear;
    U.uGradA.value.set(Math.cos(this.gradPhase), 0.25, Math.sin(this.gradPhase)).normalize();
    U.uLightDir.value.set(Math.cos(this.lightPhase), 0.3 * Math.sin(this.lightPhase * 0.7), Math.sin(this.lightPhase)).normalize();
    this.points.rotation.y = this.rotY;
  }

  worldPos(out) { return out.copy(this.group.position); }   // live — includes launch recoil
  worldRadius() { return Math.max(0.01, this.group.scale.x); }
  sceneVisibility() {
    // Match the rest of the scene: unfocused/spawning orbs are dim, and thinking/talking
    // states deliberately sit below the idle hero's brightness. The jet interpolates this
    // value end-to-end instead of rendering as an independently exposed additive light.
    const stateShade = Math.max(0.45, Math.min(1, this.cur.bright / STATES.idle.bright));
    return Math.max(0.10, Math.min(1,
      this.focusBright * this.appear * (0.55 + 0.45 * stateShade)));
  }

  // recolour live: the gradient endpoints (CSS hex string or 0xRRGGBB). Equal a==b → solid.
  setColors(a, b) { this.uniforms.uColA.value.set(vivid(a)); this.uniforms.uColB.value.set(vivid(b));
    this.cfg.colA = a; this.cfg.colB = b; }

  // free GPU buffers + detach from the scene once fully absorbed
  disposeFrom(scene) {
    scene.remove(this.group);
    this.points.geometry.dispose(); this.points.material.dispose();
    this.proxy.geometry.dispose(); this.proxy.material.dispose();
  }
}

// Cortana — always index 0 and always the first slot in the base ring. Slightly bigger
// than a companion (she stays the anchor of the shape) and framed from a touch further
// back so she fills the shot about the same as a focused companion does.
const HERO = { count: 6000, size: 1.8, restScale: 1.00, focusScale: 1.00, focusDist: 6.6,
  dim: 1.0, colA: '#4fb3ff', colB: '#e93d9a' };
// A spawned companion's shared frame. Its position is computed by _layout (a ring slot)
// — never hardcoded; only its colour + id vary per agent. Near-
// Cortana rest size (she's only SLIGHTLY bigger), a mild grow + brighten marks the focus.
const COMPANION = { count: 2600, size: 1.7, restScale: 0.78, focusScale: 0.88, focusDist: 5.6,
  dim: 1.0 };   // unfocused shade — a step below the focused orb, but dark colours must still read

// Cortana and companions share each ring. Five total live orbs fill the base ring;
// overflow starts a staggered ring above it at the same capped radius. The base ring
// grows naturally from one through five bodies, then holds steady so roster growth adds
// vertical structure rather than pushing every orb farther from the camera.
const SPACING = 5.2, MAX_ORBS_PER_LAYER = 5, LAYER_HEIGHT = 2.2;

// Camera geometry: it parks focusDist behind the focused orb — radially OUTSIDE its
// ring, normally lifted by CAM_EL — and aims DOWN the line THROUGH the orb at the central
// axis, so every view looks over the focused orb at the rest of the formation and the
// focused orb sits dead centre in frame (the aim point drops ringR*tan(CAM_EL) below
// its layer height to stay colinear with camera + orb). With raised rings it eases down
// to LAYERED_CAM_EL, opening the view above the base ring. A focus switch tweens
// azimuth/height/distance with a hard ease-out over TWEEN_DUR seconds — and rides an
// ARC over the top of the spheres (lift + pull toward the axis, peaking mid-swing) so
// the view hops the formation instead of swiveling around it. ARC_LIFT is the peak
// extra height; the arc scales with how far around the swing goes.
const CAM_EL = 0.50, LAYERED_CAM_EL = 0.30, TWEEN_DUR = 1.1, ARC_LIFT = 4.5;
const easeOutExpo = t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
const STREAM_VERT = `
precision highp float;
attribute vec3 color;
attribute float aSize;
attribute float aBright;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vBright;
void main(){
  vColor = color; vBright = aBright;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio * (4.0 / max(0.2, -mv.z));
}`;
const STREAM_FRAG = `
precision highp float;
varying vec3 vColor;
varying float vBright;
void main(){
  float a = smoothstep(0.5, 0.06, length(gl_PointCoord - vec2(0.5))) * vBright;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`;

// A straight, sustained plasma jet in the sender's own gradient. Every particle stores
// normalized progress along the LIVE source→receiver shell gap, so roster relayout, recoil,
// different radii, distance, and any 3D angle cannot detach the stream from either orb.
class PlasmaStream {
  constructor(scene, from, to) {
    this.scene = scene; this.from = from; this.to = to;
    this.age = 0; this.emitDur = DELEGATION_JET.burst;
    this.spawnRate = DELEGATION_JET.density; this.spawnAcc = 0;
    this.endpointsReleased = false; this.arrived = false; this.headScale = 1;
    this.POOL = 720; const N = this.POOL;
    this.pos = new Float32Array(N * 3); this.col = new Float32Array(N * 3);
    this.size = new Float32Array(N); this.bright = new Float32Array(N);
    this.pS = new Float32Array(N); this.pAge = new Float32Array(N);
    this.active = new Uint8Array(N);
    this.seedX = new Float32Array(N); this.seedY = new Float32Array(N);
    this.phA = new Float32Array(N); this.phB = new Float32Array(N);
    this.sSpeed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.pos[i * 3] = this.pos[i * 3 + 1] = this.pos[i * 3 + 2] = 9999;
      this.seedX[i] = Math.random() * 2 - 1; this.seedY[i] = Math.random() * 2 - 1;
      this.phA[i] = Math.random() * 6.283; this.phB[i] = Math.random() * 6.283;
      this.sSpeed[i] = 2.15 + Math.random() * 0.55;
    }

    // The stream remains unmistakably the sender's light instead of blending into the
    // receiver: secondary→primary along the plume, with a near-white sender-tinted bow.
    const cA = new THREE.Color(vivid(from.cfg.colB || from.cfg.colA));
    const cB = new THREE.Color(vivid(from.cfg.colA || from.cfg.colB));
    const cH = new THREE.Color(vivid(from.cfg.colA)).lerp(new THREE.Color(0xffffff), 0.42);
    this.cA = { r: cA.r, g: cA.g, b: cA.b };
    this.cB = { r: cB.r, g: cB.g, b: cB.b };
    this.cH = { r: cH.r, g: cH.g, b: cH.b };

    const geo = new THREE.BufferGeometry();
    const dyn = THREE.DynamicDrawUsage;
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(dyn));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(dyn));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(dyn));
    geo.setAttribute('aBright', new THREE.BufferAttribute(this.bright, 1).setUsage(dyn));
    const mat = new THREE.ShaderMaterial({
      vertexShader: STREAM_VERT, fragmentShader: STREAM_FRAG,
      uniforms: { uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat); this.points.frustumCulled = false;
    scene.add(this.points);

    this.src = new THREE.Vector3(); this.dst = new THREE.Vector3();
    this.dir = new THREE.Vector3(); this.p0 = new THREE.Vector3();
    this.p1 = new THREE.Vector3(); this.gap = new THREE.Vector3();
    this.side = new THREE.Vector3(); this.lift = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0); this.axisX = new THREE.Vector3(1, 0, 0);
    this.impact = new THREE.Vector3();
  }

  update(dt) {
    this.age += dt;
    const emitting = this.age < this.emitDur;

    // Resolve both shell contacts every frame. Insets are capped when two spawning orbs
    // happen to be unusually close, so start/end never cross or reverse the trajectory.
    this.from.worldPos(this.src); this.to.worldPos(this.dst);
    this.dir.subVectors(this.dst, this.src);
    const distance = Math.max(0.001, this.dir.length());
    this.dir.multiplyScalar(1 / distance);
    const fromInset = Math.min(this.from.worldRadius() * 0.95, distance * 0.48);
    const toInset = Math.min(this.to.worldRadius() * 0.95, distance * 0.48);
    this.p0.copy(this.src).addScaledVector(this.dir, fromInset);
    this.p1.copy(this.dst).addScaledVector(this.dir, -toInset);
    this.gap.subVectors(this.p1, this.p0);

    // Choose the reference axis least parallel to the path, then derive an orthonormal
    // cross-section. This keeps plume turbulence perpendicular at horizontal, diagonal,
    // vertical, near-camera, and far-camera angles.
    const ref = Math.abs(this.dir.y) < 0.92 ? this.up : this.axisX;
    this.side.crossVectors(this.dir, ref).normalize();
    this.lift.crossVectors(this.side, this.dir).normalize();

    this.impact.copy(this.dir).multiplyScalar(-1);
    if (emitting) {
      this.from.beginFiring(this, this.dir);
      this.to.beginLanding(this, this.impact);
    } else {
      this._releaseEndpoints();
    }

    if (emitting) {
      this.spawnAcc += this.spawnRate * dt;
      for (let i = 0; i < this.POOL && this.spawnAcc >= 1; i++) {
        if (!this.active[i]) {
          this.active[i] = 1; this.pS[i] = Math.random() * 0.02;
          this.pAge[i] = 0; this.spawnAcc -= 1;
        }
      }
    }

    let frontS = -1, anyAlive = false, hitThisFrame = false;
    for (let i = 0; i < this.POOL; i++) {
      if (!this.active[i]) continue;
      this.pAge[i] += dt;
      this.pS[i] += this.sSpeed[i] * DELEGATION_JET.speed * dt;
      if (this.pS[i] >= 1.0 || this.pAge[i] > 1.6) {
        hitThisFrame = hitThisFrame || this.pS[i] >= 1.0;
        this.active[i] = 0;
        const j = i * 3;
        this.pos[j] = this.pos[j + 1] = this.pos[j + 2] = 9999;
        continue;
      }
      anyAlive = true;
      if (this.pS[i] > frontS) frontS = this.pS[i];
    }

    if (!this.arrived && (hitThisFrame || frontS >= 0.985)) {
      this.arrived = true;
      this.to.impactStrike(this.impact);
    }
    if (this.arrived) this.headScale = Math.max(0.3, this.headScale - dt * 4.0);

    const t = this.age;
    const fromShade = this.from.sceneVisibility(), toShade = this.to.sceneVisibility();
    for (let i = 0; i < this.POOL; i++) {
      if (!this.active[i]) continue;
      const s = this.pS[i], j = i * 3;
      const distFromHead = Math.min(1, Math.max(0, frontS - s));
      const headness = (frontS <= 0 ? 0
        : Math.min(1, Math.max(0, (s - (frontS - 0.22)) / 0.22))) * this.headScale;
      const spread = 0.03 + 0.09 * distFromHead;
      const turb = 0.4 + distFromHead;
      const ox = this.seedX[i] * spread
        + Math.sin(t * 22.0 + this.phA[i]) * spread * turb;
      const oy = this.seedY[i] * spread
        + Math.sin(t * 17.0 + this.phB[i]) * spread * turb;
      this.pos[j] = this.p0.x + this.gap.x * s + this.side.x * ox + this.lift.x * oy;
      this.pos[j + 1] = this.p0.y + this.gap.y * s + this.side.y * ox + this.lift.y * oy;
      this.pos[j + 2] = this.p0.z + this.gap.z * s + this.side.z * ox + this.lift.z * oy;
      this.size[i] = 3.1 + 5.2 * headness * DELEGATION_JET.head;
      const sceneShade = fromShade + (toShade - fromShade) * s;
      this.bright[i] = sceneShade * (0.32 + 0.16 * headness);
      const hb = headness * 0.85;
      const br = this.cA.r + (this.cB.r - this.cA.r) * s;
      const bg = this.cA.g + (this.cB.g - this.cA.g) * s;
      const bb = this.cA.b + (this.cB.b - this.cA.b) * s;
      this.col[j] = br + (this.cH.r - br) * hb;
      this.col[j + 1] = bg + (this.cH.g - bg) * hb;
      this.col[j + 2] = bb + (this.cH.b - bb) * hb;
    }

    const attrs = this.points.geometry.attributes;
    attrs.position.needsUpdate = true; attrs.color.needsUpdate = true;
    attrs.aSize.needsUpdate = true; attrs.aBright.needsUpdate = true;
    return !emitting && !anyAlive;
  }

  _releaseEndpoints() {
    if (this.endpointsReleased) return;
    this.endpointsReleased = true;
    this.from.endFiring(this); this.to.endLanding(this);
  }

  dispose() {
    this._releaseEndpoints();
    this.scene.remove(this.points); this.points.geometry.dispose(); this.points.material.dispose();
  }
}

export default class Sphere {
  constructor(container, opts = {}) {
    this.container = container;
    this.onFocus = opts.onFocus || null;   // notified on every focus change
    this.running = true;
    this.focusIdx = 0;
    this.mouse = { x: 0, y: 0 };
    this.transfers = [];
    this._motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._reducedFramePending = false;
    this._onMotionChange = () => {
      // The normal loop has no pending frame after reduced mode; restart it when motion
      // is re-enabled. Entering reduced mode naturally stops on the already queued frame.
      if (!this._motionMedia.matches && this.running) this._loop();
    };
    this._motionMedia.addEventListener('change', this._onMotionChange);
    // camera state — all slot-derived, no free orbit. az = the focused orb's slot azimuth
    // (camera sits radially behind it), camY = that ring's height, camR = distance from
    // the orb. A focus switch captures these as a tween start (see focus()/_loop()).
    this.camAz = Math.PI / 2;                      // slot 0's azimuth (Cortana, boot focus)
    this.camY = 0; this.camR = HERO.focusDist; this.camEl = CAM_EL;
    this._tween = null;                            // { t, az, y, r } while a swing is live
    this.camTarget = new THREE.Vector3(0, 0, 0);   // central axis at the focused ring height
    this._tmp = new THREE.Vector3();
    this._init();
  }

  _init() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0);
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    this.camera.position.set(0, 0, this.camR);

    this._buildFloor();
    // start with only Cortana — every companion is spawned at runtime via addOrb()
    this.orbs = [ new Orb(this.scene, { ...HERO, id: 'cortana' }) ];
    this._layout();
    // no boot glide for the hero — she starts already seated in her slot
    this.orbs[0].group.position.copy(this.orbs[0].targetPos);
    this.orbs[0].bodyPos.copy(this.orbs[0].targetPos);

    this.raycaster = new THREE.Raycaster();
    this._clock = new THREE.Clock();
    this._onResize = () => { this._resize(); this._requestReducedFrame(); };
    window.addEventListener('resize', this._onResize);
    this._initPointer();
    this._loop();
  }

  // faint cyan perspective grid, flat and FIXED under the circle's central point — the
  // whole ring shares one ground, wide enough to read beneath every slot. Kept deliberately
  // quiet (low opacity, well below the ring); the shader's travelling pulse + slow breath
  // (uTime, advanced in _loop) give it life without pulling focus from the orbs.
  _buildFloor() {
    const geo = new THREE.PlaneGeometry(17, 17, 1, 1);
    const mat = new THREE.ShaderMaterial({
      vertexShader: GRID_VERT, fragmentShader: GRID_FRAG,
      uniforms: {
        uCell: { value: 0.5 }, uColor: { value: new THREE.Color(0x27b0bd) },
        uOpacity: { value: 0.07 }, uFade: { value: 6.4 }, uTime: { value: 0 },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.floor = new THREE.Mesh(geo, mat);
    this.floor.rotation.x = -Math.PI / 2;        // lay it flat (XZ world plane)
    this.floorY = -3.5;                          // the one ground level (far down, faint)
    this.floor.position.set(0, this.floorY, 0);
    this.scene.add(this.floor);
  }

  // Cortana and companions fill rings of five together in roster order. Each overflow
  // ring is raised and half-slot staggered so it reads as a distinct layer instead of
  // hiding directly behind the one below. The base radius grows only until its fifth
  // live orb, then every higher ring inherits that capped radius. Dying orbs are excluded
  // (they're absorbing into Cortana) and survivors compact into the open slots.
  // targetPos + slotAng/ringY/ringR are camera anchors; the render loop lerps the bodies.
  _layout() {
    const live = this.orbs.filter(o => !o.dying);
    const baseCount = Math.min(live.length, MAX_ORBS_PER_LAYER);
    this.layoutR = baseCount < 2 ? 0
      : Math.max(2.0, SPACING / (2 * Math.sin(Math.PI / baseCount)));
    this.layerCount = Math.max(1, Math.ceil(live.length / MAX_ORBS_PER_LAYER));

    for (let i = 0; i < live.length; i++) {
      const layer = Math.floor(i / MAX_ORBS_PER_LAYER);
      const first = layer * MAX_ORBS_PER_LAYER;
      const count = Math.min(MAX_ORBS_PER_LAYER, live.length - first);
      const slot = i - first;
      const stagger = layer % 2 ? Math.PI / MAX_ORBS_PER_LAYER : 0;
      const ang = Math.PI / 2 + stagger + (slot / count) * Math.PI * 2;
      const o = live[i], ringY = layer * LAYER_HEIGHT;
      o.slotAng = ang; o.ringY = ringY; o.ringR = this.layoutR;
      o.targetPos.set(
        Math.cos(ang) * this.layoutR, ringY, Math.sin(ang) * this.layoutR);
    }
  }

  // Click-to-focus ONLY — there is no drag/orbit. The view is always the focused orb's
  // slot framing; the orbs' own self-rotation supplies the motion. A press that barely
  // moves before release is a click — raycast it to switch focus between the orbs.
  _initPointer() {
    const el = this.renderer.domElement;
    el.style.pointerEvents = 'auto';        // re-enable on the canvas (world-stage is none)
    let lx = 0, ly = 0, moved = 0;
    const move = e => {
      moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
      lx = e.clientX; ly = e.clientY;
    };
    const up = e => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (moved < 6) this._tryFocusClick(e);        // barely moved → treat as a click
    };
    el.addEventListener('pointerdown', e => {
      lx = e.clientX; ly = e.clientY; moved = 0;
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
  }

  // raycast the click against the orb proxies; if it lands on a non-focused orb, focus it
  _tryFocusClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.orbs.filter(o => !o.dying).map(o => o.proxy), false);
    if (hits.length) {
      const orb = hits[0].object.userData.orb;
      const idx = this.orbs.indexOf(orb);
      if (idx >= 0 && idx !== this.focusIdx) this.focus(idx);
    }
  }

  // --- public API (also reachable via window.cortana.sphere) -------------------
  get orbCount() { return this.orbs.length; }
  get focusIndex() { return this.focusIdx; }
  get focusedId() { const o = this.orbs[this.focusIdx]; return o ? o.id : null; }

  // --- roster: companions added/removed at runtime; _layout keeps them in formation -----
  // Spawn a companion for `agent` ({id, colA, colB}). It is born IN PLACE at its new
  // formation vertex — tiny, then expanding quickly to full size — while the rest of the
  // roster glides to the re-solved shape around it (spawn:true). Pass {spawn:false} to
  // restore a saved orb straight to its slot at full size with no birth animation (boot).
  addOrb(agent, opts = {}) {
    const spawn = opts.spawn !== false && !this._motionMedia.matches;
    const cfg = { ...COMPANION, id: agent.id, colA: agent.colA, colB: agent.colB };
    const orb = new Orb(this.scene, cfg, { spawn });
    this.orbs.push(orb);
    this._layout();
    orb.group.position.copy(orb.targetPos);   // seated at its vertex from frame one
    orb.bodyPos.copy(orb.targetPos);
    if (!spawn) orb.appear = 1;
    this._requestReducedFrame();
    return orb;
  }

  // Absorb a companion back into Cortana: it shrinks + slides to her, then the render loop
  // reaps it once fully faded. The remaining roster re-solves the formation immediately.
  removeOrb(id) {
    const idx = this.orbs.findIndex(o => o.id === id);
    if (idx <= 0) return;                          // never Cortana / not found
    const orb = this.orbs[idx];
    if (orb.dying) return;
    if (this.focusIdx === idx) this.focus(0);      // absorbing the focused orb → back to Cortana
    orb.dying = true; orb.appearTarget = 0; orb.setState('idle');
    orb.targetPos.copy(this.orbs[0].targetPos);    // absorb back into Cortana's slot
    this._layout();
    this._requestReducedFrame();
  }

  setColors(id, colA, colB) {
    const o = this.orbs.find(x => x.id === id);
    if (o) { o.setColors(colA, colB); this._requestReducedFrame(); }
  }
  focusById(id) { const i = this.orbs.findIndex(o => o.id === id && !o.dying); if (i >= 0) this.focus(i); }
  setWorking(id, on) {
    const o = this.orbs.find(x => x.id === id && !x.dying);
    if (o) { o.setWorking(on); this._requestReducedFrame(); }
  }

  // Fire-and-forget plasma jets. These return immediately; callers never await them.
  transfer(fromId, toId) {
    if (!this.running || this._motionMedia.matches) return false;
    // Never replay stale off-screen work, and reduced motion communicates the same state
    // through status text/color without launching a spatial plasma animation.
    const from = this.orbs.find(o => o.id === fromId && !o.dying);
    const to = this.orbs.find(o => o.id === toId && !o.dying);
    if (!from || !to || from === to) return false;
    from.activateThinking(1700); to.activateThinking(1900);
    this.transfers.push(new PlasmaStream(this.scene, from, to));
    return true;
  }
  dispatchTo(companionId) {
    this.setWorking(companionId, true);
    return this.transfer('cortana', companionId);
  }
  returnFrom(companionId) {
    this.setWorking(companionId, false);
    return this.transfer(companionId, 'cortana');
  }

  // move focus to orb `i` — the camera arcs OVER THE TOP of the formation to that orb's
  // framing while it grows/brightens and the one we're leaving drops back to idle and
  // dims. The hop is a hard ease-out tween: it launches fast (up and over), sheds speed,
  // and floats down into the lock (see the tween branch in _loop).
  focus(i) {
    if (i < 0 || i >= this.orbs.length || i === this.focusIdx) return;
    this.orbs[this.focusIdx].setState('idle');   // the one we're leaving returns to rest
    this.focusIdx = i;
    this._tween = { t: 0, az: this.camAz, y: this.camY, r: this.camR };   // swing start
    this._requestReducedFrame();
    if (this.onFocus) this.onFocus(i);
  }
  focusNext() { this.focus((this.focusIdx + 1) % this.orbs.length); }

  // drive idle / thinking / talking on whichever orb currently has focus
  setState(s) {
    this.orbs[this.focusIdx].setState(s);
    this._requestReducedFrame();
  }

  // pause/resume the render loop so we don't drive the GPU when World is off-screen
  pause() { this.running = false; }
  resume() { if (this.running) return; this.running = true; this._clock.getDelta(); this._resize(); this._loop(); }

  // Live speech envelope from the daemon (via VoiceStatus): routed to whichever orb
  // has focus (that's the one that ever enters the talking state).
  audio(env, dur) {
    this.orbs[this.focusIdx].setAudio(env, dur);
    this._requestReducedFrame();
  }

  _requestReducedFrame() {
    if (!this.running || !this._motionMedia.matches || this._reducedFramePending) return;
    this._reducedFramePending = true;
    requestAnimationFrame(() => {
      this._reducedFramePending = false;
      if (this.running && this._motionMedia.matches) this._loop();
    });
  }

  _resize() {
    if (!this.container.clientWidth) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  _loop() {
    if (!this.running) return;
    const reduced = this._motionMedia.matches;
    if (!reduced) requestAnimationFrame(() => this._loop());
    const dt = reduced ? 1 : Math.min(0.05, this._clock.getDelta());
    const k = 1 - Math.pow(0.001, dt);
    if (reduced && this._tween) this._tween.t = 1;

    for (let i = 0; i < this.orbs.length; i++) this.orbs[i].update(dt, i === this.focusIdx);
    for (let i = this.transfers.length - 1; i >= 0; i--) {
      const transfer = this.transfers[i];
      if (transfer.from.dying || transfer.to.dying || transfer.update(dt)) {
        transfer.dispose(); this.transfers.splice(i, 1);
      }
    }

    // reap fully-absorbed orbs (appear shrunk to nothing), keeping focusIdx pinned to the
    // same orb as the array shifts under it.
    for (let i = this.orbs.length - 1; i >= 1; i--) {
      const o = this.orbs[i];
      if (o.dying && o.appear < 0.02) {
        o.disposeFrom(this.scene);
        this.orbs.splice(i, 1);
        if (this.focusIdx === i) this.focusIdx = 0;
        else if (this.focusIdx > i) this.focusIdx--;
      }
    }

    // The camera is fully slot-derived: it wants to sit focusDist radially BEHIND the
    // focused orb's ring slot (outside that ring, lifted by CAM_EL) looking DOWN at the
    // central axis — so every framing looks over the focused orb at the rest of the shape.
    const fo = this.orbs[this.focusIdx];
    const focusRingR = fo.ringR || 0;
    const wantEl = this.layerCount > 1 ? LAYERED_CAM_EL : CAM_EL;
    this.camEl += (wantEl - this.camEl) * k;
    // aspect guard: horizontal FOV shrinks with a narrower canvas (vertical FOV is fixed),
    // so back the camera off by ~1/aspect there — the formation's side vertices stay in
    // frame on a tall/narrow window without shrinking the shot on a wide one.
    const wantAz = fo.slotAng, wantY = fo.ringY,
          wantR = fo.cfg.focusDist * Math.max(1, 1.3 / this.camera.aspect);
    let arc = 0;                        // 0 at rest; sin bump while a focus hop is in flight
    if (this._tween) {
      // focus hop: hard ease-out from the captured start to the (live) slot framing —
      // rapid launch, decelerating approach, exact lock at t=1. The azimuth takes the
      // shortest way round, but the swivel is HIDDEN inside an over-the-top arc: sin(π·e)
      // lifts the camera and pulls it toward the axis, peaking right when the azimuth is
      // changing fastest, so the view leaps over the spheres and floats down behind the
      // target. The arc scales with the swing (≥90° gets the full hop, tiny nudges barely
      // lift) and the pull-in stays ≤55% so lookAt never degenerates on the axis.
      const tw = this._tween;
      tw.t += dt / TWEEN_DUR;
      const e = easeOutExpo(Math.min(1, tw.t));
      let dAz = wantAz - tw.az;
      dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
      this.camAz = tw.az + dAz * e;
      this.camY = tw.y + (wantY - tw.y) * e;
      this.camR = tw.r + (wantR - tw.r) * e;
      arc = Math.sin(Math.PI * e) * Math.min(1, Math.abs(dAz) / (Math.PI * 0.5));
      if (tw.t >= 1) { this.camAz = wantAz; this.camY = wantY; this.camR = wantR; this._tween = null; }
    } else {
      // at rest: gentle exponential tracking so formation reflows (roster changes) drift
      // the camera over rather than snapping it.
      let dAz = wantAz - this.camAz;
      dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
      this.camAz += dAz * k;
      this.camY += (wantY - this.camY) * k;
      this.camR += (wantR - this.camR) * k;
    }
    // look-at = the central axis, dropped just enough below formation height that the
    // camera → orb → axis line is straight — the focused orb sits dead centre in frame
    this.camTarget.set(0, this.camY - focusRingR * Math.tan(this.camEl), 0);
    const rad = (focusRingR + this.camR * Math.cos(this.camEl)) * (1 - 0.55 * arc);
    this.camera.position.set(
      Math.cos(this.camAz) * rad,
      this.camY + this.camR * Math.sin(this.camEl) + arc * ARC_LIFT,
      Math.sin(this.camAz) * rad);
    this.camera.lookAt(this.camTarget);
    this.floor.material.uniforms.uTime.value += dt;      // grid pulse + breath clock

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.running = false;
    window.removeEventListener('resize', this._onResize);
    this._motionMedia.removeEventListener('change', this._onMotionChange);
    this.transfers.forEach(t => t.dispose()); this.transfers = [];
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
