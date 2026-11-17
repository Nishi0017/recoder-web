"use strict";

const offlineStatus = document.querySelector("#offline-status");

async function prepareOffline() {
  if (!("serviceWorker" in navigator)) {
    offlineStatus.textContent = "Offline unavailable";
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register("ServiceWorker.js", {
      updateViaCache: "none"
    });
    if (registration.active?.state === "activated") {
      offlineStatus.textContent = "Offline ready";
      return;
    }

    function watch(worker) {
      if (!worker) return;
      function showInstallError() {
        if (worker.state === "redundant" && !registration.active) {
          offlineStatus.textContent = "Offline setup failed";
        }
      }
      worker.addEventListener("statechange", showInstallError);
      showInstallError();
    }
    registration.addEventListener("updatefound", () => watch(registration.installing));
    watch(registration.installing);

    await navigator.serviceWorker.ready;
    offlineStatus.textContent = "Offline ready";
  } catch {
    offlineStatus.textContent = "Offline setup failed";
  }
}

prepareOffline();

