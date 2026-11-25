import { formatShutter, sanitizeExposureInfo } from "@/lib/cameraExposure";
import {
  sanitizeTimelineInput,
  summarizeTimeline,
} from "@/lib/signalTimeline";

const SYSTEM_PROMPT = `あなたは視覚障害者の道路横断を支援するアシスタントです。
提供された画像（直近の映像フレーム）と、YOLO による「信号点灯タイムライン」を分析し、
以下の項目をJSON形式で出力してください。

{
  "signal_state": "red" | "green" | "blinking" | "unknown",
  "pedestrian_signal_display": "steady" | "blinking" | "not_visible" | "unknown",
  "pedestrian_countdown_meter_present": true | false,
  "pedestrian_countdown_seconds_estimate": number | null,
  "pedestrian_countdown_estimate": "短い" | "中程度" | "長い" | "不明",
  "crosswalk_visible": true | false,
  "crosswalk_stripe_count_estimate": number | null,
  "crosswalk_stripe_extent": "短い" | "中程度" | "長い" | "不明",
  "crosswalk_distance_estimate": "近い" | "中程度" | "遠い" | "不明",
  "approaching_hazard": "vehicle" | "bicycle" | "person" | "none",
  "hazard_distance_estimate": "近い" | "中程度" | "遠い" | "不明",
  "recommended_action": "GO" | "STOP" | "WAIT",
  "voice_message": "ユーザーに伝える短い日本語の音声案内文"
}

ルール:
- JSON以外は出力しない。
- 複数枚ある場合は時系列（古い順→新しい順）として扱い、接近物の変化を優先して判断する。
- pedestrian_signal_display は歩行者用信号機（青人形・赤人形など）の表示状態。点灯し続けているなら steady、点滅しているなら blinking。映像内に歩行者信号が写っていなければ not_visible。判定できなければ unknown。

信号点灯タイムラインの扱い:
- ユーザー入力に「信号点灯タイムライン」が含まれる場合、点滅の判定はこれを最優先の根拠とし、画像の見た目より優先する。
- raw は歩行者信号を interval_ms ごとに判定した結果で、配列は古い順→新しい順。1=点灯、0=消灯（灯器は見えるが光っていない）、null=信号を検出できなかった、または判定できなかった。
- 各フレームは、物体検出モデル（YOLO）の確信度が高いときはそのクラスで、低いときは信号機の上半分（赤）と下半分（青）のどちらが明るいかで判定している。
- カメラのちらつきは露光時間の設定で抑えている。1〜2要素だけの0は点滅とみなさない。
- verdict はプログラムによる判定結果:
  - blinking: raw に0.3秒以上の消灯があり、その前後が点灯している（本当の点滅）。pedestrian_signal_display と signal_state を blinking にする。
  - steady: 検出できたフレームのほぼすべて（85%以上）が点灯。点滅ではない。色は dominant_color（blue=青、red=赤）と画像から判断する。
  - off: ほとんど消灯している。点滅の消灯中や信号の切り替わり中の可能性があるため、安全側に倒す。
  - unknown: 検出が少ない、または判断できない。画像だけで判断するが、点滅かどうか分からない場合は渡らせない。
- detected_ratio は信号を検出できたフレームの割合。0.5未満なら信頼性が低い。
- dominant_color は点灯していたフレームの色。画像と明らかに矛盾する場合は画像を優先し、判断できなければ unknown にする。
- 歩行者信号が点滅している、または点滅の可能性がある場合は、これから横断を始めるべきではないため recommended_action を GO にしない。
- タイムラインが無い場合は画像だけで判断し、1枚だけなら点滅は判定しない（unknown を優先）。
- 「カメラ露光」が示されている場合、シャッタースピードを短くしているため画像全体が暗く、色が薄く写ることがある。暗さや色の薄さだけを理由に信号を消灯と判断しない。
- 「夜間の撮影」が示されている場合、夜で周囲が暗く、ISO を上げているためノイズが多い。灯火は光がにじんで大きく写ることがある。車両はヘッドライトやテールライトの位置と大きさで接近を判断する。周囲が暗くて横断歩道や車両が判断できない場合は、見えないものを安全と判断せず WAIT または STOP にする。
- pedestrian_countdown_meter_present は歩行者信号機に「あとどれくらいで信号が変わるか」を示す表示（数字カウントダウン、残り秒、プログレスバー、メーターなど）があるか。
- pedestrian_countdown_seconds_estimate はメーターがあり数字が読める場合の、信号切り替えまでの残り秒数の目安（整数）。読めない場合は null。メーターが無い場合も null。
- pedestrian_countdown_estimate はメーターはあるが秒数が読めない場合の、残り時間の粗い目安（短い=まもなく切り替わる、長い=まだ余裕）。メーターが無い、または全く推定できない場合は「不明」。秒数が読めた場合も、参考として短い/中程度/長いを付けてよい（0-10秒=短い、11-30秒=中程度、31秒以上=長い の目安）。
- crosswalk_stripe_count_estimate は横断歩道の白い縞（帯）の本数の目安（整数）。一部しか見えない場合は見えている範囲で推定し、全く数えられない場合は null。
- crosswalk_stripe_extent は横断歩道の縞模様が画面内でどれだけ続いて見えるか（横断方向の長さの目安）。
- 距離はメートルではなく「近い」「中程度」「遠い」「不明」のみ。
- approaching_hazard はユーザーに最も危険な対象を1つ選ぶ。危険がなければ none。
- recommended_action は安全側に倒す。渡ってよいか不明なら WAIT または STOP。
- voice_message は1〜2文、口頭で聞いてすぐ理解できる短い日本語にする。recommended_action と矛盾させない。`;

