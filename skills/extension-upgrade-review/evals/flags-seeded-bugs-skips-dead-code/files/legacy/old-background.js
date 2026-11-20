// Pre-MV3 background page (v1.x). Not referenced by the manifest any more.
chrome.contextMenus.create({ id: 'add-note', title: 'Add note', contexts: ['all'] });
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  chrome.tabs.executeScript(sender.tab.id, { file: 'content.js' });
});
let cache = {};
setInterval(function () { cache = {}; }, 60000);
