async function refresh() { const notes = await window.notes.list(); document.querySelector('#list').textContent = notes.length + ' notes'; }
document.querySelector('#save').addEventListener('click', async () => { await window.notes.save({ title: document.querySelector('#title').value, body: document.querySelector('#body').value }); refresh(); });
refresh();
