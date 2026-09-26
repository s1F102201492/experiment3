const SYSTEM_PROMPT = `あなたは視覚障害者の道路横断を支援するアシスタントです。
提供された連続画像（直近の映像フレーム）を分析し、
以下の項目をJSON形式で出力してください。

{
  "signal_state": "red" | "green" | "blinking" | "unknown",
  "crosswalk_visible": true | false,
  "crosswalk_distance_estimate": "近い" | "中程度" | "遠い" | "不明",
  "approaching_hazard": "vehicle" | "bicycle" | "person" | "none",
  "hazard_distance_estimate": "近い" | "中程度" | "遠い" | "不明",
  "recommended_action": "GO" | "STOP" | "WAIT",
  "voice_message": "ユーザーに伝える短い日本語の音声案内文"
}

ルール:
- JSON以外は出力しない。
- 複数枚ある場合は時系列（古い順→新しい順）として扱い、信号の点滅と接近物の変化を優先して判断する。
- 1枚だけの場合、点滅はほぼ判定できないため signal_state は red / green / unknown を優先し、確信がなければ unknown にする。
- 距離はメートルではなく「近い」「中程度」「遠い」「不明」のみ。
- approaching_hazard はユーザーに最も危険な対象を1つ選ぶ。危険がなければ none。
- recommended_action は安全側に倒す。渡ってよいか不明なら WAIT または STOP。
- voice_message は1〜2文、口頭で聞いてすぐ理解できる短い日本語にする。recommended_action と矛盾させない。`;

const SIGNAL_STATES = new Set(["red", "green", "blinking", "unknown"]);
const DISTANCES = new Set(["近い", "中程度", "遠い", "不明"]);
const HAZARDS = new Set(["vehicle", "bicycle", "person", "none"]);
const ACTIONS = new Set(["GO", "STOP", "WAIT"]);

const INPUT_USD_PER_MILLION = 2.5;
const OUTPUT_USD_PER_MILLION = 10;

function fallbackResult(overrides = {}) {
  return {
    signal_state: "unknown",
    crosswalk_visible: false,
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

  return {
    signal_state: SIGNAL_STATES.has(raw.signal_state)
      ? raw.signal_state
      : "unknown",
    crosswalk_visible: Boolean(raw.crosswalk_visible),
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

function estimateCostUsd(usage) {
  const input = (usage?.prompt_tokens ?? 0) / 1_000_000 * INPUT_USD_PER_MILLION;
  const output =
    (usage?.completion_tokens ?? 0) / 1_000_000 * OUTPUT_USD_PER_MILLION;
  return Number((input + output).toFixed(6));
}

export const maxDuration = 60;

export async function POST(request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "OPENAI_API_KEY が .env.local に設定されていません。" },
      { status: 500 },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON を解析できません。" }, { status: 400 });
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

  const content = [
    {
      type: "text",
      text: `フレーム数: ${images.length}（古い順→新しい順）。道路横断の状況を分析してください。`,
    },
    ...images.map((url) => ({
      type: "image_url",
      image_url: { url, detail: "low" },
    })),
  ];

  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const started = Date.now();

  const openaiResponse = await fetch(
    "https://api.openai.iniad.org/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
      }),
    },
  );

  const payload = await openaiResponse.json();
  const serverLatencyMs = Date.now() - started;

  if (!openaiResponse.ok) {
    return Response.json(
      {
        error:
          payload?.error?.message ||
          `OpenAI API エラー (${openaiResponse.status})`,
      },
      { status: openaiResponse.status },
    );
  }

  const text = payload?.choices?.[0]?.message?.content;
  const result = normalizeResult(parseModelJson(text));
  const usage = payload?.usage ?? null;

  return Response.json({
    result,
    usage,
    model,
    cost_usd_estimate: estimateCostUsd(usage),
    server_latency_ms: serverLatencyMs,
  });
}
