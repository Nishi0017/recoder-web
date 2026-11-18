"use strict";

const preview = document.querySelector("#preview");
const playback = document.querySelector("#playback");
const media = document.querySelector("#media");
const loading = document.querySelector("#loading");
const themeColor = document.querySelector('meta[name="theme-color"]');
const defaultThemeColor = themeColor?.content;
const exitDialog = document.querySelector("#hide-exit");
const exitDiscard = document.querySelector("#hide-exit-discard");
const exitDownload = document.querySelector("#hide-exit-download");

let unity;
let currentState = "idle";
let currentMessage = "Open the camera to get started.";
let hasPreviewRect = false;
let hidePanelActive = false;

let stream;
let recorder;
let clipUrl;
let clipFile;
let sharingRecording = false;
let selectedRecordingId;
let libraryBusy = false;
let opening = false;
let cameraRequest = 0;
let cameraFacing = "environment";
const resolutionPresets = {
  "4k": { width: 3840, height: 2160, label: "4K" },
  "1080p": { width: 1920, height: 1080, label: "1080p" },
  "720p": { width: 1280, height: 720, label: "720p" }
};
let qualityPreference = { resolution: "4k", fps: 60 };
try {
  const saved = JSON.parse(localStorage.getItem("recoder-quality"));
  if (saved && Object.hasOwn(resolutionPresets, saved.resolution) && [24, 30, 60].includes(saved.fps))
    qualityPreference = { resolution: saved.resolution, fps: saved.fps };
} catch {
  // A restricted storage environment still uses the selected settings for this launch.
}
let automaticQuality = false;

function send(method, value) {
  if (unity) queueMicrotask(() => unity.SendMessage("BrowserRecorder", method, value));
}

function updateMediaVisibility() {
  media.hidden = hidePanelActive || !hasPreviewRect || (preview.hidden && playback.hidden);
}

function showState(state, message) {
  currentState = state;
  currentMessage = message;
  updateMediaVisibility();
  if (exitDialog.open) refreshHideExitDialog();
  send("SetBrowserState", state);
  send("SetStatus", message);
  updateLibraryButton();
}

function releaseCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = undefined;
  }
  preview.srcObject = null;
  preview.hidden = true;
  updateQualityInfo();
}

function clearClip() {
  if (!clipUrl) return;
  publishClip("");
  playback.pause();
  playback.removeAttribute("src");
  playback.load();
  playback.hidden = true;
  URL.revokeObjectURL(clipUrl);
  clipUrl = undefined;
  clipFile = undefined;
  selectedRecordingId = undefined;
}

function publishClip(url) {
  send("SetRecordingUrl", url);
}

function accessError(error) {
  if (error.name === "NotAllowedError") return "Allow camera access in your browser settings.";
  if (error.name === "NotFoundError") return "No camera was found.";
  return "Could not open the camera. Check its connection and availability.";
}

async function openCamera() {
  if (opening || stream || recorder || libraryBusy) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showState("idle", "Open the page with HTTPS or localhost to use the camera.");
    return;
  }
  if (!window.MediaRecorder) {
    showState("idle", "Recording is unavailable in this browser.");
    return;
  }

  opening = true;
  const request = ++cameraRequest;
  showState("opening", "Waiting for camera permission…");
  try {
    const preset = resolutionPresets[qualityPreference.resolution];
    const video = {
      facingMode: { ideal: cameraFacing },
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: qualityPreference.fps }
    };
    automaticQuality = false;
    let camera;
    try {
      camera = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    } catch (error) {
      if (request !== cameraRequest) return;
      if (error.name !== "OverconstrainedError") throw error;
      automaticQuality = true;
      camera = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: cameraFacing } }
      });
    }
    if (request !== cameraRequest) {
      camera.getTracks().forEach(track => track.stop());
      return;
    }
    stream = camera;
    clearClip();
    preview.srcObject = camera;
    preview.hidden = false;
    updateMediaVisibility();
    await preview.play();
    if (request !== cameraRequest) return;
    camera.getVideoTracks()[0].addEventListener("ended", () => {
      if (stream !== camera || recorder) return;
      releaseCamera();
      showState("idle", "The camera was disconnected.");
    });
    const actualFacing = camera.getVideoTracks()[0].getSettings().facingMode;
    const differentCamera = actualFacing && actualFacing !== cameraFacing;
    if (actualFacing === "user" || actualFacing === "environment") cameraFacing = actualFacing;
    updateQualityInfo();
    showState("ready", differentCamera ? "Requested camera unavailable. Using available camera." : "Ready to record.");
  } catch (error) {
    if (request !== cameraRequest) return;
    releaseCamera();
    showState("idle", accessError(error));
  } finally {
    if (request === cameraRequest) opening = false;
    updateLibraryButton();
  }
}

