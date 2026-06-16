/**
 * LiveView — interactive screencast canvas for `awaiting_human` runs.
 *
 * Responsibilities (T027):
 * - Draws incoming `lv:frame` JPEG data to a <canvas>.
 * - Captures mouse + keyboard events on the canvas; maps client (canvas) coords
 *   → page coords using the latest frame metadata (R4 — no 1:1 assumption).
 * - Sends `lv:attach` on mount and `lv:detach` on unmount.
 * - Forwards `lv:mouse` / `lv:key` to the server via the provided `send` fn.
 *
 * C-001: This component only relays the human's input — it never attempts to
 * solve the challenge itself.
 *
 * NOTE: The coordinate-mapping helper `mapCanvasToPage` is a pure exported
 * function so WP07's Playwright e2e can import and assert it directly.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { LvClientMessage, LvFrameMetadata } from '../types';

export interface LiveViewProps {
  runId: string;
  send: (msg: LvClientMessage) => void;
}

/**
 * Map a canvas client coordinate to a page pixel coordinate.
 *
 * The canvas is styled to fill its container and may be scaled relative to the
 * device dimensions reported in the screencast frame metadata (R4). We compute
 * the ratio between the canvas rendered size and the device viewport size, then
 * invert that scale to get page coords.
 *
 * @param clientX - pointer X in canvas client space (from mouse event)
 * @param clientY - pointer Y in canvas client space (from mouse event)
 * @param canvasWidth - canvas element's current clientWidth in CSS pixels
 * @param canvasHeight - canvas element's current clientHeight in CSS pixels
 * @param meta - frame metadata carrying device dimensions and pageScaleFactor
 */
export function mapCanvasToPage(
  clientX: number,
  clientY: number,
  canvasWidth: number,
  canvasHeight: number,
  meta: LvFrameMetadata,
): { x: number; y: number } {
  // Scale factors: how many device pixels per CSS pixel of canvas
  const scaleX = canvasWidth > 0 ? meta.deviceWidth / canvasWidth : 1;
  const scaleY = canvasHeight > 0 ? meta.deviceHeight / canvasHeight : 1;

  // CDP Input.dispatchMouseEvent expects CSS/page pixels, not device pixels.
  // Divide device coords by pageScaleFactor (device-pixel-ratio).
  const psf = meta.pageScaleFactor > 0 ? meta.pageScaleFactor : 1;

  const pageX = (clientX * scaleX) / psf;
  // offsetTop accounts for any fixed chrome above the scrollable viewport
  const pageY = (clientY * scaleY - meta.offsetTop) / psf;

  return { x: Math.round(pageX), y: Math.round(pageY) };
}

/** CDP modifier bitmask from a keyboard/mouse event. */
function modifiersFromEvent(ev: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  let mod = 0;
  if (ev.altKey) mod |= 1;
  if (ev.ctrlKey) mod |= 2;
  if (ev.metaKey) mod |= 4;
  if (ev.shiftKey) mod |= 8;
  return mod;
}

