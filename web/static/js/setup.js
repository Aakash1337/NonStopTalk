(() => {
  const storageKey = "dont-stop-talking.custom-topics";
  const formSelector = 'form[hx-post$="/topics/custom"]';

  const readSavedTopics = () => {
    try {
      return window.localStorage.getItem(storageKey) || "";
    } catch {
      return "";
    }
  };

  const saveTopics = (value) => {
    try {
      if (value.trim()) {
        window.localStorage.setItem(storageKey, value);
      } else {
        window.localStorage.removeItem(storageKey);
      }
    } catch {
      // Persistence is best-effort.
    }
  };

  const restore = () => {
    const textarea = document.querySelector(`${formSelector} textarea[name="topics"]`);
    if (textarea && !textarea.value) {
      textarea.value = readSavedTopics();
    }
  };

  document.addEventListener("submit", (event) => {
    const form = event.target instanceof Element ? event.target.closest(formSelector) : null;
    if (!form) return;
    const textarea = form.querySelector('textarea[name="topics"]');
    if (textarea) {
      saveTopics(textarea.value);
    }
  });

  document.addEventListener("htmx:afterSwap", restore);
  restore();
})();
