(() => {
  const app = document.getElementById("app");
  const base = app?.dataset.roomBase;
  if (!base) return; // not a room page

  let refreshTimer = 0;
  let hostClaimTimer = 0;
  let refreshQueued = false;
  let lastVersion = null;
  let connectionProbe = 0;

  const currentApp = () => document.getElementById("app");

  const refresh = () => {
    const dialogOpen = document.querySelector("[data-mic-dialog]:not([hidden])");
    if (window.__nonStopTalkTurnRunning || dialogOpen) {
      // Never re-render under an in-progress local turn or an open dialog;
      // catch up as soon as it is safe.
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

  const scheduleHostClaimRefresh = () => {
    clearTimeout(hostClaimTimer);
    const wait = Number(currentApp()?.dataset.hostClaimWaitMs);
    if (!Number.isFinite(wait) || wait <= 0) return;
    // Render just after the grace window so the server-side duration has
    // definitely crossed the takeover threshold.
    hostClaimTimer = setTimeout(scheduleRefresh, Math.max(100, wait + 100));
  };

  document.addEventListener("nonstoptalk:turn-idle", () => {
    if (refreshQueued) {
      refreshQueued = false;
      scheduleRefresh();
    }
  });

  document.addEventListener("htmx:afterSwap", scheduleHostClaimRefresh);

  const source = new EventSource(`${base}/events`);
  source.addEventListener("update", (event) => {
    if (event.data === lastVersion) return;
    const isFirst = lastVersion === null;
    lastVersion = event.data;
    if (!isFirst) {
      scheduleRefresh();
    }
  });

  const redirectIfRoomIsGone = async () => {
    if (connectionProbe) return;
    connectionProbe = window.setTimeout(() => {
      connectionProbe = 0;
    }, 5000);
    try {
      const response = await fetch(`${base}/partial`, {
        headers: { "HX-Request": "true" },
        cache: "no-store",
      });
      const redirect = response.headers.get("HX-Redirect");
      if (redirect) {
        source.close();
        window.location.assign(redirect);
      }
    } catch {
      // A transient network outage is not the same as an expired room;
      // EventSource will retry and the next error can probe again.
    }
  };

  source.addEventListener("gone", () => {
    source.close();
    window.location.assign("/?err=gone");
  });
  source.addEventListener("error", redirectIfRoomIsGone);

  // Approximate countdown for spectators between server refreshes.
  const countdownTimer = setInterval(() => {
    const remaining = document.querySelector("[data-spectate-remaining][data-ticking]");
    if (!remaining) return;
    const value = Number(remaining.textContent);
    if (Number.isFinite(value) && value > 0) {
      remaining.textContent = String(value - 1);
    }
  }, 1000);

  scheduleHostClaimRefresh();

  window.addEventListener("pagehide", () => {
    source.close();
    clearTimeout(refreshTimer);
    clearTimeout(hostClaimTimer);
    clearTimeout(connectionProbe);
    clearInterval(countdownTimer);
  });
})();