async function startRecording() {
  if (!stream || recorder || currentState !== "ready") return;

  showState("stopping", "Preparing recording storage…");
  let row;
  try {
    const types = ["video/mp4", "video/webm"];
    const mimeType = types.find(type => MediaRecorder.isTypeSupported?.(type));
    const capture = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    row = await recordingStore.create(capture.mimeType || mimeType || "");
    const chunks = [];
    let writes = Promise.resolve();
    let storageError;
    let captureError = false;
    let sequence = 0;

    capture.addEventListener("dataavailable", event => {
      if (!event.data.size) return;
      chunks.push(event.data);
      const part = sequence++;
      writes = writes.then(async () => {
        if (storageError) return;
        try {
          await recordingStore.append(row.id, part, event.data);
        } catch (error) {
          storageError = error;
          // Keep the in-memory recording available for export on a write failure.
          if (capture.state === "recording") stopRecording();
        }
      });
    });
    capture.addEventListener("error", () => { captureError = true; });
    capture.addEventListener("stop", async () => {
      if (recorder !== capture) return;
      releaseCamera();
      showState("stopping", "Saving recording…");
      navigator.vibrate?.([55, 65, 55]);
      await writes;
      const type = capture.mimeType || chunks[0]?.type || row.type;
      const filename = recordingFilename(type);
      try {
        if (!chunks.length) await recordingStore.remove(row.id);
        else await recordingStore.finish(row.id, storageError || captureError ? "interrupted" : "complete", filename);
      } catch (error) {
        storageError = error;
      }
      recorder = undefined;
      if (!chunks.length) {
        showState("idle", "No video was captured.");
        return;
      }

      clearClip();
      clipFile = new File(chunks, filename, { type });
      clipUrl = URL.createObjectURL(clipFile);
      selectedRecordingId = row.id;
      playback.src = clipUrl;
      playback.hidden = false;
      showState("idle", storageError
        ? "Storage failed. Export this recording before closing."
        : captureError ? "Recording interrupted. Check the saved video."
        : "Recording saved. Open Recordings to see all videos.");
      publishClip(clipUrl);
    });

    if (!stream || document.visibilityState === "hidden") {
      await recordingStore.remove(row.id);
      showState("idle", "Open the camera to get started.");
      return;
    }
    capture.start(1000);
    recorder = capture;
    navigator.vibrate?.(70);
    showState("recording", "Recording…");
    // The request may be declined. IndexedDB still works in best-effort mode.
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    if (row) await recordingStore.remove(row.id).catch(() => {});
    showState(stream ? "ready" : "idle", "Could not start recording. Check available storage.");
  }
}

function stopRecording() {
  if (recorder?.state !== "recording") return;
  showState("stopping", "Finishing the recording…");
  recorder.stop();
}

playback.addEventListener("error", () => {
  if (clipUrl) showState("idle", "Could not play the recorded video.");
});

function suspendCamera() {
  cameraRequest++;
  opening = false;
  if (recorder?.state === "recording") stopRecording();
  releaseCamera();
  if (!recorder && currentState !== "stopping")
    showState("idle", "Open the camera to get started.");
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && !sharingRecording) suspendCamera();
});

