// Face tracker for DEMON Visage.
//
// Loads MediaPipe FaceLandmarker (478 landmarks + 52 ARKit blendshapes),
// runs it over a video source (live webcam OR the bundled demo clip), and
// publishes the latest readings on `window.__faceTracker`. The DEMON bridge
// reads those readings and maps them to remix knobs — this module owns ONLY
// tracking + the on-screen face-mesh overlay, never the model.
//
// The overlay is deliberately loud: the full mesh is drawn every frame and
// the regions that drive the remix (mouth, brows, head-turn axis) light up as
// you move, so it is obvious the face is in control.

import {
  FaceLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://esm.sh/@mediapipe/tasks-vision@0.10.14";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const DEMO_VIDEO_SRC = "./assets/d10.mp4";

// ── Pure geometry helpers (exported for headless tests) ────────────────────

// Pull a blendshape score out of a MediaPipe categories array by name.
export function shapeScore(categories, name) {
  if (!categories) return 0;
  for (const c of categories) {
    if (c.categoryName === name) return c.score;
  }
  return 0;
}

// Approximate head pose from face landmarks. Returns signed, roughly
// normalized yaw/pitch in about [-1, 1]. Pure: synthetic landmark arrays in
// the tests exercise this without a camera.
export function computePose(lm) {
  if (!lm || lm.length < 470) return { yaw: 0, pitch: 0, roll: 0 };
  const noseTip = lm[1];
  const faceLeft = lm[234];
  const faceRight = lm[454];
  const eyeL = lm[33];
  const eyeR = lm[263];
  const chin = lm[152];

  // Yaw: horizontal asymmetry of the nose between the face edges.
  const dLeft = Math.abs(noseTip.x - faceLeft.x);
  const dRight = Math.abs(faceRight.x - noseTip.x);
  const yaw = (dLeft - dRight) / (dLeft + dRight + 1e-6);

  // Pitch: nose height between the eye line and the chin (foreshortens as the
  // head tilts), centered on a neutral resting ratio.
  const eyeY = (eyeL.y + eyeR.y) / 2;
  const noseRel = (noseTip.y - eyeY) / (chin.y - eyeY + 1e-6);
  const pitch = (noseRel - 0.5) * 3.2;

  // Roll: tilt of the eye line.
  const roll = Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x);

  return {
    yaw: Math.max(-1, Math.min(1, yaw)),
    pitch: Math.max(-1, Math.min(1, pitch)),
    roll,
  };
}

// ── Tracker ────────────────────────────────────────────────────────────────

class FaceTracker {
  constructor() {
    this.landmarker = null;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.draw = null;
    this.stream = null;
    this.source = "camera"; // 'camera' | 'video'
    this.mirror = true; // camera is mirrored for intuitive control
    this.lastVideoTime = -1;

    // Published, read by the bridge each pump tick.
    this.ready = false;
    this.faceVisible = false;
    this.blend = Object.create(null); // categoryName -> score
    this.landmarks = null;
    this.pose = { yaw: 0, pitch: 0, roll: 0 };
    this.error = null;

    this.onStatus = () => {};
  }

