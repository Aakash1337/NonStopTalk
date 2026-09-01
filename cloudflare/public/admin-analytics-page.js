import {
  ADMIN_ANALYTICS_WINDOWS,
  loadAdminAnalytics,
  renderAdminDashboard,
  renderAdminLoading,
  renderAdminUnlock,
} from "/admin-analytics.js";

const root = document.querySelector("#admin-app");
const announcer = document.querySelector("#admin-announcer");

let snapshot = null;
let selectedDays = 30;
let loadedAt = null;
let activeRequest = null;

root.innerHTML = renderAdminUnlock();
root.addEventListener("submit", handleSubmit);
root.addEventListener("click", handleClick);
window.addEventListener("pagehide", clearPageState);
window.addEventListener("pageshow", handlePageShow);

async function handleSubmit(event) {
  const form = event.target.closest("[data-admin-token-form]");
  if (!form) return;
  event.preventDefault();
  if (!form.reportValidity()) return;

  const tokenField = form.querySelector("#admin-token");
  const token = tokenField && "value" in tokenField ? String(tokenField.value).trim() : "";
  if (tokenField && "value" in tokenField) tokenField.value = "";

  activeRequest?.abort();
  const request = new AbortController();
  activeRequest = request;
  snapshot = null;
  loadedAt = null;
  root.setAttribute("aria-busy", "true");
  root.innerHTML = renderAdminLoading();

  try {
    const nextSnapshot = await loadAdminAnalytics(token, { signal: request.signal });
    if (request.signal.aborted || activeRequest !== request) return;
    snapshot = nextSnapshot;
    selectedDays = 30;
    loadedAt = new Date();
    renderDashboard();
    focusHeading();
    announce("Aggregate analytics loaded.");
  } catch (error) {
    if (error?.name === "AbortError" || activeRequest !== request) return;
    request.abort();
    snapshot = null;
    loadedAt = null;
    root.innerHTML = renderAdminUnlock(error?.message || "Analytics could not be loaded.");
    focusToken();
  } finally {
    if (activeRequest === request) activeRequest = null;
    root.removeAttribute("aria-busy");
  }
}

function handleClick(event) {
  const button = event.target.closest("[data-command]");
  if (!button) return;
  const command = button.dataset.command;
  if (command === "admin-window") {
    const days = Number(button.dataset.days);
    if (!snapshot || !ADMIN_ANALYTICS_WINDOWS.includes(days)) return;
    selectedDays = days;
    renderDashboard();
    root.querySelector(`[data-command="admin-window"][data-days="${days}"]`)?.focus();
    announce(`Showing ${days} day${days === 1 ? "" : "s"} of analytics.`);
    return;
  }
  if (command === "admin-reauthorize") {
    activeRequest?.abort();
    activeRequest = null;
    snapshot = null;
    loadedAt = null;
    root.innerHTML = renderAdminUnlock();
    focusToken();
  }
}

function renderDashboard() {
  if (!snapshot) return;
  root.innerHTML = renderAdminDashboard(snapshot, selectedDays, loadedAt);
}

function focusHeading() {
  const heading = root.querySelector("h1");
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus();
}

function focusToken() {
  requestAnimationFrame(() => root.querySelector("#admin-token")?.focus());
}

function announce(message) {
  if (!announcer) return;
  announcer.textContent = "";
  queueMicrotask(() => { announcer.textContent = message; });
}

function clearPageState() {
  activeRequest?.abort();
  activeRequest = null;
  snapshot = null;
  loadedAt = null;
  const tokenField = root.querySelector("#admin-token");
  if (tokenField && "value" in tokenField) tokenField.value = "";
  root.removeAttribute("aria-busy");
  root.innerHTML = renderAdminUnlock();
  if (announcer) announcer.textContent = "";
}

function handlePageShow(event) {
  if (!event.persisted) return;
  clearPageState();
  focusToken();
}
