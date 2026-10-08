(() => {
  "use strict";

  const VOICE_ENABLED_KEY = "clarity-flipper-voice-enabled-v1";
  const PERSONAL_MODEL_NAME = "clarity-flipper-personal-zh-v1";
  const REQUIRED_SAMPLES = 3;
  const MODEL_PATH = "./voice-model/model.json";
  const METADATA_PATH = "./voice-model/metadata.json";
  const AUDIO_CONSTRAINTS = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  const trainingSteps = [
    { label: "zh_up", name: "上", prompt: "说“上”" },
    { label: "zh_down", name: "下", prompt: "说“下”" },
    { label: "zh_left", name: "左", prompt: "说“左”" },
    { label: "zh_right", name: "右", prompt: "说“右”" },
    { label: "_background_noise_", name: "安静", prompt: "保持安静" },
    {
      label: "_unknown_",
      name: "其他",
      prompts: ["说“前”", "说“后”", "说“停”"],
    },
  ];

  const directionByLabel = {
    zh_up: "up",
    zh_down: "down",
    zh_left: "left",
    zh_right: "right",
  };

  class ClarityVoiceControl {
    constructor({ onDirection, isSessionRunning }) {
      this.onDirection = onDirection;
      this.isSessionRunning = isSessionRunning;
      this.elements = {
        toggle: document.querySelector("#voiceToggle"),
        status: document.querySelector("#voiceStatus"),
        indicator: document.querySelector("#voiceIndicator"),
        indicatorText: document.querySelector("#voiceIndicatorText"),
        openTrainingButton: document.querySelector(
          "#openVoiceTrainingButton",
        ),
        dialog: document.querySelector("#voiceTrainingDialog"),
        closeDialogButton: document.querySelector(
          "#closeVoiceTrainingButton",
        ),
        steps: document.querySelector("#voiceTrainingSteps"),
        prompt: document.querySelector("#recordingPrompt"),
        stepLabel: document.querySelector("#recordingStepLabel"),
        promptText: document.querySelector("#recordingPromptText"),
        sampleCount: document.querySelector("#recordingSampleCount"),
        progressWrap: document.querySelector(".voice-training-progress"),
        progress: document.querySelector("#voiceTrainingProgress"),
        trainingStatus: document.querySelector("#voiceTrainingStatus"),
        recordButton: document.querySelector("#recordVoiceSampleButton"),
        recordButtonLabel: document.querySelector(
          "#recordVoiceSampleButton span",
        ),
        trainButton: document.querySelector("#trainVoiceModelButton"),
        resetButton: document.querySelector("#resetVoiceModelButton"),
      };
      this.supported = Boolean(
        window.isSecureContext &&
          navigator.mediaDevices?.getUserMedia &&
          window.tf &&
          window.speechCommands,
      );
      this.enabled = localStorage.getItem(VOICE_ENABLED_KEY) === "true";
      this.defaultRecognizer = null;
      this.personalRecognizer = null;
      this.recordingRecognizer = null;
      this.activeRecognizer = null;
      this.modelLoadPromise = null;
      this.hasPersonalModel = false;
      this.busy = false;
      this.dialogReady = false;
      this.trainingComplete = false;
      this.listenRequestId = 0;
      this.lastDetectionAt = 0;
      this.indicatorTimerId = null;

      this.renderSteps({});
      this.bindEvents();
      this.restoreInitialState();
    }

    bindEvents() {
      this.elements.toggle.addEventListener("change", () => {
        this.setEnabled(this.elements.toggle.checked);
      });
      this.elements.openTrainingButton.addEventListener("click", () => {
        this.openTrainingDialog();
      });
      this.elements.closeDialogButton.addEventListener("click", () => {
        this.closeTrainingDialog();
      });
      this.elements.dialog.addEventListener("cancel", (event) => {
        if (this.busy) {
          event.preventDefault();
          return;
        }
        window.setTimeout(() => this.resumeAfterDialog(), 0);
      });
      this.elements.dialog.addEventListener("close", () => {
        this.resumeAfterDialog();
      });
      this.elements.recordButton.addEventListener("click", () => {
        this.recordCurrentSample();
      });
      this.elements.trainButton.addEventListener("click", () => {
        this.trainPersonalModel();
      });
      this.elements.resetButton.addEventListener("click", () => {
        this.resetPersonalModel();
      });
    }

    async restoreInitialState() {
      if (!this.supported) {
        this.enabled = false;
        this.elements.toggle.checked = false;
        this.elements.toggle.disabled = true;
        this.elements.openTrainingButton.disabled = true;
        this.setStatus("此浏览器不支持离线语音", "error");
        return;
      }

      this.elements.toggle.checked = this.enabled;
      try {
        const savedModels = await window.speechCommands.listSavedTransferModels();
        this.hasPersonalModel = savedModels.includes(PERSONAL_MODEL_NAME);
      } catch {
        this.hasPersonalModel = false;
      }
      this.updateModelUi();

      if (this.enabled) {
        this.setStatus("正在载入离线模型…", "loading");
        this.ensureReady()
          .then(() => this.updateModelUi())
          .catch((error) => this.handleError(error));
      }
    }

    setStatus(message, type = "idle") {
      this.elements.status.textContent = message;
      this.elements.status.dataset.state = type;
    }

    setIndicator(message, type = "listening") {
      window.clearTimeout(this.indicatorTimerId);
      this.elements.indicator.hidden = false;
      this.elements.indicator.dataset.state = type;
      this.elements.indicatorText.textContent = message;
    }

    hideIndicator() {
      window.clearTimeout(this.indicatorTimerId);
      this.elements.indicator.hidden = true;
      delete this.elements.indicator.dataset.state;
    }

    showDetection(direction) {
      const names = { up: "上", down: "下", left: "左", right: "右" };
      this.setIndicator(`听到：${names[direction]}`, "detected");
      this.indicatorTimerId = window.setTimeout(() => {
        if (this.isSessionRunning() && this.enabled) {
          this.setIndicator("正在听", "listening");
        }
      }, 650);
    }

    updateModelUi() {
      this.elements.resetButton.hidden = !this.hasPersonalModel;
      if (!this.enabled) {
        this.setStatus(
          this.hasPersonalModel ? "我的声音模型 · 已关闭" : "离线默认模型",
        );
      } else if (this.activeRecognizer) {
        this.setStatus(
          this.hasPersonalModel ? "我的声音模型已就绪" : "默认模型已就绪",
          "ready",
        );
      }
    }

    async setEnabled(enabled) {
      this.enabled = enabled;
      localStorage.setItem(VOICE_ENABLED_KEY, String(enabled));
      if (!enabled) {
        await this.stopListening();
        this.hideIndicator();
        this.updateModelUi();
        return;
      }

      this.setStatus("正在载入离线模型…", "loading");
      try {
        await this.ensureReady();
        this.updateModelUi();
        if (this.isSessionRunning()) {
          await this.startListening();
        }
      } catch (error) {
        this.handleError(error);
      }
    }

    async ensureReady() {
      if (this.activeRecognizer) {
        return this.activeRecognizer;
      }
      if (this.modelLoadPromise) {
        return this.modelLoadPromise;
      }

      this.modelLoadPromise = (async () => {
        await window.tf.ready();
        this.defaultRecognizer = window.speechCommands.create(
          "BROWSER_FFT",
          null,
          new URL(MODEL_PATH, window.location.href).href,
          new URL(METADATA_PATH, window.location.href).href,
        );
        await this.defaultRecognizer.ensureModelLoaded();
        this.activeRecognizer = this.defaultRecognizer;

        if (this.hasPersonalModel) {
          this.personalRecognizer =
            this.defaultRecognizer.createTransfer(PERSONAL_MODEL_NAME);
          try {
            await this.personalRecognizer.load();
            this.activeRecognizer = this.personalRecognizer;
          } catch (error) {
            console.warn("个人声音模型加载失败，已回退到默认模型", error);
            this.hasPersonalModel = false;
            this.personalRecognizer = null;
            delete this.defaultRecognizer.transferRecognizers?.[
              PERSONAL_MODEL_NAME
            ];
          }
        }
        return this.activeRecognizer;
      })();

      try {
        return await this.modelLoadPromise;
      } finally {
        this.modelLoadPromise = null;
      }
    }

    async startListening() {
      if (!this.enabled || !this.isSessionRunning() || this.busy) {
        return;
      }

      const requestId = ++this.listenRequestId;
      this.setIndicator("模型载入中", "loading");
      try {
        const recognizer = await this.ensureReady();
        if (
          requestId !== this.listenRequestId ||
          !this.enabled ||
          !this.isSessionRunning()
        ) {
          return;
        }
        if (recognizer.isListening()) {
          this.setIndicator("正在听", "listening");
          return;
        }

        const labels = recognizer.wordLabels();
        await recognizer.listen(
          ({ scores }) => {
            let bestIndex = 0;
            for (let index = 1; index < scores.length; index += 1) {
              if (scores[index] > scores[bestIndex]) {
                bestIndex = index;
              }
            }
            const direction = directionByLabel[labels[bestIndex]];
            const now = performance.now();
            if (!direction || now - this.lastDetectionAt < 650) {
              return;
            }
            this.lastDetectionAt = now;
            this.showDetection(direction);
            this.onDirection(direction);
          },
          {
            overlapFactor: 0.55,
            probabilityThreshold: this.hasPersonalModel ? 0.78 : 0.84,
            suppressionTimeMillis: 700,
            invokeCallbackOnNoiseAndUnknown: false,
            audioTrackConstraints: AUDIO_CONSTRAINTS,
          },
        );
        if (requestId !== this.listenRequestId) {
          await this.stopRecognizer(recognizer);
          return;
        }
        this.setIndicator("正在听", "listening");
        this.updateModelUi();
      } catch (error) {
        this.handleError(error);
      }
    }

    async stopRecognizer(recognizer) {
      if (!recognizer?.isListening()) {
        return;
      }
      try {
        await recognizer.stopListening();
      } catch (error) {
        console.warn("停止语音识别失败", error);
      }
    }

    async stopListening() {
      this.listenRequestId += 1;
      await Promise.all([
        this.stopRecognizer(this.defaultRecognizer),
        this.stopRecognizer(this.personalRecognizer),
      ]);
      this.hideIndicator();
    }

    onSessionStart() {
      this.startListening();
    }

    onSessionStop() {
      this.stopListening();
    }

    getRecordingRecognizer() {
      if (!this.recordingRecognizer) {
        delete this.defaultRecognizer.transferRecognizers?.[
          PERSONAL_MODEL_NAME
        ];
        this.recordingRecognizer =
          this.defaultRecognizer.createTransfer(PERSONAL_MODEL_NAME);
      }
      return this.recordingRecognizer;
    }

    getExampleCounts() {
      if (
        !this.recordingRecognizer ||
        this.recordingRecognizer.isDatasetEmpty()
      ) {
        return {};
      }
      return this.recordingRecognizer.countExamples();
    }

    getCurrentStep(counts = this.getExampleCounts()) {
      return trainingSteps.find(
        (step) => (counts[step.label] || 0) < REQUIRED_SAMPLES,
      );
    }

    getPrompt(step, count) {
      if (step.prompts) {
        return step.prompts[Math.min(count, step.prompts.length - 1)];
      }
      return step.prompt;
    }

    renderSteps(counts) {
      this.elements.steps.replaceChildren(
        ...trainingSteps.map((step) => {
          const count = Math.min(counts[step.label] || 0, REQUIRED_SAMPLES);
          const row = document.createElement("div");
          row.className = "voice-training-step";
          row.classList.toggle("is-complete", count >= REQUIRED_SAMPLES);

          const name = document.createElement("span");
          name.textContent = step.name;
          const markers = document.createElement("span");
          markers.className = "sample-markers";
          markers.setAttribute(
            "aria-label",
            `${step.name}已录制 ${count} 次，共 ${REQUIRED_SAMPLES} 次`,
          );
          for (let index = 0; index < REQUIRED_SAMPLES; index += 1) {
            const marker = document.createElement("i");
            marker.classList.toggle("is-filled", index < count);
            markers.append(marker);
          }
          row.append(name, markers);
          return row;
        }),
      );

      const completed = trainingSteps.reduce(
        (sum, step) =>
          sum + Math.min(counts[step.label] || 0, REQUIRED_SAMPLES),
        0,
      );
      const total = trainingSteps.length * REQUIRED_SAMPLES;
      this.elements.progress.style.width = `${(completed / total) * 100}%`;
      this.elements.progressWrap.setAttribute("aria-valuenow", String(completed));

      const current = this.getCurrentStep(counts);
      if (!current) {
        this.elements.stepLabel.textContent = "录制完成";
        this.elements.promptText.textContent = "可以生成模型";
        this.elements.sampleCount.textContent = `${total} / ${total}`;
        this.elements.recordButton.disabled = true;
        this.elements.trainButton.disabled = false;
        return;
      }

      const stepIndex = trainingSteps.indexOf(current);
      const count = counts[current.label] || 0;
      this.elements.stepLabel.textContent =
        `第 ${stepIndex + 1} 项，共 ${trainingSteps.length} 项`;
      this.elements.promptText.textContent = this.getPrompt(current, count);
      this.elements.sampleCount.textContent =
        `${count} / ${REQUIRED_SAMPLES}`;
      this.elements.recordButton.disabled = this.busy;
      this.elements.trainButton.disabled = true;
    }

    setDialogBusy(busy) {
      this.busy = busy;
      this.elements.closeDialogButton.disabled = busy;
      this.elements.recordButton.disabled =
        busy || !this.dialogReady || this.trainingComplete;
      this.elements.trainButton.disabled =
        busy || this.trainingComplete || Boolean(this.getCurrentStep());
      this.elements.resetButton.disabled = busy;
    }

    async openTrainingDialog() {
      await this.stopListening();
      if (!this.elements.dialog.open) {
        this.elements.dialog.showModal();
      }
      this.elements.trainingStatus.textContent = "正在准备离线模型…";
      this.dialogReady = false;
      this.setDialogBusy(true);

      try {
        await this.ensureReady();
        if (!this.recordingRecognizer) {
          this.trainingComplete = false;
          this.elements.prompt.classList.remove("is-complete");
        }
        this.getRecordingRecognizer();
        this.dialogReady = true;
        this.renderSteps(this.getExampleCounts());
        this.elements.trainingStatus.textContent = "准备录制";
        delete this.elements.trainingStatus.dataset.state;
      } catch (error) {
        this.dialogReady = false;
        this.handleTrainingError(error);
      } finally {
        this.setDialogBusy(false);
      }
    }

    closeTrainingDialog() {
      if (!this.busy && this.elements.dialog.open) {
        this.elements.dialog.close();
      }
    }

    resumeAfterDialog() {
      if (this.enabled && this.isSessionRunning()) {
        this.startListening();
      }
    }

    async recordCurrentSample() {
      if (this.busy) {
        return;
      }
      const recognizer = this.getRecordingRecognizer();
      const counts = this.getExampleCounts();
      const current = this.getCurrentStep(counts);
      if (!current) {
        return;
      }

      this.setDialogBusy(true);
      delete this.elements.trainingStatus.dataset.state;
      this.elements.recordButton.classList.add("is-recording");
      this.elements.recordButtonLabel.textContent = "正在录制";
      this.elements.trainingStatus.textContent =
        current.label === "_background_noise_"
          ? "请保持安静…"
          : `${this.getPrompt(current, counts[current.label] || 0)}…`;

      try {
        await recognizer.collectExample(current.label, {
          durationSec: 1,
          audioTrackConstraints: AUDIO_CONSTRAINTS,
        });
        const nextCounts = this.getExampleCounts();
        this.renderSteps(nextCounts);
        this.elements.trainingStatus.textContent = `已录制“${current.name}”`;
      } catch (error) {
        this.handleTrainingError(error);
      } finally {
        this.elements.recordButton.classList.remove("is-recording");
        this.elements.recordButtonLabel.textContent = "录制本条";
        this.setDialogBusy(false);
        this.renderSteps(this.getExampleCounts());
      }
    }

    async trainPersonalModel() {
      if (this.busy || this.getCurrentStep()) {
        return;
      }

      const recognizer = this.getRecordingRecognizer();
      this.setDialogBusy(true);
      delete this.elements.trainingStatus.dataset.state;
      this.elements.trainingStatus.textContent = "正在训练 0%";

      try {
        const epochs = 32;
        await recognizer.train({
          epochs,
          validationSplit: 0.2,
          batchSize: 6,
          optimizer: window.tf.train.adam(0.0015),
          augmentByMixingNoiseRatio: 0.12,
          callback: {
            onEpochEnd: async (epoch) => {
              const progress = Math.round(((epoch + 1) / epochs) * 100);
              this.elements.trainingStatus.textContent =
                `正在训练 ${progress}%`;
              await window.tf.nextFrame();
            },
          },
        });
        await recognizer.save();
        this.hasPersonalModel = true;
        this.personalRecognizer = recognizer;
        this.recordingRecognizer = null;
        this.activeRecognizer = recognizer;
        this.trainingComplete = true;
        this.elements.trainingStatus.textContent = "我的声音模型已生成";
        this.elements.prompt.classList.add("is-complete");
        this.elements.promptText.textContent = "训练完成";
        this.elements.trainButton.disabled = true;
        this.updateModelUi();
      } catch (error) {
        this.handleTrainingError(error);
      } finally {
        this.setDialogBusy(false);
      }
    }

    async resetPersonalModel() {
      if (this.busy) {
        return;
      }
      this.setDialogBusy(true);
      try {
        await this.stopListening();
        if (this.hasPersonalModel) {
          await window.speechCommands.deleteSavedTransferModel(
            PERSONAL_MODEL_NAME,
          );
        }
        this.hasPersonalModel = false;
        this.personalRecognizer = null;
        this.recordingRecognizer = null;
        delete this.defaultRecognizer.transferRecognizers?.[
          PERSONAL_MODEL_NAME
        ];
        this.activeRecognizer = this.defaultRecognizer;
        this.trainingComplete = false;
        this.elements.prompt.classList.remove("is-complete");
        this.renderSteps({});
        this.elements.trainingStatus.textContent = "已恢复默认模型";
        this.updateModelUi();
      } catch (error) {
        this.handleTrainingError(error);
      } finally {
        this.setDialogBusy(false);
      }
    }

    handleTrainingError(error) {
      console.error("声音模型操作失败", error);
      const permissionDenied =
        error?.name === "NotAllowedError" ||
        String(error?.message).toLowerCase().includes("permission");
      this.elements.trainingStatus.textContent = permissionDenied
        ? "麦克风权限未开启，请在浏览器设置中允许"
        : "操作失败，请重试";
      this.elements.trainingStatus.dataset.state = "error";
    }

    handleError(error) {
      console.error("语音识别不可用", error);
      const permissionDenied =
        error?.name === "NotAllowedError" ||
        String(error?.message).toLowerCase().includes("permission");
      this.setStatus(
        permissionDenied ? "麦克风权限未开启" : "语音模型载入失败",
        "error",
      );
      if (this.isSessionRunning() && this.enabled) {
        this.setIndicator(
          permissionDenied ? "麦克风不可用" : "语音不可用",
          "error",
        );
      }
    }
  }

  window.ClarityVoiceControl = ClarityVoiceControl;
})();
