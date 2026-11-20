import { saveNotes } from '../lib/storage.js';

const draft = document.getElementById('draft');
const { popupDraft = '' } = await chrome.storage.local.get('popupDraft');
draft.value = popupDraft;

// Keep the unfinished draft when the popup closes.
window.addEventListener('unload', () => {
  chrome.storage.local.set({ popupDraft: draft.value });
});

document.getElementById('save').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await saveNotes({ id: crypto.randomUUID(), url: tab.url, text: draft.value });
  await chrome.storage.local.remove('popupDraft');
  window.close();
});