export function LiveView({ runId, send }: Readonly<LiveViewProps>) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const metaRef = useRef<LvFrameMetadata | null>(null);

  // Send lv:attach on mount, lv:detach on unmount.
  useEffect(() => {
    send({ t: 'lv:attach', runId });
    return () => {
      send({ t: 'lv:detach', runId });
    };
  }, [runId, send]);

  // Listen for lv:frame messages on the global WS event stream.
  // We subscribe directly to the raw socket messages via a custom event so we
  // can handle the high-frequency `t` field (not a RunEvent) without modifying
  // the existing RunEvent discriminated union.
  useEffect(() => {
    function onWsMessage(rawEv: Event) {
      const ev = rawEv as CustomEvent<string>;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.detail);
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== 'object') return;
      const msg = parsed as Record<string, unknown>;
      if (msg['t'] !== 'lv:frame' || msg['runId'] !== runId) return;

      const meta = msg['metadata'] as LvFrameMetadata | undefined;
      const dataB64 = msg['dataB64'] as string | undefined;
      if (!meta || !dataB64) return;

      metaRef.current = meta;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const img = new Image();
      img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);
      };
      img.src = `data:image/jpeg;base64,${dataB64}`;
    }

    globalThis.addEventListener('lv-ws-message', onWsMessage);
    return () => {
      globalThis.removeEventListener('lv-ws-message', onWsMessage);
    };
  }, [runId]);

  const getPageCoords = useCallback((ev: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const meta = metaRef.current;
    if (!canvas || !meta) return null;
    const rect = canvas.getBoundingClientRect();
    const clientX = ev.clientX - rect.left;
    const clientY = ev.clientY - rect.top;
    return mapCanvasToPage(clientX, clientY, rect.width, rect.height, meta);
  }, []);

  const cdpButton = useCallback((ev: React.MouseEvent): 'left' | 'right' | 'middle' | 'none' => {
    if (ev.button === 0) return 'left';
    if (ev.button === 1) return 'middle';
    if (ev.button === 2) return 'right';
    return 'none';
  }, []);

  const onMouseDown = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      const coords = getPageCoords(ev);
      if (!coords) return;
      send({
        t: 'lv:mouse',
        runId,
        event: 'mousePressed',
        x: coords.x,
        y: coords.y,
        button: cdpButton(ev),
        buttons: ev.buttons,
        clickCount: 1,
        modifiers: modifiersFromEvent(ev),
      } as LvClientMessage);
    },
    [runId, send, getPageCoords, cdpButton],
  );

  const onMouseUp = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      const coords = getPageCoords(ev);
      if (!coords) return;
      send({
        t: 'lv:mouse',
        runId,
        event: 'mouseReleased',
        x: coords.x,
        y: coords.y,
        button: cdpButton(ev),
        buttons: ev.buttons,
        clickCount: 1,
        modifiers: modifiersFromEvent(ev),
      } as LvClientMessage);
    },
    [runId, send, getPageCoords, cdpButton],
  );

  const onMouseMove = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      const coords = getPageCoords(ev);
      if (!coords) return;
      send({
        t: 'lv:mouse',
        runId,
        event: 'mouseMoved',
        x: coords.x,
        y: coords.y,
        button: cdpButton(ev),
        buttons: ev.buttons,
        modifiers: modifiersFromEvent(ev),
      } as LvClientMessage);
    },
    [runId, send, getPageCoords, cdpButton],
  );

  const onWheel = useCallback(
    (ev: React.WheelEvent<HTMLCanvasElement>) => {
      const coords = getPageCoords(ev);
      if (!coords) return;
      send({
        t: 'lv:mouse',
        runId,
        event: 'mouseWheel',
        x: coords.x,
        y: coords.y,
        deltaX: ev.deltaX,
        deltaY: ev.deltaY,
        modifiers: modifiersFromEvent(ev),
      } as LvClientMessage);
    },
    [runId, send, getPageCoords],
  );

  const onKeyDown = useCallback(
    (ev: React.KeyboardEvent<HTMLCanvasElement>) => {
      ev.preventDefault();
      send({
        t: 'lv:key',
        runId,
        event: 'keyDown',
        key: ev.key,
        code: ev.code,
        modifiers: modifiersFromEvent(ev),
      } as LvClientMessage);
      // Also send a char event for printable characters (CDP requires it).
      if (ev.key.length === 1) {
        send({
          t: 'lv:key',
          runId,
          event: 'char',
          text: ev.key,
          modifiers: modifiersFromEvent(ev),
        } as LvClientMessage);
      }
    },
    [runId, send],
  );

  const onKeyUp = useCallback(
    (ev: React.KeyboardEvent<HTMLCanvasElement>) => {
      ev.preventDefault();
      send({
        t: 'lv:key',
        runId,
        event: 'keyUp',
        key: ev.key,
        code: ev.code,
        modifiers: modifiersFromEvent(ev),
      } as LvClientMessage);
    },
    [runId, send],
  );

  return (
    <canvas
      ref={canvasRef}
      className="liveview-canvas"
      tabIndex={0}
      aria-label="Interactive browser view — solve the challenge here"
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onMouseMove={onMouseMove}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      style={{ cursor: 'crosshair', outline: 'none', width: '100%', display: 'block' }}
    />
  );
}
