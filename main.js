import { MapHighlighter, parseHexColor } from './gpu.js';

// ─────────────────────────────────────────────────────────────────────────────
// Static content
// ─────────────────────────────────────────────────────────────────────────────

const HELP_HTML = `
  <h2 id="infoTitle">Forza Map Finder</h2>
  <p>Highlights roads you haven't driven yet on the Forza Horizon map. Undiscovered roads render in a flat grey (<code>#808080</code>); this tool swaps that colour for a high-contrast green (<code>#44FF00</code>) so the missing routes pop out instantly.</p>
  <p>All pixel work runs on the GPU through a WebGL2 fragment shader — even a 4K screenshot is processed in a couple of milliseconds.</p>

  <h3>PC — Live capture</h3>
  <ol>
    <li>Click <strong>Share Screen</strong> and pick your Forza window.</li>
    <li>Open the map in-game. Undiscovered roads turn green in real time.</li>
    <li>Use <em>Pause</em> and <em>Stop</em> to control the stream when you're done.</li>
  </ol>

  <h3>Xbox — Screenshot upload</h3>
  <ol>
    <li>In-game, open the map.</li>
    <li>Press <strong>Xbox + Y</strong> to capture a screenshot.</li>
    <li>The screenshot appears in the <strong>Xbox app</strong> on your phone (Captures tab) within seconds, or on xbox.com.</li>
    <li>Open this page on your phone or PC, switch to the <strong>Xbox</strong> tab, then upload the screenshot — tap the button, drag the file in, or press <kbd>Ctrl</kbd>+<kbd>V</kbd>.</li>
    <li>Undiscovered roads light up. Zoom in to plan your next drive.</li>
  </ol>

  <h3>PlayStation — Screenshot upload</h3>
  <ol>
    <li>In-game, open the map.</li>
    <li>On <strong>PS5</strong>: tap the <strong>Create</strong> button → <em>Take Screenshot</em>. On <strong>PS4</strong>: press or hold the <strong>Share</strong> button → <em>Save Screenshot</em>.</li>
    <li>Sync the capture to the <strong>PlayStation App</strong> on your phone, or download it from <em>Settings → Captures and Broadcasts → Captures</em> over USB.</li>
    <li>Open this page on your phone or PC, switch to the <strong>PS</strong> tab, then upload the screenshot the same way as the Xbox flow above.</li>
    <li>Undiscovered roads light up. Zoom in to plan your next drive.</li>
  </ol>

  <p><em>Tip:</em> Console screenshots are usually clean enough that Tolerance 1 catches the undiscovered-grey exactly without flooding the rest of the map. If a few roads slip through, nudge Tolerance up one notch at a time.</p>

  <h3>Controls</h3>
  <ul>
    <li><strong>Find / Replace</strong> — the colours to search for and substitute.</li>
    <li><strong>Tolerance</strong> (0–40) — how far a pixel may drift from the target colour and still count as a match.</li>
    <li><strong>Desaturate background</strong> — converts every non-matching pixel to grey so the highlight pops harder.</li>
    <li><strong>FPS</strong> (PC only) — processing rate of the live capture loop, 0.1 to 30.</li>
    <li><strong>Scale</strong> — native resolution (scrollable) vs. fit-to-window.</li>
    <li><strong>Save image</strong> — exports the current processed frame as a timestamped PNG.</li>
  </ul>

  <h3>Privacy</h3>
  <p>Every pixel is processed locally in your browser. No images, frames or settings ever leave your device.</p>
`;

const DEFAULT_TOLERANCE_PC   = 5;
const DEFAULT_TOLERANCE_XBOX = 1;

// ─────────────────────────────────────────────────────────────────────────────
// DOM lookup
// ─────────────────────────────────────────────────────────────────────────────

const byId = (id) => document.getElementById(id);

