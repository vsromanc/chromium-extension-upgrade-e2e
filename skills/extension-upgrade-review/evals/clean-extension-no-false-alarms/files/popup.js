(() => {
  async function call(type, payload) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await chrome.runtime.sendMessage({ type, payload });
        if (res?.error) throw new Error(res.error);
        return res?.value;
      } catch (e) {
        if (attempt >= 1 || !/message port closed|Receiving end does not exist/.test(e.message)) throw e;
      }
    }
  }
  const minutes = document.getElementById('minutes');
  chrome.storage.local.get('settings').then(({ settings }) => (minutes.value = settings?.minutes ?? 25));
  // Saved on every change: the popup can close at any moment.
  minutes.addEventListener('input', () =>
    chrome.storage.local.get('settings').then(({ settings }) =>
      chrome.storage.local.set({ settings: { ...settings, minutes: Number(minutes.value) || 25 } }),
    ),
  );
  document.getElementById('start').addEventListener('click', async () => {
    const s = await call('start');
    document.getElementById('status').textContent = `Until ${new Date(s.endsAt).toLocaleTimeString()}`;
  });
})();
