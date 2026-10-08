const CALIBRATION_KEY = "clarity-flipper-calibration-v2";
const SETTINGS_KEY = "clarity-flipper-settings-v1";
const DEFAULT_PIXELS_PER_MM = 96 / 25.4;
const SNELLEN_VIEWING_DISTANCE_MM = 400;
const SNELLEN_DENOMINATORS = [20, 25, 30, 40, 50, 60, 80, 100];

const directions = {
  up: { rotation: -90, label: "上" },
  right: { rotation: 0, label: "右" },
  down: { rotation: 90, label: "下" },
  left: { rotation: 180, label: "左" },
};

const elements = {
  stage: document.querySelector("#stage"),
  stageCaption: document.querySelector("#stageCaption"),
  targetWrap: document.querySelector("#targetWrap"),
  optotype: document.querySelector("#optotype"),
  feedback: document.querySelector("#feedback"),
  timeValue: document.querySelector("#timeValue"),
  focusTimeValue: document.querySelector("#focusTimeValue"),
  correctValue: document.querySelector("#correctValue"),
  paceValue: document.querySelector("#paceValue"),
  snellenSelect: document.querySelector("#snellenSelect"),
  snellenSizeOutput: document.querySelector("#snellenSizeOutput"),
  physicalSizeLabel: document.querySelector("#physicalSizeLabel"),
  soundToggle: document.querySelector("#soundToggle"),
  durationControl: document.querySelector("#durationControl"),
  directionButtons: [...document.querySelectorAll(".direction-button")],
  startButton: document.querySelector("#startButton"),
  startButtonLabel: document.querySelector("#startButton span"),
  startButtonIcon: document.querySelector("#startButton path"),
  resetButton: document.querySelector("#resetButton"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  fullscreenIcon: document.querySelector("#fullscreenButton path"),
  openCalibrationButton: document.querySelector("#openCalibrationButton"),
  calibrationState: document.querySelector("#calibrationState"),
  calibrationDialog: document.querySelector("#calibrationDialog"),
  calibrationForm: document.querySelector("#calibrationForm"),
  calibrationMeasurements: [
    ...document.querySelectorAll(".calibration-measurement"),
  ],
  calibrationError: document.querySelector("#calibrationError"),
  cancelCalibrationButton: document.querySelector("#cancelCalibrationButton"),
};

const state = {
  status: "idle",
  durationSeconds: 60,
  correctCount: 0,
  currentDirection: "right",
  snellenDenominator: 40,
  soundEnabled: false,
  startedAt: 0,
  elapsedBeforeStart: 0,
  timerId: null,
  feedbackTimerId: null,
  answerLocked: false,
  calibration: readJson(CALIBRATION_KEY),
};

function readJson(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The app remains usable when storage is disabled.
  }
}

function getViewportScale() {
  return window.visualViewport?.scale || 1;
}

function getPixelsPerMm() {
  if (!state.calibration) {
    return DEFAULT_PIXELS_PER_MM / getViewportScale();
  }

  const currentDevicePixelRatio = window.devicePixelRatio || 1;
  const currentViewportScale = getViewportScale();
  return (
    state.calibration.pixelsPerMm *
    (state.calibration.devicePixelRatio / currentDevicePixelRatio) *
    (state.calibration.viewportScale / currentViewportScale)
  );
}

function getSnellenTargetHeightMm(denominator) {
  const visualAngleMinutes = 5 * (denominator / 20);
  const visualAngleRadians = (visualAngleMinutes * Math.PI) / (180 * 60);
  return (
    2 *
    SNELLEN_VIEWING_DISTANCE_MM *
    Math.tan(visualAngleRadians / 2)
  );
}

