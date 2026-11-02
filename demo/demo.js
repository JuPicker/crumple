/* Crumple demo: a small file app. Everything that moves uses one real spring. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ---------- springs, as CSS easing curves */
  // Simulates a damped spring and samples it into a CSS linear() curve.
  function springCurve(stiffness, damping, mass = 1) {
    const dt = 1 / 240, pts = [];
    let x = 0, v = 0, t = 0;
    while (t < 3) {
      const a = (-stiffness * (x - 1) - damping * v) / mass;
      v += a * dt; x += v * dt; t += dt;
      pts.push(x);
      if (Math.abs(1 - x) < 0.0008 && Math.abs(v) < 0.01) break;
    }
    const n = 48, step = Math.max(1, Math.floor(pts.length / n));
    const out = [0];
    for (let i = step; i < pts.length; i += step) out.push(+pts[i].toFixed(4));
    out.push(1);
    return { easing: `linear(${out.join(', ')})`, ms: Math.round(t * 1000) };
  }
  const SNAP = springCurve(400, 24);   // tabs, pills, toggles: a visible little overshoot
  const SOFT = springCurve(200, 26);   // pages and big surfaces
  const root = document.documentElement.style;
  if (CSS.supports('transition-timing-function', 'linear(0, 1)')) {
    root.setProperty('--spring', SNAP.easing); root.setProperty('--spring-dur', SNAP.ms + 'ms');
    root.setProperty('--spring-soft', SOFT.easing); root.setProperty('--spring-soft-dur', SOFT.ms + 'ms');
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const enter = (el, from, curve = SOFT) => {
    if (reduced || !el.animate) return;
    el.animate([from, { opacity: 1, transform: 'none', filter: 'blur(0px)' }], { duration: curve.ms, easing: curve.easing, fill: 'backwards' });
  };

  /* ---------- morphing pill (segmented controls and tabs) */
  function segmented(el, onPick) {
    const pill = $('.pill', el), tabs = $$('button', el);
    const place = (btn, instant) => {
      if (instant) el.classList.add('no-anim');
      pill.style.width = btn.offsetWidth + 'px';
      pill.style.transform = `translateX(${btn.offsetLeft}px)`;
      if (instant) { pill.offsetWidth; el.classList.remove('no-anim'); }
    };
    const pick = (btn, instant) => {
      tabs.forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      place(btn, instant);
    };
    tabs.forEach((b) => b.addEventListener('click', () => { if (b.getAttribute('aria-selected') === 'true') return; pick(b); onPick && onPick(b); }));
    const current = () => tabs.find((b) => b.getAttribute('aria-selected') === 'true') || tabs[0];
    const relayout = () => place(current(), true);
    new ResizeObserver(relayout).observe(el);
    requestAnimationFrame(relayout);
    return { pick: (b, instant) => pick(b, instant), current, relayout };
  }

  /* ---------- data */
  const FILES = [
    { name: 'Q3 Roadmap.fig', kind: 'Figma file', cat: 'doc', icon: 'doc', c: '#7c5cff', size: 18.4, owner: ['JP', '#c7b8ff', 'Julia'], date: 'Today' },
    { name: 'Brand guidelines.pdf', kind: 'PDF', cat: 'doc', icon: 'doc', c: '#e5484d', size: 6.2, owner: ['MO', '#ffcfa8', 'Malik'], date: 'Yesterday' },
    { name: 'Launch film v7 final.mp4', kind: 'Video', cat: 'media', icon: 'film', c: '#12a594', size: 412, owner: ['JP', '#c7b8ff', 'Julia'], date: 'Oct 28' },
    { name: 'Budget 2027.xlsx', kind: 'Spreadsheet', cat: 'doc', icon: 'doc', c: '#30a46c', size: 0.24, owner: ['SL', '#b4e4c8', 'Sara'], date: 'Oct 24' },
    { name: 'Moodboard.png', kind: 'Image', cat: 'media', icon: 'img', c: '#f76b15', size: 3.1, owner: ['MO', '#ffcfa8', 'Malik'], date: 'Oct 19' },
    { name: 'Interview notes.md', kind: 'Markdown', cat: 'doc', icon: 'doc', c: '#60646c', size: 0.01, owner: ['SL', '#b4e4c8', 'Sara'], date: 'Oct 14' },
    { name: 'Hero shot 04.jpg', kind: 'Image', cat: 'media', icon: 'img', c: '#0090ff', size: 8.7, owner: ['JP', '#c7b8ff', 'Julia'], date: 'Oct 9' },
    { name: 'Pitch deck draft.key', kind: 'Keynote', cat: 'doc', icon: 'doc', c: '#d6409f', size: 24.5, owner: ['MO', '#ffcfa8', 'Malik'], date: 'Oct 2' },
  ];
  const fmt = (mb) => (mb >= 1 ? mb.toFixed(1).replace(/\.0$/, '') + ' MB' : Math.max(1, Math.round(mb * 1000)) + ' KB');
  const deleted = new Set();
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const verb = isTouch ? 'flick' : 'throw';

  const toss = Crumple.create({
    sound: true, zIndex: 25, binTheme: 'glass',
    stage: { color: 'rgba(255,255,255,.58)', blur: 22 },
  });
  window.__toss = toss;

  /* ---------- files page */
  const rows = $('#rows');
  function renderFiles() {
    rows.innerHTML = '';
    FILES.forEach((f, i) => {
      const el = document.createElement('div');
      el.className = 'tr'; el.dataset.i = i; el.dataset.cat = f.cat;
      el.innerHTML = `<div class="fname"><span class="ftile" style="--c:${f.c}"><svg class="i"><use href="#i-${f.icon}"/></svg></span><div><b></b><span>${f.kind}</span></div></div>
        <span class="owner"><span class="avatar" style="--c:${f.owner[1]}">${f.owner[0]}</span>${f.owner[2]}</span>
        <span class="muted">${fmt(f.size)}</span><span class="muted">${f.date}</span>
        <button class="icon" type="button" aria-label="Delete ${f.name}"><svg class="i"><use href="#i-trash"/></svg></button>`;
      $('b', el).textContent = f.name;
      $('button', el).addEventListener('click', () => openDialog(fileDialog(i)));
      rows.appendChild(el);
    });
    applyFilter(true);
  }
  let filter = 'all';
  function applyFilter(instant) {
    let k = 0;
    $$('.tr', rows).forEach((el) => {
      const show = (filter === 'all' || el.dataset.cat === filter) && !deleted.has(+el.dataset.i);
      const was = !el.classList.contains('hide');
      el.classList.toggle('hide', !show && !el.classList.contains('gone'));
      if (show && (!was || !instant)) enter(el, { opacity: 0, transform: 'translateY(8px)', filter: 'blur(2px)' }, SNAP), el.getAnimations().forEach((a) => (a.startTime = document.timeline.currentTime + k++ * 28));
    });
    updateCounts();
  }
  function updateCounts() {
    const left = FILES.filter((_, i) => !deleted.has(i));
    const c = { all: left.length, doc: left.filter((f) => f.cat === 'doc').length, media: left.filter((f) => f.cat === 'media').length };
    $$('[data-c]').forEach((s) => (s.textContent = c[s.dataset.c] ?? s.textContent));
    $('#nav-count').textContent = c.all;
    $('#st-files').textContent = c.all;
    const used = 17.73 + left.reduce((a, f) => a + f.size, 0) / 1000;
    $('#st-size').textContent = used.toFixed(1) + ' GB';
    $('#side-storage').textContent = used.toFixed(1) + ' of 50 GB';
    $('#side-bar').style.transform = `scaleX(${used / 50})`;
    const visible = $$('.tr', rows).filter((el) => !el.classList.contains('hide') && !el.classList.contains('gone')).length;
    rows.classList.toggle('is-empty', visible === 0);
  }
  segmented($('#ftabs'), (b) => { filter = b.dataset.f; applyFilter(false); });
  segmented($('#vtabs'));
  $('#refill').addEventListener('click', () => { deleted.clear(); renderFiles(); });

  function fileDialog(i) {
    const f = FILES[i];
    return {
      title: `Delete “${f.name}”?`,
      text: 'It goes in the bin. You can still undo it for a few seconds.',
      meta: `<span class="ftile" style="--c:${f.c}"><svg class="i"><use href="#i-${f.icon}"/></svg></span><div><b>${f.name}</b><span>${fmt(f.size)}, edited ${f.date.toLowerCase()}</span></div>`,
      cancel: 'Cancel', confirm: 'Delete',
      hint: `Hold Delete, then ${verb} it in the bin`,
      toast: ['Deleted', f.name],
      done: () => { deleted.add(i); const el = rows.querySelector(`[data-i="${i}"]`); el && el.classList.add('gone'); updateCounts(); },
      undo: () => { deleted.delete(i); const el = rows.querySelector(`[data-i="${i}"]`); el && el.classList.remove('gone', 'hide'); applyFilter(true); },
    };
  }

  /* ---------- billing page */
  let yearly = false, cancelled = false;
  const priceEl = $('#price');
  function tweenPrice(to) {
    const from = parseFloat(priceEl.textContent.replace('$', '')) || 0;
    const t0 = performance.now(), d = 520;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - k, 3);
      priceEl.textContent = '$' + Math.round(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  function renderPlan() {
    tweenPrice(yearly ? 120 : 12);
    $('#per').textContent = yearly ? 'per year' : 'per month';
    $('#save').classList.toggle('on', yearly);
    const badge = $('#plan-badge');
    badge.textContent = cancelled ? 'Ends Dec 2' : 'Active';
    badge.classList.toggle('warn', cancelled);
    $('#next').textContent = cancelled ? 'None, plan ends Dec 2' : yearly ? 'Dec 2, 2026 ($120)' : 'Dec 2, 2026';
    $('#renew').setAttribute('aria-checked', String(!cancelled));
    $('#zone-title').textContent = cancelled ? 'Your plan ends on Dec 2' : 'Cancel subscription';
    $('#zone-text').textContent = cancelled ? 'Changed your mind? Resume and nothing changes.' : 'You keep Pro until the end of the period. Nothing is deleted.';
    const btn = $('#cancel-plan');
    btn.textContent = cancelled ? 'Resume plan' : 'Cancel plan';
    btn.className = cancelled ? 'btn primary' : 'btn ghost-danger';
  }
  segmented($('#cycle'), (b) => { yearly = b.dataset.c === 'y'; renderPlan(); });
  const btabs = segmented($('#btabs'), (b) => {
    $$('#page-billing .tab-body').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.t));
    const on = $('#tab-' + b.dataset.t);
    enter(on, { opacity: 0, transform: 'translateY(12px) scale(.99)', filter: 'blur(4px)' });
    if (b.dataset.t === 'plan') fillBars(on);
  });
  void btabs;
  $('#renew').addEventListener('click', (e) => {
    if (cancelled) { cancelled = false; renderPlan(); return; }
    e.currentTarget.setAttribute('aria-checked', String(e.currentTarget.getAttribute('aria-checked') !== 'true'));
  });
  function planDialog() {
    return {
      title: 'Cancel your Pro plan?',
      text: 'You keep Pro until Dec 2, then you move to Free. Your files stay where they are.',
      meta: `<span class="plan-mark">P</span><div><b>Pro, ${yearly ? 'yearly' : 'monthly'}</b><span>${yearly ? '$120 per year' : '$12 per month'}, Visa ending in 4242</span></div>`,
      cancel: 'Keep Pro', confirm: 'Cancel plan',
      hint: `Hold Cancel plan, then ${verb} it in the bin`,
      toast: ['Plan cancelled', 'Pro stays on until Dec 2'],
      done: () => { cancelled = true; renderPlan(); },
      undo: () => { cancelled = false; renderPlan(); },
    };
  }
  $('#cancel-plan').addEventListener('click', () => { if (cancelled) { cancelled = false; renderPlan(); } else openDialog(planDialog()); });
  function fillBars(scope) {
    $$('.bar i[data-v]', scope).forEach((i, k) => {
      i.style.transition = 'none'; i.style.transform = 'scaleX(0)'; i.offsetWidth;
      i.style.transition = ''; setTimeout(() => (i.style.transform = `scaleX(${i.dataset.v})`), 80 + k * 60);
    });
  }

  /* ---------- navigation: sidebar pill + page morph */
  const nav = $('#nav'), navPill = $('#nav-pill');
  const placeNav = (a, instant) => {
    if (instant) nav.classList.add('no-anim');
    navPill.style.transform = `translateY(${a.offsetTop}px)`;
    if (instant) { navPill.offsetWidth; nav.classList.remove('no-anim'); }
  };
  let page = 'files';
  const mnav = segmented($('#mnav'), (b) => go(b.dataset.go));
  function go(to) {
    const target = ['billing', 'members', 'settings'].includes(to) ? 'billing' : 'files';
    const link = $(`#nav a[data-go="${to}"]`);
    $$('#nav a').forEach((a) => a.toggleAttribute('aria-current', a === link));
    if (link) { link.setAttribute('aria-current', 'page'); placeNav(link); }
    mnav.pick($(`#mnav [data-go="${target}"]`));
    if (target === page) return;
    const from = $('#page-' + page), next = $('#page-' + target);
    page = target;
    closeDialog(); quiet();
    if (!reduced && from.animate) {
      from.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-6px)', filter: 'blur(4px)' }], { duration: 160, easing: 'ease-in' })
        .finished.then(() => from.classList.remove('on'));
    } else from.classList.remove('on');
    setTimeout(() => {
      next.classList.add('on');
      enter(next, { opacity: 0, transform: 'translateY(16px) scale(.985)', filter: 'blur(6px)' });
      if (target === 'billing') fillBars(next);
    }, reduced ? 0 : 140);
  }
  $$('#nav a').forEach((a) => a.addEventListener('click', () => go(a.dataset.go)));
  new ResizeObserver(() => placeNav($('#nav a[aria-current]') || $('#nav a[data-go="files"]'), true)).observe(nav);

  /* ---------- dialog */
  const scrim = $('#scrim'), dialog = $('#dialog'), confirmBtn = $('#dlg-confirm');
  let current = null, grabbed = false;
  function openDialog(d, { restoring = false } = {}) {
    current = d; grabbed = false;
    $('#dlg-title').textContent = d.title;
    $('#dlg-text').textContent = d.text;
    $('#dlg-meta').innerHTML = d.meta;
    $('#dlg-cancel').textContent = d.cancel;
    confirmBtn.textContent = d.confirm;
    $('#hint-text').textContent = d.hint;
    dialog.style.visibility = restoring ? 'hidden' : '';
    scrim.classList.remove('leaving');
    scrim.classList.add('open');
    if (!restoring) {
      enter(dialog, { opacity: 0, transform: 'translateY(12px) scale(.94)', filter: 'blur(2px)' }, SNAP);
      enter($('.hint', scrim), { opacity: 0, transform: 'translateY(8px)' }, SOFT);
      setTimeout(() => { if (current === d) toss.prepare(dialog).catch(() => {}); }, SNAP.ms + 40);
      setTimeout(() => confirmBtn.focus({ preventScroll: true }), 60);
    }
  }
  function closeDialog() { scrim.classList.remove('open', 'leaving'); current = null; }
  $('#dlg-cancel').addEventListener('click', closeDialog);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim && !grabbed) closeDialog(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && current && !grabbed) closeDialog(); });

  // recapture with the hover state, so the swap to WebGL is invisible
  let hoverTimer;
  const recapture = () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => current && !grabbed && toss.prepare(dialog).catch(() => {}), 220); };
  confirmBtn.addEventListener('pointerenter', recapture);
  confirmBtn.addEventListener('pointerleave', recapture);
  confirmBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || grabbed) return;
    e.preventDefault();
    grabbed = true; clearTimeout(hoverTimer);
    scrim.classList.add('leaving');
    toss.grab(dialog, e);
  });
  // keyboard: Enter or Space makes a perfect shot
  confirmBtn.addEventListener('click', (e) => {
    if (e.detail !== 0 || grabbed) return;
    grabbed = true;
    scrim.classList.add('leaving');
    toss.throwInto(dialog);
  });

  /* ---------- coach line */
  const coach = $('#coach');
  let coachTimer;
  function say(text, ms = 2200) {
    coach.textContent = text; coach.classList.add('show');
    clearTimeout(coachTimer);
    if (ms) coachTimer = setTimeout(() => coach.classList.remove('show'), ms);
  }
  function quiet() { clearTimeout(coachTimer); coach.classList.remove('show'); }

  /* ---------- toast stack */
  const stack = $('#toasts'), toasts = [];
  function layout() {
    const hover = stack.matches(':hover');
    const up = matchMedia('(max-width:900px)').matches ? 1 : -1;
    toasts.forEach((t, i) => {
      const k = toasts.length - 1 - i;
      const y = hover ? k * (64 + 8) * up : k * 12 * up;
      const s = hover ? 1 : 1 - k * 0.05;
      t.el.style.transform = t.el.classList.contains('in') ? '' : `translateY(${y}px) scale(${s})`;
      t.el.style.opacity = k > 2 && !hover ? '0' : '1';
      t.el.style.zIndex = String(100 - k);
      t.el.classList.toggle('behind', k > 0);
    });
  }
  stack.addEventListener('pointerenter', layout);
  stack.addEventListener('pointerleave', layout);
  function pushToast(d, ball) {
    const el = document.createElement('div');
    el.className = 'toast in';
    el.innerHTML = `<span class="ico"><svg class="i"><use href="#i-trash"/></svg></span><div class="txt"><b></b><span></span></div>
      <button class="btn" type="button">Undo</button><button class="icon" type="button" aria-label="Dismiss"><svg class="i"><use href="#i-x"/></svg></button>`;
    $('b', el).textContent = d.toast[0];
    $('.txt span', el).textContent = d.toast[1];
    const t = { el, d, ball, timer: setTimeout(() => dropToast(t), 7000) };
    $('.btn', el).addEventListener('click', () => undo(t));
    $('.icon', el).addEventListener('click', () => dropToast(t));
    stack.appendChild(el);
    toasts.push(t);
    requestAnimationFrame(() => requestAnimationFrame(() => { el.classList.remove('in'); layout(); }));
    layout();
  }
  function dropToast(t) {
    const i = toasts.indexOf(t);
    if (i < 0) return;
    clearTimeout(t.timer);
    toasts.splice(i, 1);
    t.el.style.opacity = '0';
    t.el.style.transform += ' translateY(8px)';
    setTimeout(() => t.el.remove(), 400);
    layout();
  }
  // undo is quiet: the item comes back in place, the ball leaves the bin
  function undo(t) {
    dropToast(t);
    t.d.undo();
    if (t.ball) toss.discard(t.ball);
  }

  /* ---------- engine events */
  let streak = 0;
  toss.on('hover', () => say(`Now ${verb} it in the bin`, 0));
  toss.on('pickup', quiet);
  toss.on('throw', quiet);
  toss.on('miss', () => { streak = 0; say(isTouch ? 'So close. Grab it and flick again' : 'So close. Pick it up and try again', 0); });
  toss.on('score', (ball) => {
    quiet();
    const d = current;
    closeDialog();
    if (!d) return;
    streak++;
    d.done();
    setTimeout(() => pushToast(d, ball), 500);
    if (streak >= 2) say(streak === 2 ? 'Two in a row' : `${streak} in a row`, 1600);
  });

  /* ---------- sound */
  const setSound = (on) => {
    toss.setSound(on);
    $('#sound').setAttribute('aria-checked', String(on));
    $('#sound-m').setAttribute('aria-pressed', String(on));
    $('#sound-m').style.opacity = on ? '1' : '.45';
  };
  $('#sound').addEventListener('click', () => setSound($('#sound').getAttribute('aria-checked') !== 'true'));
  $('#sound-m').addEventListener('click', () => setSound($('#sound-m').getAttribute('aria-pressed') !== 'true'));

  /* ---------- boot */
  renderFiles();
  renderPlan();
  placeNav($('#nav a[data-go="files"]'), true);

  // deterministic stills: ?shot=<crumple 0..1>&rx=&ry=&rz= (degrees)&px=&py= (pointer, 0..1)&page=billing
  const P = new URLSearchParams(location.search);
  if (P.get('page') === 'billing') go('billing');
  if (!P.has('shot')) {
    document.fonts.ready.then(() => setTimeout(() => openDialog(P.get('page') === 'billing' ? planDialog() : fileDialog(0)), 700));
    return;
  }
  document.fonts.ready.then(async () => {
    if (P.get('shot') === 'page') { setTimeout(() => (document.title = 'shot:done'), 900); return; }
    openDialog(P.get('page') === 'billing' ? planDialog() : fileDialog(0));
    await new Promise((res) => setTimeout(res, SNAP.ms + 100));
    if (+P.get('shot') < 0) { document.title = 'shot:done'; return; }
    await toss.prepare(dialog);
    const r = confirmBtn.getBoundingClientRect();
    const x = P.has('px') ? +P.get('px') * innerWidth : r.left + r.width / 2;
    const y = P.has('py') ? +P.get('py') * innerHeight : r.top + r.height / 2;
    confirmBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, button: 0, clientX: x, clientY: y, pointerType: 'mouse' }));
    await new Promise((res) => setTimeout(res, 100));
    toss.o.crumpleTime = 1e9;
    const b = toss.balls[0];
    const d = Math.PI / 180;
    const qa = (ax, a) => [ax[0] * Math.sin(a / 2), ax[1] * Math.sin(a / 2), ax[2] * Math.sin(a / 2), Math.cos(a / 2)];
    const mul = (a, c) => [a[3]*c[0]+a[0]*c[3]+a[1]*c[2]-a[2]*c[1], a[3]*c[1]-a[0]*c[2]+a[1]*c[3]+a[2]*c[0], a[3]*c[2]+a[0]*c[1]-a[1]*c[0]+a[2]*c[3], a[3]*c[3]-a[0]*c[0]-a[1]*c[1]-a[2]*c[2]];
    b.q = mul(qa([0, 0, 1], +(P.get('rz') || 0) * d), mul(qa([0, 1, 0], +(P.get('ry') || 0) * d), qa([1, 0, 0], +(P.get('rx') || 0) * d)));
    b.w3 = [0, 0, 0]; b.t = +P.get('shot'); b.seed = +(P.get('seed') || 7);
    setTimeout(() => (document.title = 'shot:done'), 1100);
  });
})();
