// Stand-in for the chrome.* APIs content.js uses, so the content script can run in a plain test page.
// Query parameter `lang` picks the locale (default: en).
(() => {
  const params = new URLSearchParams(location.search);
  const lang = params.get('lang') || 'en';

  const loadJson = (path) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', path, false); // synchronous: content.js reads messages while it initializes
    xhr.send();
    return xhr.status === 200 ? JSON.parse(xhr.responseText) : null;
  };
  const manifest = loadJson('/manifest.json');
  // Like Chrome: an unsupported language falls back to default_locale
  const messages = loadJson(`/_locales/${lang}/messages.json`) || loadJson(`/_locales/${manifest.default_locale}/messages.json`);
  const store = {};

  window.chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => manifest,
      onMessage: { addListener() {} },
    },
    i18n: {
      // Same substitution rules as Chromium's ReplaceStringPlaceholders: $1..$9 from the substitutions, $$ -> $
      getMessage: (key, subs = []) =>
        (messages[key]?.message ?? '').replace(/\$(\$|[1-9])/g, (_, d) => (d === '$' ? '$' : subs[d - 1] ?? '')),
      getUILanguage: () => lang,
    },
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: store[key] }),
        set: (items) => Object.assign(store, items),
      },
    },
  };

  // Simulates reloading the extension: every chrome.* call made by the old content script would now throw
  window.invalidateExtension = () => {
    delete window.chrome.runtime.id;
  };
})();