function updateTargetSize() {
  const currentTargetSizeMm = getSnellenTargetHeightMm(
    state.snellenDenominator,
  );
  const targetPixels = currentTargetSizeMm * getPixelsPerMm();
  document.documentElement.style.setProperty(
    "--target-size",
    `${targetPixels.toFixed(3)}px`,
  );

  const snellenSizeText = `${currentTargetSizeMm.toFixed(2)} mm`;
  elements.snellenSizeOutput.value = snellenSizeText;
  elements.snellenSizeOutput.textContent = snellenSizeText;
  elements.physicalSizeLabel.textContent = `20/${state.snellenDenominator}`;
  elements.physicalSizeLabel.title = `40 cm 视距下高 ${snellenSizeText}`;
}

function updateCalibrationState() {
  const label = elements.calibrationState.querySelector("span:last-child");
  elements.calibrationState.classList.toggle(
    "is-calibrated",
    Boolean(state.calibration),
  );
  label.textContent = state.calibration ? "尺寸已校准" : "未校准";
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function getElapsedMilliseconds() {
  if (state.status === "running") {
    return state.elapsedBeforeStart + (performance.now() - state.startedAt);
  }
  return state.elapsedBeforeStart;
}

function updateMetrics() {
  const elapsedSeconds = getElapsedMilliseconds() / 1000;
  const remainingSeconds = state.durationSeconds - elapsedSeconds;
  const formattedRemainingTime = formatTime(remainingSeconds);
  elements.timeValue.textContent = formattedRemainingTime;
  elements.focusTimeValue.textContent = formattedRemainingTime;
  elements.correctValue.textContent = String(state.correctCount);
  elements.paceValue.textContent =
    elapsedSeconds >= 3
      ? ((state.correctCount / elapsedSeconds) * 60).toFixed(1)
      : "--";

  if (remainingSeconds <= 0 && state.status === "running") {
    completeSession();
  }
}

function setControlsEnabled(enabled) {
  elements.directionButtons.forEach((button) => {
    button.disabled = !enabled;
  });
}

function setSessionFocusMode(enabled) {
  document.body.classList.toggle("is-session-active", enabled);
  if (enabled) {
    window.scrollTo(0, 0);
  }
}

function setStartButton(mode) {
  if (mode === "pause") {
    elements.startButtonLabel.textContent = "暂停训练";
    elements.startButtonIcon.setAttribute("d", "M9 7v10M15 7v10");
    return;
  }

  elements.startButtonLabel.textContent =
    mode === "resume" ? "继续训练" : "开始训练";
  elements.startButtonIcon.setAttribute("d", "m9 7 8 5-8 5Z");
}

function chooseNextDirection() {
  const candidates = Object.keys(directions).filter(
    (direction) => direction !== state.currentDirection,
  );
  state.currentDirection =
    candidates[Math.floor(Math.random() * candidates.length)];
  const next = directions[state.currentDirection];
  elements.optotype.style.setProperty(
    "--target-rotation",
    `${next.rotation}deg`,
  );
  elements.optotype.setAttribute("aria-label", `开口朝${next.label}的视标`);
}

function clearFeedback() {
  window.clearTimeout(state.feedbackTimerId);
  elements.feedback.textContent = "";
  elements.feedback.className = "feedback";
  elements.stage.classList.remove("is-correct", "is-wrong");
}

function showFeedback(type, message) {
  clearFeedback();
  elements.feedback.textContent = message;
  elements.feedback.classList.add(`is-${type}`);
  elements.stage.classList.add(`is-${type}`);
  state.feedbackTimerId = window.setTimeout(clearFeedback, 500);
}

function playSuccessTone() {
  if (!state.soundEnabled) {
    return;
  }

  const AudioContext =
    window.AudioContext || Reflect.get(window, "webkitAudioContext");
  if (!AudioContext) {
    return;
  }

  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 620;
  gain.gain.setValueAtTime(0.06, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.08);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.08);
  oscillator.addEventListener("ended", () => context.close());
}

function answer(direction) {
  if (state.status !== "running" || state.answerLocked) {
    return;
  }

  state.answerLocked = true;

  if (direction === state.currentDirection) {
    state.correctCount += 1;
    showFeedback("correct", "正确，翻转镜片");
    playSuccessTone();
  } else {
    showFeedback("wrong", "已换新视标");
  }

  updateMetrics();

  window.setTimeout(() => {
    chooseNextDirection();
    state.answerLocked = false;
  }, 120);
}

