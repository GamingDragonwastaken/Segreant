// The hero plate. Loaded as a module after site.js; without it (or without
// WebGL) the CSS print underneath stays, finished and still.
//
// 1. On the first visit the engraving inks itself in, deepest grooves first.
// 2. The UV lamp: with a mouse it follows the pointer over the plate; the
//    "UV lamp" button holds it on (touch: drag across the note; keyboard: arrows).
// 3. As the hero scrolls away, the note is inspected: a UV disc opens over the
//    griffin and the numbering machine stamps the serial in the plate's corner.
import { Plate } from './plate.js';

const root = document.documentElement;
const fig = document.querySelector('[data-plate]');
const motion = root.classList.contains('motion');
const params = new URLSearchParams(location.search);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
const finePointer = matchMedia('(pointer: fine)').matches;

async function start() {
  const canvas = fig.querySelector('canvas');
  let plate;
  // The engraving sits at 90% of the canvas, so the feathered canvas edge never touches it.
  try { plate = new Plate(canvas, { fit: [0.05, 0.05, 0.9, 0.9] }); } catch { fig.classList.add('no-gl'); return; }
  // Load only the resolution the screen can show.
  const need = fig.getBoundingClientRect().width * Math.min(devicePixelRatio || 1, 2);
  try { await plate.load(need > 1000 ? 'assets/print/plate-griffin.webp' : 'assets/print/plate-griffin-900.webp', 'assets/print/uv-fibres.webp'); }
  catch { fig.classList.add('no-gl'); return; }
  fig.classList.add('gl');

  const runIntro = motion && (root.classList.contains('intro') || params.has('intro'));
  const T0 = performance.now() + 60, DUR = 3200;
  plate.state.progress = runIntro ? 0 : 1;

  // ---- The lamp ----
  const lamp = { target: 0, level: 0, pos: [0.5, 0.45], goal: [0.5, 0.45], held: false };
  const button = document.querySelector('[data-lamp]');
  const note = document.querySelector('[data-lamp-note]');
  const toPlate = (x, y) => { const r = canvas.getBoundingClientRect(); return [(x - r.left) / r.width, (y - r.top) / r.height]; };
  if (finePointer) {
    fig.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse') return; lamp.goal = toPlate(e.clientX, e.clientY); lamp.target = 1; fig.classList.add('lamp-on'); wake(); });
    fig.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !lamp.held) { lamp.target = 0; fig.classList.remove('lamp-on'); wake(); } });
  }
  if (button) {
    button.hidden = false;
    if (note) { note.hidden = false; note.textContent = finePointer ? 'or move your pointer over the griffin.' : 'then drag across the griffin.'; }
    button.addEventListener('click', () => {
      lamp.held = !lamp.held; lamp.target = lamp.held ? 1 : 0;
      button.setAttribute('aria-pressed', String(lamp.held));
      fig.style.touchAction = lamp.held ? 'none' : '';
      wake();
    });
    button.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }[e.key];
      if (!lamp.held || !d) return;
      e.preventDefault(); lamp.goal = [clamp(lamp.goal[0] + d[0]), clamp(lamp.goal[1] + d[1])]; wake();
    });
    fig.addEventListener('pointerdown', (e) => { if (lamp.held && e.pointerType !== 'mouse') { fig.setPointerCapture(e.pointerId); lamp.goal = toPlate(e.clientX, e.clientY); wake(); } });
    fig.addEventListener('pointermove', (e) => { if (lamp.held && e.pointerType !== 'mouse' && e.buttons) { lamp.goal = toPlate(e.clientX, e.clientY); wake(); } });
  }

  // ---- The inspection as the hero scrolls away ----
  const hero = fig.closest('header') || fig;
  const serial = fig.querySelector('[data-serial]');
  const finalSerial = serial ? serial.textContent : '';
  let numbered = false;
  const inspect = () => (motion ? clamp((scrollY - hero.offsetHeight * 0.06) / (hero.offsetHeight * 0.42)) : 0);
  const number = (on) => {
    if (!serial || on === numbered) return;
    numbered = on;
    fig.classList.toggle('numbered', on);
    if (!on || !motion) { serial.textContent = finalSerial; return; }
    const t0 = performance.now(); const chars = finalSerial.split('');
    const tick = (t) => {
      const k = (t - t0) / 650;
      serial.textContent = chars.map((ch, i) => (/\d/.test(ch) && k < 0.3 + i * 0.06 ? String(Math.floor(Math.random() * 10)) : ch)).join('');
      if (k < 0.3 + chars.length * 0.06) requestAnimationFrame(tick); else serial.textContent = finalSerial;
    };
    requestAnimationFrame(tick);
  };

  let raf = 0;
  const frame = (t) => {
    raf = 0;
    let busy = false;
    const s = plate.state;
    if (runIntro && s.progress < 1) { const k = clamp((t - T0) / DUR); s.progress = ease(k); busy = k < 1; }
    // pointer lamp
    lamp.level += (lamp.target - lamp.level) * 0.16;
    lamp.pos[0] += (lamp.goal[0] - lamp.pos[0]) * 0.35; lamp.pos[1] += (lamp.goal[1] - lamp.pos[1]) * 0.35;
    busy = busy || Math.abs(lamp.target - lamp.level) > 0.002 || Math.hypot(lamp.goal[0] - lamp.pos[0], lamp.goal[1] - lamp.pos[1]) > 0.0005 || lamp.level > 0.002;
    // scroll inspection: a disc that opens from the griffin's chest
    const k = inspect();
    if (lamp.level > 0.05 || k <= 0.001) {
      s.uv = lamp.level < 0.002 ? 0 : lamp.level; s.uvPos = lamp.pos; s.uvR = 190; s.halo = 1;
    } else {
      s.uv = 1; s.uvPos = [0.47, 0.5]; s.uvR = plate.css[0] * (0.05 + 0.4 * ease(k)); s.halo = 0;
      busy = true;
    }
    // Off screen, nothing is drawn and the loop sleeps until the next scroll.
    if (hero.getBoundingClientRect().bottom < 0 && s.progress >= 1) return;
    plate.draw(t);
    if (busy) raf = requestAnimationFrame(frame);
  };
  const wake = () => { if (!raf) raf = requestAnimationFrame(frame); };
  addEventListener('scroll', () => { number(inspect() > 0.55); wake(); }, { passive: true });
  addEventListener('resize', wake);
  new MutationObserver(wake).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', wake);
  number(inspect() > 0.55);
  wake();

  // Capture hook: ?uv=x,y holds the lamp at a point on the plate (fractions).
  if (params.has('uv')) {
    const [x, y] = params.get('uv').split(',').map(Number);
    lamp.goal = lamp.pos = [x, y]; lamp.target = lamp.level = 1; wake();
  }
}

if (fig) start();
