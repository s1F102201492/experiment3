export const CLASS_TRUST_SCORE = 0.6;
export const DARK_LEVEL = 80;
export const MIN_LAMP_CONTRAST = 1.5;
export const CLIPPED_LEVEL = 245;

const SAMPLE_WIDTH = 24;
const SAMPLE_HEIGHT = 48;
const MIN_BOX_HEIGHT_PX = 12;
const BRIGHT_PERCENTILE = 0.9;

let sampleContext = null;

function getSampleContext() {
  if (!sampleContext) {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_WIDTH;
    canvas.height = SAMPLE_HEIGHT;
    sampleContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  return sampleContext;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

// 歩行者信号は上が赤、下が青なので、枠の上半分と下半分の明るさだけで色を決められる
export function measureLamps(video, box) {
  if (!box || box.height < MIN_BOX_HEIGHT_PX || box.width < 2) return null;

  const context = getSampleContext();
  const insetX = box.width * 0.15;
  context.drawImage(
    video,
    box.x + insetX,
    box.y,
    box.width - insetX * 2,
    box.height,
    0,
    0,
    SAMPLE_WIDTH,
    SAMPLE_HEIGHT,
  );
  const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);

  const half = SAMPLE_HEIGHT / 2;
  const top = [];
  const bottom = [];
  const topClipped = [];
  const bottomClipped = [];
  for (let y = 0; y < SAMPLE_HEIGHT; y += 1) {
    for (let x = 0; x < SAMPLE_WIDTH; x += 1) {
      const i = (y * SAMPLE_WIDTH + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const level = Math.max(r, g, b);
      const clipped = Math.min(r, g, b) >= CLIPPED_LEVEL;
      if (y < half) {
        top.push(level);
        topClipped.push(clipped);
      } else {
        bottom.push(level);
        bottomClipped.push(clipped);
      }
    }
  }

  const topLevel = percentile(top, BRIGHT_PERCENTILE);
  const bottomLevel = percentile(bottom, BRIGHT_PERCENTILE);
  const litClipped = topLevel >= bottomLevel ? topClipped : bottomClipped;
  const clippedRatio =
    litClipped.filter(Boolean).length / Math.max(1, litClipped.length);

  return {
    top_level: topLevel,
    bottom_level: bottomLevel,
    contrast: Number(
      ((Math.max(topLevel, bottomLevel) + 1) /
        (Math.min(topLevel, bottomLevel) + 1)).toFixed(2),
    ),
    clipped_ratio: Number(clippedRatio.toFixed(2)),
  };
}

export function judgeByPosition(measurement) {
  if (!measurement) return { state: null, color: null };
  const { top_level: topLevel, bottom_level: bottomLevel, contrast } =
    measurement;
  if (Math.max(topLevel, bottomLevel) < DARK_LEVEL) {
    return { state: 0, color: null };
  }
  if (contrast < MIN_LAMP_CONTRAST) return { state: null, color: null };
  return { state: 1, color: topLevel > bottomLevel ? "red" : "blue" };
}

// YOLO の得点が高ければクラスを使い、低いときだけ位置と明るさで判定する
export function combineSignalJudgement(detection, measurement) {
  const position = judgeByPosition(measurement);

  if (!detection?.box) {
    return { state: null, color: null, method: "none", position };
  }
  if (detection.score >= CLASS_TRUST_SCORE) {
    return {
      state: detection.state,
      color: detection.color,
      method: "yolo",
      position,
    };
  }
  if (position.state === null) {
    return { state: null, color: null, method: "position", position };
  }
  return {
    state: position.state,
    color: position.color,
    method: "position",
    position,
  };
}
