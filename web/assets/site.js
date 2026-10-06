// Segreant site: the only script. Everything on the page reads and works without
// it. It adds the theme switch and the copy button (both hidden until wired)
// and, when html.motion was set before first paint, runs "the print run": the
// numbering wheels, inking as plates come into view, the sheet lifting as you
// scroll, the loop-guard simulation and the bill's tilt. The hero plate and its
// UV lamp are assets/hero.js.
(() => {
  const root = document.documentElement;
  const light = matchMedia('(prefers-color-scheme: light)');
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : !light.matches);

  // ---- Theme switch: the label names the theme you would switch to. ----
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    const label = () => { button.textContent = isDark() ? 'Light theme' : 'Dark theme'; };
    button.hidden = false;
    label();
    button.addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('segreant-theme', next); } catch (e) { /* storage blocked: the choice lasts this visit */ }
      label();
    });
    light.addEventListener('change', label);
  });

  // ---- Copy the install commands: drop comment lines, prompts and trailing comments. ----
  document.querySelectorAll('[data-copy]').forEach((button) => {
    const source = document.getElementById(button.dataset.copy);
    if (!source || !navigator.clipboard) return;
    const text = source.textContent.split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .map((line) => line.replace(/^\$\s*/, '').replace(/\s+#.*$/, '').trimEnd())
      .filter(Boolean).join('\n');
    const idle = button.textContent;
    button.hidden = false;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch (e) {
        button.textContent = 'Copy blocked; select the text instead';
      }
      setTimeout(() => { button.textContent = idle; }, 1800);
    });
  });

  // ---- Run the press again (footer link). ----
  document.querySelectorAll('[data-replay]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      try { sessionStorage.removeItem('segreant-intro'); } catch (e) { /* ignore */ }
      scrollTo(0, 0);
      location.reload();
    });
  });

  if (!root.classList.contains('motion')) return;
  const params = new URLSearchParams(location.search);

  // ---- Numbering wheels: each digit rolls to its figure. ----
  const wheel = (el, stagger) => {
    const text = el.textContent;
    el.setAttribute('aria-label', text);
    el.textContent = '';
    let k = 0;
    for (const ch of text) {
      if (/[0-9]/.test(ch)) {
        const dg = document.createElement('span');
        dg.className = 'dg';
        dg.setAttribute('aria-hidden', 'true');
        const strip = document.createElement('span');
        strip.style.setProperty('--n', ch);
        strip.style.setProperty('--delay', `${(stagger + k * 0.07).toFixed(2)}s`);
        for (let d = 0; d <= 9; d++) { const s = document.createElement('span'); s.textContent = String(d); strip.append(s); }
        dg.append(strip);
        dg.dataset.d = ch;
        el.append(dg);
        k += 1;
      } else {
        const s = document.createElement('span');
        s.setAttribute('aria-hidden', 'true');
        s.textContent = ch;
        el.append(s);
      }
    }
  };
  document.querySelectorAll('[data-roll]').forEach((el, i) => wheel(el, 0.15 + (i % 6) * 0.12));
  // Size each wheel to its own digit once the face is loaded, so "$251.10" sets
  // like type and never like "$25 1. 10" (a wheel is otherwise as wide as its widest digit).
  const fitWheels = () => document.querySelectorAll('.dg').forEach((dg) => {
    const probe = document.createElement('span');
    probe.textContent = dg.dataset.d; probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    dg.parentElement.append(probe);
    dg.style.setProperty('--dw', `${probe.getBoundingClientRect().width.toFixed(2)}px`);
    probe.remove();
  });
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(fitWheels);

  // ---- Ink each plate as it reaches the reader, once. ----
  const inkAll = params.has('inkall');
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('inked');
      io.unobserve(entry.target);
    }
  }, { threshold: 0.22 });
  document.querySelectorAll('.ink-on').forEach((el) => (inkAll ? el.classList.add('inked') : io.observe(el)));

  // ---- The sheet lifts away as you scroll past it. ----
  const sheet = document.querySelector('.sheet');
  if (sheet) {
    let raf = 0;
    const lift = () => {
      raf = 0;
      const h = sheet.offsetHeight || 1;
      const p = Math.min(1, Math.max(0, scrollY / h));
      sheet.style.setProperty('--lift', p.toFixed(3));
    };
    addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(lift); }, { passive: true });
    lift();
  }

  // ---- The bill tilts toward the pointer; its foil and a glare follow the light. ----
  if (matchMedia('(pointer: fine)').matches) document.querySelectorAll('.note-cert').forEach((note) => {
    const face = note.querySelector('.nf');
    if (!face) return;
    note.addEventListener('pointermove', (event) => {
      const r = face.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (event.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (event.clientY - r.top) / r.height));
      note.classList.add('tilting');
      face.style.setProperty('--ry', `${((x - 0.5) * 10).toFixed(2)}deg`);
      face.style.setProperty('--rx', `${((0.5 - y) * 8).toFixed(2)}deg`);
      face.style.setProperty('--gx', `${(x * 100).toFixed(1)}%`);
      face.style.setProperty('--gy', `${(y * 100).toFixed(1)}%`);
      face.style.setProperty('--fy', (x * 0.6 + y * 0.4).toFixed(3));
      face.style.setProperty('--glare', '1');
    });
    note.addEventListener('pointerleave', () => {
      note.classList.remove('tilting');
      face.style.setProperty('--rx', '0deg'); face.style.setProperty('--ry', '0deg'); face.style.setProperty('--glare', '0');
    });
  });

  // ---- The loop guard, as a simulation with sample figures. An agent loop sends
  // requests ever faster; once the spend in the last 60 seconds reaches the $2.00
  // threshold, the next request is blocked with the guard's real message. ----
  const loop = document.querySelector('.loop');
  if (loop) {
    const tape = loop.querySelector('.tape');
    const meter = loop.querySelector('.meter');
    const meterVal = loop.querySelector('.meter-val');
    const replay = loop.querySelector('.loop-replay');
    const LIMIT = 2.0; const FINAL = 2.04;
    let timer = 0; let running = false;
    const stamp = (ms) => {
      const d = new Date(Date.UTC(2026, 8, 30, 14, 2, 5) + ms);
      return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}.${String(Math.floor(d.getUTCMilliseconds() / 10)).padStart(2, '0')}`;
    };
    const line = (time, cost, status, blocked) => {
      const li = document.createElement('li');
      if (blocked) li.className = 'blocked';
      li.innerHTML = `<span>${time}</span><span class="c">${cost}</span><span>${status}</span>`;
      tape.append(li);
      while (tape.children.length > 14) tape.firstElementChild.remove();
    };
    const show = (sum) => { meter.style.setProperty('--w', String(sum / LIMIT)); meterVal.textContent = `$${sum.toFixed(2)}`; };
    const run = () => {
      if (running) return;
      running = true; loop.classList.remove('blocked'); tape.textContent = ''; replay.hidden = true;
      // A seeded sequence, so every run (and every screenshot) is the same loop.
      let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      let sum = 0; let simMs = 0; let n = 0;
      const step = () => {
        const gap = Math.max(450, 2600 - n * 70);            // the loop speeds up
        simMs += gap;
        let cost = 0.026 + rnd() * 0.03;
        if (sum + cost >= LIMIT) cost = FINAL - sum;          // the last forwarded request lands the window on $2.04
        sum = Math.round((sum + cost) * 100) / 100;
        line(stamp(simMs), `$${cost.toFixed(3)}`, 'forwarded', false);
        show(sum); n += 1;
        if (sum >= LIMIT) {
          timer = setTimeout(() => {
            line(stamp(simMs + 380), '—', 'blocked by loop guard', true);
            loop.classList.add('blocked');
            running = false; replay.hidden = false;
          }, 420);
          return;
        }
        timer = setTimeout(step, Math.max(55, 240 - n * 6)); // real time shrinks with it
      };
      step();
    };
    // Motion: clear the printed end state so the run can play from the start.
    loop.classList.remove('blocked'); tape.textContent = ''; show(0);
    replay.addEventListener('click', () => { clearTimeout(timer); running = false; run(); });
    const start = () => run();
    if (loop.classList.contains('inked')) start();
    else new MutationObserver((list, obs) => { if (loop.classList.contains('inked')) { obs.disconnect(); start(); } }).observe(loop, { attributes: true, attributeFilter: ['class'] });
  }

  // ---- Capture hooks for visual regression. ?freeze=<ms>
  // pauses every animation at that moment, so a headless browser can photograph
  // any frame of the run. ----
  if (params.has('card')) root.classList.add('capture-card'); // social-card capture: no pointer hint
  if (params.has('at')) setTimeout(() => scrollTo(0, Number(params.get('at')) || 0), 300);
  if (params.has('freeze')) {
    const t = Number(params.get('freeze')) || 0;
    const hold = () => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = t; });
    setTimeout(hold, 600);
    setTimeout(hold, 1200);
  }
})();