window.addEventListener("pagehide", () => {
  if (exitDialog.open) exitDialog.close();
  suspendCamera();
});

function recordingFilename(type) {
  const extensionByType = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogv"
  };
  const mimeType = type.split(";", 1)[0].trim().toLowerCase();
  const extension = extensionByType[mimeType] || "video";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `recoder-${timestamp}.${extension}`;
}

async function downloadRecording() {
  if (!clipUrl || sharingRecording) return false;

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const shareData = { files: [clipFile] };
  if (isIOS && navigator.share && navigator.canShare?.(shareData)) {
    sharingRecording = true;
    try {
      await navigator.share(shareData);
      return true;
    } catch (error) {
      if (error.name !== "AbortError") {
        const message = "Could not open sharing. Tap the save button to try again.";
        send("SetStatus", message);
        if (exitDialog.open) {
          document.querySelector("#hide-exit-status").textContent = "共有メニューを開けませんでした。もう一度お試しください。";
        }
      }
      return false;
    } finally {
      sharingRecording = false;
    }
  }

  const link = document.createElement("a");
  link.href = clipUrl;
  link.download = clipFile.name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  return true;
}
async function startHiddenRecording() {
  if (currentState === "idle") await openCamera();
  if (hidePanelActive && currentState === "ready") startRecording();
}

function setHidePanel(active) {
  hidePanelActive = active;
  document.documentElement.toggleAttribute("data-hide-panel", active);
  if (themeColor) themeColor.content = active ? "#000000" : defaultThemeColor;
  document.querySelector("#offline-status").hidden = active;
  libraryButton.hidden = active;
  cameraSwitchButton.hidden = active;
  qualityButton.hidden = active;
  if (active) playback.pause();
  updateMediaVisibility();
}

function refreshHideExitDialog() {
  const hasRecording = Boolean(clipUrl);
  exitDiscard.disabled = !hasRecording;
  exitDownload.disabled = !hasRecording;
  document.querySelector("#hide-exit-status").textContent =
    currentState === "recording" ? "録画中です。「はい」を選んでも録画は続きます。" :
    hasRecording ? "録画した動画を破棄または保存できます。" : "停止済みの録画はありません。";
}

function confirmHideExit() {
  if (!hidePanelActive || exitDialog.open) return;
  refreshHideExitDialog();
  exitDialog.showModal();
}

function closeHidePanel() {
  exitDialog.close();
  send("CloseHidePanel", "");
}

document.querySelector("#hide-exit-yes").addEventListener("click", closeHidePanel);
document.querySelector("#hide-exit-no").addEventListener("click", () => exitDialog.close());
exitDiscard.addEventListener("click", async () => {
  if (!clipUrl || libraryBusy) return;
  libraryBusy = true;
  try {
    if (selectedRecordingId) await recordingStore.remove(selectedRecordingId);
    clearClip();
    showState("idle", "Recording discarded.");
    closeHidePanel();
  } catch {
    document.querySelector("#hide-exit-status").textContent = "削除に失敗しました。もう一度お試しください。";
  } finally {
    libraryBusy = false;
    updateLibraryButton();
  }
});
exitDownload.addEventListener("click", async () => {
  if (await downloadRecording()) closeHidePanel();
});

const qualityButton = document.querySelector("#quality-button");
const qualityDialog = document.querySelector("#quality-dialog");
const resolutionSelect = document.querySelector("#quality-resolution");
const fpsSelect = document.querySelector("#quality-fps");
const qualityApply = document.querySelector("#quality-apply");
const qualityRequested = document.querySelector("#quality-requested");
const qualityActual = document.querySelector("#quality-actual");
const qualityMessage = document.querySelector("#quality-message");

