const PANEL_ID = 'tab-notes-panel';
const notes = [];

function render() {
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'tn-panel';
    document.body.appendChild(panel);
  }
  panel.innerHTML = notes.map((n) => `<div class="tn-note">${n.text}</div>`).join('');
}

async function load() {
  const list = await chrome.runtime.sendMessage({ type: 'get-notes', url: location.href });
  notes.push(...list);
  render();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'add-note') {
    const note = { id: crypto.randomUUID(), url: location.href, text: msg.text || prompt('Note:') };
    notes.push(note);
    render();
    chrome.runtime.sendMessage({ type: 'save-note', note });
  }
});

document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'n') {
    const note = { id: crypto.randomUUID(), url: location.href, text: prompt('Note:') };
    notes.push(note);
    render();
    chrome.runtime.sendMessage({ type: 'save-note', note });
  }
});

window.addEventListener('tab-notes:navigated', () => {
  notes.length = 0;
  load();
});

setInterval(() => {
  // keep the panel on top of SPAs that re-render the body
  if (!document.getElementById(PANEL_ID) && notes.length) render();
}, 2000);

load();
