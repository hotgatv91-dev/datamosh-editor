/**
 * Pointer drag helper.
 *
 * Every timeline interaction (scrub, range select, clip move/trim, effect
 * move/resize) goes through this so mouse and touch behave identically and the
 * gesture keeps working when the finger leaves the element.
 */

export interface DragHandlers<T = unknown> {
  onStart?: (event: PointerEvent) => T | null;
  onMove: (state: { dx: number; dy: number; x: number; y: number; startX: number; startY: number }, payload: T) => void;
  onEnd?: (state: { dx: number; dy: number }, payload: T) => void;
}

export function startPointerDrag<T>(
  event: PointerEvent,
  element: HTMLElement,
  handlers: DragHandlers<T>,
): void {
  const payload = handlers.onStart?.(event) ?? (null as T);
  if (payload === null && handlers.onStart) return;

  const startX = event.clientX;
  const startY = event.clientY;
  let moved = false;

  const handleMove = (moveEvent: PointerEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    handlers.onMove(
      { dx, dy, x: moveEvent.clientX, y: moveEvent.clientY, startX, startY },
      payload,
    );
  };

  const handleUp = (upEvent: PointerEvent) => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    window.removeEventListener('pointercancel', handleUp);
    try {
      element.releasePointerCapture?.(upEvent.pointerId);
    } catch {
      /* capture may already be released */
    }
    handlers.onEnd?.({ dx: upEvent.clientX - startX, dy: upEvent.clientY - startY }, payload);
    void moved;
  };

  try {
    element.setPointerCapture?.(event.pointerId);
  } catch {
    /* some browsers refuse capture on non-primary pointers */
  }
  window.addEventListener('pointermove', handleMove, { passive: true });
  window.addEventListener('pointerup', handleUp);
  window.addEventListener('pointercancel', handleUp);
}

/** Wraps a JSX handler into the shape React's onPointerDown expects. */
export function pointerDown<T>(
  element: HTMLElement | null,
  handlers: DragHandlers<T>,
): (event: React.PointerEvent) => void {
  return (event: React.PointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const native = event.nativeEvent;
    const target = (element ?? (event.currentTarget as HTMLElement)) as HTMLElement;
    event.preventDefault();
    startPointerDrag<T>(native, target, handlers);
  };
}
