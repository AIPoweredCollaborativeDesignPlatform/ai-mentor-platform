import * as fabric from 'fabric';

type Pinch = { dist: number; mid: fabric.Point };

/**
 * Two-finger pinch zoom and pan on touch screens. One finger keeps drawing/selecting through Fabric; as soon as
 * a second finger lands, the gesture is taken over here (capture phase, so Fabric never sees the moves) and
 * `onGestureStart` lets the board cancel whatever the first finger had started.
 */
export function attachPinchZoom(el: HTMLElement, getCanvas: () => fabric.Canvas | null, hooks: { onGestureStart: () => void; onZoom: (zoom: number) => void }) {
  let pinch: Pinch | null = null;

  const local = (t: Touch) => {
    const r = el.getBoundingClientRect();
    return new fabric.Point(t.clientX - r.left, t.clientY - r.top);
  };
  const measure = (e: TouchEvent) => {
    const a = local(e.touches[0]), b = local(e.touches[1]);
    return { dist: Math.max(1, a.distanceFrom(b)), mid: a.midPointFrom(b) };
  };

  const onStart = (e: TouchEvent) => {
    const canvas = getCanvas();
    if (!canvas || e.touches.length !== 2) return;
    e.preventDefault();
    e.stopPropagation();
    if (!pinch) hooks.onGestureStart();
    pinch = measure(e);
  };

  const onMove = (e: TouchEvent) => {
    const canvas = getCanvas();
    if (!pinch || !canvas) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.touches.length < 2) return;
    const { dist, mid } = measure(e);
    // Incremental: pan by the midpoint's movement, then zoom around the new midpoint
    const zoom = Math.min(8, Math.max(0.1, (canvas.getZoom() * dist) / pinch.dist));
    canvas.relativePan(mid.subtract(pinch.mid));
    canvas.zoomToPoint(mid, zoom);
    pinch = { dist, mid };
    hooks.onZoom(zoom);
  };

  // Touch end passes through so Fabric can close the (cancelled) first-finger interaction
  const onEnd = (e: TouchEvent) => {
    if (pinch && e.touches.length < 2) pinch = null;
  };

  el.addEventListener('touchstart', onStart, { capture: true, passive: false });
  el.addEventListener('touchmove', onMove, { capture: true, passive: false });
  el.addEventListener('touchend', onEnd, { capture: true });
  el.addEventListener('touchcancel', onEnd, { capture: true });
  return () => {
    el.removeEventListener('touchstart', onStart, { capture: true });
    el.removeEventListener('touchmove', onMove, { capture: true });
    el.removeEventListener('touchend', onEnd, { capture: true });
    el.removeEventListener('touchcancel', onEnd, { capture: true });
  };
}