  async init(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.draw = new DrawingUtils(this.ctx);

    this.onStatus("loading face model");
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });

    try {
      await this.setSource(this.source);
    } catch (e) {
      // Camera denied/absent → fall back to the bundled demo clip so the app
      // still runs (and so headless/no-camera environments work).
      console.warn("[visage] camera unavailable, using demo clip:", e);
      this.error = e;
      this.source = "video";
      await this.setSource("video");
    }
    this.ready = true;
    this._loop();
    return this.source;
  }

  async setSource(kind) {
    this.source = kind;
    this.lastVideoTime = -1;
    // Tear down a live camera stream when switching away from it.
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    if (kind === "video") {
      this.mirror = false;
      this.video.srcObject = null;
      this.video.src = DEMO_VIDEO_SRC;
      this.video.loop = true;
      this.video.muted = true;
      this.onStatus("loading demo clip");
      await this.video.play().catch(() => {});
    } else {
      this.mirror = true;
      this.video.removeAttribute("src");
      this.onStatus("requesting camera");
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      this.video.loop = false;
      this.video.muted = true;
      await this.video.play().catch(() => {});
    }

    await this._awaitMetadata();
    this._syncCanvasSize();
    this.video.classList.toggle("mirrored", this.mirror);
    this.canvas.classList.toggle("mirrored", this.mirror);
    this.onStatus(kind === "video" ? "demo clip" : "camera live");
  }

  _awaitMetadata() {
    return new Promise((resolve) => {
      if (this.video.readyState >= 1 && this.video.videoWidth) return resolve();
      this.video.onloadedmetadata = () => resolve();
    });
  }

  _syncCanvasSize() {
    const w = this.video.videoWidth || 640;
    const h = this.video.videoHeight || 480;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  _loop() {
    const tick = () => {
      requestAnimationFrame(tick);
      this._detect();
    };
    requestAnimationFrame(tick);
  }

  _detect() {
    const v = this.video;
    if (!this.landmarker || !v || v.readyState < 2 || !v.videoWidth) return;
    if (v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;

    let result;
    try {
      result = this.landmarker.detectForVideo(v, performance.now());
    } catch (e) {
      return; // transient; next frame retries
    }

    const lm = result.faceLandmarks && result.faceLandmarks[0];
    if (lm) {
      this.faceVisible = true;
      this.landmarks = lm;
      const cats = result.faceBlendshapes && result.faceBlendshapes[0]
        ? result.faceBlendshapes[0].categories
        : null;
      const blend = Object.create(null);
      if (cats) for (const c of cats) blend[c.categoryName] = c.score;
      this.blend = blend;
      this.pose = computePose(lm);
    } else {
      this.faceVisible = false;
      this.landmarks = null;
    }
    this._render();
  }

  _render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const lm = this.landmarks;
    if (!lm) return;

    const b = this.blend;
    const jaw = b.jawOpen || 0;
    const smile = ((b.mouthSmileLeft || 0) + (b.mouthSmileRight || 0)) / 2;
    const browUp = b.browInnerUp || 0;
    const browDown = ((b.browDownLeft || 0) + (b.browDownRight || 0)) / 2;

    // Faint full tesselation — "the whole face is tracked".
    this.draw.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_TESSELATION, {
      color: "rgba(110,255,176,0.16)",
      lineWidth: 0.5,
    });
    // Face oval + eyes always visible.
    this.draw.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, {
      color: "rgba(120,255,200,0.55)",
      lineWidth: 1.5,
    });
    this.draw.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, {
      color: "rgba(180,240,255,0.7)",
      lineWidth: 1.2,
    });
    this.draw.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, {
      color: "rgba(180,240,255,0.7)",
      lineWidth: 1.2,
    });
    this.draw.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, {
      color: "rgba(255,255,255,0.85)",
      lineWidth: 1.5,
    });
    this.draw.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, {
      color: "rgba(255,255,255,0.85)",
      lineWidth: 1.5,
    });

    // Lips glow with jawOpen (the headline REMIX driver).
    this.draw.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LIPS, {
      color: heat(jaw, [255, 120, 60]),
      lineWidth: 1.5 + jaw * 6,
    });

    // Brows: green when raised (echo), red when furrowed (grit).
    const browAct = Math.max(browUp, browDown);
    const browColor = browUp >= browDown ? [110, 255, 160] : [255, 90, 90];
    this.draw.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, {
      color: heat(browAct, browColor),
      lineWidth: 1.5 + browAct * 5,
    });
    this.draw.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, {
      color: heat(browAct, browColor),
      lineWidth: 1.5 + browAct * 5,
    });

    // Smile ribbon under the mouth corners brightens with smile.
    if (smile > 0.05) {
      const lc = lm[61], rc = lm[291];
      ctx.beginPath();
      ctx.moveTo(lc.x * w, lc.y * h);
      ctx.lineTo(rc.x * w, rc.y * h);
      ctx.strokeStyle = heat(smile, [120, 220, 255]);
      ctx.lineWidth = 1 + smile * 5;
      ctx.stroke();
    }

    // Head-turn axis: a bar through the nose whose length tracks yaw.
    const nose = lm[1];
    const yaw = this.pose.yaw;
    ctx.beginPath();
    ctx.moveTo(nose.x * w, nose.y * h);
    ctx.lineTo((nose.x + yaw * 0.18) * w, nose.y * h);
    ctx.strokeStyle = "rgba(255,210,120,0.9)";
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

// Lerp a base RGB toward white as activation rises, returning an rgba string.
function heat(a, rgb) {
  const t = Math.max(0, Math.min(1, a));
  const r = Math.round(rgb[0] + (255 - rgb[0]) * t * 0.6);
  const g = Math.round(rgb[1] + (255 - rgb[1]) * t * 0.6);
  const bl = Math.round(rgb[2] + (255 - rgb[2]) * t * 0.6);
  return `rgba(${r},${g},${bl},${0.5 + 0.5 * t})`;
}

export const tracker = new FaceTracker();
window.__faceTracker = tracker;
