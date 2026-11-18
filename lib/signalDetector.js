const ORT_VERSION = "1.22.0";
const ORT_BASE_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const ORT_SCRIPT_URL = `${ORT_BASE_URL}ort.webgpu.min.js`;

export const MODEL_URL = "/models/signal.onnx";
export const MODEL_INPUT_SIZE = 640;
export const SCORE_THRESHOLD = 0.35;

const SIGNAL_CLASS_INFO = {
  signal_blue: { state: 1, color: "blue" },
  signal_off: { state: 0, color: null },
  signal_red: { state: 1, color: "red" },
};

// ultralytics の ONNX は metadata に names を "{0: 'a', 1: 'b'}" の形で埋め込む
function readClassNames(modelBytes) {
  const text = new TextDecoder("latin1").decode(modelBytes);
  const match = text.match(/names[\s\S]{1,4}?(\{\d+:\s*['"][\s\S]*?['"]\})/);
  if (!match) return null;
  const names = [];
  for (const [, index, , label] of match[1].matchAll(/(\d+):\s*(['"])(.*?)\2/g)) {
    names[Number(index)] = label;
  }
  return names.length ? names : null;
}

function buildClassTable(names) {
  const signalClasses = new Map();
  names.forEach((label, classId) => {
    const info = SIGNAL_CLASS_INFO[label];
    if (info) signalClasses.set(classId, { label, ...info });
  });
  return { numClasses: names.length, signalClasses };
}

let ortPromise = null;

function loadOrt() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("ブラウザでのみ実行できます。"));
  }
  if (window.ort) return Promise.resolve(window.ort);
  if (!ortPromise) {
    ortPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = ORT_SCRIPT_URL;
      script.async = true;
      script.onload = () => {
        if (window.ort) resolve(window.ort);
        else reject(new Error("onnxruntime-web を初期化できません。"));
      };
      script.onerror = () => {
        ortPromise = null;
        reject(new Error("onnxruntime-web を読み込めません（ネットワークを確認）。"));
      };
      document.head.appendChild(script);
    });
  }
  return ortPromise;
}

function pickBestSignal(output, { numClasses, signalClasses }) {
  const { dims, data } = output;
  let best = null;

  const consider = (classId, score) => {
    const info = signalClasses.get(classId);
    if (!info || score < SCORE_THRESHOLD) return;
    if (!best || score > best.score) best = { ...info, classId, score };
  };

  if (dims.length === 3 && dims[2] === 6) {
    // end2end 出力: [1, max_det, (x1, y1, x2, y2, score, class)]
    for (let i = 0; i < dims[1]; i += 1) {
      const offset = i * 6;
      consider(Math.round(data[offset + 5]), data[offset + 4]);
    }
    return best;
  }

  if (dims.length === 3 && dims[1] === 4 + numClasses) {
    // 従来形式: [1, 4 + nc, anchors]（クラス得点は 0〜1 に変換済み）
    const anchors = dims[2];
    for (let a = 0; a < anchors; a += 1) {
      for (const classId of signalClasses.keys()) {
        consider(classId, data[(4 + classId) * anchors + a]);
      }
    }
    return best;
  }

  if (dims.length === 3 && dims[1] > 4 && dims[2] > dims[1]) {
    throw new Error(
      `モデルの出力のクラス数（${dims[1] - 4}）が、モデルに埋め込まれたクラス名の数（${numClasses}）と一致しません。`,
    );
  }

  throw new Error(`想定外のモデル出力形状です: [${dims.join(", ")}]`);
}

async function fetchModel() {
  let response;
  try {
    response = await fetch(MODEL_URL);
  } catch {
    throw new Error(`YOLO モデル（${MODEL_URL}）を取得できません。`);
  }
  if (response.status === 404) {
    throw new Error(
      `YOLO モデルが見つかりません。weights.pt を ONNX に書き出し、public${MODEL_URL} に置いてください。`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `YOLO モデル（${MODEL_URL}）を取得できません（${response.status}）。`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function createSignalDetector() {
  const ort = await loadOrt();
  ort.env.wasm.wasmPaths = ORT_BASE_URL;
  const modelBytes = await fetchModel();

  const classNames = readClassNames(modelBytes);
  if (!classNames) {
    throw new Error(
      "モデルからクラス名を読み取れません。ultralytics の yolo export で書き出した ONNX を使ってください。",
    );
  }
  const classTable = buildClassTable(classNames);
  if (classTable.signalClasses.size === 0) {
    throw new Error(
      `モデルに signal_blue / signal_off / signal_red のクラスがありません（クラス: ${classNames.join(", ")}）。`,
    );
  }

  let session = null;
  let backend = null;
  let lastError = null;
  const providers =
    typeof navigator !== "undefined" && navigator.gpu
      ? ["webgpu", "wasm"]
      : ["wasm"];

  for (const provider of providers) {
    try {
      session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: [provider],
        graphOptimizationLevel: "all",
      });
      backend = provider;
      break;
    } catch (caught) {
      lastError = caught;
    }
  }

  if (!session) {
    const reason = lastError instanceof Error ? lastError.message : "";
    throw new Error(
      `YOLO モデル（${MODEL_URL}）を読み込めません。${reason}`,
    );
  }

  const size = MODEL_INPUT_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const input = new Float32Array(3 * size * size);

  async function detect(video) {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!videoWidth || !videoHeight) {
      throw new Error("映像の準備ができていません。");
    }

    const scale = Math.min(size / videoWidth, size / videoHeight);
    const width = Math.round(videoWidth * scale);
    const height = Math.round(videoHeight * scale);
    const dx = Math.floor((size - width) / 2);
    const dy = Math.floor((size - height) / 2);

    context.fillStyle = "rgb(114, 114, 114)";
    context.fillRect(0, 0, size, size);
    context.drawImage(video, 0, 0, videoWidth, videoHeight, dx, dy, width, height);
    const pixels = context.getImageData(0, 0, size, size).data;

    const area = size * size;
    for (let i = 0; i < area; i += 1) {
      input[i] = pixels[i * 4] / 255;
      input[i + area] = pixels[i * 4 + 1] / 255;
      input[i + area * 2] = pixels[i * 4 + 2] / 255;
    }

    const tensor = new ort.Tensor("float32", input, [1, 3, size, size]);
    const outputs = await session.run({ [inputName]: tensor });
    const output = outputs[outputName];
    const best = pickBestSignal(output, classTable);
    output.dispose?.();

    if (!best) {
      return { state: null, color: null, label: null, score: null };
    }
    return {
      state: best.state,
      color: best.color,
      label: best.label,
      score: Number(best.score.toFixed(2)),
    };
  }

  return {
    backend,
    classNames,
    detect,
    release: () => session.release?.(),
  };
}
