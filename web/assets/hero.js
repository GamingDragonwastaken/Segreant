// The hero plate. Loaded as a module after site.js; without it (or without
// WebGL) the CSS print underneath stays, finished and still.
//
// 1. On the first visit the engraving inks itself in, deepest grooves first.
// 2. As the hero scrolls away, the numbering machine stamps the serial in the
//    plate's corner.
import { Plate } from './plate.js';

const root = document.documentElement;
const fig = document.querySelector('[data-plate]');
const motion = root.classList.contains('motion');
const params = new URLSearchParams(location.search);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);

async function start() {
  const canvas = fig.querySelector('canvas');
  let plate;
  // The engraving sits at 90% of the canvas, so the feathered canvas edge never touches it.
  try { plate = new Plate(canvas, { fit: [0.05, 0.05, 0.9, 0.9] }); } catch { fig.classList.add('no-gl'); return; }
  // Load only the resolution the screen can show.
  const need = fig.getBoundingClientRect().width * Math.min(devicePixelRatio || 1, 2);
  try { await plate.load(need > 1000 ? 'assets/print/plate-griffin.webp' : 'assets/print/plate-griffin-900.webp'); }
  catch { fig.classList.add('no-gl'); return; }
  fig.classList.add('gl');

  const runIntro = motion && (root.classList.contains('intro') || params.has('intro'));
  const T0 = performance.now() + 60, DUR = 3200;
  plate.state.progress = runIntro ? 0 : 1;
  plate.state.uv = 0;

  // ---- The serial is stamped as the hero scrolls away ----
  const hero = fig.closest('header') || fig;
  const serial = fig.querySelector('[data-serial]');
  const finalSerial = serial ? serial.textContent : '';
  let numbered = false;
  const away = () => clamp((scrollY - hero.offsetHeight * 0.06) / (hero.offsetHeight * 0.42));
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
    const s = plate.state;
    let busy = false;
    if (runIntro && s.progress < 1) { const k = clamp((t - T0) / DUR); s.progress = ease(k); busy = k < 1; }
    // Off screen, nothing is drawn and the loop sleeps until the next scroll.
    if (hero.getBoundingClientRect().bottom < 0 && s.progress >= 1) return;
    plate.draw(t);
    if (busy) raf = requestAnimationFrame(frame);
  };
  const wake = () => { if (!raf) raf = requestAnimationFrame(frame); };
  addEventListener('scroll', () => { number(away() > 0.55); }, { passive: true });
  addEventListener('resize', wake);
  new MutationObserver(wake).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', wake);
  number(away() > 0.55);
  wake();
}

if (fig) start();
