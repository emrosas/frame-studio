// The key entry page (ADR 0017): takes the key, hands it to main, forgets it.

const entry = window.frameStudioKeyEntry;
const field = document.getElementById('key');
const error = document.getElementById('error');
const save = document.getElementById('save');

document.getElementById('title').textContent = `Add a ${entry.provider.label} key`;
document.getElementById('page').addEventListener('click', () => entry.openKeyPage());
document.getElementById('cancel').addEventListener('click', () => entry.cancel());
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') entry.cancel();
});
document.getElementById('entry').addEventListener('submit', async (e) => {
  e.preventDefault();
  save.disabled = true;
  error.textContent = '';
  const problem = await entry.save(field.value);
  save.disabled = false;
  if (problem) error.textContent = problem;
  else field.value = '';
});
field.focus();
