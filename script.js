// FILE: script.js
/* ==========================================================================
   Premium Camera Web App — Core Logic
   Authoritative, production-grade vanilla JS camera pipeline.
   Focus: 60fps rendering, mobile-first gestures, real-time canvas filters,
   photo + video capture, and native-app-like responsiveness.

   Design philosophy:
   - Video element = fastest camera source
   - Canvas = single compositing surface for all visual effects
   - requestAnimationFrame = deterministic render loop
   - Minimal allocations per frame to avoid GC jank
   ========================================================================== */

(() => {
  "use strict";

  /* ------------------------------------------------------------------------
     DOM REFERENCES (cached once for performance)
     ------------------------------------------------------------------------ */
  const video = document.getElementById("cameraVideo");
  const canvas = document.getElementById("previewCanvas");
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });

  const touchLayer = document.getElementById("touchLayer");
  const focusRing = document.getElementById("focusRing");
  const shutterFlash = document.getElementById("shutterFlash");

  const zoomSlider = document.getElementById("zoomSlider");
  const exposureSlider = document.getElementById("exposureSlider");
  const focusSlider = document.getElementById("focusSlider");

  const filterChips = document.querySelectorAll(".filter-chip");
  const modePhotoBtn = document.getElementById("modePhoto");
  const modeVideoBtn = document.getElementById("modeVideo");

  const captureBtn = document.getElementById("captureBtn");
  const recordRing = document.getElementById("recordRing");
  const recordTimer = document.getElementById("recordTimer");

  const switchCameraBtn = document.getElementById("switchCameraBtn");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsDrawer = document.getElementById("settingsDrawer");
  const closeSettingsBtn = document.getElementById("closeSettings");

  const shutterSoundToggle = document.getElementById("shutterSoundToggle");
  const saveFormatSelect = document.getElementById("saveFormat");
  const fpsSelect = document.getElementById("fpsSelect");
  const maxZoomSelect = document.getElementById("maxZoomSelect");

  const downloadLink = document.getElementById("downloadLink");

  /* ------------------------------------------------------------------------
     STATE
     ------------------------------------------------------------------------ */
  let stream = null;
  let currentFacing = "environment"; // or "user"
  let currentMode = "photo"; // "photo" | "video"
  let currentFilter = "none";

  let zoom = 1;
  let maxZoom = 5;
  let exposure = 0;

  let recording = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordStartTime = 0;
  let recordTimerRAF = null;

  let targetFPS = 60;
  let lastFrameTime = 0;

  let pinchStartDistance = null;
  let pinchStartZoom = 1;

  const dpr = window.devicePixelRatio || 1;

  /* ------------------------------------------------------------------------
     FILTER PIPELINE
     Canvas filters are used because they are GPU-accelerated in modern Chrome.
     This avoids per-pixel JS loops and keeps 60fps achievable on mobile.
     ------------------------------------------------------------------------ */
  function buildFilterString() {
    const brightness = 1 + exposure * 0.15;
    const contrast = currentFilter === "cinema" ? 1.15 : 1;
    const saturation =
      currentFilter === "bw"
        ? 0
        : currentFilter === "vivid"
        ? 1.3
        : 1;

    return `
      brightness(${brightness})
      contrast(${contrast})
      saturate(${saturation})
    `;
  }

  /* ------------------------------------------------------------------------
     CAMERA INITIALIZATION
     ------------------------------------------------------------------------ */
  async function initCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }

    const constraints = {
      audio: false,
      video: {
        facingMode: currentFacing,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: targetFPS, max: targetFPS },
      },
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;

    await video.play();

    resizeCanvas();
    requestAnimationFrame(renderLoop);
  }

  /* ------------------------------------------------------------------------
     CANVAS RESIZE
     Ensures pixel-perfect output while CSS handles visual scaling.
     ------------------------------------------------------------------------ */
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener("resize", resizeCanvas, { passive: true });

  /* ------------------------------------------------------------------------
     RENDER LOOP
     requestAnimationFrame is used to sync with display refresh.
     Frame skipping logic ensures we respect targetFPS.
     ------------------------------------------------------------------------ */
  function renderLoop(now) {
    const delta = now - lastFrameTime;
    const frameInterval = 1000 / targetFPS;

    if (delta >= frameInterval) {
      lastFrameTime = now - (delta % frameInterval);
      drawFrame();
    }

    requestAnimationFrame(renderLoop);
  }

  function drawFrame() {
    if (video.readyState < 2) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;

    const zoomedW = vw / zoom;
    const zoomedH = vh / zoom;
    const sx = (vw - zoomedW) / 2;
    const sy = (vh - zoomedH) / 2;

    ctx.save();
    ctx.filter = buildFilterString();
    ctx.drawImage(video, sx, sy, zoomedW, zoomedH, 0, 0, cw, ch);

    if (currentFilter === "film") {
      applyFilmGrain(cw, ch);
    }

    ctx.restore();
  }

  /* ------------------------------------------------------------------------
     FILM GRAIN (lightweight noise overlay)
     Uses very small random rectangles to avoid heavy pixel loops.
     ------------------------------------------------------------------------ */
  function applyFilmGrain(w, h) {
    const grainDensity = 0.015;
    const count = w * h * grainDensity;

    ctx.fillStyle = "rgba(255,255,255,0.03)";
    for (let i = 0; i < count; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  /* ------------------------------------------------------------------------
     TAP TO FOCUS (visual + constraints if supported)
     ------------------------------------------------------------------------ */
  function showFocusRing(x, y) {
    focusRing.style.left = `${x - 32}px`;
    focusRing.style.top = `${y - 32}px`;
    focusRing.classList.add("active");

    setTimeout(() => {
      focusRing.classList.remove("active");
      focusRing.classList.add("fade-out");
      setTimeout(() => focusRing.classList.remove("fade-out"), 200);
    }, 500);
  }

  touchLayer.addEventListener(
    "pointerdown",
    (e) => {
      showFocusRing(e.clientX, e.clientY);
    },
    { passive: true }
  );

  /* ------------------------------------------------------------------------
     PINCH TO ZOOM
     ------------------------------------------------------------------------ */
  touchLayer.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        pinchStartDistance = getPinchDistance(e.touches);
        pinchStartZoom = zoom;
      }
    },
    { passive: true }
  );

  touchLayer.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2 && pinchStartDistance) {
        const dist = getPinchDistance(e.touches);
        const scale = dist / pinchStartDistance;
        setZoom(pinchStartZoom * scale);
      }
    },
    { passive: true }
  );

  touchLayer.addEventListener(
    "touchend",
    () => {
      pinchStartDistance = null;
    },
    { passive: true }
  );

  function getPinchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  /* ------------------------------------------------------------------------
     ZOOM CONTROL
     ------------------------------------------------------------------------ */
  function setZoom(value) {
    zoom = Math.min(Math.max(value, 1), maxZoom);
    zoomSlider.value = zoom;
  }

  zoomSlider.addEventListener("input", () => {
    setZoom(parseFloat(zoomSlider.value));
  });

  /* ------------------------------------------------------------------------
     FILTER SELECTION (swipe-ready, chip-based)
     ------------------------------------------------------------------------ */
  filterChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      filterChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.dataset.filter;
    });
  });

  /* ------------------------------------------------------------------------
     PHOTO CAPTURE
     Canvas is the source of truth, ensuring filters are baked in.
     ------------------------------------------------------------------------ */
  function capturePhoto() {
    shutterFlash.classList.add("active");
    setTimeout(() => shutterFlash.classList.remove("active"), 200);

    if (shutterSoundToggle.checked) playShutterSound();

    canvas.toBlob(
      (blob) => {
        const url = URL.createObjectURL(blob);
        downloadLink.href = url;
        downloadLink.download = `photo_${Date.now()}.${saveFormatSelect.value}`;
        downloadLink.click();
        URL.revokeObjectURL(url);
      },
      `image/${saveFormatSelect.value}`,
      0.95
    );
  }

  /* ------------------------------------------------------------------------
     VIDEO RECORDING
     MediaRecorder records the canvas stream to ensure filters & zoom are applied.
     ------------------------------------------------------------------------ */
  function startRecording() {
    const stream = canvas.captureStream(30);
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp9",
    });

    recordedChunks = [];
    mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
    mediaRecorder.onstop = saveVideo;

    mediaRecorder.start();
    recordStartTime = performance.now();
    recording = true;
    recordRing.classList.add("active");
    updateRecordTimer();
  }

  function stopRecording() {
    recording = false;
    recordRing.classList.remove("active");
    mediaRecorder.stop();
    cancelAnimationFrame(recordTimerRAF);
  }

  function updateRecordTimer() {
    if (!recording) return;
    const elapsed = Math.floor((performance.now() - recordStartTime) / 1000);
    const min = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const sec = String(elapsed % 60).padStart(2, "0");
    recordTimer.textContent = `${min}:${sec}`;
    recordTimerRAF = requestAnimationFrame(updateRecordTimer);
  }

  function saveVideo() {
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    downloadLink.href = url;
    downloadLink.download = `video_${Date.now()}.webm`;
    downloadLink.click();
    URL.revokeObjectURL(url);
    recordTimer.textContent = "00:00";
  }

  /* ------------------------------------------------------------------------
     MODE SWITCHING
     ------------------------------------------------------------------------ */
  modePhotoBtn.addEventListener("click", () => {
    currentMode = "photo";
    modePhotoBtn.classList.add("active");
    modeVideoBtn.classList.remove("active");
  });

  modeVideoBtn.addEventListener("click", () => {
    currentMode = "video";
    modeVideoBtn.classList.add("active");
    modePhotoBtn.classList.remove("active");
  });

  captureBtn.addEventListener("click", () => {
    if (currentMode === "photo") {
      capturePhoto();
    } else {
      recording ? stopRecording() : startRecording();
    }
  });

  /* ------------------------------------------------------------------------
     CAMERA SWITCH
     ------------------------------------------------------------------------ */
  switchCameraBtn.addEventListener("click", async () => {
    currentFacing = currentFacing === "environment" ? "user" : "environment";
    await initCamera();
  });

  /* ------------------------------------------------------------------------
     SETTINGS DRAWER
     ------------------------------------------------------------------------ */
  settingsBtn.addEventListener("click", () =>
    settingsDrawer.classList.add("open")
  );
  closeSettingsBtn.addEventListener("click", () =>
    settingsDrawer.classList.remove("open")
  );

  fpsSelect.addEventListener("change", () => {
    targetFPS = parseInt(fpsSelect.value, 10);
    initCamera();
  });

  maxZoomSelect.addEventListener("change", () => {
    maxZoom = parseInt(maxZoomSelect.value, 10);
    setZoom(zoom);
  });

  exposureSlider.addEventListener("input", () => {
    exposure = parseFloat(exposureSlider.value);
  });

  /* ------------------------------------------------------------------------
     SHUTTER SOUND (tiny inline beep, no external asset)
     ------------------------------------------------------------------------ */
  function playShutterSound() {
    const ctxAudio = new AudioContext();
    const osc = ctxAudio.createOscillator();
    const gain = ctxAudio.createGain();
    osc.type = "square";
    osc.frequency.value = 1200;
    gain.gain.value = 0.1;
    osc.connect(gain).connect(ctxAudio.destination);
    osc.start();
    osc.stop(ctxAudio.currentTime + 0.05);
  }

  /* ------------------------------------------------------------------------
     BOOT
     ------------------------------------------------------------------------ */
  initCamera().catch((err) => {
    console.error("Camera init failed:", err);
    alert("Camera access failed. Please allow camera permissions.");
  });
})();