const ui = {
  canvas:       byId('canvas'),
  canvasWrap:   byId('canvas-wrap'),

  modePc:       byId('modePc'),
  modeXbox:     byId('modeXbox'),
  modePs:       byId('modePs'),

  startBtn:     byId('startBtn'),
  pauseBtn:     byId('pauseBtn'),
  pauseLabel:   byId('pauseLabel'),
  stopBtn:      byId('stopBtn'),
  uploadBtn:    byId('uploadBtn'),
  pasteBtn:     byId('pasteBtn'),
  saveBtn:      byId('saveBtn'),
  scaleBtn:     byId('scaleBtn'),
  scaleLabel:   byId('scaleLabel'),

  fps:          byId('fps'),
  fpsValue:     byId('fpsValue'),
  tolerance:    byId('tolerance'),
  tolValue:     byId('tolValue'),
  colorTarget:  byId('colorTarget'),
  colorReplace: byId('colorReplace'),
  targetHex:    byId('targetHex'),
  replaceHex:   byId('replaceHex'),
  greyscale:    byId('greyscale'),

  placeholder:  byId('placeholder'),
  dropzone:     byId('dropzone'),
  dropzoneCapture: byId('dropzoneCapture'),
  fileInput:    byId('fileInput'),

  statusbar:    byId('statusbar'),
  status:       byId('status'),

  infoBtn:      byId('infoBtn'),
  infoOverlay:  byId('infoOverlay'),
  infoClose:    byId('infoClose'),
  infoBody:     byId('infoBody'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Mutable state
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  mode:   'pc',               // 'pc' | 'xbox'
  hasFrame: false,            // a frame has been rendered at least once
  pending: false,             // a render is queued via rAF
  live: {
    stream:  null,
    video:   null,
    running: false,
    paused:  false,
    rafId:   0,
    lastTs:  0,
  },
  params: {
    findColor:    parseHexColor('#808080'),
    paintColor:   parseHexColor('#44ff00'),
    tolerance255: DEFAULT_TOLERANCE_PC,
    desaturate:   true,
  },
};

let highlighter = null;

// ─────────────────────────────────────────────────────────────────────────────
// Status helpers
// ─────────────────────────────────────────────────────────────────────────────

function setStatus(text, kind = 'idle') {
  ui.status.textContent = text;
  ui.statusbar.classList.toggle('live',  kind === 'live');
  ui.statusbar.classList.toggle('error', kind === 'error');
}

// ─────────────────────────────────────────────────────────────────────────────
// Render pipeline
// ─────────────────────────────────────────────────────────────────────────────

function paint() {
  highlighter.render(state.params);
  state.hasFrame = true;
  ui.saveBtn.disabled = false;
}

// Coalesce parameter changes into a single GPU re-render per animation frame.
// Only relevant in Xbox mode where the source frame doesn't change on its own.
function requestRepaint() {
  if (state.mode === 'pc' || !state.hasFrame) return;
  if (state.pending) return;
  state.pending = true;
  requestAnimationFrame(() => {
    state.pending = false;
    paint();
    setStatus(`${ui.canvas.width}×${ui.canvas.height} · processed`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour & tolerance plumbing
// ─────────────────────────────────────────────────────────────────────────────

function applyFindColor(hex) {
  const rgb = parseHexColor(hex);
  if (!rgb) return;
  state.params.findColor = rgb;
  ui.targetHex.textContent = hex.toUpperCase();
  requestRepaint();
}

function applyPaintColor(hex) {
  const rgb = parseHexColor(hex);
  if (!rgb) return;
  state.params.paintColor = rgb;
  ui.replaceHex.textContent = hex.toUpperCase();
  requestRepaint();
}

function applyTolerance(value) {
  const v = clamp(Number(value) | 0, 0, 40);
  state.params.tolerance255 = v;
  ui.tolerance.value = v;
  ui.tolValue.textContent = String(v);
  requestRepaint();
}

function applyDesaturate(enabled) {
  state.params.desaturate = !!enabled;
  ui.greyscale.checked    = !!enabled;
  requestRepaint();
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode switching
// ─────────────────────────────────────────────────────────────────────────────

const CAPTURE_INSTRUCTIONS = {
  xbox: 'Capture in-game with <kbd>Xbox</kbd>+<kbd>Y</kbd>, then share from the Xbox app.',
  ps:   'PS5: tap <kbd>Create</kbd>. PS4: press <kbd>Share</kbd>. Then sync through the PlayStation App.',
};

function isPhotoMode(m) {
  return m === 'xbox' || m === 'ps';
}

function switchMode(target) {
  if (target === state.mode) return;
  const previous = state.mode;
  state.mode = target;

  // Tear down whatever the previous mode owned.
  if (previous === 'pc') stopLive();
  if (isPhotoMode(previous) && !isPhotoMode(target)) state.hasFrame = false;

  // Reset canvas presentation.
  ui.canvas.hidden    = true;
  ui.saveBtn.disabled = true;

  // Toggle button highlight on the three tabs.
  for (const [el, m] of [[ui.modePc, 'pc'], [ui.modeXbox, 'xbox'], [ui.modePs, 'ps']]) {
    el.classList.toggle('active', target === m);
    el.setAttribute('aria-selected', target === m ? 'true' : 'false');
  }

  // Show / hide blocks: .mode-pc for PC live, .mode-photo shared by Xbox & PS.
  for (const el of document.querySelectorAll('.mode-pc'))    el.hidden = target !== 'pc';
  for (const el of document.querySelectorAll('.mode-photo')) el.hidden = !isPhotoMode(target);

  // Swap the platform-specific capture line inside the dropzone.
  ui.dropzoneCapture.innerHTML = CAPTURE_INSTRUCTIONS[target] || '';

  // Auto-bump tolerance default per mode (unless the user already changed it).
  if (isPhotoMode(target) && state.params.tolerance255 === DEFAULT_TOLERANCE_PC) {
    applyTolerance(DEFAULT_TOLERANCE_XBOX);
  } else if (target === 'pc' && state.params.tolerance255 === DEFAULT_TOLERANCE_XBOX) {
    applyTolerance(DEFAULT_TOLERANCE_PC);
  }

  setStatus(target === 'pc' ? 'Idle' : 'Waiting for screenshot');
}

// ─────────────────────────────────────────────────────────────────────────────
// PC mode — live capture via getDisplayMedia + requestAnimationFrame
// ─────────────────────────────────────────────────────────────────────────────

async function startLive() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 5 },
        width:     { ideal: 2560 },
        height:    { ideal: 1440 },
      },
      audio: false,
    });

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted     = true;
    video.playsInline = true;
    await video.play();

    if (!video.videoWidth) {
      await new Promise((resolve) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
      });
    }

    highlighter.resize(video.videoWidth, video.videoHeight);

    stream.getVideoTracks()[0].addEventListener('ended', stopLive);

    Object.assign(state.live, {
      stream, video,
      running: true,
      paused:  false,
      lastTs:  0,
    });

    ui.canvas.hidden        = false;
    ui.placeholder.hidden   = true;
    ui.startBtn.disabled    = true;
    ui.pauseBtn.disabled    = false;
    ui.stopBtn.disabled     = false;
    ui.pauseLabel.textContent = 'Pause';
    resetView();

    state.live.rafId = requestAnimationFrame(liveTick);
  } catch (err) {
    setStatus('Error: ' + (err.message || err), 'error');
  }
}