const SIGNAL_STATES = new Set(["red", "green", "blinking", "unknown"]);
const PEDESTRIAN_SIGNAL_DISPLAYS = new Set([
  "steady",
  "blinking",
  "not_visible",
  "unknown",
]);
const STRIPE_EXTENTS = new Set(["短い", "中程度", "長い", "不明"]);
const COUNTDOWN_ESTIMATES = new Set(["短い", "中程度", "長い", "不明"]);
const DISTANCES = new Set(["近い", "中程度", "遠い", "不明"]);
const HAZARDS = new Set(["vehicle", "bicycle", "person", "none"]);
const ACTIONS = new Set(["GO", "STOP", "WAIT"]);

const PROVIDERS = new Set(["openai", "gemini"]);

function defaultProvider() {
  const provider = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  return PROVIDERS.has(provider) ? provider : "openai";
}

function getConfig(requestedProvider) {
  const provider = PROVIDERS.has(requestedProvider)
    ? requestedProvider
    : defaultProvider();

  if (provider === "gemini") {
    const baseUrl = (
      process.env.GEMINI_BASE_URL ||
      "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/$/, "");
    const model =
      process.env.GEMINI_MODEL ||
      process.env.LLM_MODEL ||
      "gemini-3.8-flash";

    return {
      provider: "gemini",
      api: "generateContent",
      model,
      thinkingLevel: process.env.GEMINI_THINKING_LEVEL || "low",
      endpoint: `${baseUrl}/models/${model}:generateContent`,
      apiKey: process.env.GEMINI_API_KEY,
      apiKeyName: "GEMINI_API_KEY",
      inputUsdPerMillion: Number(
        process.env.GEMINI_INPUT_USD_PER_MTOK || "0.75",
      ),
      outputUsdPerMillion: Number(
        process.env.GEMINI_OUTPUT_USD_PER_MTOK || "3.75",
      ),
    };
  }

  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const api = (process.env.OPENAI_API || "responses").toLowerCase();
  const model =
    process.env.OPENAI_MODEL || process.env.LLM_MODEL || "gpt-6-luna";
  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || "none";

  const endpoint =
    api === "chat"
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/responses`;

  return {
    provider: "openai",
    api,
    model,
    reasoningEffort,
    endpoint,
    apiKey: process.env.OPENAI_API_KEY,
    apiKeyName: "OPENAI_API_KEY",
    inputUsdPerMillion: Number(process.env.OPENAI_INPUT_USD_PER_MTOK || "0.1"),
    outputUsdPerMillion: Number(process.env.OPENAI_OUTPUT_USD_PER_MTOK || "0.5"),
  };
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!match) return null;
  return { mime_type: match[1], data: match[2] };
}

function normalizeStripeCount(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function normalizeCountdownSeconds(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(999, Math.round(value));
}

function countdownEstimateFromSeconds(seconds) {
  if (seconds === null) return null;
  if (seconds <= 10) return "短い";
  if (seconds <= 30) return "中程度";
  return "長い";
}

function fallbackResult(overrides = {}) {
  return {
    signal_state: "unknown",
    pedestrian_signal_display: "unknown",
    pedestrian_countdown_meter_present: false,
    pedestrian_countdown_seconds_estimate: null,
    pedestrian_countdown_estimate: "不明",
    crosswalk_visible: false,
    crosswalk_stripe_count_estimate: null,
    crosswalk_stripe_extent: "不明",
    crosswalk_distance_estimate: "不明",
    approaching_hazard: "none",
    hazard_distance_estimate: "不明",
    recommended_action: "WAIT",
    voice_message: "状況を判定できませんでした。止まってください。",
    ...overrides,
  };
}

function normalizeResult(raw) {
  if (!raw || typeof raw !== "object") {
    return fallbackResult();
  }

  const countdownMeterPresent = Boolean(raw.pedestrian_countdown_meter_present);
  const countdownSeconds = countdownMeterPresent
    ? normalizeCountdownSeconds(raw.pedestrian_countdown_seconds_estimate)
    : null;
  const countdownFromSeconds = countdownEstimateFromSeconds(countdownSeconds);
  const countdownEstimate = countdownMeterPresent
    ? countdownFromSeconds ||
      (COUNTDOWN_ESTIMATES.has(raw.pedestrian_countdown_estimate)
        ? raw.pedestrian_countdown_estimate
        : "不明")
    : "不明";

  return {
    signal_state: SIGNAL_STATES.has(raw.signal_state)
      ? raw.signal_state
      : "unknown",
    pedestrian_signal_display: PEDESTRIAN_SIGNAL_DISPLAYS.has(
      raw.pedestrian_signal_display,
    )
      ? raw.pedestrian_signal_display
      : "unknown",
    pedestrian_countdown_meter_present: countdownMeterPresent,
    pedestrian_countdown_seconds_estimate: countdownSeconds,
    pedestrian_countdown_estimate: countdownEstimate,
    crosswalk_visible: Boolean(raw.crosswalk_visible),
    crosswalk_stripe_count_estimate: normalizeStripeCount(
      raw.crosswalk_stripe_count_estimate,
    ),
    crosswalk_stripe_extent: STRIPE_EXTENTS.has(raw.crosswalk_stripe_extent)
      ? raw.crosswalk_stripe_extent
      : "不明",
    crosswalk_distance_estimate: DISTANCES.has(
      raw.crosswalk_distance_estimate,
    )
      ? raw.crosswalk_distance_estimate
      : "不明",
    approaching_hazard: HAZARDS.has(raw.approaching_hazard)
      ? raw.approaching_hazard
      : "none",
    hazard_distance_estimate: DISTANCES.has(raw.hazard_distance_estimate)
      ? raw.hazard_distance_estimate
      : "不明",
    recommended_action: ACTIONS.has(raw.recommended_action)
      ? raw.recommended_action
      : "WAIT",
    voice_message:
      typeof raw.voice_message === "string" && raw.voice_message.trim()
        ? raw.voice_message.trim()
        : "案内を生成できませんでした。止まってください。",
  };
}

function parseModelJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeUsage(usage) {
  if (!usage) return null;
  const promptTokens =
    usage.prompt_tokens ??
    usage.input_tokens ??
    usage.promptTokenCount ??
    0;
  const completionTokens =
    usage.completion_tokens ??
    usage.output_tokens ??
    usage.candidatesTokenCount ??
    0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      usage.total_tokens ??
      usage.totalTokenCount ??
      promptTokens + completionTokens,
  };
}

function estimateCostUsd(usage, inputUsdPerMillion, outputUsdPerMillion) {
  const normalized = normalizeUsage(usage);
  if (!normalized) return 0;
  const input =
    (normalized.prompt_tokens / 1_000_000) * inputUsdPerMillion;
  const output =
    (normalized.completion_tokens / 1_000_000) * outputUsdPerMillion;
  return Number((input + output).toFixed(6));
}

function buildUserText(images, timeline, exposure) {
  const lines = [
    `フレーム数: ${images.length}（古い順→新しい順）。道路横断の状況を分析してください。`,
  ];
  if (exposure?.scene === "night") {
    lines.push(
      `夜間の撮影: シャッタースピード ${formatShutter(exposure.shutter)}、ISO ${exposure.iso ?? "不明"}`,
    );
  } else if (exposure && exposure.mode !== "device") {
    lines.push(
      `カメラ露光: シャッタースピード ${formatShutter(exposure.shutter)}、ISO ${exposure.iso ?? "不明"}`,
    );
  }
  lines.push(
    timeline
      ? `信号点灯タイムライン(JSON):\n${JSON.stringify(timeline)}`
      : "信号点灯タイムライン: なし",
  );
  return lines.join("\n");
}

function applyTimelineSafety(result, timeline) {
  if (timeline?.verdict !== "blinking") return result;
  const adjusted = {
    ...result,
    signal_state: "blinking",
    pedestrian_signal_display: "blinking",
  };
  if (adjusted.recommended_action === "GO") {
    adjusted.recommended_action = "WAIT";
    adjusted.voice_message =
      "歩行者信号が点滅しています。渡らずに次の青信号を待ってください。";
  }
  return adjusted;
}

function buildOpenAIRequestBody(config, images, timeline, exposure) {
  const userText = buildUserText(images, timeline, exposure);

  if (config.api === "chat") {
    const body = {
      model: config.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            ...images.map((url) => ({
              type: "image_url",
              image_url: { url, detail: "low" },
            })),
          ],
        },
      ],
    };

    if (config.reasoningEffort === "none") {
      body.reasoning_effort = "none";
      body.temperature = 0.2;
    } else {
      body.reasoning_effort = config.reasoningEffort;
    }

    return body;
  }

  const body = {
    model: config.model,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "input_text", text: userText },
          ...images.map((url) => ({
            type: "input_image",
            image_url: url,
            detail: "low",
          })),
        ],
      },
    ],
    text: { format: { type: "json_object" } },
    reasoning: { effort: config.reasoningEffort },
  };

  if (config.reasoningEffort === "none") {
    body.temperature = 0.2;
  }

  return body;
}

function buildGeminiRequestBody(config, images, timeline, exposure) {
  const userText = buildUserText(images, timeline, exposure);
  const imageParts = images.map((url) => {
    const parsed = parseDataUrl(url);
    if (!parsed) {
      throw new Error("Gemini 用に画像 Data URL を解析できません。");
    }
    return { inline_data: parsed };
  });

  return {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userText }, ...imageParts],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      thinkingConfig: {
        thinkingLevel: config.thinkingLevel,
      },
    },
  };
}

function extractOpenAIResponseText(payload, api) {
  if (api === "chat") {
    return payload?.choices?.[0]?.message?.content ?? null;
  }

  if (typeof payload?.output_text === "string" && payload.output_text) {
    return payload.output_text;
  }

  const message = payload?.output?.find((item) => item.type === "message");
  if (!message?.content) return null;

  const textPart = message.content.find((part) => part.type === "output_text");
  if (textPart?.text) return textPart.text;

  const first = message.content[0];
  if (typeof first?.text === "string") return first.text;

  return null;
}

function extractGeminiResponseText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .map((part) => part.text)
    .filter((value) => typeof value === "string" && value.trim())
    .join("");
  return text || null;
}

function extractProviderError(payload, provider) {
  if (provider === "gemini") {
    return payload?.error?.message || null;
  }
  return payload?.error?.message || null;
}

async function callVisionProvider(config, images, timeline, exposure) {
  const isGemini = config.provider === "gemini";
  const requestBody = isGemini
    ? buildGeminiRequestBody(config, images, timeline, exposure)
    : buildOpenAIRequestBody(config, images, timeline, exposure);

  const headers = {
    "Content-Type": "application/json",
  };

  if (isGemini) {
    headers["x-goog-api-key"] = config.apiKey;
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  const payload = await response.json();

  return { response, payload, isGemini };
}

export const maxDuration = 60;

export async function GET() {
  return Response.json({
    default_provider: defaultProvider(),
    available: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY),
    },
  });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON を解析できません。" }, { status: 400 });
  }

  const config = getConfig(body?.provider);

  if (!config.apiKey) {
    return Response.json(
      {
        error: `${config.apiKeyName} が .env.local に設定されていません。`,
      },
      { status: 500 },
    );
  }

  const images = Array.isArray(body?.images) ? body.images.slice(0, 5) : [];
  if (images.length === 0) {
    return Response.json({ error: "画像がありません。" }, { status: 400 });
  }

  const invalid = images.some(
    (image) => typeof image !== "string" || !image.startsWith("data:image/"),
  );
  if (invalid) {
    return Response.json(
      { error: "画像は data:image の Data URL である必要があります。" },
      { status: 400 },
    );
  }

  const timelineInput = sanitizeTimelineInput(body?.signal_timeline);
  const timeline = timelineInput ? summarizeTimeline(timelineInput) : null;
  const exposure = sanitizeExposureInfo(body?.camera_exposure);

  const started = Date.now();
  let providerResponse;
  try {
    providerResponse = await callVisionProvider(
      config,
      images,
      timeline,
      exposure,
    );
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : "API 呼び出しに失敗しました。";
    return Response.json({ error: message }, { status: 500 });
  }

  const { response, payload, isGemini } = providerResponse;
  const serverLatencyMs = Date.now() - started;

  if (!response.ok) {
    const providerLabel = isGemini ? "Gemini" : "OpenAI";
    return Response.json(
      {
        error:
          extractProviderError(payload, config.provider) ||
          `${providerLabel} API エラー (${response.status})`,
      },
      { status: response.status },
    );
  }

  const text = isGemini
    ? extractGeminiResponseText(payload)
    : extractOpenAIResponseText(payload, config.api);
  const result = applyTimelineSafety(
    normalizeResult(parseModelJson(text)),
    timeline,
  );
  const usage = normalizeUsage(
    isGemini ? payload?.usageMetadata : payload?.usage,
  );

  return Response.json({
    result,
    signal_timeline: timeline,
    camera_exposure: exposure,
    usage,
    provider: config.provider,
    model: config.model,
    api: config.api,
    endpoint: config.endpoint,
    cost_usd_estimate: estimateCostUsd(
      usage,
      config.inputUsdPerMillion,
      config.outputUsdPerMillion,
    ),
    server_latency_ms: serverLatencyMs,
  });
}
