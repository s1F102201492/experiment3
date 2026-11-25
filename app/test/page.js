"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MANUAL_SHUTTERS,
  applyDeviceExposure,
  applyManualExposure,
  NIGHT_SCENE_LEVEL,
  calibrateForScene,
  exposureTimeToShutter,
  formatShutter,
  isFlickerSafe,
  isShutterSupported,
  readExposureSupport,
} from "@/lib/cameraExposure";
import { combineSignalJudgement, measureLamps } from "@/lib/lampPosition";
import { LLM_PROVIDERS, useLlmProvider } from "@/lib/llmProvider";
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
const EXPOSURE_POLL_MS = 500;
const EXPOSURE_HISTORY = 60;
const MANUAL_VERIFY_DELAY_MS = 500;
const MANUAL_TOLERANCE = 0.05;

function isClose(actual, requested) {
  if (!actual || !requested) return false;
  return Math.abs(actual - requested) / requested <= MANUAL_TOLERANCE;
}

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

const judgeMethodLabel = {
  yolo: "YOLO のクラス",
  position: "位置と明るさ",
  none: "検出なし",
};

const sceneLabel = {
  day: "昼",
  night: "夜",
};

const exposureModeLabel = {
  calibrate: "自動調整",
  manual: "手動",
  device: "端末おまかせ",
};

function shutterRangeText(range) {
  if (!range) return "—";
  return `${formatShutter(Math.round(10000 / range.max))}〜${formatShutter(
    Math.round(10000 / range.min),
  )}`;
}

function formatJudgement(judgement) {
  if (!judgement || judgement.state === null) return "判定できず";
  if (judgement.state === 0) return "消灯";
  return judgement.color === "red" ? "赤点灯" : "青点灯";
}

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

const trackExposureModeLabel = {
  manual: "手動",
  continuous: "自動",
  "single-shot": "単発自動",
  none: "なし",
};

function ExposureChart({ label, values, format }) {
  const present = values.filter((value) => value !== null);
  const latest = values.at(-1) ?? null;
  const min = present.length ? Math.min(...present) : null;
  const max = present.length ? Math.max(...present) : null;
  const span = max - min || 1;
  const step = 100 / Math.max(1, EXPOSURE_HISTORY - 1);
  const offset = EXPOSURE_HISTORY - values.length;
  const points = values
    .map((value, index) =>
      value === null
        ? null
        : `${(offset + index) * step},${max === min ? 20 : 36 - ((value - min) / span) * 32}`,
    )
    .filter(Boolean)
    .join(" ");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-zinc-500">{label}</span>
        <span className="font-mono text-base font-semibold">
          {latest === null ? "—" : format(latest)}
        </span>
      </div>
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="h-14 w-full rounded-lg bg-zinc-100 dark:bg-zinc-900"
      >
        {points ? (
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            className="text-sky-600 dark:text-sky-400"
          />
        ) : null}
      </svg>
      <p className="text-xs text-zinc-500">
        最小 {min === null ? "—" : format(min)} ／ 最大{" "}
        {max === null ? "—" : format(max)}
      </p>
    </div>
  );
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

