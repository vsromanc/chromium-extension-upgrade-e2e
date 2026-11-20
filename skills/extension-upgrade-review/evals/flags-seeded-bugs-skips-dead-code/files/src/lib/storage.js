// v1/v2 stored notes as an array under "notes"; v3 stores { [id]: note } under "notesById".
export async function getNotes() {
  const { notesById = {} } = await chrome.storage.local.get('notesById');
  return notesById;
}

export async function saveNotes(note) {
  const all = await getNotes();
  all[note.id] = note;
  await chrome.storage.local.set({ notesById: all });
}

export async function migrate() {
  const { notes } = await chrome.storage.local.get('notes');
  if (!Array.isArray(notes)) return;
  const byId = {};
  for (const n of notes) byId[n.id ?? crypto.randomUUID()] = n;
  await chrome.storage.local.set({ notesById: byId });
  await chrome.storage.local.remove('notes');
}
