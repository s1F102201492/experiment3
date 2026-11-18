export const FRAME_INTERVAL_MS = 100;
export const WINDOW_FRAMES = 20;
export const MAX_FLICKER_GAP_FRAMES = 2;
export const MIN_BLINK_OFF_FRAMES = 3;
export const MIN_DETECTED_RATIO = 0.5;

export const SIGNAL_COLORS = new Set(["blue", "red"]);
export const TIMELINE_VERDICTS = new Set([
  "blinking",
  "steady",
  "off",
  "unknown",
]);

export function removeFlicker(states, maxGap = MAX_FLICKER_GAP_FRAMES) {
  const out = [...states];
  let i = 0;
  while (i < out.length) {
    if (out[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < out.length && out[j] === 0) j += 1;
    const bounded =
      i > 0 && j < out.length && out[i - 1] === 1 && out[j] === 1;
    if (bounded && j - i <= maxGap) out.fill(1, i, j);
    i = j;
  }
  return out;
}

function findOffRuns(states) {
  const runs = [];
  let i = 0;
  while (i < states.length) {
    if (states[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < states.length && states[j] === 0) j += 1;
    runs.push({
      start: i,
      length: j - i,
      boundedByOn: i > 0 && j < states.length && states[i - 1] === 1 && states[j] === 1,
    });
    i = j;
  }
  return runs;
}

function mostFrequent(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function decideVerdict({ detectedRatio, onRatio, blinkOffRuns }) {
  if (detectedRatio < MIN_DETECTED_RATIO) return "unknown";
  if (blinkOffRuns > 0) return "blinking";
  if (onRatio === 1) return "steady";
  if (onRatio !== null && onRatio <= 0.2) return "off";
  return "unknown";
}

export function sanitizeTimelineInput(input) {
  if (!input || typeof input !== "object") return null;
  if (!Array.isArray(input.raw) || input.raw.length === 0) return null;

  const raw = input.raw
    .slice(-WINDOW_FRAMES)
    .map((value) => (value === 1 || value === 0 ? value : null));
  const colorsSource = Array.isArray(input.colors)
    ? input.colors.slice(-raw.length)
    : [];
  const colors = raw.map((_, index) =>
    SIGNAL_COLORS.has(colorsSource[index]) ? colorsSource[index] : null,
  );
  const intervalMs = Number(input.interval_ms);

  return {
    raw,
    colors,
    interval_ms:
      Number.isFinite(intervalMs) && intervalMs > 0
        ? Math.round(intervalMs)
        : FRAME_INTERVAL_MS,
  };
}

export function summarizeTimeline({ raw, colors, interval_ms }) {
  const smoothed = removeFlicker(raw);
  const detected = smoothed.filter((value) => value !== null);
  const detectedRatio = raw.length ? detected.length / raw.length : 0;
  const onRatio = detected.length
    ? detected.filter((value) => value === 1).length / detected.length
    : null;

  const rawFlickerFrames = raw.reduce(
    (count, value, index) =>
      value === 0 && smoothed[index] === 1 ? count + 1 : count,
    0,
  );
  const offRuns = findOffRuns(smoothed);
  const blinkOffRuns = offRuns.filter(
    (run) => run.boundedByOn && run.length >= MIN_BLINK_OFF_FRAMES,
  ).length;
  const longestOffRunFrames = offRuns.reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );

  const litColors = colors.filter(
    (color, index) => color && smoothed[index] === 1,
  );

  return {
    interval_ms,
    window_ms: raw.length * interval_ms,
    raw,
    smoothed,
    detected_ratio: Number(detectedRatio.toFixed(2)),
    on_ratio: onRatio === null ? null : Number(onRatio.toFixed(2)),
    flicker_frames_removed: rawFlickerFrames,
    blink_off_runs: blinkOffRuns,
    longest_off_run_ms: longestOffRunFrames * interval_ms,
    dominant_color: mostFrequent(litColors) ?? "unknown",
    verdict: decideVerdict({ detectedRatio, onRatio, blinkOffRuns }),
  };
}