function liveTick(now) {
  if (!state.live.running) return;

  if (state.live.paused) {
    state.live.rafId = requestAnimationFrame(liveTick);
    return;
  }

  const interval = 1000 / Number(ui.fps.value);
  if (now - state.live.lastTs >= interval) {
    state.live.lastTs = now;
    const t0 = performance.now();
    highlighter.upload(state.live.video);
    paint();
    const cost = performance.now() - t0;
    setStatus(
      `Live · ${ui.canvas.width}×${ui.canvas.height} · ${cost.toFixed(1)} ms · ${Number(ui.fps.value).toFixed(1)} fps`,
      'live',
    );
  }
  state.live.rafId = requestAnimationFrame(liveTick);
}

function togglePause() {
  if (!state.live.running) return;
  state.live.paused = !state.live.paused;
  ui.pauseLabel.textContent = state.live.paused ? 'Resume' : 'Pause';
  if (state.live.paused) setStatus('Paused');
}

function stopLive() {
  cancelAnimationFrame(state.live.rafId);
  if (state.live.stream) {
    for (const track of state.live.stream.getTracks()) track.stop();
  }
  Object.assign(state.live, {
    stream:  null,
    video:   null,
    running: false,
    paused:  false,
    rafId:   0,
    lastTs:  0,
  });
  ui.startBtn.disabled = false;
  ui.pauseBtn.disabled = true;
  ui.stopBtn.disabled  = true;
  ui.pauseLabel.textContent = 'Pause';
  ui.saveBtn.disabled  = true;
  setStatus('Stopped');
}