function updateQualityInfo() {
  const preset = resolutionPresets[qualityPreference.resolution];
  qualityRequested.textContent = `指定 ${preset.label}・${qualityPreference.fps}fps`;
  const track = stream?.getVideoTracks()[0];
  if (!track) {
    qualityActual.textContent = "取得 カメラを開くと確認できます";
    return;
  }
  const settings = track.getSettings();
  const dimensions = settings.width && settings.height ? `${settings.width}×${settings.height}` : "解像度不明";
  const frameRate = Number.isFinite(settings.frameRate) ? `${Math.round(settings.frameRate * 10) / 10}fps（設定値）` : "fps不明";
  const matchesSize = Math.max(settings.width, settings.height) === preset.width &&
    Math.min(settings.width, settings.height) === preset.height;
  const adjusted = automaticQuality || (settings.width && settings.height && !matchesSize) ||
    (Number.isFinite(settings.frameRate) && Math.abs(settings.frameRate - qualityPreference.fps) > 0.5);
  qualityActual.textContent = `取得 ${dimensions}・${frameRate}${adjusted ? " · 自動調整" : ""}`;
}

qualityButton.addEventListener("click", () => {
  if (qualityButton.disabled) return;
  resolutionSelect.value = qualityPreference.resolution;
  fpsSelect.value = String(qualityPreference.fps);
  qualityMessage.textContent = "非対応の設定は利用可能な画質へ自動調整します。";
  updateQualityInfo();
  qualityDialog.showModal();
});
document.querySelector("#quality-close").addEventListener("click", () => qualityDialog.close());
qualityApply.addEventListener("click", async () => {
  if (recorder || opening || libraryBusy || currentState === "stopping") return;
  const resolution = resolutionSelect.value;
  const fps = Number(fpsSelect.value);
  if (!Object.hasOwn(resolutionPresets, resolution) || ![24, 30, 60].includes(fps)) return;
  const changed = resolution !== qualityPreference.resolution || fps !== qualityPreference.fps;
  qualityPreference = { resolution, fps };
  let remembered = true;
  try { localStorage.setItem("recoder-quality", JSON.stringify(qualityPreference)); }
  catch { remembered = false; }
  qualityMessage.textContent = remembered ? "設定を保存しました。" : "次回起動用に記憶できませんでした。今回の設定は適用します。";
  if (stream && changed) {
    releaseCamera();
    await openCamera();
  }
  updateQualityInfo();
});
preview.addEventListener("resize", updateQualityInfo);
updateQualityInfo();

const libraryButton = document.querySelector("#recordings-button");
const cameraSwitchButton = document.querySelector("#camera-switch");
cameraSwitchButton.addEventListener("click", async () => {
  if (recorder || opening || libraryBusy || currentState === "stopping") return;
  cameraFacing = cameraFacing === "environment" ? "user" : "environment";
  if (stream) {
    releaseCamera();
    await openCamera();
  }
  updateLibraryButton();
});
const libraryDialog = document.querySelector("#recordings-dialog");
const libraryList = document.querySelector("#recordings-list");
const libraryMessage = document.querySelector("#recordings-message");
const libraryPreview = document.querySelector("#recordings-preview");
const libraryDownload = document.querySelector("#recordings-download");

function updateLibraryButton() {
  const qualityLocked = Boolean(recorder || opening || libraryBusy || currentState === "stopping");
  qualityButton.disabled = qualityLocked;
  resolutionSelect.disabled = qualityLocked;
  fpsSelect.disabled = qualityLocked;
  qualityApply.disabled = qualityLocked;
  cameraSwitchButton.disabled = Boolean(recorder || opening || libraryBusy || currentState === "stopping");
  cameraSwitchButton.textContent = cameraFacing === "environment" ? "前面カメラへ" : "背面カメラへ";
  libraryButton.disabled = Boolean(recorder || opening || libraryBusy || stream || currentState === "stopping");
}

