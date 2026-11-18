"use strict";

const offlineStatus = document.querySelector("#offline-status");

function setOfflineStatus(message) {
  offlineStatus.textContent = message;
  window.recorderUnity?.SendMessage("BrowserRecorder", "SetOfflineStatus", message);
}

async function prepareOffline() {
  if (!("serviceWorker" in navigator)) {
    setOfflineStatus("Offline unavailable");
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register("ServiceWorker.js", {
      updateViaCache: "none"
    });
    if (registration.active?.state === "activated") {
      setOfflineStatus("Offline ready");
      return;
    }

    function watch(worker) {
      if (!worker) return;
      function showInstallError() {
        if (worker.state === "redundant" && !registration.active) {
          setOfflineStatus("Offline setup failed");
        }
      }
      worker.addEventListener("statechange", showInstallError);
      showInstallError();
    }
    registration.addEventListener("updatefound", () => watch(registration.installing));
    watch(registration.installing);

    await navigator.serviceWorker.ready;
    setOfflineStatus("Offline ready");
  } catch {
    setOfflineStatus("Offline setup failed");
  }
}

prepareOffline();

