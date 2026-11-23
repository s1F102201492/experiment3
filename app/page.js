"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyDeviceExposure,
  calibrateExposure,
  readExposureSupport,
} from "@/lib/cameraExposure";
import { combineSignalJudgement, measureLamps } from "@/lib/lampPosition";
import { useLlmProvider } from "@/lib/llmProvider";
import { createSignalDetector } from "@/lib/signalDetector";
import { FRAME_INTERVAL_MS, WINDOW_FRAMES } from "@/lib/signalTimeline";

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

function vibrate(pattern) {
  navigator.vibrate?.(pattern);
}

function buildTimelineInput(frames) {
  const interval =
    frames.length < 2
      ? FRAME_INTERVAL_MS
      : Math.round(
          (frames[frames.length - 1].at - frames[0].at) / (frames.length - 1),
        );
  return {
    raw: frames.map((frame) => frame.state),
    colors: frames.map((frame) => frame.color),
    interval_ms: interval,
  };
}

const actionStyle = {
  GO: "bg-emerald-700",
  STOP: "bg-red-700",
  WAIT: "bg-amber-600",
};

export default function Home() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const statusRef = useRef("idle");
  const framesRef = useRef([]);
  const detectingRef = useRef(false);
  const analyzingRef = useRef(false);
  const frameTimerRef = useRef(null);
  const analyzeTimerRef = useRef(null);
  const exposureRef = useRef(null);
  const lastSpeechRef = useRef(null);

  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [action, setAction] = useState(null);
  const { providerRef } = useLlmProvider();

  const updateStatus = useCallback((value) => {
    statusRef.current = value;
    setStatus(value);
  }, []);

  const stopGuide = useCallback(() => {
    clearInterval(frameTimerRef.current);
    clearInterval(analyzeTimerRef.current);
    frameTimerRef.current = null;
    analyzeTimerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    exposureRef.current = null;
    framesRef.current = [];
    updateStatus("idle");
    setAction(null);
  }, [updateStatus]);

  useEffect(() => {
    const onVoices = () => window.speechSynthesis.getVoices();
    window.speechSynthesis?.addEventListener("voiceschanged", onVoices);
    return () => {
      window.speechSynthesis?.removeEventListener("voiceschanged", onVoices);
      stopGuide();
      detectorRef.current?.release();
      detectorRef.current = null;
      window.speechSynthesis?.cancel();
    };
  }, [stopGuide]);

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
    const scale = Math.min(1, CAPTURE_WIDTH / video.videoWidth || 1);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas
      .getContext("2d", { willReadFrequently: true })
      .drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }, []);

  const sampleFrame = useCallback(async () => {
    const video = videoRef.current;
    const detection = await detectorRef.current.detect(video);
    const measurement = measureLamps(video, detection.box);
    const judgement = combineSignalJudgement(detection, measurement);
    return { detection, measurement, position: judgement.position, judgement };
  }, []);

  const detectTick = useCallback(async () => {
    if (statusRef.current !== "running" || detectingRef.current) return;
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;

    detectingRef.current = true;
    try {
      const { judgement } = await sampleFrame();
      framesRef.current = [
        ...framesRef.current,
        { state: judgement.state, color: judgement.color, at: performance.now() },
      ].slice(-WINDOW_FRAMES);
    } catch {
      // 1フレームの失敗は次のフレームで取り戻せるので無視する
    } finally {
      detectingRef.current = false;
    }
  }, [sampleFrame]);

  const analyze = useCallback(async () => {
    if (statusRef.current !== "running" || analyzingRef.current) return;
    if (framesRef.current.length < MIN_FRAMES_FOR_ANALYSIS) return;

    analyzingRef.current = true;
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerRef.current,
          images: [captureFrame()],
          signal_timeline: buildTimelineInput(framesRef.current),
          camera_exposure: exposureRef.current,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      if (statusRef.current !== "running") return;

      const { result } = payload;
      setMessage(result.voice_message);
      setAction(result.recommended_action);
      announce(
        `${result.recommended_action}/${result.pedestrian_signal_display}`,
        result.voice_message,
      );
    } catch {
      if (statusRef.current !== "running") return;
      setMessage("判定に失敗しました。止まってください。");
      setAction("STOP");
      announce("error", "判定に失敗しました。止まってください。");
    } finally {
      analyzingRef.current = false;
    }
  }, [announce, captureFrame, providerRef]);

  const startGuide = useCallback(async () => {
    updateStatus("preparing");
    setMessage("準備しています。そのままお待ちください。");
    vibrate(100);
    speakJapanese("準備しています。カメラを前に向けて、そのままお待ちください。");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();

      if (!detectorRef.current) {
        detectorRef.current = await createSignalDetector();
      }
      if (statusRef.current !== "preparing") return;

      const track = stream.getVideoTracks()[0];
      const support = readExposureSupport(track);
      if (support.manualExposure) {
        const result = await calibrateExposure({
          track,
          support,
          sampleFrame,
          isCancelled: () => statusRef.current !== "preparing",
        });
        exposureRef.current = result.applied
          ? { ...result.applied, mode: "calibrate" }
          : null;
      } else {
        exposureRef.current = await applyDeviceExposure(track, support);
      }
    } catch {
      if (statusRef.current !== "preparing") return;
      stopGuide();
      setMessage("カメラを起動できませんでした。");
      vibrate([200, 100, 200]);
      speakJapanese(
        "カメラを起動できませんでした。カメラの使用を許可してから、もう一度ボタンを押してください。",
      );
      return;
    }
    if (statusRef.current !== "preparing") return;

    framesRef.current = [];
    lastSpeechRef.current = { key: "start", at: Date.now() };
    updateStatus("running");
    setMessage("案内を開始しました。");
    vibrate([100, 80, 100]);
    speakJapanese("案内を開始します。止めるときは、画面をもう一度押してください。");
    frameTimerRef.current = setInterval(detectTick, FRAME_INTERVAL_MS);
    analyzeTimerRef.current = setInterval(analyze, ANALYZE_INTERVAL_MS);
  }, [analyze, detectTick, sampleFrame, stopGuide, updateStatus]);

  const onPress = useCallback(() => {
    if (statusRef.current === "idle") {
      startGuide();
      return;
    }
    stopGuide();
    setMessage("案内を停止しました。");
    vibrate(300);
    speakJapanese("案内を停止しました。");
  }, [startGuide, stopGuide]);
  const buttonLabel =
    status === "idle"
      ? "案内開始"
      : status === "preparing"
        ? "準備中"
        : "案内停止";
  const buttonHint =
    status === "idle"
      ? "画面のどこを押しても始まります"
      : status === "preparing"
        ? "押すと中止します"
        : "押すと停止します";
  const buttonColor =
    status === "idle"
      ? "bg-yellow-400 text-black"
      : status === "preparing"
        ? "bg-blue-800 text-white"
        : `${actionStyle[action] ?? "bg-zinc-800"} text-white`;

  return (
    <div className="flex min-h-dvh flex-col bg-black text-white">
      <main className="flex flex-1 flex-col gap-3 p-3">
        <button
          type="button"
          onClick={onPress}
          aria-label={`${buttonLabel}。${buttonHint}`}
          className={`flex flex-1 flex-col items-center justify-center gap-6 rounded-3xl border-8 border-white px-4 py-10 font-bold shadow-2xl transition-colors focus:outline-none focus-visible:ring-8 focus-visible:ring-sky-400 active:scale-[0.99] ${buttonColor}`}
        >
          <span className="text-7xl leading-tight sm:text-9xl">
            {buttonLabel}
          </span>
          <span className="text-2xl sm:text-4xl">{buttonHint}</span>
        </button>

        <p
          aria-live="polite"
          className="min-h-24 rounded-2xl bg-zinc-900 px-4 py-4 text-center text-3xl font-semibold leading-snug sm:text-4xl"
        >
          {message || "ボタンを押すと、カメラで信号を見て音声で案内します。"}
        </p>

        <div className="flex items-end justify-between gap-3" aria-hidden="true">
          <video
            ref={videoRef}
            className={`h-24 w-40 rounded-xl bg-zinc-900 object-cover ${
              status === "idle" ? "invisible" : ""
            }`}
            playsInline
            muted
          />
          <Link
            href="/test"
            tabIndex={-1}
            className="text-sm text-zinc-500 underline"
          >
            実験用ページ
          </Link>
        </div>
        <canvas ref={canvasRef} className="hidden" />
      </main>
    </div>
  );
}
