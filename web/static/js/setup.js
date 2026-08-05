(() => {
  const storageKey = "nonstoptalk.custom-topics";
  const legacyStorageKey = "dont-stop-talking.custom-topics";
  const formSelector = 'form[hx-post$="/topics/custom"]';

  const readMigratedValue = (key, legacyKey) => {
    const current = window.localStorage.getItem(key);
    if (current !== null) {
      try {
        window.localStorage.removeItem(legacyKey);
      } catch {
        // Keep using the current value when legacy cleanup is blocked.
      }
      return current;
    }
    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy !== null) {
      try {
        window.localStorage.setItem(key, legacy);
        window.localStorage.removeItem(legacyKey);
      } catch {
        // Read through the legacy value when migration cannot be persisted.
      }
    }
    return legacy;
  };

  const readSavedTopics = () => {
    try {
      return readMigratedValue(storageKey, legacyStorageKey) || "";
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
      window.localStorage.removeItem(legacyStorageKey);
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

  // --- Saved presets (settings + custom topics, stored on this device) ---

  const presetsKey = "nonstoptalk.presets";
  const legacyPresetsKey = "dont-stop-talking.presets";

  const readPresets = () => {
    try {
      return JSON.parse(readMigratedValue(presetsKey, legacyPresetsKey)) || {};
    } catch {
      return {};
    }
  };

  const savePresets = (presets) => {
    try {
      window.localStorage.setItem(presetsKey, JSON.stringify(presets));
      window.localStorage.removeItem(legacyPresetsKey);
    } catch {
      // Persistence is best-effort.
    }
  };

  const populatePresetList = () => {
    const list = document.querySelector("[data-preset-list]");
    if (!list) return;
    const selected = list.value;
    list.replaceChildren();
    const names = Object.keys(readPresets()).sort();
    if (names.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No saved presets";
      list.appendChild(option);
      return;
    }
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      list.appendChild(option);
    }
    if (selected && names.includes(selected)) {
      list.value = selected;
    }
  };

  const currentSetup = () => {
    const settings = document.getElementById("settings");
    if (!settings) return null;
    const field = (name) => settings.querySelector(`[name="${name}"]`)?.value || "";
    return {
      duration: field("duration"),
      silence: field("silence"),
      rounds: field("rounds"),
      topicPack: field("topicPack"),
      aiJudge: settings.querySelector('[name="aiJudge"]')?.checked ? "on" : "",
      topics: document.querySelector(`${formSelector} textarea[name="topics"]`)?.value || "",
    };
  };

  const downloadTopics = () => {
    const textarea = document.querySelector(`${formSelector} textarea[name="topics"]`);
    const content = textarea?.value.trim();
    if (!content) return;
    const blob = new Blob([content + "\n"], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "nonstoptalk-topics.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest("[data-preset-save]")) {
      const name = document.querySelector("[data-preset-name]")?.value.trim();
      const setup = currentSetup();
      if (!name || !setup) return;
      const presets = readPresets();
      presets[name] = setup;
      savePresets(presets);
      populatePresetList();
      const list = document.querySelector("[data-preset-list]");
      if (list) list.value = name;
    }

    if (target.closest("[data-preset-delete]")) {
      const list = document.querySelector("[data-preset-list]");
      const name = list?.value;
      if (!name) return;
      const presets = readPresets();
      delete presets[name];
      savePresets(presets);
      populatePresetList();
    }

    if (target.closest("[data-preset-apply]")) {
      const name = document.querySelector("[data-preset-list]")?.value;
      const preset = name ? readPresets()[name] : null;
      const form = document.querySelector("[data-preset-form]");
      if (!preset || !form) return;
      for (const [key, value] of Object.entries(preset)) {
        const input = form.querySelector(`[name="${key}"]`);
        if (input) input.value = value;
      }
      form.requestSubmit();
    }

    if (target.closest("[data-export-topics]")) {
      downloadTopics();
    }
  });

  document.addEventListener("change", (event) => {
    const input = event.target instanceof Element ? event.target.closest("[data-import-topics]") : null;
    const file = input?.files?.[0];
    if (!file) return;
    file.text().then((content) => {
      const textarea = document.querySelector(`${formSelector} textarea[name="topics"]`);
      if (textarea) {
        textarea.value = content.trim().slice(0, 20000);
      }
      input.value = "";
    });
  });

  const refresh = () => {
    restore();
    populatePresetList();
  };

  document.addEventListener("htmx:afterSwap", refresh);
  refresh();
})();
