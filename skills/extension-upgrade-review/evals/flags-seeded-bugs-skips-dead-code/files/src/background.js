import { getNotes, saveNotes, migrate } from './lib/storage.js';

// In-memory index of notes per URL, filled lazily.
let notesByUrl = new Map();
let initialized = false;

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.create({ id: 'add-note', title: 'Add note here', contexts: ['page', 'selection'] });
  if (details.reason === 'update') {
    await migrate(); // v3 stores notes as objects keyed by id
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  chrome.tabs.sendMessage(tab.id, { type: 'add-note', text: info.selectionText ?? '' });
});

async function init() {
  const all = await getNotes();
  for (const n of Object.values(all)) {
    if (!notesByUrl.has(n.url)) notesByUrl.set(n.url, []);
    notesByUrl.get(n.url).push(n);
  }
  initialized = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'get-notes') {
      sendResponse(notesByUrl.get(msg.url) ?? []);
    } else if (msg.type === 'save-note') {
      saveNotes(msg.note).then(() => {
        notesByUrl.set(msg.note.url, [...(notesByUrl.get(msg.note.url) ?? []), msg.note]);
        sendResponse({ ok: true });
      });
      return true;
    }
  });
}

init();
