"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createSignalDetector, MODEL_URL } from "@/lib/signalDetector";
import {
  FRAME_INTERVAL_MS,
  WINDOW_FRAMES,
  sanitizeTimelineInput,
  summarizeTimeline,
} from "@/lib/signalTimeline";

const CAPTURE_WIDTH = 768;
const JPEG_QUALITY = 0.65;
const ANALYZE_INTERVAL_MS = 1000;
const MIN_FRAMES_FOR_ANALYSIS = WINDOW_FRAMES / 2;
const REPEAT_SPEECH_MS = 4000;

function speakJapanese(text) {
  if (!text || typeof window === "undefined" || !window.speechSynthesis) {
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  utterance.rate = 1;
  const voice = window.speechSynthesis
    .getVoices()
    .find((item) => item.lang.startsWith("ja"));
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function measuredIntervalMs(frames) {
  if (frames.length < 2) return FRAME_INTERVAL_MS;
  const span = frames[frames.length - 1].at - frames[0].at;
  return Math.round(span / (frames.length - 1));
}

function buildTimelineInput(frames) {
  return {
    raw: frames.map((frame) => frame.state),
    colors: frames.map((frame) => frame.color),
    interval_ms: measuredIntervalMs(frames),
  };
}

const actionLabel = {
  GO: "進む",
  STOP: "止まる",
  WAIT: "待つ",
};

const pedestrianSignalLabel = {
  steady: "点灯",
  blinking: "点滅",
  not_visible: "見えない",
  unknown: "不明",
};

const verdictLabel = {
  blinking: "点滅",
  steady: "点灯",
  off: "消灯",
  unknown: "不明",
};

const detectionLabel = {
  signal_blue: "青点灯",
  signal_red: "赤点灯",
  signal_off: "消灯",
};

const detectorStatusLabel = {
  idle: "未読み込み",
  loading: "読み込み中…",
  ready: "準備完了",
  error: "読み込み失敗",
};

function formatStripeCount(count) {
  if (count === null || count === undefined) return "不明";
  return `約${count}本`;
}

function formatCountdown(result) {
  if (!result?.pedestrian_countdown_meter_present) {
    return "メーターなし";
  }
  const seconds = result.pedestrian_countdown_seconds_estimate;
  const coarse = result.pedestrian_countdown_estimate;
  if (seconds !== null && seconds !== undefined) {
    return `約${seconds}秒（${coarse}）`;
  }
  if (coarse && coarse !== "不明") {
    return `秒数不明（${coarse}）`;
  }
  return "メーターあり・残り不明";
}

function TimelineRow({ label, values }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs text-zinc-500">{label}</span>
      <div className="flex gap-0.5">
        {values.map((value, index) => (
          <span
            key={index}
            title={value === null ? "検出なし" : String(value)}
            className={`h-5 w-3 rounded-sm ${
              value === 1
                ? "bg-amber-400"
                : value === 0
                  ? "bg-zinc-700"
                  : "border border-dashed border-zinc-400"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const videoObjectUrlRef = useRef(null);
  const runningRef = useRef(false);
  const analyzingRef = useRef(false);
  const detectingRef = useRef(false);
  const detectorRef = useRef(null);
  const framesRef = useRef([]);
  const frameTimerRef = useRef(null);
  const analyzeTimerRef = useRef(null);
  const lastSpeechRef = useRef(null);

  const [source, setSource] = useState("camera");
  const [videoName, setVideoName] = useState("");
  const [running, setRunning] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [lastResult, setLastResult] = useState(null);
  const [logs, setLogs] = useState([]);
  const [detectorStatus, setDetectorStatus] = useState("idle");
  const [detectorBackend, setDetectorBackend] = useState("");
  const [latestDetection, setLatestDetection] = useState(null);
  const [liveTimeline, setLiveTimeline] = useState(null);

  const stopCamera = useCallback(() => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
  }, []);

  const stopLoop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (frameTimerRef.current) {
      clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
    if (analyzeTimerRef.current) {
      clearInterval(analyzeTimerRef.current);
      analyzeTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const onVoices = () => window.speechSynthesis.getVoices();
    window.speechSynthesis?.addEventListener("voiceschanged", onVoices);
    return () => {
      window.speechSynthesis?.removeEventListener("voiceschanged", onVoices);
      stopLoop();
      stopCamera();
      detectorRef.current?.release();
      detectorRef.current = null;
      if (videoObjectUrlRef.current) {
        URL.revokeObjectURL(videoObjectUrlRef.current);
      }
      window.speechSynthesis?.cancel();
    };
  }, [stopCamera, stopLoop]);

  const announce = useCallback((key, text) => {
    const last = lastSpeechRef.current;
    const now = Date.now();
    const changed = !last || last.key !== key;
    const idle =
      !window.speechSynthesis?.speaking &&
      now - (last?.at ?? 0) >= REPEAT_SPEECH_MS;
    if (!changed && !idle) return;
    speakJapanese(text);
    lastSpeechRef.current = { key, at: now };
  }, []);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      throw new Error("映像の準備ができていません。");
    }

    const scale = Math.min(1, CAPTURE_WIDTH / video.videoWidth || 1);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }, []);

  const ensureDetector = useCallback(async () => {
    if (detectorRef.current) return detectorRef.current;
    setDetectorStatus("loading");
    try {
      const detector = await createSignalDetector();
      detectorRef.current = detector;
      setDetectorBackend(detector.backend);
      setDetectorStatus("ready");
      return detector;
    } catch (caught) {
      setDetectorStatus("error");
      throw caught;
    }
  }, []);

  const detectTick = useCallback(async () => {
    if (!runningRef.current || detectingRef.current) return;
    const video = videoRef.current;
    const detector = detectorRef.current;
    if (!video || !detector || video.readyState < 2) return;

    if (source === "video" && video.ended) {
      stopLoop();
      speakJapanese("動画が終了しました。");
      return;
    }

    detectingRef.current = true;
    try {
      const detection = await detector.detect(video);
      const frames = [
        ...framesRef.current,
        { state: detection.state, color: detection.color, at: performance.now() },
      ].slice(-WINDOW_FRAMES);
      framesRef.current = frames;
      setLatestDetection(detection);
      const input = sanitizeTimelineInput(buildTimelineInput(frames));
      setLiveTimeline(input ? summarizeTimeline(input) : null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "YOLO の判定に失敗しました。",
      );
    } finally {
      detectingRef.current = false;
    }
  }, [source, stopLoop]);

  const analyze = useCallback(async () => {
    if (!runningRef.current || analyzingRef.current) return;
    if (framesRef.current.length < MIN_FRAMES_FOR_ANALYSIS) return;

    analyzingRef.current = true;
    setAnalyzing(true);
    const started = performance.now();
    const timelineInput = buildTimelineInput(framesRef.current);

    try {
      const images = [captureFrame()];
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, signal_timeline: timelineInput }),
      });
      const payload = await response.json();
      const latencyMs = Math.round(performance.now() - started);

      if (!response.ok) {
        throw new Error(payload.error || "解析に失敗しました。");
      }

      setLastResult({ ...payload, latencyMs });
      announce(
        `${payload.result.recommended_action}/${payload.result.pedestrian_signal_display}`,
        payload.result.voice_message,
      );

      setLogs((current) => [
        {
          timestamp: new Date().toISOString(),
          source,
          latency_ms: latencyMs,
          server_latency_ms: payload.server_latency_ms,
          provider: payload.provider,
          model: payload.model,
          usage: payload.usage,
          cost_usd_estimate: payload.cost_usd_estimate,
          signal_timeline: payload.signal_timeline,
          result: payload.result,
          video_name: source === "video" ? videoName : null,
        },
        ...current,
      ]);
    } catch (caught) {
      const latencyMs = Math.round(performance.now() - started);
      const message = caught instanceof Error ? caught.message : "不明なエラー";
      setError(message);
      announce("error", "判定に失敗しました。止まってください。");
      setLogs((current) => [
        {
          timestamp: new Date().toISOString(),
          source,
          latency_ms: latencyMs,
          signal_timeline: timelineInput,
          error: message,
          video_name: source === "video" ? videoName : null,
        },
        ...current,
      ]);
    } finally {
      analyzingRef.current = false;
      setAnalyzing(false);
    }
  }, [announce, captureFrame, source, videoName]);

  const startCamera = useCallback(async () => {
    stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    cameraStreamRef.current = stream;
    const video = videoRef.current;
    video.srcObject = stream;
    await video.play();
  }, [stopCamera]);

  const onVideoFile = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;

      stopLoop();
      stopCamera();
      if (videoObjectUrlRef.current) {
        URL.revokeObjectURL(videoObjectUrlRef.current);
      }

      const url = URL.createObjectURL(file);
      videoObjectUrlRef.current = url;
      setVideoName(file.name);
      setSource("video");

      const video = videoRef.current;
      video.srcObject = null;
      video.src = url;
      video.muted = true;
      await video.play().catch(() => {});
    },
    [stopCamera, stopLoop],
  );

  const switchToCamera = useCallback(async () => {
    stopLoop();
    setSource("camera");
    setVideoName("");
    const video = videoRef.current;
    video.removeAttribute("src");
    video.load();
    try {
      await startCamera();
      setError("");
    } catch {
      setError("カメラを利用できません。ブラウザの許可を確認してください。");
    }
  }, [startCamera, stopLoop]);

  const startExperiment = useCallback(async () => {
    setError("");
    window.speechSynthesis?.getVoices();

    try {
      if (source === "camera" && !cameraStreamRef.current) {
        await startCamera();
      }
      const video = videoRef.current;
      if (source === "video") {
        if (!video.src) {
          throw new Error("先に動画ファイルを選んでください。");
        }
        video.muted = true;
        await video.play();
      }
      await ensureDetector();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "開始できません。");
      return;
    }

    framesRef.current = [];
    setLatestDetection(null);
    setLiveTimeline(null);
    speakJapanese("実験を開始します。");
    lastSpeechRef.current = { key: "start", at: Date.now() };

    runningRef.current = true;
    setRunning(true);
    frameTimerRef.current = setInterval(detectTick, FRAME_INTERVAL_MS);
    analyzeTimerRef.current = setInterval(analyze, ANALYZE_INTERVAL_MS);
  }, [analyze, detectTick, ensureDetector, source, startCamera]);

  const resultTimeline = lastResult?.signal_timeline;

  return (
    <div className="min-h-full bg-zinc-50 text-zinc-950 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-zinc-500">実験3</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            横断歩道ナビゲーション実験
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            0.1秒ごとに YOLO26n（ブラウザ内）で歩行者信号の点灯・消灯を判定し、
            カメラのちらつきを除いた直近2秒分の結果と最新フレームを GPT-6 Luna
            または Gemini 3.8 Flash に渡して、1秒ごとに日本語で案内します。
            プロバイダは .env.local の LLM_PROVIDER で切り替えます。
          </p>
        </header>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-black dark:border-zinc-800">
            <video
              ref={videoRef}
              className="aspect-video w-full bg-black object-contain"
              playsInline
              muted
              controls={source === "video"}
            />
            <canvas ref={canvasRef} className="hidden" />
          </div>

          <div className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">入力</legend>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`rounded-full px-4 py-2 text-sm ${
                    source === "camera"
                      ? "bg-zinc-950 text-white dark:bg-white dark:text-black"
                      : "border border-zinc-300 dark:border-zinc-700"
                  }`}
                  onClick={switchToCamera}
                >
                  ライブカメラ
                </button>
                <label className="cursor-pointer rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700">
                  動画を選ぶ
                  <input
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={onVideoFile}
                  />
                </label>
              </div>
              {videoName ? (
                <p className="text-xs text-zinc-500">{videoName}</p>
              ) : null}
            </fieldset>

            <div className="flex flex-col gap-1 text-sm">
              <p className="font-medium">YOLO 信号判定</p>
              <p className="text-zinc-600 dark:text-zinc-400">
                モデル: {detectorStatusLabel[detectorStatus]}
                {detectorBackend ? `（${detectorBackend}）` : ""}
              </p>
              <p className="text-zinc-600 dark:text-zinc-400">
                判定間隔: {FRAME_INTERVAL_MS} ms 固定 ／ 実測{" "}
                {liveTimeline ? `${liveTimeline.interval_ms} ms` : "—"}
              </p>
              {liveTimeline && liveTimeline.interval_ms > FRAME_INTERVAL_MS * 1.3 ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  推論が間に合っていません。ちらつき判定の精度が下がります。
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={startExperiment}
                disabled={running || detectorStatus === "loading"}
                className="rounded-full bg-emerald-700 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {running
                  ? analyzing
                    ? "解析中…"
                    : "判定中…"
                  : detectorStatus === "loading"
                    ? "モデル読み込み中…"
                    : "実験を開始"}
              </button>
              <button
                type="button"
                onClick={() => {
                  stopLoop();
                  videoRef.current?.pause();
                  window.speechSynthesis?.cancel();
                }}
                disabled={!running}
                className="rounded-full border border-zinc-300 px-5 py-2.5 text-sm dark:border-zinc-700 disabled:opacity-50"
              >
                停止
              </button>
            </div>
            <p className="text-xs leading-5 text-zinc-500">
              開始ボタンが最初の操作になり、以降の案内は自動再生されます。モデルは{" "}
              {MODEL_URL} から読み込みます。
            </p>
          </div>
        </section>

        {error ? (
          <p className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        ) : null}

        <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-lg font-medium">信号点灯タイムライン（直近2秒）</h2>
          {liveTimeline ? (
            <div className="mt-3 flex flex-col gap-2">
              <TimelineRow label="検出そのまま" values={liveTimeline.raw} />
              <TimelineRow label="ちらつき除去" values={liveTimeline.smoothed} />
              <div className="mt-1 grid gap-1 text-sm sm:grid-cols-2">
                <p>
                  最新フレーム:{" "}
                  {latestDetection?.label
                    ? `${detectionLabel[latestDetection.label]}（${latestDetection.score}）`
                    : "検出なし"}
                </p>
                <p>判定: {verdictLabel[liveTimeline.verdict]}</p>
                <p>色: {liveTimeline.dominant_color}</p>
                <p>検出率: {Math.round(liveTimeline.detected_ratio * 100)}%</p>
                <p>除去したちらつき: {liveTimeline.flicker_frames_removed}フレーム</p>
                <p>最長の消灯: {liveTimeline.longest_off_run_ms} ms</p>
              </div>
              <p className="text-xs text-zinc-500">
                黄=点灯、灰=消灯、点線=検出なし。点灯に挟まれた0.2秒以下の消灯をちらつきとして点灯に置き換えます。
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">まだ判定はありません。</p>
          )}
        </section>

        <section
          aria-live="polite"
          className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <h2 className="text-lg font-medium">最新の判定</h2>
          {lastResult ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <p className="sm:col-span-2 text-xl font-semibold">
                {lastResult.result.voice_message}
              </p>
              <p>推奨: {actionLabel[lastResult.result.recommended_action]}</p>
              <p>信号: {lastResult.result.signal_state}</p>
              <p>
                歩行者信号:{" "}
                {pedestrianSignalLabel[lastResult.result.pedestrian_signal_display] ??
                  lastResult.result.pedestrian_signal_display}
              </p>
              <p>
                YOLO 判定:{" "}
                {resultTimeline ? verdictLabel[resultTimeline.verdict] : "なし"}
              </p>
              <p>残り時間メーター: {formatCountdown(lastResult.result)}</p>
              <p>
                横断歩道:{" "}
                {lastResult.result.crosswalk_visible ? "あり" : "なし"}（
                {lastResult.result.crosswalk_distance_estimate}）
              </p>
              <p>
                横断歩道の帯:{" "}
                {formatStripeCount(
                  lastResult.result.crosswalk_stripe_count_estimate,
                )}
                ／範囲 {lastResult.result.crosswalk_stripe_extent}
              </p>
              <p>
                危険: {lastResult.result.approaching_hazard}（
                {lastResult.result.hazard_distance_estimate}）
              </p>
              <p>
                モデル: {lastResult.provider ?? "—"} / {lastResult.model ?? "—"}
              </p>
              <p>レイテンシ: {lastResult.latencyMs} ms</p>
              <p>
                推定コスト: ${lastResult.cost_usd_estimate?.toFixed(6)} / 回
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">まだ判定はありません。</p>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-medium">実験ログ（{logs.length}件）</h2>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
                onClick={() =>
                  downloadJson(
                    `crosswalk-experiment-${Date.now()}.json`,
                    logs,
                  )
                }
                disabled={logs.length === 0}
              >
                JSONを保存
              </button>
              <button
                type="button"
                className="rounded-full border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
                onClick={() => setLogs([])}
                disabled={logs.length === 0}
              >
                ログを消去
              </button>
            </div>
          </div>
          <div className="mt-3 max-h-80 overflow-auto text-xs">
            {logs.length === 0 ? (
              <p className="text-zinc-500">ログはまだありません。</p>
            ) : (
              <table className="w-full min-w-[1020px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-800">
                    <th className="py-2 pr-3">時刻</th>
                    <th className="py-2 pr-3">入力</th>
                    <th className="py-2 pr-3">ms</th>
                    <th className="py-2 pr-3">YOLO判定</th>
                    <th className="py-2 pr-3">信号</th>
                    <th className="py-2 pr-3">歩行者信号</th>
                    <th className="py-2 pr-3">残りメーター</th>
                    <th className="py-2 pr-3">横断歩道の帯</th>
                    <th className="py-2 pr-3">案内</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr
                      key={log.timestamp + String(log.latency_ms)}
                      className="border-b border-zinc-100 dark:border-zinc-900"
                    >
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {log.timestamp.replace("T", " ").slice(11, 19)}
                      </td>
                      <td className="py-2 pr-3">{log.source}</td>
                      <td className="py-2 pr-3">{log.latency_ms}</td>
                      <td className="py-2 pr-3">
                        {log.signal_timeline?.verdict
                          ? verdictLabel[log.signal_timeline.verdict]
                          : "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {log.result?.signal_state || log.error || "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {log.result
                          ? pedestrianSignalLabel[
                              log.result.pedestrian_signal_display
                            ] ?? log.result.pedestrian_signal_display
                          : "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {log.result ? formatCountdown(log.result) : "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {log.result
                          ? `${formatStripeCount(log.result.crosswalk_stripe_count_estimate)} / ${log.result.crosswalk_stripe_extent}`
                          : "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {log.result?.voice_message || log.error}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
