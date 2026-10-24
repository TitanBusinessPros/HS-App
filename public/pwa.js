(() => {
  const installButton = document.getElementById("install-app");
  const updateButton = document.getElementById("update-app");
  const status = document.getElementById("pwa-status");
  const currentVersion = document.querySelector('meta[name="app-version"]')?.content;
  let installPrompt;

  function showStatus(message) {
    status.textContent = message;
    status.hidden = false;
  }

  async function latestVersion() {
    const url = new URL("version.json", document.baseURI);
    url.searchParams.set("check", Date.now().toString());
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("Version check failed");
    const { version } = await response.json();
    if (typeof version !== "string" || !version) throw new Error("Version is missing");
    return version;
  }

  async function checkForUpdates() {
    try {
      const version = await latestVersion();
      updateButton.hidden = !currentVersion || currentVersion === version;
    } catch { /* Keep the button hidden until a newer published version is confirmed. */ }
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installButton.hidden = true;
    showStatus("Homesteader was installed.");
  });

  if (window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone) installButton.hidden = true;
  installButton.addEventListener("click", async () => {
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome !== "accepted") showStatus("You can install Homesteader later from your browser menu.");
      return;
    }
    const apple = /iPhone|iPad|iPod/.test(navigator.userAgent);
    showStatus(apple ? "In Safari, tap Share, then Add to Home Screen." : "Open your browser menu and choose Install app or Add to Home Screen.");
  });

  updateButton.addEventListener("click", async () => {
    updateButton.disabled = true;
    showStatus("Checking for the current version...");
    try {
      const version = await latestVersion();
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          await registration.update();
          if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
          if (!navigator.serviceWorker.controller) {
            await Promise.race([
              new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })),
              new Promise((resolve) => setTimeout(resolve, 3000))
            ]);
          }
        }
      }
      showStatus("Opening the current version...");
      const destination = new URL(location.href);
      destination.searchParams.set("appVersion", version.slice(0, 12));
      location.replace(destination.href);
    } catch {
      showStatus("Could not check for updates. Connect to the internet and try again.");
      updateButton.disabled = false;
    }
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(() => checkForUpdates()).catch(() => checkForUpdates());
    });
  } else {
    checkForUpdates();
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkForUpdates();
  });
  setInterval(() => { if (!document.hidden) checkForUpdates(); }, 5 * 60 * 1000);
})();
