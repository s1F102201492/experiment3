"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const CAPTURE_WIDTH = 768;
const JPEG_QUALITY = 0.65;
const BURST_COUNT = 5;
const BURST_GAP_MS = 250;

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export default function Home() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const videoObjectUrlRef = useRef(null);
  const runningRef = useRef(false);
  const analyzingRef = useRef(false);
  const intervalIdRef = useRef(null);

  const [source, setSource] = useState("camera");
  const [captureMode, setCaptureMode] = useState("interval");
  const [intervalMs, setIntervalMs] = useState(1500);
  const [videoName, setVideoName] = useState("");
  const [running, setRunning] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [lastResult, setLastResult] = useState(null);
  const [logs, setLogs] = useState([]);

  const stopCamera = useCallback(() => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
  }, []);

  const stopLoop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (intervalIdRef.current) {
      clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }
  }, []);

  useEffect(() => {
    const onVoices = () => window.speechSynthesis.getVoices();
    window.speechSynthesis?.addEventListener("voiceschanged", onVoices);
    return () => {
      window.speechSynthesis?.removeEventListener("voiceschanged", onVoices);
      stopLoop();
      stopCamera();
      if (videoObjectUrlRef.current) {
        URL.revokeObjectURL(videoObjectUrlRef.current);
      }
      window.speechSynthesis?.cancel();
    };
  }, [stopCamera, stopLoop]);

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

  const captureBurst = useCallback(async () => {
    const frames = [];
    for (let i = 0; i < BURST_COUNT; i += 1) {
      frames.push(captureFrame());
      if (i < BURST_COUNT - 1) await wait(BURST_GAP_MS);
    }
    return frames;
  }, [captureFrame]);

  const analyze = useCallback(
    async (modeOverride) => {
      if (analyzingRef.current) return;
      analyzingRef.current = true;
      setAnalyzing(true);
      setError("");

      const mode = modeOverride || captureMode;
      const started = performance.now();
      let frameCount = 0;

      try {
        const images =
          mode === "burst" ? await captureBurst() : [captureFrame()];
        frameCount = images.length;

        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images }),
        });
        const payload = await response.json();
        const latencyMs = Math.round(performance.now() - started);

        if (!response.ok) {
          throw new Error(payload.error || "解析に失敗しました。");
        }

        setLastResult({ ...payload, latencyMs, frameCount, mode });
        speakJapanese(payload.result.voice_message);

        setLogs((current) => [
          {
            timestamp: new Date().toISOString(),
            source,
            capture_mode: mode,
            frame_count: frameCount,
            latency_ms: latencyMs,
            server_latency_ms: payload.server_latency_ms,
            provider: payload.provider,
            model: payload.model,
            usage: payload.usage,
            cost_usd_estimate: payload.cost_usd_estimate,
            result: payload.result,
            video_name: source === "video" ? videoName : null,
          },
          ...current,
        ]);
      } catch (caught) {
        const latencyMs = Math.round(performance.now() - started);
        const message = caught instanceof Error ? caught.message : "不明なエラー";
        setError(message);
        speakJapanese("判定に失敗しました。止まってください。");
        setLogs((current) => [
          {
            timestamp: new Date().toISOString(),
            source,
            capture_mode: mode,
            frame_count: frameCount,
            latency_ms: latencyMs,
            error: message,
            video_name: source === "video" ? videoName : null,
          },
          ...current,
        ]);
      } finally {
        analyzingRef.current = false;
        setAnalyzing(false);
      }
    },
    [captureBurst, captureFrame, captureMode, source, videoName],
  );

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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "開始できません。");
      return;
    }

    speakJapanese("実験を開始します。");

    if (captureMode === "single") {
      await analyze("single");
      return;
    }

    runningRef.current = true;
    setRunning(true);
    await analyze(captureMode);

    intervalIdRef.current = setInterval(() => {
      if (!runningRef.current || analyzingRef.current) return;
      const video = videoRef.current;
      if (source === "video" && video?.ended) {
        stopLoop();
        speakJapanese("動画が終了しました。");
        return;
      }
      analyze(captureMode);
    }, Number(intervalMs));
  }, [analyze, captureMode, intervalMs, source, startCamera, stopLoop]);

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

  return (
    <div className="min-h-full bg-zinc-50 text-zinc-950 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-zinc-500">実験3</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            横断歩道ナビゲーション実験
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            カメラまたは保存動画のフレームを GPT-6 Luna または Gemini 3.8
            Flash で解析し、判定のたびに日本語で自動案内します。プロバイダは
            .env.local の LLM_PROVIDER で切り替えます。YOLO は使いません。
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

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">撮影モード</legend>
              <select
                className="rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
                value={captureMode}
                onChange={(event) => setCaptureMode(event.target.value)}
                disabled={running}
              >
                <option value="single">単発（1枚）</option>
                <option value="interval">定期（1枚ずつ）</option>
                <option value="burst">バースト（連続5枚）</option>
              </select>
              {captureMode !== "single" ? (
                <label className="text-sm text-zinc-600 dark:text-zinc-400">
                  間隔 {intervalMs} ms
                  <input
                    type="range"
                    min="500"
                    max="1500"
                    step="100"
                    value={intervalMs}
                    disabled={running}
                    className="mt-1 block w-full"
                    onChange={(event) =>
                      setIntervalMs(Number(event.target.value))
                    }
                  />
                </label>
              ) : null}
            </fieldset>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={startExperiment}
                disabled={analyzing || running}
                className="rounded-full bg-emerald-700 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {running ? "判定中…" : analyzing ? "解析中…" : "実験を開始"}
              </button>
              <button
                type="button"
                onClick={() => {
                  stopLoop();
                  videoRef.current?.pause();
                  window.speechSynthesis?.cancel();
                }}
                disabled={!running && !analyzing}
                className="rounded-full border border-zinc-300 px-5 py-2.5 text-sm dark:border-zinc-700 disabled:opacity-50"
              >
                停止
              </button>
            </div>
            <p className="text-xs leading-5 text-zinc-500">
              開始ボタンが最初の操作になり、以降の案内は自動再生されます。点滅・接近の評価にはバースト（5枚）を使ってください。
            </p>
          </div>
        </section>

        {error ? (
          <p className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        ) : null}

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
                    <th className="py-2 pr-3">モード</th>
                    <th className="py-2 pr-3">ms</th>
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
                      <td className="py-2 pr-3">{log.capture_mode}</td>
                      <td className="py-2 pr-3">{log.latency_ms}</td>
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
