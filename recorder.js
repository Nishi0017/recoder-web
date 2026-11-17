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
let opening = false;
let cameraRequest = 0;

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
}

function releaseCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = undefined;
  }
  preview.srcObject = null;
  preview.hidden = true;
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
  if (opening || stream || recorder) return;
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
    const camera = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } }
    });
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
    showState("ready", "Ready to record.");
  } catch (error) {
    if (request !== cameraRequest) return;
    releaseCamera();
    showState("idle", accessError(error));
  } finally {
    if (request === cameraRequest) opening = false;
  }
}

function startRecording() {
  if (!stream || recorder) return;

  try {
    const types = ["video/mp4", "video/webm"];
    const mimeType = types.find(type => MediaRecorder.isTypeSupported?.(type));
    const capture = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];

    capture.addEventListener("dataavailable", event => {
      if (event.data.size) chunks.push(event.data);
    });
    capture.addEventListener("error", () => {
      if (recorder !== capture) return;
      recorder = undefined;
      releaseCamera();
      showState("idle", "Recording failed.");
    });
    capture.addEventListener("stop", () => {
      if (recorder !== capture) return;
      recorder = undefined;
      releaseCamera();
      navigator.vibrate?.([55, 65, 55]);
      if (!chunks.length) {
        showState("idle", "No video was captured.");
        return;
      }

      const type = capture.mimeType || chunks[0].type;
      clipFile = new File(chunks, recordingFilename(type), { type });
      clipUrl = URL.createObjectURL(clipFile);
      playback.src = clipUrl;
      playback.hidden = false;
      showState("idle", "Recording finished. Play it in the preview.");
      publishClip(clipUrl);
    });

    capture.start();
    recorder = capture;
    navigator.vibrate?.(70);
    showState("recording", "Recording…");
  } catch {
    showState("ready", "Could not start recording.");
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

window.addEventListener("pagehide", () => {
  if (exitDialog.open) exitDialog.close();
  cameraRequest++;
  opening = false;
  if (recorder?.state === "recording") recorder.stop();
  recorder = undefined;
  releaseCamera();
  clearClip();
  showState("idle", "Open the camera to get started.");
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
exitDiscard.addEventListener("click", () => {
  if (!clipUrl) return;
  clearClip();
  showState("idle", "Recording discarded.");
  closeHidePanel();
});
exitDownload.addEventListener("click", async () => {
  if (await downloadRecording()) closeHidePanel();
});

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





