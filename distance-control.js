(() => {
  "use strict";

  const DISTANCE_ENABLED_KEY = "clarity-flipper-distance-enabled-v1";
  const DISTANCE_CALIBRATION_KEY = "clarity-flipper-distance-calibration-v1";
  const REFERENCE_DISTANCE_MM = 400;
  const MIN_RECOMMENDED_DISTANCE_MM = 350;
  const MAX_RECOMMENDED_DISTANCE_MM = 450;
  const REQUIRED_STABLE_SAMPLES = 7;
  const MAX_SAMPLE_WINDOW = 11;
  const MAX_MEASUREMENT_DURATION_MS = 9000;
  const MODEL_PATH = "./distance-model/model.json";
  const VIDEO_CONSTRAINTS = {
    facingMode: "user",
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 15, max: 24 },
  };

  class ClarityDistanceControl {
    constructor() {
      this.elements = {
        toggle: document.querySelector("#distanceToggle"),
        status: document.querySelector("#distanceStatus"),
        openCalibrationButton: document.querySelector(
          "#openDistanceCalibrationButton",
        ),
        indicator: document.querySelector("#distanceIndicator"),
        indicatorText: document.querySelector("#distanceIndicatorText"),
        dialog: document.querySelector("#distanceDialog"),
        closeButton: document.querySelector("#closeDistanceDialogButton"),
        title: document.querySelector("#distanceDialogTitle"),
        description: document.querySelector("#distanceDialogDescription"),
        preview: document.querySelector("#distancePreview"),
        video: document.querySelector("#distanceVideo"),
        overlay: document.querySelector("#distanceLandmarkOverlay"),
        faceGuide: document.querySelector("#distanceLandmarkOverlay .face-guide"),
        eyePointA: document.querySelector("#distanceEyePointA"),
        eyePointB: document.querySelector("#distanceEyePointB"),
        eyeLine: document.querySelector("#distanceEyeLine"),
        result: document.querySelector("#distanceResult"),
        value: document.querySelector("#distanceValue"),
        advice: document.querySelector("#distanceAdvice"),
        measureStatus: document.querySelector("#distanceMeasureStatus"),
        actionButton: document.querySelector("#distanceActionButton"),
        retryButton: document.querySelector("#retryDistanceButton"),
        cancelButton: document.querySelector("#cancelDistanceButton"),
      };
      this.supported = Boolean(
        window.isSecureContext &&
          navigator.mediaDevices?.getUserMedia &&
          window.tf &&
          window.blazeface,
      );
      const savedEnabled = this.readText(DISTANCE_ENABLED_KEY);
      this.enabled = savedEnabled === null ? true : savedEnabled === "true";
      this.calibration = this.readJson(DISTANCE_CALIBRATION_KEY);
      this.model = null;
      this.modelPromise = null;
      this.stream = null;
      this.flow = null;
      this.runId = 0;
      this.lastResultMm = null;
      this.lastSessionWasMeasured = false;

      this.bindEvents();
      this.restoreInitialState();
    }

    readText(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    }

    readJson(key) {
      try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : null;
      } catch {
        return null;
      }
    }

    writeText(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // The feature remains available for the current page load.
      }
    }

    writeJson(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // The feature remains available for the current page load.
      }
    }

    bindEvents() {
      this.elements.toggle.addEventListener("change", () => {
        this.enabled = this.elements.toggle.checked;
        if (!this.enabled) {
          this.lastResultMm = null;
          this.lastSessionWasMeasured = false;
          this.onSessionStop();
        }
        this.writeText(DISTANCE_ENABLED_KEY, String(this.enabled));
        this.updateSettingUi();
      });
      this.elements.openCalibrationButton.addEventListener("click", () => {
        this.openFlow({ forSession: false, forceCalibration: true });
      });
      this.elements.closeButton.addEventListener("click", () => {
        this.finishFlow(false);
      });
      this.elements.cancelButton.addEventListener("click", () => {
        this.finishFlow(false);
      });
      this.elements.dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        this.finishFlow(false);
      });
      this.elements.actionButton.addEventListener("click", () => {
        this.handleAction();
      });
      this.elements.retryButton.addEventListener("click", () => {
        this.retryMeasurement();
      });
    }

    restoreInitialState() {
      if (!this.supported) {
        this.enabled = false;
        this.elements.toggle.checked = false;
        this.elements.toggle.disabled = true;
        this.elements.openCalibrationButton.disabled = true;
        this.setSettingStatus("此浏览器不支持摄像头测距", "error");
        return;
      }
      this.elements.toggle.checked = this.enabled;
      this.updateSettingUi();
    }

    setSettingStatus(message, state = "idle") {
      this.elements.status.textContent = message;
      this.elements.status.dataset.state = state;
    }

    updateSettingUi() {
      this.elements.toggle.checked = this.enabled;
      if (!this.enabled) {
        this.setSettingStatus(
          this.calibration ? "已关闭 · 40 cm 参考已保存" : "已关闭",
        );
        return;
      }
      if (this.calibration) {
        this.setSettingStatus("每轮开始前估计一次", "ready");
        return;
      }
      this.setSettingStatus("首次使用需在 40 cm 标定");
    }

    prepareForSession() {
      if (!this.enabled || !this.supported) {
        this.lastResultMm = null;
        this.lastSessionWasMeasured = false;
        return Promise.resolve(true);
      }
      this.lastSessionWasMeasured = false;
      return this.openFlow({
        forSession: true,
        forceCalibration: !this.calibration,
      });
    }

    openFlow({ forSession, forceCalibration }) {
      if (this.flow) {
        return this.flow.promise;
      }

      let resolveFlow;
      const promise = new Promise((resolve) => {
        resolveFlow = resolve;
      });
      this.flow = {
        promise,
        resolve: resolveFlow,
        forSession,
        mode: forceCalibration ? "calibration" : "measurement",
        phase: "loading",
        measurement: null,
        camera: null,
      };
      this.runId += 1;
      this.resetDialogUi();
      if (!this.elements.dialog.open) {
        this.elements.dialog.showModal();
      }
      this.setupFlow(this.runId);
      return promise;
    }

    resetDialogUi() {
      const isCalibration = this.flow.mode === "calibration";
      this.elements.title.textContent = isCalibration
        ? "标定 40 cm 参考距离"
        : "训练前估计视距";
      this.elements.description.textContent = isCalibration
        ? "用直尺确认眼睛到屏幕约 40 cm，正对屏幕并保持不动。"
        : "请正对屏幕并保持不动，稳定后只记录本轮距离。";
      this.elements.preview.hidden = false;
      this.elements.result.hidden = true;
      delete this.elements.result.dataset.state;
      this.elements.retryButton.hidden = true;
      this.elements.actionButton.disabled = true;
      this.elements.actionButton.dataset.action = "none";
      this.elements.actionButton.textContent = "正在准备";
      this.elements.measureStatus.textContent = "正在准备摄像头和本地模型…";
      delete this.elements.measureStatus.dataset.state;
      this.clearLandmarks();
    }

    async setupFlow(runId) {
      try {
        await this.ensureModel();
        const camera = await this.startCamera(runId);
        if (!this.isCurrentRun(runId)) {
          return;
        }

        this.flow.camera = camera;
        if (
          this.flow.mode === "measurement" &&
          !this.isCalibrationCompatible(camera)
        ) {
          this.flow.mode = "calibration";
          this.elements.title.textContent = "摄像头环境已变化";
          this.elements.description.textContent =
            "请用直尺确认眼睛到屏幕约 40 cm，重新建立本机参考距离。";
        }

        if (this.flow.mode === "calibration") {
          this.flow.phase = "ready-calibration";
          this.elements.measureStatus.textContent =
            "调整到 40 cm，保持正脸并让面部位于虚线框内。";
          this.elements.actionButton.disabled = false;
          this.elements.actionButton.dataset.action = "measure";
          this.elements.actionButton.textContent =
            "已保持 40 cm，开始标定";
          return;
        }

        await this.collectMeasurement(runId);
      } catch (error) {
        if (this.isCurrentRun(runId)) {
          this.handleFlowError(error);
        }
      }
    }

    async ensureModel() {
      if (this.model) {
        return this.model;
      }
      if (this.modelPromise) {
        return this.modelPromise;
      }

      this.modelPromise = (async () => {
        await window.tf.ready();
        const model = await window.blazeface.load({
          maxFaces: 1,
          scoreThreshold: 0.75,
          modelUrl: new URL(MODEL_PATH, window.location.href).href,
        });
        const warmupInput = window.tf.zeros([128, 128, 3]);
        try {
          await model.estimateFaces(warmupInput, false, false, true);
        } finally {
          warmupInput.dispose();
        }
        return model;
      })();

      try {
        this.model = await this.modelPromise;
        return this.model;
      } finally {
        this.modelPromise = null;
      }
    }

    async startCamera(runId) {
      this.stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: VIDEO_CONSTRAINTS,
      });
      if (!this.isCurrentRun(runId)) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("测距已取消");
      }

      this.stream = stream;
      this.elements.video.srcObject = stream;
      await this.waitForVideo(this.elements.video);
      await this.elements.video.play();
      const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
      const camera = {
        deviceId: settings.deviceId || "",
        width: this.elements.video.videoWidth,
        height: this.elements.video.videoHeight,
        aspectRatio:
          this.elements.video.videoWidth / this.elements.video.videoHeight,
        orientation: this.getOrientation(),
      };
      this.configureOverlay(camera.width, camera.height);
      return camera;
    }

    waitForVideo(video) {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          cleanup();
          reject(new Error("摄像头启动超时"));
        }, 6000);
        const cleanup = () => {
          window.clearTimeout(timeoutId);
          video.removeEventListener("loadedmetadata", handleLoaded);
          video.removeEventListener("error", handleError);
        };
        const handleLoaded = () => {
          cleanup();
          resolve();
        };
        const handleError = () => {
          cleanup();
          reject(new Error("无法读取摄像头画面"));
        };
        video.addEventListener("loadedmetadata", handleLoaded, { once: true });
        video.addEventListener("error", handleError, { once: true });
      });
    }

    getOrientation() {
      return window.matchMedia("(orientation: portrait)").matches
        ? "portrait"
        : "landscape";
    }

    isCalibrationCompatible(camera) {
      if (!this.calibration) {
        return false;
      }
      if (this.calibration.orientation !== camera.orientation) {
        return false;
      }
      if (
        this.calibration.deviceId &&
        camera.deviceId &&
        this.calibration.deviceId !== camera.deviceId
      ) {
        return false;
      }
      const aspectDifference =
        Math.abs(this.calibration.aspectRatio - camera.aspectRatio) /
        this.calibration.aspectRatio;
      return aspectDifference <= 0.12;
    }

    configureOverlay(width, height) {
      this.elements.overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
      this.elements.faceGuide.setAttribute("cx", String(width / 2));
      this.elements.faceGuide.setAttribute("cy", String(height * 0.48));
      this.elements.faceGuide.setAttribute("rx", String(width * 0.2));
      this.elements.faceGuide.setAttribute("ry", String(height * 0.34));
    }

    handleAction() {
      const action = this.elements.actionButton.dataset.action;
      if (action === "measure") {
        this.collectMeasurement(this.runId);
      } else if (action === "confirm") {
        this.finishFlow(true);
      } else if (action === "retry-setup") {
        this.retryMeasurement();
      }
    }

    retryMeasurement() {
      if (!this.flow) {
        return;
      }
      this.runId += 1;
      this.flow.phase = "loading";
      this.flow.measurement = null;
      this.resetDialogUi();
      this.setupFlow(this.runId);
    }

    async collectMeasurement(runId) {
      if (!this.flow || this.flow.phase === "sampling") {
        return;
      }
      this.flow.phase = "sampling";
      this.elements.actionButton.disabled = true;
      this.elements.actionButton.dataset.action = "none";
      this.elements.actionButton.textContent = "正在读取";
      this.elements.measureStatus.textContent =
        "请直视屏幕并保持头部不动…";
      delete this.elements.measureStatus.dataset.state;

      const samples = [];
      const startedAt = performance.now();
      let lastGuidance = "请让面部位于虚线框内";

      while (
        this.isCurrentRun(runId) &&
        performance.now() - startedAt < MAX_MEASUREMENT_DURATION_MS
      ) {
        const faces = await this.model.estimateFaces(
          this.elements.video,
          false,
          false,
          true,
        );
        if (!this.isCurrentRun(runId)) {
          return;
        }

        const analysis = this.analyzeFace(faces[0]);
        this.renderLandmarks(analysis);
        if (analysis.valid) {
          samples.push(analysis.normalizedEyeDistance);
          if (samples.length > MAX_SAMPLE_WINDOW) {
            samples.shift();
          }
          const stableValue = this.getStableValue(samples);
          if (stableValue !== null) {
            this.completeMeasurement(stableValue);
            return;
          }
          lastGuidance = "已识别双眼，请继续保持不动…";
        } else {
          lastGuidance = analysis.guidance;
        }
        this.elements.measureStatus.textContent = lastGuidance;
        await this.delay(90);
      }

      throw new Error(
        lastGuidance === "已识别双眼，请继续保持不动…"
          ? "读数波动较大，请保持头部不动后重试"
          : lastGuidance,
      );
    }

    analyzeFace(face) {
      if (!face?.landmarks || face.landmarks.length < 3) {
        return { valid: false, guidance: "未识别到正脸，请面向屏幕" };
      }

      const width = this.elements.video.videoWidth;
      const height = this.elements.video.videoHeight;
      const eyeA = face.landmarks[0];
      const eyeB = face.landmarks[1];
      const nose = face.landmarks[2];
      const dx = eyeA[0] - eyeB[0];
      const dy = eyeA[1] - eyeB[1];
      const eyeDistance = Math.hypot(dx, dy);
      const midpoint = [
        (eyeA[0] + eyeB[0]) / 2,
        (eyeA[1] + eyeB[1]) / 2,
      ];
      const faceWidth = Math.abs(face.bottomRight[0] - face.topLeft[0]);
      const probability = Number(face.probability || 0);
      const result = {
        valid: false,
        eyeA,
        eyeB,
        normalizedEyeDistance: eyeDistance / width,
      };

      if (probability < 0.78) {
        result.guidance = "光线不足或面部不清晰，请调整位置";
        return result;
      }
      if (
        midpoint[0] < width * 0.2 ||
        midpoint[0] > width * 0.8 ||
        midpoint[1] < height * 0.14 ||
        midpoint[1] > height * 0.68
      ) {
        result.guidance = "请将面部移到虚线框中央";
        return result;
      }
      if (faceWidth / width < 0.17) {
        result.guidance = "面部过小，请适当靠近屏幕";
        return result;
      }
      if (faceWidth / width > 0.82) {
        result.guidance = "面部过大，请适当远离屏幕";
        return result;
      }
      if (Math.abs(dy) / eyeDistance > 0.12) {
        result.guidance = "请保持头部水平";
        return result;
      }
      if (Math.abs(nose[0] - midpoint[0]) / eyeDistance > 0.24) {
        result.guidance = "请正对屏幕，不要侧脸";
        return result;
      }

      result.valid = true;
      result.guidance = "已识别双眼，请继续保持不动…";
      return result;
    }

    renderLandmarks(analysis) {
      if (!analysis?.eyeA || !analysis?.eyeB) {
        this.clearLandmarks();
        return;
      }
      const [x1, y1] = analysis.eyeA;
      const [x2, y2] = analysis.eyeB;
      this.elements.eyePointA.setAttribute("cx", String(x1));
      this.elements.eyePointA.setAttribute("cy", String(y1));
      this.elements.eyePointB.setAttribute("cx", String(x2));
      this.elements.eyePointB.setAttribute("cy", String(y2));
      this.elements.eyeLine.setAttribute("d", `M${x1} ${y1}L${x2} ${y2}`);
    }

    clearLandmarks() {
      this.elements.eyePointA.setAttribute("cx", "-20");
      this.elements.eyePointA.setAttribute("cy", "-20");
      this.elements.eyePointB.setAttribute("cx", "-20");
      this.elements.eyePointB.setAttribute("cy", "-20");
      this.elements.eyeLine.setAttribute("d", "");
    }

    getStableValue(samples) {
      if (samples.length < REQUIRED_STABLE_SAMPLES) {
        return null;
      }
      const recent = samples.slice(-REQUIRED_STABLE_SAMPLES);
      const sorted = [...recent].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const relativeSpread =
        (sorted[sorted.length - 1] - sorted[0]) / median;
      return relativeSpread <= 0.07 ? median : null;
    }

    completeMeasurement(normalizedEyeDistance) {
      const { camera, mode } = this.flow;
      let distanceMm;
      if (mode === "calibration") {
        this.calibration = {
          normalizedEyeDistance,
          referenceDistanceMm: REFERENCE_DISTANCE_MM,
          deviceId: camera.deviceId,
          width: camera.width,
          height: camera.height,
          aspectRatio: camera.aspectRatio,
          orientation: camera.orientation,
          calibratedAt: new Date().toISOString(),
        };
        this.writeJson(DISTANCE_CALIBRATION_KEY, this.calibration);
        this.updateSettingUi();
        distanceMm = REFERENCE_DISTANCE_MM;
      } else {
        distanceMm =
          (REFERENCE_DISTANCE_MM *
            this.calibration.normalizedEyeDistance) /
          normalizedEyeDistance;
      }

      this.flow.phase = "result";
      this.flow.measurement = distanceMm;
      this.lastResultMm = distanceMm;
      this.stopCamera();
      this.showResult(distanceMm);
    }

    showResult(distanceMm) {
      const roundedCentimeters = Math.round(distanceMm / 10);
      const isNear = distanceMm < MIN_RECOMMENDED_DISTANCE_MM;
      const isFar = distanceMm > MAX_RECOMMENDED_DISTANCE_MM;
      this.elements.preview.hidden = true;
      this.elements.result.hidden = false;
      this.elements.value.textContent = String(roundedCentimeters);
      this.elements.result.dataset.state =
        isNear || isFar ? "warning" : "ready";

      if (isNear) {
        const adjustment = Math.max(1, Math.round((400 - distanceMm) / 10));
        this.elements.advice.textContent =
          `距离偏近，建议后退约 ${adjustment} cm 后重新测量。`;
      } else if (isFar) {
        const adjustment = Math.max(1, Math.round((distanceMm - 400) / 10));
        this.elements.advice.textContent =
          `距离偏远，建议靠近约 ${adjustment} cm 后重新测量。`;
      } else {
        this.elements.advice.textContent = "距离合适，可以开始训练。";
      }

      this.elements.measureStatus.textContent =
        "摄像头已关闭。本结果仅用于本轮提示，不会改变视标大小。";
      this.elements.actionButton.disabled = false;
      this.elements.actionButton.dataset.action = "confirm";
      this.elements.actionButton.textContent = this.flow.forSession
        ? isNear || isFar
          ? "仍然开始训练"
          : "开始训练"
        : "完成";
      this.elements.retryButton.hidden = false;
      this.elements.retryButton.textContent =
        this.flow.mode === "calibration" ? "重新标定" : "重新测量";
    }

    handleFlowError(error) {
      console.error("训练前测距失败", error);
      this.stopCamera();
      const permissionDenied =
        error?.name === "NotAllowedError" ||
        String(error?.message).toLowerCase().includes("permission");
      const noCamera =
        error?.name === "NotFoundError" || error?.name === "OverconstrainedError";
      this.elements.measureStatus.textContent = permissionDenied
        ? "摄像头权限未开启，请在浏览器设置中允许"
        : noCamera
          ? "未找到可用的前置摄像头"
          : error?.message || "测距失败，请重试";
      this.elements.measureStatus.dataset.state = "error";
      this.elements.actionButton.disabled = false;
      this.elements.actionButton.dataset.action = "retry-setup";
      this.elements.actionButton.textContent = "重试";
    }

    finishFlow(confirmed) {
      if (!this.flow) {
        return;
      }
      const { resolve, forSession, measurement } = this.flow;
      this.runId += 1;
      this.stopCamera();
      this.flow = null;
      if (this.elements.dialog.open) {
        this.elements.dialog.close();
      }
      if (!confirmed || !measurement) {
        this.lastResultMm = null;
        this.lastSessionWasMeasured = false;
      } else if (forSession) {
        this.lastSessionWasMeasured = true;
      }
      resolve(Boolean(confirmed && (!forSession || measurement)));
    }

    stopCamera() {
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      this.elements.video.pause();
      this.elements.video.srcObject = null;
      this.clearLandmarks();
    }

    isCurrentRun(runId) {
      return Boolean(this.flow && runId === this.runId);
    }

    delay(milliseconds) {
      return new Promise((resolve) => {
        window.setTimeout(resolve, milliseconds);
      });
    }

    onSessionStart() {
      if (
        !this.enabled ||
        !this.lastSessionWasMeasured ||
        !this.lastResultMm
      ) {
        this.elements.indicator.hidden = true;
        return;
      }
      this.elements.indicatorText.textContent =
        `本轮约 ${Math.round(this.lastResultMm / 10)} cm`;
      this.elements.indicator.hidden = false;
    }

    onSessionStop() {
      this.elements.indicator.hidden = true;
    }

    onSessionReset() {
      this.lastResultMm = null;
      this.lastSessionWasMeasured = false;
      this.onSessionStop();
    }

    onVisibilityHidden() {
      if (this.flow) {
        this.finishFlow(false);
      } else {
        this.stopCamera();
      }
    }
  }

  window.ClarityDistanceControl = ClarityDistanceControl;
})();
