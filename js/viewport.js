// iOS keeps the layout viewport tall when its keyboard opens. Fit the app to
// the visible viewport instead, including Safari's automatic focus panning.
export function fitViewport(win, doc, onResize = () => {}) {
  const root = doc.documentElement;
  const viewport = win.visualViewport;
  let frame = 0;
  let restingHeight = win.innerHeight;
  let restingWidth = win.innerWidth;
  let keyboardOpen = false;
  const listeners = [];
  function update() {
    frame = 0;
    // Leave browser zoom alone; resizing the layout during pinch zoom makes
    // controls jump and can prevent users from reading enlarged text.
    if (viewport && Math.abs(viewport.scale - 1) > 0.02) return;
    const height = viewport?.height || win.innerHeight;
    const width = win.innerWidth;
    const top = Math.max(0, viewport?.offsetTop || 0);
    const editable = doc.activeElement?.matches('textarea, input:not([type=checkbox]):not([type=radio]), [contenteditable="true"]');
    const touch = win.navigator.maxTouchPoints > 0;
    // Rotation invalidates the old portrait/landscape reference height.
    if (Math.abs(width - restingWidth) > 80) {
      restingHeight = win.innerHeight;
      restingWidth = width;
    }
    const obscured = Math.max(win.innerHeight, restingHeight) - height;
    keyboardOpen = touch && obscured > 120 && (editable || keyboardOpen);
    if (!keyboardOpen && !editable) restingHeight = win.innerHeight;
    const messages = doc.querySelector('.messages');
    const atBottom = messages && messages.scrollHeight - messages.clientHeight - messages.scrollTop < 64;
    root.style.setProperty('--app-height', `${height}px`);
    root.style.setProperty('--app-top', `${top}px`);
    root.classList.toggle('keyboard-open', Boolean(keyboardOpen));
    onResize(height);
    // Preserve an existing conversation's bottom anchor without moving users
    // who deliberately scrolled back to read earlier messages.
    if (atBottom) messages.scrollTop = messages.scrollHeight;
  }
  function schedule() {
    if (!frame) frame = win.requestAnimationFrame(update);
  }
  function listen(target, event) {
    target?.addEventListener(event, schedule);
    listeners.push(() => target?.removeEventListener(event, schedule));
  }
  for (const event of ['resize', 'scroll']) listen(viewport, event);
  for (const event of ['resize', 'pageshow']) listen(win, event);
  for (const event of ['focusin', 'focusout']) listen(doc, event);
  update();
  return () => {
    listeners.forEach(remove => remove());
    if (frame) win.cancelAnimationFrame(frame);
  };
}
