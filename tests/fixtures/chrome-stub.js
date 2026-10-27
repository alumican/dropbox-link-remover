// Stand-in for the chrome.* APIs content.js uses, so the content script can run in a plain test page.
// chrome.i18n is deliberately missing: the panel takes its language from the page, not from Chrome.
(() => {
  const loadJson = (path) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', path, false); // synchronous: content.js reads the manifest while it runs
    xhr.send();
    return xhr.status === 200 ? JSON.parse(xhr.responseText) : null;
  };
  const manifest = loadJson('/manifest.json');
  const store = {};

  window.chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => manifest,
      onMessage: { addListener() {} },
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
