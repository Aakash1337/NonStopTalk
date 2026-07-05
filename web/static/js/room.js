(() => {
  const app = document.getElementById("app");
  const base = app?.dataset.roomBase;
  if (!base) return; // not a room page

  let refreshTimer = 0;
  let refreshQueued = false;
  let lastVersion = null;

  const refresh = () => {
    if (window.__dstTurnRunning) {
      // Never re-render under an in-progress local turn; catch up after.
      refreshQueued = true;
      return;
    }
    if (!window.htmx) return;
    window.htmx.ajax("GET", `${base}/partial`, { target: "#app", swap: "outerHTML" });
  };

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  };

  document.addEventListener("dst:turn-idle", () => {
    if (refreshQueued) {
      refreshQueued = false;
      scheduleRefresh();
    }
  });

  const source = new EventSource(`${base}/events`);
  source.addEventListener("update", (event) => {
    if (event.data === lastVersion) return;
    const isFirst = lastVersion === null;
    lastVersion = event.data;
    if (!isFirst) {
      scheduleRefresh();
    }
  });

  // Approximate countdown for spectators between server refreshes.
  setInterval(() => {
    const remaining = document.querySelector("[data-spectate-remaining][data-ticking]");
    if (!remaining) return;
    const value = Number(remaining.textContent);
    if (Number.isFinite(value) && value > 0) {
      remaining.textContent = String(value - 1);
    }
  }, 1000);

  window.addEventListener("pagehide", () => source.close());
})();