function startSession() {
  if (!state.calibration) {
    openCalibration(true);
    return;
  }

  if (state.status === "complete") {
    resetSession();
  }

  state.status = "running";
  state.startedAt = performance.now();
  setSessionFocusMode(true);
  elements.stage.classList.remove("is-idle", "is-complete");
  elements.stageCaption.textContent = "训练进行中";
  setControlsEnabled(true);
  setStartButton("pause");
  state.timerId = window.setInterval(updateMetrics, 200);
  updateMetrics();
}

function pauseSession() {
  state.elapsedBeforeStart = getElapsedMilliseconds();
  state.status = "paused";
  setSessionFocusMode(false);
  window.clearInterval(state.timerId);
  elements.stageCaption.textContent = "已暂停";
  setControlsEnabled(false);
  setStartButton("resume");
  updateMetrics();
}

function completeSession() {
  state.elapsedBeforeStart = state.durationSeconds * 1000;
  state.status = "complete";
  setSessionFocusMode(false);
  window.clearInterval(state.timerId);
  elements.stage.classList.add("is-complete");
  elements.stageCaption.textContent = "本轮完成";
  elements.feedback.textContent = `完成 ${state.correctCount} 次`;
  elements.feedback.className = "feedback is-correct";
  setControlsEnabled(false);
  setStartButton("start");
  updateMetrics();
}

function resetSession() {
  window.clearInterval(state.timerId);
  clearFeedback();
  state.status = "idle";
  setSessionFocusMode(false);
  state.correctCount = 0;
  state.elapsedBeforeStart = 0;
  state.answerLocked = false;
  elements.stage.classList.add("is-idle");
  elements.stage.classList.remove("is-complete");
  elements.stageCaption.textContent = "准备开始";
  setControlsEnabled(false);
  setStartButton("start");
  chooseNextDirection();
  updateMetrics();
}

function handleStartButton() {
  if (state.status === "running") {
    pauseSession();
    return;
  }
  startSession();
}

function saveSettings() {
  writeJson(SETTINGS_KEY, {
    snellenDenominator: state.snellenDenominator,
    durationSeconds: state.durationSeconds,
    soundEnabled: state.soundEnabled,
  });
}

function restoreSettings() {
  const settings = readJson(SETTINGS_KEY);
  if (!settings) {
    return;
  }

  if (SNELLEN_DENOMINATORS.includes(settings.snellenDenominator)) {
    state.snellenDenominator = settings.snellenDenominator;
  }
  if ([60, 120, 180].includes(settings.durationSeconds)) {
    state.durationSeconds = settings.durationSeconds;
  }
  state.soundEnabled = Boolean(settings.soundEnabled);
}

function updateSettingsUi() {
  elements.snellenSelect.value = String(state.snellenDenominator);
  elements.soundToggle.checked = state.soundEnabled;
  elements.durationControl.querySelectorAll(".segment").forEach((button) => {
    button.classList.toggle(
      "is-active",
      Number(button.dataset.duration) === state.durationSeconds,
    );
  });
  updateTargetSize();
}

function openCalibration(required = false) {
  elements.calibrationDialog.dataset.required = String(required);
  elements.cancelCalibrationButton.hidden = required;
  elements.calibrationError.textContent = "";
  elements.calibrationMeasurements.forEach((input) => {
    input.value = "";
    input.removeAttribute("aria-invalid");
  });

  if (!elements.calibrationDialog.open) {
    elements.calibrationDialog.showModal();
  }
}

