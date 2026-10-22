/** Animate the native client without resizing it or recreating its renderer. */
function createClientTransition({ window, getPositions, reduceMotion, onState }) {
  let requested = window.isVisible() && !window.isMinimized();
  let progress = requested ? 1 : 0;
  let opacity = window.getOpacity();
  let positions = null;
  let timer = null;

  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function move(value) {
    if (!positions || window.isMaximized() || window.isFullScreen()) return;
    const { start, end } = positions;
    window.setPosition(
      Math.round(start.x + (end.x - start.x) * value),
      Math.round(start.y + (end.y - start.y) * value), false,
    );
  }

  function paint(value) {
    progress = value;
    window.setOpacity(opacity * value);
    move(value);
  }

  function finish() {
    cancel();
    if (window.isDestroyed()) return;
    if (requested) paint(1);
    else {
      progress = 0;
      window.hide();
      window.setSkipTaskbar(true);
      window.setOpacity(opacity);
      move(1);
    }
    onState();
  }

  function animate() {
    cancel();
    const target = requested ? 1 : 0;
    if (reduceMotion() || Math.abs(target - progress) < 0.001) { finish(); return; }
    const from = progress;
    const began = performance.now();
    const duration = Math.max(16, (requested ? 220 : 160) * Math.abs(target - from));
    const tick = () => {
      timer = null;
      if (window.isDestroyed()) return;
      const elapsed = Math.min(1, (performance.now() - began) / duration);
      const eased = 1 - (1 - elapsed) ** 3;
      paint(from + (target - from) * eased);
      if (elapsed >= 1) finish();
      else timer = setTimeout(tick, 16);
    };
    timer = setTimeout(tick, 16);
  }

  function show() {
    if (window.isDestroyed()) return;
    const fresh = !window.isVisible() || window.isMinimized();
    if (requested && !fresh) { window.focus(); return; }
    requested = true;
    if (fresh) {
      cancel();
      opacity = window.getOpacity();
      progress = 0;
      window.setOpacity(0);
      if (window.isMinimized()) window.restore();
      positions = getPositions();
      move(reduceMotion() ? 1 : 0);
    }
    window.setSkipTaskbar(false);
    window.show();
    window.focus();
    onState();
    animate();
  }

  function hide() {
    if (window.isDestroyed()) return;
    requested = false;
    onState();
    if (!window.isVisible() || window.isMinimized()) {
      cancel();
      progress = 0;
      window.hide();
      window.setSkipTaskbar(true);
      return;
    }
    // A manually moved window should fade from its current position.
    if (timer === null && positions) {
      const [x, y] = window.getPosition();
      const dx = positions.start.x - positions.end.x;
      const dy = positions.start.y - positions.end.y;
      positions = { end: { x, y }, start: { x: x + dx, y: y + dy } };
    }
    animate();
  }

  function settle() {
    if (timer === null || window.isDestroyed()) return;
    finish();
  }

  function externallyHidden() {
    requested = false;
    if (timer !== null) {
      cancel();
      progress = 0;
      window.setOpacity(opacity);
      move(1);
    }
    onState();
  }

  function dispose() {
    cancel();
    window.removeListener('hide', externallyHidden);
    window.removeListener('minimize', settle);
    window.removeListener('maximize', settle);
    window.removeListener('unmaximize', settle);
    window.removeListener('closed', dispose);
    if (!window.isDestroyed()) { window.setOpacity(opacity); move(1); }
  }

  window.on('hide', externallyHidden);
  window.on('minimize', settle);
  window.on('maximize', settle);
  window.on('unmaximize', settle);
  window.on('closed', dispose);
  return { show, hide, settle, dispose, isOpen: () => requested && !window.isMinimized() };
}

module.exports = { createClientTransition };
