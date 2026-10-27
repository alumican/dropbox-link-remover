// Toolbar icon: toggles the panel on a Dropbox page, otherwise opens the shared links page
const LINKS_URL = 'https://www.dropbox.com/share/links';
const TOGGLE_MESSAGE = 'dlr-toggle'; // must match content.js

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: TOGGLE_MESSAGE });
  } catch {
    chrome.tabs.create({ url: LINKS_URL });
  }
});