function saveCalibration(event) {
  event.preventDefault();
  const measurements = elements.calibrationMeasurements.map((input) => ({
    pixels: Number(input.dataset.pixels),
    millimeters: Number(input.value),
  }));
  const ratios = measurements.map(
    ({ pixels, millimeters }) => pixels / millimeters,
  );
  const pixelsPerMm =
    measurements.reduce((sum, measurement) => sum + measurement.pixels, 0) /
    measurements.reduce(
      (sum, measurement) => sum + measurement.millimeters,
      0,
    );
  const ratioSpread = (Math.max(...ratios) - Math.min(...ratios)) / pixelsPerMm;

  if (ratioSpread > 0.15) {
    elements.calibrationError.textContent =
      "三次测量结果差异较大，请重新测量后填写。";
    elements.calibrationMeasurements.forEach((input) => {
      input.setAttribute("aria-invalid", "true");
    });
    return;
  }

  state.calibration = {
    pixelsPerMm,
    devicePixelRatio: window.devicePixelRatio || 1,
    viewportScale: getViewportScale(),
    method: "ruler-lines",
    measurements,
    calibratedAt: new Date().toISOString(),
  };
  writeJson(CALIBRATION_KEY, state.calibration);
  updateCalibrationState();
  updateTargetSize();
  elements.calibrationDialog.close("confirm");
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    document.documentElement.requestFullscreen?.();
  }
}

function updateFullscreenIcon() {
  const isFullscreen = Boolean(document.fullscreenElement);
  elements.fullscreenButton.setAttribute(
    "aria-label",
    isFullscreen ? "退出全屏" : "进入全屏",
  );
  elements.fullscreenButton.title = isFullscreen ? "退出全屏" : "全屏";
  elements.fullscreenIcon.setAttribute(
    "d",
    isFullscreen
      ? "M8 8H3M8 8V3M16 8h5M16 8V3M8 16H3M8 16v5M16 16h5M16 16v5"
      : "M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5",
  );
}

elements.directionButtons.forEach((button) => {
  button.addEventListener("click", () => answer(button.dataset.direction));
});

elements.startButton.addEventListener("click", handleStartButton);
elements.resetButton.addEventListener("click", resetSession);

elements.snellenSelect.addEventListener("change", () => {
  state.snellenDenominator = Number(elements.snellenSelect.value);
  updateTargetSize();
  saveSettings();
});

elements.soundToggle.addEventListener("change", () => {
  state.soundEnabled = elements.soundToggle.checked;
  saveSettings();
});

elements.durationControl.addEventListener("click", (event) => {
  const button = event.target.closest(".segment");
  if (!button) {
    return;
  }

  state.durationSeconds = Number(button.dataset.duration);
  updateSettingsUi();
  saveSettings();
  resetSession();
});

elements.openCalibrationButton.addEventListener("click", () =>
  openCalibration(false),
);
elements.calibrationMeasurements.forEach((input) => {
  input.addEventListener("input", () => {
    elements.calibrationError.textContent = "";
    input.removeAttribute("aria-invalid");
  });
});
elements.calibrationForm.addEventListener("submit", saveCalibration);
elements.calibrationDialog.addEventListener("cancel", (event) => {
  if (elements.calibrationDialog.dataset.required === "true") {
    event.preventDefault();
  }
});

elements.fullscreenButton.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", updateFullscreenIcon);

document.addEventListener("keydown", (event) => {
  const directionByKey = {
    ArrowUp: "up",
    ArrowRight: "right",
    ArrowDown: "down",
    ArrowLeft: "left",
  };
  const direction = directionByKey[event.key];
  if (!direction) {
    return;
  }
  event.preventDefault();
  answer(direction);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.status === "running") {
    pauseSession();
  }
});

window.addEventListener("resize", () => {
  updateTargetSize();
});
window.visualViewport?.addEventListener("resize", updateTargetSize);

restoreSettings();
saveSettings();
updateSettingsUi();
updateCalibrationState();
resetSession();

if (!state.calibration) {
  window.requestAnimationFrame(() => openCalibration(true));
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js", {
        scope: "./",
        updateViaCache: "none",
      })
      .catch((error) => {
        console.warn("离线服务注册失败", error);
      });
  });
}
