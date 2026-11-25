// シャッタースピードは「1/x 秒」の x で扱う
export const CALIBRATION_SHUTTERS = [100, 120, 160, 200, 250, 320, 500, 1000];
export const MANUAL_SHUTTERS = [50, 60, 100, 120, 160, 200, 250, 320, 500, 1000, 2000];
export const FLICKER_SAFE_MAX_SHUTTER = 120;
export const NIGHT_SHUTTERS = [100, 60, 30];
export const NIGHT_ISO_STEPS = [100, 200, 400, 800, 1600, 3200];
// 1/100 秒・ISO 最低で撮った画面の平均輝度（0〜255）がこれ未満なら夜とみなす
export const NIGHT_SCENE_LEVEL = 40;
export const SCENES = new Set(["day", "night"]);

const SETTLE_MS = 600;
const SAMPLES_PER_STEP = 6;
const SAMPLE_GAP_MS = 100;
const MIN_LIT_SAMPLES = 2;
const MIN_JUDGEABLE_RATIO = 0.7;

export const EXPOSURE_MODES = new Set(["calibrate", "manual", "device"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Image Capture 仕様の exposureTime は 100 マイクロ秒単位
export function shutterToExposureTime(shutter) {
  return 10000 / shutter;
}

export function exposureTimeToShutter(exposureTime) {
  if (!exposureTime) return null;
  return Math.round(10000 / exposureTime);
}

export function formatShutter(shutter) {
  return shutter ? `1/${shutter}秒` : "—";
}

export function isFlickerSafe(shutter) {
  return shutter <= FLICKER_SAFE_MAX_SHUTTER;
}

function clampToRange(value, range) {
  if (!range || typeof range.min !== "number") return value;
  return Math.min(range.max, Math.max(range.min, value));
}

export function readExposureSupport(track) {
  const capabilities = track?.getCapabilities?.() ?? {};
  const settings = track?.getSettings?.() ?? {};
  const exposureModes = capabilities.exposureMode ?? [];
  return {
    exposureModes,
    exposureTime: capabilities.exposureTime ?? null,
    iso: capabilities.iso ?? null,
    manualExposure:
      exposureModes.includes("manual") && Boolean(capabilities.exposureTime),
    settings: {
      exposureMode: settings.exposureMode ?? null,
      exposureTime: settings.exposureTime ?? null,
      iso: settings.iso ?? null,
    },
  };
}

export function isShutterSupported(support, shutter) {
  const range = support?.exposureTime;
  if (!range) return false;
  const value = shutterToExposureTime(shutter);
  return value >= range.min && value <= range.max;
}

export async function applyManualExposure(track, support, { shutter, iso }) {
  if (!support?.manualExposure) {
    throw new Error("この端末のカメラは露光時間の手動設定に対応していません。");
  }
  const constraint = {
    exposureMode: "manual",
    exposureTime: clampToRange(shutterToExposureTime(shutter), support.exposureTime),
  };
  if (support.iso && typeof iso === "number") {
    constraint.iso = clampToRange(iso, support.iso);
  }
  await track.applyConstraints({ advanced: [constraint] });
  const settings = track.getSettings();
  return {
    mode: "manual",
    shutter: exposureTimeToShutter(settings.exposureTime) ?? shutter,
    iso: settings.iso ?? constraint.iso ?? null,
  };
}

export async function applyDeviceExposure(track, support) {
  if (support?.exposureModes.includes("continuous")) {
    await track.applyConstraints({ advanced: [{ exposureMode: "continuous" }] });
  }
  const settings = track.getSettings();
  return {
    mode: "device",
    shutter: exposureTimeToShutter(settings.exposureTime),
    iso: settings.iso ?? null,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function evaluateSamples(samples) {
  const found = samples.filter((sample) => sample.measurement);
  const lit = found.filter((sample) => sample.position.state !== 0);
  const judgeable = lit.filter((sample) => sample.position.state === 1);
  return {
    found: found.length,
    lit: lit.length,
    judgeable: judgeable.length,
    contrast: median(found.map((sample) => sample.measurement.contrast)),
    clipped_ratio: median(lit.map((sample) => sample.measurement.clipped_ratio)),
    ok:
      lit.length >= MIN_LIT_SAMPLES &&
      judgeable.length / lit.length >= MIN_JUDGEABLE_RATIO,
  };
}

// ISO を最低にし、1/100 秒から順に短くして、上下どちらの灯火が光っているか判定できる設定を探す
export async function calibrateExposure({
  track,
  support,
  sampleFrame,
  onStep,
  isCancelled = () => false,
}) {
  const iso = support.iso?.min;
  const shutters = CALIBRATION_SHUTTERS.filter((shutter) =>
    isShutterSupported(support, shutter),
  );
  if (shutters.length === 0) {
    throw new Error("この端末で使えるシャッタースピードの候補がありません。");
  }

  const steps = [];
  for (const shutter of shutters) {
    if (isCancelled()) break;
    const applied = await applyManualExposure(track, support, { shutter, iso });
    await wait(SETTLE_MS);

    const samples = [];
    for (let i = 0; i < SAMPLES_PER_STEP; i += 1) {
      samples.push(await sampleFrame());
      await wait(SAMPLE_GAP_MS);
    }
    const step = { ...applied, ...evaluateSamples(samples) };
    steps.push(step);
    onStep?.(step);

    if (step.found === 0) {
      const fallback = await applyManualExposure(track, support, {
        shutter: shutters[0],
        iso,
      });
      return { ok: false, reason: "no_signal", applied: fallback, steps };
    }
    if (step.ok) return { ok: true, applied, steps };
  }

  const best = [...steps].sort(
    (a, b) => b.judgeable - a.judgeable || (b.contrast ?? 0) - (a.contrast ?? 0),
  )[0];
  const applied = best
    ? await applyManualExposure(track, support, { shutter: best.shutter, iso })
    : null;
  return { ok: false, reason: "not_judgeable", applied, steps };
}

function nightIsoSteps(support) {
  if (!support.iso) return [null];
  const { min, max } = support.iso;
  const steps = [min, ...NIGHT_ISO_STEPS.filter((iso) => iso > min && iso < max), max];
  return [...new Set(steps)];
}

function rankStep(a, b) {
  return (
    b.found - a.found ||
    b.judgeable - a.judgeable ||
    (a.clipped_ratio ?? 1) - (b.clipped_ratio ?? 1)
  );
}

// 夜はシャッターを 1/100 秒（ちらつきが出ない最短）に保ったまま ISO を上げ、
// 灯火が白飛びせず YOLO が信号を見つけられる明るさを探す。1/100 秒で一度も見つからなければ 1/60・1/30 秒も試す
export async function calibrateNightExposure({
  track,
  support,
  sampleFrame,
  onStep,
  isCancelled = () => false,
}) {
  const shutters = NIGHT_SHUTTERS.filter((shutter) =>
    isShutterSupported(support, shutter),
  );
  if (shutters.length === 0) {
    throw new Error("この端末で使えるシャッタースピードの候補がありません。");
  }
  const isoSteps = nightIsoSteps(support);

  const steps = [];
  for (const shutter of shutters) {
    if (isCancelled()) break;
    for (const iso of isoSteps) {
      if (isCancelled()) break;
      const applied = await applyManualExposure(track, support, { shutter, iso });
      await wait(SETTLE_MS);

      const samples = [];
      for (let i = 0; i < SAMPLES_PER_STEP; i += 1) {
        samples.push(await sampleFrame());
        await wait(SAMPLE_GAP_MS);
      }
      const step = { ...applied, ...evaluateSamples(samples) };
      steps.push(step);
      onStep?.(step);

      if (step.ok) return { ok: true, applied, steps };
    }
    if (steps.some((step) => step.found > 0)) break;
  }

  const best = [...steps].sort(rankStep)[0];
  if (!best || best.found === 0) {
    const fallback = await applyDeviceExposure(track, support);
    return { ok: false, reason: "no_signal", applied: fallback, steps };
  }
  const applied = await applyManualExposure(track, support, {
    shutter: best.shutter,
    iso: best.iso,
  });
  return { ok: false, reason: "not_judgeable", applied, steps };
}

let brightnessContext = null;

export function measureSceneBrightness(video) {
  if (!brightnessContext) {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    brightnessContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  brightnessContext.drawImage(video, 0, 0, 32, 18);
  const { data } = brightnessContext.getImageData(0, 0, 32, 18);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return Math.round(total / (data.length / 4));
}

// 自動露出は暗い場面でも明るく写そうとするので、露光を 1/100 秒・ISO 最低に固定してから明るさを測る
export async function detectScene({ track, support, video }) {
  await applyManualExposure(track, support, {
    shutter: 100,
    iso: support.iso?.min,
  });
  await wait(SETTLE_MS);
  const brightness = measureSceneBrightness(video);
  return {
    scene: brightness < NIGHT_SCENE_LEVEL ? "night" : "day",
    brightness,
  };
}

// scene が "auto" なら明るさで昼夜を判定してから、それぞれの調整を行う
export async function calibrateForScene({ scene = "auto", video, ...options }) {
  let detected = { scene, brightness: null };
  if (scene === "auto") {
    detected = await detectScene({ ...options, video });
  }
  const calibrate =
    detected.scene === "night" ? calibrateNightExposure : calibrateExposure;
  const result = await calibrate(options);
  return {
    ...result,
    scene: detected.scene,
    brightness: detected.brightness,
    applied: result.applied
      ? {
          ...result.applied,
          mode: result.applied.mode === "device" ? "device" : "calibrate",
          scene: detected.scene,
        }
      : null,
  };
}

export function sanitizeExposureInfo(input) {
  if (!input || typeof input !== "object") return null;
  if (!EXPOSURE_MODES.has(input.mode)) return null;
  const shutter = Number(input.shutter);
  const iso = Number(input.iso);
  return {
    mode: input.mode,
    shutter: Number.isFinite(shutter) && shutter > 0 ? Math.round(shutter) : null,
    iso: Number.isFinite(iso) && iso > 0 ? Math.round(iso) : null,
    scene: SCENES.has(input.scene) ? input.scene : null,
  };
}
