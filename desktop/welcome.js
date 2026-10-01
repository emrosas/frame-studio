// The welcome window's buttons. Main does the work; this only asks.

const bridge = window.frameStudioWelcome;
const error = document.getElementById('error');

async function run(action) {
  error.hidden = true;
  // One folder at a time: the buttons wait while this one opens.
  const buttons = [...document.querySelectorAll('button')];
  for (const b of buttons) b.disabled = true;
  try {
    const problem = await action();
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
    }
  } catch (err) {
    error.textContent = String(err && err.message ? err.message : err);
    error.hidden = false;
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

document.getElementById('new').addEventListener('click', () => run(() => bridge.newProject()));
document.getElementById('open').addEventListener('click', () => run(() => bridge.openFolder()));
document.getElementById('sample').addEventListener('click', () => run(() => bridge.sampleProject()));

const FOLDER_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/></svg>';

// Each recent project by name, with its path under it (home as ~).
const list = document.getElementById('recent');
for (const path of bridge.recent) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.title = path;
  button.innerHTML = FOLDER_ICON;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = path.split('/').filter(Boolean).pop() || path;
  const where = document.createElement('span');
  where.className = 'path';
  where.textContent = path.replace(/^\/Users\/[^/]+/, '~');
  button.append(name, where);
  button.addEventListener('click', () => run(() => bridge.openRecent(path)));
  item.append(button);
  list.append(item);
}
document.getElementById('empty').hidden = bridge.recent.length > 0;

// The app's update (ADR 0009), when it has one: Update installs it and restarts.
const updateBox = document.getElementById('update');
const updateText = document.getElementById('update-text');
const updateGo = document.getElementById('update-go');
let updateAction = null;

function showUpdate(state) {
  updateBox.classList.toggle('is-error', state.status === 'error');
  updateAction = null;
  if (state.status === 'available') {
    updateText.textContent = `Frame Studio ${state.version} is available.`;
    updateGo.textContent = 'Update';
    updateAction = () => bridge.updates.install();
  } else if (state.status === 'downloading') {
    updateText.textContent = `Downloading ${state.version}… ${state.total > 0 ? Math.round((state.done / state.total) * 100) : 0}%`;
  } else if (state.status === 'restarting') {
    updateText.textContent = `Installing ${state.version}…`;
  } else if (state.status === 'error' && state.version) {
    updateText.textContent = state.message;
    updateGo.textContent = state.manual ? 'Release page' : 'Try again';
    updateAction = () => (state.manual ? bridge.updates.openNotes() : bridge.updates.install());
  }
  updateGo.hidden = updateAction === null;
  updateBox.hidden = !['available', 'downloading', 'restarting'].includes(state.status) && !(state.status === 'error' && state.version);
}

if (bridge.updates) {
  updateGo.addEventListener('click', () => updateAction?.());
  bridge.updates.onChange(showUpdate);
  bridge.updates.state().then(showUpdate, () => {});
}