async function refreshLibrary() {
  const rows = await recordingStore.list();
  libraryList.replaceChildren();
  libraryMessage.textContent = rows.length ? "動画を選んで再生・保存できます。" : "保存された録画はありません。";
  for (const row of rows) {
    const item = document.createElement("li");
    item.dataset.recordingId = row.id;
    const description = document.createElement("p");
    const when = new Date(row.createdAt).toLocaleString("ja-JP");
    description.textContent = `${when} · ${(row.bytes / 1048576).toFixed(1)} MB` +
      (row.status === "complete" ? "" : " · 未完了（再生できない場合があります）");
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "選択・再生";
    play.disabled = row.bytes === 0;
    play.addEventListener("click", () => selectSavedRecording(row.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "削除";
    remove.addEventListener("click", () => deleteSavedRecording(row.id));
    item.append(description, play, remove);
    libraryList.append(item);
  }
}

async function selectSavedRecording(id) {
  if (libraryBusy) return;
  libraryBusy = true;
  try {
    const saved = await recordingStore.read(id);
    if (!saved || !saved.file.size) throw new Error("Empty recording");
    clearClip();
    clipFile = saved.file;
    selectedRecordingId = id;
    clipUrl = URL.createObjectURL(clipFile);
    playback.src = clipUrl;
    playback.hidden = false;
    libraryPreview.src = clipUrl;
    libraryPreview.hidden = false;
    libraryDownload.disabled = false;
    publishClip(clipUrl);
    updateMediaVisibility();
    libraryMessage.textContent = saved.row.status === "complete"
      ? "再生ボタンで確認できます。「保存・共有」で書き出します。"
      : "未完了の録画です。復元できた部分を確認してください。";
  } catch {
    libraryMessage.textContent = "録画を読み込めませんでした。";
  } finally {
    libraryBusy = false;
    updateLibraryButton();
  }
}

async function deleteSavedRecording(id) {
  if (libraryBusy || !window.confirm("この録画を端末内から削除しますか？")) return;
  libraryBusy = true;
  try {
    await recordingStore.remove(id);
    if (selectedRecordingId === id) {
      libraryPreview.pause();
      libraryPreview.removeAttribute("src");
      libraryPreview.load();
      libraryPreview.hidden = true;
      libraryDownload.disabled = true;
      clearClip();
      updateMediaVisibility();
    }
    await refreshLibrary();
  } catch {
    libraryMessage.textContent = "削除に失敗しました。";
  } finally {
    libraryBusy = false;
    updateLibraryButton();
  }
}

libraryButton.addEventListener("click", async () => {
  if (recorder || opening || stream || libraryBusy) return;
  playback.pause();
  libraryPreview.hidden = true;
  libraryDownload.disabled = true;
  libraryDialog.showModal();
  try { await refreshLibrary(); }
  catch { libraryMessage.textContent = "端末内の保存領域を開けませんでした。"; }
});
document.querySelector("#recordings-close").addEventListener("click", () => libraryDialog.close());
libraryDialog.addEventListener("close", () => {
  libraryPreview.pause();
  libraryPreview.removeAttribute("src");
  libraryPreview.load();
});
libraryPreview.addEventListener("error", () => {
  libraryMessage.textContent = "この録画は再生できません。未完了の動画は正常に復元できない場合があります。";
});
libraryDownload.addEventListener("click", downloadRecording);

window.recoder = {
  confirmHideExit,
  openCamera,
  startRecording,
  stopRecording,
  downloadRecording,
  startHiddenRecording,
  setHidePanel,
  setPreviewRect(x, y, width, height) {
    media.style.left = `${x * 100}%`;
    media.style.top = `${y * 100}%`;
    media.style.width = `${width * 100}%`;
    media.style.height = `${height * 100}%`;
    hasPreviewRect = width > 0 && height > 0;
    updateMediaVisibility();
  }
};

const loader = document.createElement("script");
loader.src = unityLoader;
loader.onerror = () => { loading.textContent = "Could not load the Unity Web build."; };
loader.onload = async () => {
  try {
    unity = await createUnityInstance(document.querySelector("#unity-canvas"), unityConfig);
    window.recorderUnity = unity;
    loading.hidden = true;
    showState(currentState, currentMessage);
  } catch (error) {
    console.error(error);
    loading.textContent = "Could not start the Unity Web build.";
  }
};
document.body.append(loader);





