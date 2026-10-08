import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nodeUtil = require("node:util");
nodeUtil.isNullOrUndefined ||= (value) => value == null;
const tf = require("@tensorflow/tfjs-node");
const speechCommands = require("@tensorflow-models/speech-commands");
const FFT = require("fft.js");

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT_DIR = join(ROOT, "voice-model");
const BASE_URL =
  "https://storage.googleapis.com/tfjs-models/tfjs/speech-commands/v0.5/browser_fft/directional4w";
const SAMPLE_RATE = 44100;
const FFT_HOP = 1024;
const FFT_WINDOW = 2048;
const FRAME_SIZE = 232;
const FRAME_COUNT = 43;
const SAMPLE_COUNT = FRAME_COUNT * FFT_HOP;
const TRAIN_VOICES = [
  "Tingting",
  "Eddy (Chinese (China mainland))",
  "Flo (Chinese (China mainland))",
  "Grandma (Chinese (China mainland))",
  "Grandpa (Chinese (China mainland))",
  "Reed (Chinese (China mainland))",
  "Rocko (Chinese (China mainland))",
  "Sandy (Chinese (China mainland))",
  "Shelley (Chinese (China mainland))",
  "Meijia",
  "Sinji",
];
const TRAIN_RATES = [145, 175, 205, 235];
const TEST_RATES = [160, 220];
const COMMANDS = {
  zh_up: "上",
  zh_down: "下",
  zh_left: "左",
  zh_right: "右",
};
const UNKNOWN_WORDS = ["前", "后", "开", "关", "对", "错", "开始", "停止"];

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function download(path) {
  const response = await fetch(`${BASE_URL}/${path}`);
  if (!response.ok) {
    throw new Error(`Failed to download ${path}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function parsePcm16Wav(path) {
  const buffer = readFileSync(path);
  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`Unsupported WAV file: ${path}`);
  }

  let offset = 12;
  let channels;
  let sampleRate;
  let bitsPerSample;
  let pcm;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt ") {
      const format = buffer.readUInt16LE(chunkStart);
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
      if (format !== 1) {
        throw new Error(`Expected PCM WAV, received format ${format}`);
      }
    } else if (chunkId === "data") {
      pcm = buffer.subarray(chunkStart, chunkStart + chunkLength);
    }
    offset = chunkStart + chunkLength + (chunkLength % 2);
  }

  if (
    channels !== 1 ||
    sampleRate !== SAMPLE_RATE ||
    bitsPerSample !== 16 ||
    pcm == null
  ) {
    throw new Error(
      `Expected mono 16-bit ${SAMPLE_RATE} Hz WAV, got ${channels}ch/${bitsPerSample}bit/${sampleRate}Hz`,
    );
  }

  const samples = new Float32Array(pcm.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2) / 32768;
  }
  return samples;
}

function trimSilence(samples) {
  let peak = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
  }
  const threshold = Math.max(peak * 0.018, 0.001);
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]) < threshold) {
    start += 1;
  }
  while (end > start && Math.abs(samples[end - 1]) < threshold) {
    end -= 1;
  }
  const padding = Math.round(SAMPLE_RATE * 0.035);
  return samples.slice(Math.max(0, start - padding), Math.min(samples.length, end + padding));
}

function prepareWaveform(samples, key, variant = 0) {
  const random = seededRandom(hashString(`${key}:${variant}`));
  const trimmed = trimSilence(samples);
  const output = new Float32Array(SAMPLE_COUNT);
  const maxLength = Math.round(SAMPLE_RATE * 0.76);
  const source =
    trimmed.length <= maxLength
      ? trimmed
      : trimmed.slice(
          Math.floor((trimmed.length - maxLength) / 2),
          Math.floor((trimmed.length - maxLength) / 2) + maxLength,
        );
  const available = SAMPLE_COUNT - source.length;
  const start = Math.max(
    0,
    Math.min(available, Math.round(SAMPLE_RATE * (0.11 + random() * 0.16))),
  );
  const gain = 0.72 + random() * 0.25;
  const noiseLevel = variant === 0 ? 0 : 0.0015 + random() * 0.0025;

  for (let index = 0; index < source.length; index += 1) {
    output[start + index] = source[index] * gain;
  }
  for (let index = 0; index < output.length; index += 1) {
    output[index] += (random() * 2 - 1) * noiseLevel;
  }
  return output;
}

function createNoiseWaveform(key) {
  const random = seededRandom(hashString(key));
  const output = new Float32Array(SAMPLE_COUNT);
  const level = 0.001 + random() * 0.005;
  let filtered = 0;
  for (let index = 0; index < output.length; index += 1) {
    filtered = filtered * 0.92 + (random() * 2 - 1) * 0.08;
    output[index] = filtered * level;
  }
  return output;
}

const blackmanWindow = Float64Array.from(
  { length: FFT_WINDOW },
  (_, index) =>
    0.42 -
    0.5 * Math.cos((2 * Math.PI * index) / FFT_WINDOW) +
    0.08 * Math.cos((4 * Math.PI * index) / FFT_WINDOW),
);

function waveformToSpectrogram(samples) {
  const fft = new FFT(FFT_WINDOW);
  const input = new Float64Array(FFT_WINDOW);
  const spectrum = fft.createComplexArray();
  const output = new Float32Array(FRAME_COUNT * FRAME_SIZE);

  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const frameEnd = (frame + 1) * FFT_HOP;
    const frameStart = frameEnd - FFT_WINDOW;
    for (let index = 0; index < FFT_WINDOW; index += 1) {
      const sampleIndex = frameStart + index;
      input[index] =
        (sampleIndex >= 0 && sampleIndex < samples.length
          ? samples[sampleIndex]
          : 0) * blackmanWindow[index];
    }
    fft.realTransform(spectrum, input);
    for (let bin = 0; bin < FRAME_SIZE; bin += 1) {
      const real = spectrum[bin * 2];
      const imaginary = spectrum[bin * 2 + 1];
      const magnitude = Math.hypot(real, imaginary) / FFT_WINDOW;
      output[frame * FRAME_SIZE + bin] = Math.max(
        -100,
        Math.min(-30, 20 * Math.log10(Math.max(magnitude, 1e-12))),
      );
    }
  }

  let mean = 0;
  for (const value of output) {
    mean += value;
  }
  mean /= output.length;
  let variance = 0;
  for (const value of output) {
    variance += (value - mean) ** 2;
  }
  const std = Math.sqrt(variance / output.length) + 1e-6;
  for (let index = 0; index < output.length; index += 1) {
    output[index] = (output[index] - mean) / std;
  }
  return output;
}

function synthesize(tempDir, voice, rate, text, key) {
  const path = join(tempDir, `${key}.wav`);
  execFileSync("say", [
    "-v",
    voice,
    "-r",
    String(rate),
    "-o",
    path,
    "--file-format=WAVE",
    "--data-format=LEI16@44100",
    text,
  ]);
  return parsePcm16Wav(path);
}

function addExample(dataset, label, waveform) {
  dataset.addExample({
    label,
    spectrogram: {
      data: waveformToSpectrogram(waveform),
      frameSize: FRAME_SIZE,
    },
  });
}

function buildVoiceExamples(dataset, tempDir, voices, rates, includeAugmented) {
  for (const [label, text] of Object.entries(COMMANDS)) {
    for (const voice of voices) {
      for (const rate of rates) {
        const key = `${label}-${voice}-${rate}`.replaceAll(/[^a-z0-9-]/gi, "_");
        const samples = synthesize(tempDir, voice, rate, text, key);
        addExample(dataset, label, prepareWaveform(samples, key, 0));
        if (includeAugmented) {
          addExample(dataset, label, prepareWaveform(samples, key, 1));
        }
      }
    }
  }

  for (let index = 0; index < voices.length * rates.length; index += 1) {
    const voice = voices[index % voices.length];
    const rate = rates[index % rates.length];
    const text = UNKNOWN_WORDS[index % UNKNOWN_WORDS.length];
    const key = `unknown-${voice}-${rate}-${index}`.replaceAll(
      /[^a-z0-9-]/gi,
      "_",
    );
    const samples = synthesize(tempDir, voice, rate, text, key);
    addExample(dataset, "_unknown_", prepareWaveform(samples, key, 0));
    if (includeAugmented) {
      addExample(dataset, "_unknown_", prepareWaveform(samples, key, 1));
    }
  }

  const noiseCount = voices.length * rates.length * (includeAugmented ? 2 : 1);
  for (let index = 0; index < noiseCount; index += 1) {
    addExample(
      dataset,
      "_background_noise_",
      createNoiseWaveform(`noise-${voices.length}-${rates.length}-${index}`),
    );
  }
}

async function loadBaseRecognizer() {
  const modelJson = JSON.parse((await download("model.json")).toString("utf8"));
  const metadata = JSON.parse((await download("metadata.json")).toString("utf8"));
  const shards = await Promise.all(
    modelJson.weightsManifest[0].paths.map((path) => download(path)),
  );
  const weightBuffer = Buffer.concat(shards);
  const weightData = weightBuffer.buffer.slice(
    weightBuffer.byteOffset,
    weightBuffer.byteOffset + weightBuffer.byteLength,
  );
  const artifacts = {
    modelTopology: modelJson.modelTopology,
    weightSpecs: modelJson.weightsManifest[0].weights,
    weightData,
  };
  const recognizer = speechCommands.create(
    "BROWSER_FFT",
    null,
    artifacts,
    metadata,
  );
  await recognizer.ensureModelLoaded();
  return recognizer;
}

function topPrediction(labels, scores) {
  let bestIndex = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index] > scores[bestIndex]) {
      bestIndex = index;
    }
  }
  return { label: labels[bestIndex], score: scores[bestIndex] };
}

async function saveModel(transfer) {
  let artifacts;
  await transfer.save({
    save: async (value) => {
      artifacts = value;
      return {
        modelArtifactsInfo: tf.io.getModelArtifactsInfoForJSON(value),
      };
    },
  });
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const weightPath = "group1-shard1of1.bin";
  writeFileSync(join(OUTPUT_DIR, weightPath), Buffer.from(artifacts.weightData));
  writeFileSync(
    join(OUTPUT_DIR, "model.json"),
    JSON.stringify({
      format: "layers-model",
      generatedBy: `TensorFlow.js ${tf.version.tfjs}`,
      convertedBy: null,
      modelTopology: artifacts.modelTopology,
      weightsManifest: [
        {
          paths: [weightPath],
          weights: artifacts.weightSpecs,
        },
      ],
    }),
  );
  writeFileSync(
    join(OUTPUT_DIR, "metadata.json"),
    JSON.stringify({
      wordLabels: transfer.wordLabels(),
      frameSize: FRAME_SIZE,
      sampleRateHz: SAMPLE_RATE,
      generatedAt: new Date().toISOString(),
      source: "macOS Mandarin speech synthesis with transfer learning",
    }),
  );
}

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), "clarity-voice-model-"));
  try {
    console.log("Generating Mandarin speech examples...");
    const trainDataset = new speechCommands.Dataset();
    buildVoiceExamples(
      trainDataset,
      tempDir,
      TRAIN_VOICES,
      TRAIN_RATES,
      true,
    );
    console.log("Training examples:", trainDataset.getExampleCounts());

    const baseRecognizer = await loadBaseRecognizer();
    const transfer = baseRecognizer.createTransfer("clarity-default-zh-v1");
    transfer.loadExamples(trainDataset.serialize());
    await transfer.train({
      epochs: 45,
      validationSplit: 0.18,
      batchSize: 32,
      optimizer: tf.train.adam(0.0015),
      augmentByMixingNoiseRatio: 0.12,
    });

    const testDataset = new speechCommands.Dataset();
    buildVoiceExamples(
      testDataset,
      tempDir,
      TRAIN_VOICES,
      TEST_RATES,
      false,
    );
    const labels = transfer.wordLabels();
    let correct = 0;
    let total = 0;
    const confusion = {};
    for (const label of testDataset.getVocabulary()) {
      confusion[label] = {};
      for (const { example } of testDataset.getExamples(label)) {
        const input = tf.tensor4d(example.spectrogram.data, [
          1,
          FRAME_COUNT,
          FRAME_SIZE,
          1,
        ]);
        const result = await transfer.recognize(input);
        input.dispose();
        const prediction = topPrediction(labels, result.scores);
        confusion[label][prediction.label] =
          (confusion[label][prediction.label] || 0) + 1;
        correct += Number(prediction.label === label);
        total += 1;
      }
    }
    console.log("Held-out accuracy:", `${correct}/${total}`, correct / total);
    console.log(JSON.stringify(confusion, null, 2));
    if (correct / total < 0.9) {
      throw new Error("Held-out accuracy is below 90%; refusing to publish model");
    }

    await saveModel(transfer);
    console.log(`Saved default model to ${OUTPUT_DIR}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