export default function TestPage() {
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
  const appliedExposureRef = useRef(null);
  const calibratingRef = useRef(false);

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
  const [exposureSupport, setExposureSupport] = useState(null);
  const [exposureMode, setExposureMode] = useState("calibrate");
  const [calibrationScene, setCalibrationScene] = useState("auto");
  const [manualCheck, setManualCheck] = useState(null);
  const [manualShutter, setManualShutter] = useState(100);
  const [manualIso, setManualIso] = useState(null);
  const [appliedExposure, setAppliedExposure] = useState(null);
  const [calibration, setCalibration] = useState({
    status: "idle",
    steps: [],
    message: "",
  });
  const { provider, providerRef, setProvider, available } = useLlmProvider();
  const [exposureHistory, setExposureHistory] = useState([]);
  const liveExposure = exposureHistory.at(-1) ?? null;

  const updateAppliedExposure = useCallback((value) => {
    appliedExposureRef.current = value;
    setAppliedExposure(value);
  }, []);

  const stopCamera = useCallback(() => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    setExposureSupport(null);
    setExposureHistory([]);
    setManualCheck(null);
    updateAppliedExposure(null);
  }, [updateAppliedExposure]);

  useEffect(() => {
    if (!exposureSupport) return undefined;
    const timer = setInterval(() => {
      const settings = cameraStreamRef.current?.getVideoTracks()[0]?.getSettings();
      if (!settings) return;
      const sample = {
        mode: settings.exposureMode ?? null,
        shutter: exposureTimeToShutter(settings.exposureTime),
        iso: settings.iso ?? null,
      };
      setExposureHistory((current) =>
        [...current, sample].slice(-EXPOSURE_HISTORY),
      );
    }, EXPOSURE_POLL_MS);
    return () => clearInterval(timer);
  }, [exposureSupport]);

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

  const sampleFrame = useCallback(async () => {
    const video = videoRef.current;
    const detection = await detectorRef.current.detect(video);
    const measurement = measureLamps(video, detection.box);
    const judgement = combineSignalJudgement(detection, measurement);
    return { detection, measurement, position: judgement.position, judgement };
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
      const sample = await sampleFrame();
      const frames = [
        ...framesRef.current,
        {
          state: sample.judgement.state,
          color: sample.judgement.color,
          at: performance.now(),
        },
      ].slice(-WINDOW_FRAMES);
      framesRef.current = frames;
      setLatestDetection(sample);
      const input = sanitizeTimelineInput(buildTimelineInput(frames));
      setLiveTimeline(input ? summarizeTimeline(input) : null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "YOLO の判定に失敗しました。",
      );
    } finally {
      detectingRef.current = false;
    }
  }, [sampleFrame, source, stopLoop]);

  const analyze = useCallback(async () => {
    if (!runningRef.current || analyzingRef.current) return;
    if (framesRef.current.length < MIN_FRAMES_FOR_ANALYSIS) return;

    analyzingRef.current = true;
    setAnalyzing(true);
    const started = performance.now();
    const timelineInput = buildTimelineInput(framesRef.current);
    const cameraExposure = appliedExposureRef.current;

    try {
      const images = [captureFrame()];
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerRef.current,
          images,
          signal_timeline: timelineInput,
          camera_exposure: cameraExposure,
        }),
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
          camera_exposure: payload.camera_exposure,
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
          camera_exposure: cameraExposure,
          error: message,
          video_name: source === "video" ? videoName : null,
        },
        ...current,
      ]);
    } finally {
      analyzingRef.current = false;
      setAnalyzing(false);
    }
  }, [announce, captureFrame, providerRef, source, videoName]);

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

    const support = readExposureSupport(stream.getVideoTracks()[0]);
    setExposureSupport(support);
    setManualIso(support.iso?.min ?? null);
    if (!support.manualExposure) setExposureMode("device");
  }, [stopCamera]);

  const runCalibration = useCallback(async () => {
    if (calibratingRef.current) return null;
    const track = cameraStreamRef.current?.getVideoTracks()[0];
    const support = track ? readExposureSupport(track) : null;
    if (!track || !support?.manualExposure) {
      throw new Error("この端末のカメラは露光時間の手動設定に対応していません。");
    }
    await ensureDetector();

    calibratingRef.current = true;
    setCalibration({ status: "running", steps: [], message: "" });
    try {
      const result = await calibrateForScene({
        scene: calibrationScene,
        video: videoRef.current,
        track,
        support,
        sampleFrame,
        onStep: (step) =>
          setCalibration((current) => ({
            ...current,
            steps: [...current.steps, step],
          })),
      });
      if (result.applied) updateAppliedExposure(result.applied);
      const night = result.scene === "night";
      const setting = `${formatShutter(result.applied?.shutter)}・ISO ${result.applied?.iso ?? "—"}`;
      const outcome = result.ok
        ? `${setting} で灯火を判定できました。`
        : result.reason === "no_signal"
          ? night
            ? "どの ISO でも歩行者信号を検出できませんでした。端末おまかせに戻しました。"
            : "歩行者信号が映っていないため調整できませんでした。1/100秒に戻しました。"
          : `どの設定でも判定が安定しませんでした。いちばん良かった ${setting} にしました。`;
      const sceneText =
        result.brightness === null
          ? `${sceneLabel[result.scene]}用の調整（手動指定）`
          : `明るさ ${result.brightness}（${NIGHT_SCENE_LEVEL} 未満で夜）→ ${sceneLabel[result.scene]}用の調整`;
      setCalibration((current) => ({
        ...current,
        status: result.ok ? "done" : "failed",
        message: `${sceneText}。${outcome}`,
      }));
      return result;
    } finally {
      calibratingRef.current = false;
    }
  }, [calibrationScene, ensureDetector, sampleFrame, updateAppliedExposure]);

  const applyExposureSettings = useCallback(
    async (mode) => {
      const track = cameraStreamRef.current?.getVideoTracks()[0];
      if (!track) throw new Error("先にカメラを起動してください。");
      const support = readExposureSupport(track);
      if (mode !== "manual") setManualCheck(null);
      if (mode === "calibrate") {
        await runCalibration();
      } else if (mode === "manual") {
        const requested = {
          shutter: manualShutter,
          iso: support.iso ? manualIso : null,
        };
        setManualCheck({ status: "applying", requested });
        try {
          updateAppliedExposure(
            await applyManualExposure(track, support, requested),
          );
          await new Promise((resolve) =>
            setTimeout(resolve, MANUAL_VERIFY_DELAY_MS),
          );
          const settings = track.getSettings();
          const actual = {
            mode: settings.exposureMode ?? null,
            shutter: exposureTimeToShutter(settings.exposureTime),
            iso: settings.iso ?? null,
          };
          const matched =
            actual.mode === "manual" &&
            isClose(actual.shutter, requested.shutter) &&
            (requested.iso === null || isClose(actual.iso, requested.iso));
          setManualCheck({
            status: matched ? "applied" : "mismatch",
            requested,
            actual,
            at: new Date().toLocaleTimeString("ja-JP"),
          });
        } catch (caught) {
          setManualCheck({ status: "error", requested });
          throw caught;
        }
      } else {
        updateAppliedExposure(await applyDeviceExposure(track, support));
      }
      setExposureSupport(readExposureSupport(track));
    },
    [manualIso, manualShutter, runCalibration, updateAppliedExposure],
  );

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
      if (source === "camera") {
        const track = cameraStreamRef.current?.getVideoTracks()[0];
        const mode = readExposureSupport(track).manualExposure
          ? exposureMode
          : "device";
        if (mode === "calibrate") speakJapanese("露光を調整しています。");
        await applyExposureSettings(mode);
      }
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
  }, [
    analyze,
    applyExposureSettings,
    detectTick,
    ensureDetector,
    exposureMode,
    source,
    startCamera,
  ]);

  const resultTimeline = lastResult?.signal_timeline;
  const manualPending =
    exposureMode === "manual" &&
    Boolean(exposureSupport?.manualExposure) &&
    (!manualCheck ||
      manualCheck.requested.shutter !== manualShutter ||
      (Boolean(exposureSupport.iso) && manualCheck.requested.iso !== manualIso));
  const formatExposurePair = (value) =>
    `${formatShutter(value?.shutter)}・ISO ${value?.iso ?? "—"}`;

  return (
    <div className="min-h-full bg-zinc-50 text-zinc-950 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-zinc-500">実験3</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            横断歩道ナビゲーション実験
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            カメラの露光時間と ISO を調整してちらつきと白飛びを抑え、0.1秒ごとに
            YOLO26n（ブラウザ内）と信号機の上下の明るさで歩行者信号の点灯・消灯を判定します。
            直近2秒分の結果と最新フレームを GPT-6 Luna または Gemini 3.8 Flash
            に渡して、1秒ごとに日本語で案内します。プロバイダは下の「AI モデル」で切り替えます（未選択なら
            .env.local の LLM_PROVIDER）。
          </p>
        </header>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-black dark:border-zinc-800">
              <video
                ref={videoRef}
                className="aspect-video w-full bg-black object-contain"
                playsInline
                muted
                controls={source === "video"}
              />
              {source === "camera" && liveExposure ? (
                <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap gap-2 font-mono text-white">
                  <span
                    className={`rounded-lg px-3 py-1.5 text-lg font-semibold ${
                      liveExposure.shutter && !isFlickerSafe(liveExposure.shutter)
                        ? "bg-amber-600/85"
                        : "bg-black/70"
                    }`}
                  >
                    SS {formatShutter(liveExposure.shutter)}
                  </span>
                  <span className="rounded-lg bg-black/70 px-3 py-1.5 text-lg font-semibold">
                    ISO {liveExposure.iso ?? "—"}
                  </span>
                  <span className="self-center rounded-lg bg-black/70 px-2 py-1 text-xs">
                    {trackExposureModeLabel[liveExposure.mode] ??
                      liveExposure.mode ??
                      "モード不明"}
                  </span>
                </div>
              ) : null}
              <canvas ref={canvasRef} className="hidden" />
            </div>

            {source === "camera" && exposureHistory.length > 0 ? (
              <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                <h2 className="text-sm font-medium">
                  カメラの実際の露光（直近
                  {(EXPOSURE_HISTORY * EXPOSURE_POLL_MS) / 1000}秒）
                </h2>
                <div className="mt-2 grid gap-4 sm:grid-cols-2">
                  <ExposureChart
                    label="シャッタースピード（上ほど短い）"
                    values={exposureHistory.map((sample) => sample.shutter)}
                    format={formatShutter}
                  />
                  <ExposureChart
                    label="ISO 感度"
                    values={exposureHistory.map((sample) => sample.iso)}
                    format={(iso) => `ISO ${iso}`}
                  />
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  {EXPOSURE_POLL_MS} ms ごとにカメラから読み取った値です。1/120秒より短いシャッターは橙色で表示します。
                </p>
              </div>
            ) : null}
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
              <legend className="text-sm font-medium">AI モデル</legend>
              <div className="flex flex-wrap gap-2">
                {LLM_PROVIDERS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={provider === item.id}
                    className={`rounded-full px-4 py-2 text-sm ${
                      provider === item.id
                        ? "bg-zinc-950 text-white dark:bg-white dark:text-black"
                        : "border border-zinc-300 dark:border-zinc-700"
                    }`}
                    onClick={() => setProvider(item.id)}
                  >
                    {item.label}
                    {available && !available[item.id] ? "（キー未設定）" : ""}
                  </button>
                ))}
              </div>
              <p className="text-xs text-zinc-500">
                実行中に切り替えると次の解析から反映されます。ここでの選択はホームの案内にも使われます。
              </p>
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
                  推論が間に合っていません。点滅判定の精度が下がります。
                </p>
              ) : null}
            </div>

            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="font-medium">露光設定（Android）</legend>
              {source !== "camera" ? (
                <p className="text-zinc-500">動画ファイルでは使えません。</p>
              ) : !exposureSupport ? (
                <p className="text-zinc-500">
                  カメラを起動すると対応状況を表示します。
                </p>
              ) : !exposureSupport.manualExposure ? (
                <p className="text-amber-700 dark:text-amber-400">
                  この端末・ブラウザは露光時間の手動設定に対応していません。端末おまかせで動作します。
                </p>
              ) : (
                <>
                  <p className="text-zinc-600 dark:text-zinc-400">
                    対応範囲: シャッター {shutterRangeText(exposureSupport.exposureTime)}
                    {exposureSupport.iso
                      ? ` ／ ISO ${exposureSupport.iso.min}〜${exposureSupport.iso.max}`
                      : " ／ ISO 設定なし"}
                  </p>
                  <select
                    className="rounded-lg border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
                    value={exposureMode}
                    onChange={(event) => setExposureMode(event.target.value)}
                    disabled={running || calibration.status === "running"}
                  >
                    <option value="calibrate">自動調整</option>
                    <option value="manual">手動</option>
                    <option value="device">端末おまかせ（自動露出）</option>
                  </select>
                  {exposureMode === "calibrate" ? (
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap gap-2">
                        {[
                          ["auto", "昼夜を自動判定"],
                          ["day", "昼"],
                          ["night", "夜"],
                        ].map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={calibrationScene === value}
                            disabled={running || calibration.status === "running"}
                            className={`rounded-full px-3 py-1.5 text-xs disabled:opacity-50 ${
                              calibrationScene === value
                                ? "bg-zinc-950 text-white dark:bg-white dark:text-black"
                                : "border border-zinc-300 dark:border-zinc-700"
                            }`}
                            onClick={() => setCalibrationScene(value)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-zinc-500">
                        昼: ISO 最低で 1/100秒から短くしてちらつきと白飛びを抑える。夜: 1/100秒のまま ISO を上げ、YOLO が信号を検出できる明るさを探す（見つからなければ 1/60・1/30秒も試す）。
                      </p>
                    </div>
                  ) : null}
                  {exposureMode === "manual" ? (
                    <div className="flex flex-col gap-2">
                      <label className="flex items-center gap-2">
                        シャッター
                        <select
                          className="rounded-lg border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
                          value={manualShutter}
                          onChange={(event) =>
                            setManualShutter(Number(event.target.value))
                          }
                        >
                          {MANUAL_SHUTTERS.filter((shutter) =>
                            isShutterSupported(exposureSupport, shutter),
                          ).map((shutter) => (
                            <option key={shutter} value={shutter}>
                              {formatShutter(shutter)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {exposureSupport.iso ? (
                        <label className="text-zinc-600 dark:text-zinc-400">
                          ISO {manualIso}
                          <input
                            type="range"
                            min={exposureSupport.iso.min}
                            max={exposureSupport.iso.max}
                            step={exposureSupport.iso.step || 1}
                            value={manualIso ?? exposureSupport.iso.min}
                            className="mt-1 block w-full"
                            onChange={(event) =>
                              setManualIso(Number(event.target.value))
                            }
                          />
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className={`self-start rounded-full px-4 py-2 disabled:opacity-50 ${
                      manualPending
                        ? "bg-emerald-700 font-medium text-white"
                        : "border border-zinc-300 dark:border-zinc-700"
                    }`}
                    disabled={
                      calibration.status === "running" ||
                      manualCheck?.status === "applying" ||
                      (running && exposureMode === "calibrate")
                    }
                    onClick={() =>
                      applyExposureSettings(exposureMode).catch((caught) =>
                        setError(
                          caught instanceof Error
                            ? caught.message
                            : "露光を設定できません。",
                        ),
                      )
                    }
                  >
                    {calibration.status === "running"
                      ? "調整中…"
                      : manualCheck?.status === "applying"
                        ? "適用中…"
                        : exposureMode === "calibrate"
                          ? "今すぐ自動調整"
                          : "設定を適用"}
                  </button>
                  {exposureMode === "manual" ? (
                    <div aria-live="polite" className="text-xs">
                      {manualCheck?.status === "applying" ? (
                        <p className="text-zinc-500">カメラに設定しています…</p>
                      ) : manualPending ? (
                        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                          {manualCheck
                            ? `まだ適用されていない変更があります（${formatExposurePair({ shutter: manualShutter, iso: exposureSupport.iso ? manualIso : null })}）。「設定を適用」を押してください。`
                            : "まだ適用していません。値を選んで「設定を適用」を押してください。"}
                        </p>
                      ) : manualCheck?.status === "applied" ? (
                        <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                          ✓ 適用されました（{manualCheck.at}）
                          <br />
                          カメラの実際の値: {formatExposurePair(manualCheck.actual)}
                        </p>
                      ) : manualCheck?.status === "mismatch" ? (
                        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                          ⚠ 要求どおりになっていません（{manualCheck.at}）
                          <br />
                          要求: {formatExposurePair(manualCheck.requested)} ／ 実際:{" "}
                          {formatExposurePair(manualCheck.actual)}
                          {manualCheck.actual.mode !== "manual"
                            ? `（カメラの露出モードが「${trackExposureModeLabel[manualCheck.actual.mode] ?? manualCheck.actual.mode ?? "不明"}」のままです）`
                            : ""}
                        </p>
                      ) : manualCheck?.status === "error" ? (
                        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                          適用に失敗しました（{formatExposurePair(manualCheck.requested)}）。
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="text-zinc-600 dark:text-zinc-400">
                    現在:{" "}
                    {appliedExposure
                      ? `${exposureModeLabel[appliedExposure.mode]}${appliedExposure.scene ? `（${sceneLabel[appliedExposure.scene]}）` : ""} ／ ${formatShutter(appliedExposure.shutter)} ／ ISO ${appliedExposure.iso ?? "—"}`
                      : "未設定"}
                  </p>
                  {appliedExposure?.shutter &&
                  !isFlickerSafe(appliedExposure.shutter) ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      1/120秒より短いため、LED のちらつきが映る可能性があります。
                    </p>
                  ) : null}
                  {calibration.message ? (
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">
                      {calibration.message}
                    </p>
                  ) : null}
                  {calibration.steps.length > 0 ? (
                    <table className="text-xs">
                      <thead>
                        <tr className="text-left text-zinc-500">
                          <th className="pr-2">シャッター</th>
                          <th className="pr-2">ISO</th>
                          <th className="pr-2">検出</th>
                          <th className="pr-2">判定可/点灯</th>
                          <th className="pr-2">明暗比</th>
                          <th>白飛び</th>
                        </tr>
                      </thead>
                      <tbody>
                        {calibration.steps.map((step, index) => (
                          <tr key={index}>
                            <td className="pr-2">{formatShutter(step.shutter)}</td>
                            <td className="pr-2">{step.iso ?? "—"}</td>
                            <td className="pr-2">{step.found}</td>
                            <td className="pr-2">
                              {step.judgeable}/{step.lit}
                            </td>
                            <td className="pr-2">{step.contrast ?? "—"}</td>
                            <td>
                              {step.clipped_ratio === null
                                ? "—"
                                : `${Math.round(step.clipped_ratio * 100)}%`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                </>
              )}
            </fieldset>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={startExperiment}
                disabled={
                  running ||
                  detectorStatus === "loading" ||
                  calibration.status === "running"
                }
                className="rounded-full bg-emerald-700 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {running
                  ? analyzing
                    ? "解析中…"
                    : "判定中…"
                  : detectorStatus === "loading"
                    ? "モデル読み込み中…"
                    : calibration.status === "running"
                      ? "露光を調整中…"
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
              <TimelineRow label="判定結果" values={liveTimeline.raw} />
              <div className="mt-1 grid gap-1 text-sm sm:grid-cols-2">
                <p>
                  最新フレーム: {formatJudgement(latestDetection?.judgement)}（
                  {judgeMethodLabel[latestDetection?.judgement.method ?? "none"]}）
                </p>
                <p>
                  YOLO:{" "}
                  {latestDetection?.detection.label
                    ? `${detectionLabel[latestDetection.detection.label]}（${latestDetection.detection.score}）`
                    : "検出なし"}
                </p>
                <p>
                  上下の明るさ:{" "}
                  {latestDetection?.measurement
                    ? `上 ${latestDetection.measurement.top_level} ／ 下 ${latestDetection.measurement.bottom_level}（明暗比 ${latestDetection.measurement.contrast}）`
                    : "—"}
                </p>
                <p>
                  位置での判定: {formatJudgement(latestDetection?.position)}
                  {latestDetection?.measurement
                    ? ` ／ 白飛び ${Math.round(latestDetection.measurement.clipped_ratio * 100)}%`
                    : ""}
                </p>
                <p>判定: {verdictLabel[liveTimeline.verdict]}</p>
                <p>色: {liveTimeline.dominant_color}</p>
                <p>検出率: {Math.round(liveTimeline.detected_ratio * 100)}%</p>
                <p>最長の消灯: {liveTimeline.longest_off_run_ms} ms</p>
              </div>
              <p className="text-xs text-zinc-500">
                黄=点灯、灰=消灯、点線=検出なし・判定できず。YOLO の確信度が0.6以上ならクラスで、未満なら信号機の上半分（赤）と下半分（青）の明るさで判定します。
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
                    <th className="py-2 pr-3">露光</th>
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
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {log.camera_exposure
                          ? `${log.camera_exposure.scene ? `${sceneLabel[log.camera_exposure.scene]} ` : ""}${formatShutter(log.camera_exposure.shutter)} / ISO ${log.camera_exposure.iso ?? "—"}`
                          : "—"}
                      </td>
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
