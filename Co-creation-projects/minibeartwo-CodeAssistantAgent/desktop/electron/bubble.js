const button = document.getElementById('bubble');
const bridge = window.assistantBubble;
let gesture = null;
let finishing = false;
let suppressClickUntil = 0;

function showError() {
  button.title = '操作暂未完成，请重试 · 右键可打开菜单';
}

function toggle() {
  bridge.toggle().catch(showError);
}

function updateState({ clientVisible, ready }) {
  button.classList.toggle('client-visible', clientVisible);
  button.classList.toggle('connecting', !ready);
  button.setAttribute('aria-expanded', String(clientVisible));
  button.setAttribute('aria-busy', String(!ready));
  const action = clientVisible ? '收起代码助手' : '打开代码助手';
  button.setAttribute('aria-label', `${action}${ready ? '' : '，服务正在启动'}`);
  button.title = `${ready ? action : '代码助手正在启动'} · 点击${clientVisible ? '收起' : '打开'} · 拖动移动 · 右键菜单`;
}

button.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !event.isPrimary || gesture || finishing) return;
  event.preventDefault();
  button.focus({ preventScroll: true });
  button.setPointerCapture(event.pointerId);
  button.classList.add('pressed');
  gesture = {
    pointerId: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    dragged: false,
    started: bridge.startDrag().then(
      () => true,
      () => false,
    ),
  };
});

function measureGesture(event) {
  if (!gesture || !Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return;
  if (Math.hypot(event.screenX - gesture.startX, event.screenY - gesture.startY) > 6) {
    gesture.dragged = true;
  }
}

button.addEventListener('pointermove', (event) => {
  if (gesture?.pointerId === event.pointerId) {
    measureGesture(event);
    bridge.moveDrag();
  }
});

async function finishGesture(event, canceled) {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  measureGesture(event);
  const current = gesture;
  gesture = null;
  finishing = true;
  suppressClickUntil = performance.now() + 400;
  button.classList.remove('pressed');
  if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
  try {
    if (!(await current.started)) {
      showError();
      return;
    }
    // The main process measures native screen coordinates, including the final position.
    const result = await bridge.endDrag();
    if (!canceled && !current.dragged && result && !result.dragged) await bridge.toggle();
  } catch {
    showError();
  } finally {
    finishing = false;
  }
}

button.addEventListener('pointerup', (event) => {
  event.preventDefault();
  void finishGesture(event, false);
});
button.addEventListener('pointercancel', (event) => void finishGesture(event, true));
button.addEventListener('lostpointercapture', (event) => void finishGesture(event, true));

button.addEventListener('click', (event) => {
  event.preventDefault();
  // Pointer gestures are handled above; detail 0 preserves assistive-technology activation.
  if (event.detail === 0 && performance.now() >= suppressClickUntil) toggle();
});

button.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (gesture) void finishGesture({ pointerId: gesture.pointerId }, true);
  bridge.menu();
});

button.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (!event.repeat && !gesture && !finishing) toggle();
  } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    bridge.menu();
  } else if (event.key === 'Escape' && gesture) {
    event.preventDefault();
    void finishGesture({ pointerId: gesture.pointerId }, true);
  }
});

window.addEventListener('blur', () => {
  if (gesture) void finishGesture({ pointerId: gesture.pointerId }, true);
});

const unsubscribe = bridge.onState(updateState);
window.addEventListener('beforeunload', unsubscribe, { once: true });
