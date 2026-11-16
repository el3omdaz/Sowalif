let active = false;

export async function requestText(message, value = '') {
  if (!window.sowalifDesktop) return window.prompt(message, value);
  if (active) return null;

  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'text-dialog';
  dialog.setAttribute('aria-labelledby', 'text-dialog-message');

  const form = document.createElement('form');
  form.method = 'dialog';
  const label = document.createElement('label');
  label.id = 'text-dialog-message';
  label.className = 'text-dialog-message';
  label.htmlFor = 'text-dialog-value';
  label.textContent = message;
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'text-dialog-value';
  input.dir = 'auto';
  input.autofocus = true;
  input.value = value;

  const actions = document.createElement('div');
  actions.className = 'row text-dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn ghost';
  cancel.textContent = 'إلغاء';
  cancel.addEventListener('click', () => dialog.close());
  const accept = document.createElement('button');
  accept.type = 'submit';
  accept.value = 'accept';
  accept.className = 'btn primary';
  accept.textContent = 'متابعة';
  actions.append(cancel, accept);
  form.append(label, input, actions);
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
  active = true;
  input.select();

  return new Promise(resolve => dialog.addEventListener('close', () => {
    active = false;
    dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    resolve(dialog.returnValue === 'accept' ? input.value : null);
  }, { once: true }));
}