// ─────────────────────────────────────────────────────────────────────────────
// Xbox mode — single image upload via createImageBitmap
// ─────────────────────────────────────────────────────────────────────────────

async function ingestBlob(blob) {
  if (!blob || !blob.type || !blob.type.startsWith('image/')) {
    setStatus('That file is not an image', 'error');
    return;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    setStatus('Could not decode image: ' + (err.message || err), 'error');
    return;
  }
  highlighter.resize(bitmap.width, bitmap.height);
  highlighter.upload(bitmap);
  bitmap.close && bitmap.close();
  ui.canvas.hidden      = false;
  ui.placeholder.hidden = true;
  ui.dropzone.hidden    = true;
  resetView();
  paint();
  setStatus(`${ui.canvas.width}×${ui.canvas.height} · processed`);
}

function pickFile() {
  ui.fileInput.click();
}

async function pasteFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    setStatus('Clipboard read is not available — try Ctrl+V instead', 'error');
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          await ingestBlob(blob);
          return;
        }
      }
    }
    setStatus('No image on clipboard', 'error');
  } catch (err) {
    setStatus('Clipboard read failed: ' + (err.message || err), 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Save & scale (mode-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

function saveCanvasAsPng() {
  ui.canvas.toBlob((blob) => {
    if (!blob) return;
    const a   = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href     = url;
    a.download = `forza-map-${timestamp()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

// ─────────────────────────────────────────────────────────────────────────────
// View controller — auto-fit the canvas to the available area, then layer
// zoom and pan on top. Wheel + drag on desktop, pinch + drag on touch.
// ─────────────────────────────────────────────────────────────────────────────

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 16;

const view = {
  fitScale: 1,
  zoom:     1,
  panX:     0,
  panY:     0,
};

function computeFitScale() {
  const cw = ui.canvas.width;
  const ch = ui.canvas.height;
  if (!cw || !ch) return 1;
  const rect = ui.canvasWrap.getBoundingClientRect();
  const margin = 24;
  const availW = Math.max(1, rect.width  - margin * 2);
  const availH = Math.max(1, rect.height - margin * 2);
  return Math.min(availW / cw, availH / ch);
}

function applyView() {
  const total = view.fitScale * view.zoom;
  ui.canvas.style.transform =
    `translate(${view.panX}px, ${view.panY}px) scale(${total})`;
}

function resetView() {
  view.fitScale = computeFitScale();
  view.zoom = 1;
  view.panX = 0;
  view.panY = 0;
  applyView();
}

function zoomAt(screenX, screenY, factor) {
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.zoom * factor));
  if (newZoom === view.zoom) return;
  const rect = ui.canvas.getBoundingClientRect();
  const cx = rect.left + rect.width  / 2;
  const cy = rect.top  + rect.height / 2;
  const k = 1 - newZoom / view.zoom;
  view.panX += (screenX - cx) * k;
  view.panY += (screenY - cy) * k;
  view.zoom = newZoom;
  applyView();
}

function attachViewControls() {
  const surface = ui.canvasWrap;
  const pointers = new Map();
  let pinch = null;

  surface.addEventListener('wheel', (e) => {
    if (ui.canvas.hidden) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0018));
  }, { passive: false });

  surface.addEventListener('pointerdown', (e) => {
    if (ui.canvas.hidden) return;
    if (e.target.closest('button, input, a')) return;
    surface.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        startDist: Math.hypot(a.x - b.x, a.y - b.y),
        startZoom: view.zoom,
      };
    }
    surface.style.cursor = 'grabbing';
  });

  surface.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const target = pinch.startZoom * (d / pinch.startDist);
      const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, target));
      const factor = clamped / view.zoom;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (factor !== 1) zoomAt(mid.x, mid.y, factor);
    } else if (pointers.size === 1) {
      view.panX += e.clientX - prev.x;
      view.panY += e.clientY - prev.y;
      applyView();
    }
  });

  function release(e) {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) surface.style.cursor = '';
  }
  surface.addEventListener('pointerup',     release);
  surface.addEventListener('pointercancel', release);

  surface.addEventListener('dblclick', () => {
    if (ui.canvas.hidden) return;
    resetView();
  });

  window.addEventListener('resize', () => {
    if (ui.canvas.hidden) return;
    view.fitScale = computeFitScale();
    applyView();
  });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ─────────────────────────────────────────────────────────────────────────────
// Help modal
// ─────────────────────────────────────────────────────────────────────────────

function openHelp()  { ui.infoOverlay.hidden = false; }
function closeHelp() { ui.infoOverlay.hidden = true;  }

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

function wireMode() {
  ui.modePc  .addEventListener('click', () => switchMode('pc'));
  ui.modeXbox.addEventListener('click', () => switchMode('xbox'));
  ui.modePs  .addEventListener('click', () => switchMode('ps'));
}

function wireColors() {
  ui.colorTarget .addEventListener('input', (e) => applyFindColor(e.target.value));
  ui.colorReplace.addEventListener('input', (e) => applyPaintColor(e.target.value));
  ui.greyscale   .addEventListener('input', (e) => applyDesaturate(e.target.checked));
  // Reflect initial defaults into the UI labels.
  ui.targetHex.textContent  = ui.colorTarget .value.toUpperCase();
  ui.replaceHex.textContent = ui.colorReplace.value.toUpperCase();
}

function wireSliders() {
  ui.tolerance.addEventListener('input', (e) => applyTolerance(e.target.value));
  ui.fps      .addEventListener('input', (e) => {
    ui.fpsValue.textContent = Number(e.target.value).toFixed(1);
  });
  ui.fpsValue.textContent = Number(ui.fps.value).toFixed(1);
  ui.tolValue.textContent = String(ui.tolerance.value);
}

function wireSource() {
  // PC mode
  ui.startBtn.addEventListener('click', startLive);
  ui.pauseBtn.addEventListener('click', togglePause);
  ui.stopBtn .addEventListener('click', stopLive);

  // Xbox mode
  ui.uploadBtn.addEventListener('click', pickFile);
  ui.pasteBtn .addEventListener('click', pasteFromClipboard);

  if (!navigator.clipboard || !navigator.clipboard.read) {
    ui.pasteBtn.style.display = 'none';
  }

  ui.fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await ingestBlob(file);
    ui.fileInput.value = '';
  });

  // Drag & drop on the dropzone.
  ui.dropzone.addEventListener('click', pickFile);
  for (const ev of ['dragenter', 'dragover']) {
    ui.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      ui.dropzone.classList.add('over');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    ui.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      ui.dropzone.classList.remove('over');
    });
  }
  // Stop drop-anywhere from navigating the browser to the file.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop',     (e) => e.preventDefault());

  ui.dropzone.addEventListener('drop', async (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) await ingestBlob(file);
  });

  // Paste anywhere on the page in Xbox mode.
  document.addEventListener('paste', async (e) => {
    if (!isPhotoMode(state.mode)) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) await ingestBlob(blob);
        return;
      }
    }
  });
}

function wireSaveScale() {
  ui.saveBtn .addEventListener('click', saveCanvasAsPng);
  ui.scaleBtn.addEventListener('click', resetView);
  attachViewControls();
}

function wireHelp() {
  ui.infoBody.innerHTML = HELP_HTML;
  ui.infoBtn  .addEventListener('click', openHelp);
  ui.infoClose.addEventListener('click', closeHelp);
  ui.infoOverlay.addEventListener('click', (e) => {
    if (e.target === ui.infoOverlay) closeHelp();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHelp();
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Don't fail the app if the SW can't register (e.g. on file://).
  navigator.serviceWorker.register(new URL('./sw.js', import.meta.url)).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

function init() {
  try {
    highlighter = new MapHighlighter(ui.canvas);
  } catch (err) {
    setStatus(err.message, 'error');
    ui.startBtn  .disabled = true;
    ui.uploadBtn .disabled = true;
    ui.pasteBtn  .disabled = true;
    return;
  }

  wireColors();
  wireSliders();
  wireMode();
  wireSource();
  wireSaveScale();
  wireHelp();
  registerServiceWorker();

  // Sync defaults into the visual UI.
  applyTolerance(ui.tolerance.value);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
