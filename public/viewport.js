// Mobile keyboards can resize only the visual viewport, including in standalone PWAs.
// Keep the shell inside that visible area without treating pinch zoom as a resize.
const viewport = window.visualViewport;
if (viewport) {
  const root = document.documentElement;
  let frame;
  function update() {
    frame = undefined;
    if (Math.abs(viewport.scale - 1) > 0.01 || viewport.height <= 0) return;
    root.style.setProperty('--studio-height', `${viewport.height}px`);
    root.style.setProperty('--studio-top', `${viewport.offsetTop}px`);
  }
  function schedule() {
    if (frame === undefined) frame = requestAnimationFrame(update);
  }
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('pageshow', schedule);
  update();
}

// Keep the "Derniers messages" pill above the composer frame. The composer grows
// while typing (textarea autoresize) and the visual viewport shrinks with the
// mobile keyboard, so a fixed bottom offset would overlap the input.
(function keepScrollButtonAboveComposer() {
  const area = document.querySelector('.conversation-column .composer-area');
  if (!area) return;
  let frame = 0;
  function measure() {
    frame = 0;
    document.documentElement.style.setProperty('--scroll-bottom-offset', `${area.offsetHeight + 12}px`);
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(measure);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(schedule).observe(area);
  document.getElementById('composer')?.addEventListener('input', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('pageshow', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  measure();
})();
