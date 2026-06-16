# Contract: Live-view WebSocket protocol (screencast + input)

A higher-frequency message family carried on the **existing** `/api/events` WebSocket,
separate from the run-event log. All messages are zod-validated. Active **only** while the
target run is `awaiting_human` (NFR-004). Today the WS is server→client only; this adds a
client→server direction scoped to live view.

## Authorization & scoping (enforced — C-003/C-004, R9)

- Live-view traffic is accepted only on the authenticated UI connection (local-first trust
  model; see R9 deployment caveat).
- A connection must first send `live-view:attach { runId }`; the server binds **one**
  `LiveViewSession` to that connection for that run. Input is rejected unless the run is
  `awaiting_human` and owned by the requesting connection.
- Navigation initiated via forwarded input is constrained to the run's current origin.

## Server → client

```ts
// stream control
{
  t: 'lv:started';
  runId: string;
  viewport: {
    width: number;
    height: number;
  }
}
{
  t: 'lv:frame';
  runId: string;
  seq: number;
  dataB64: string; // JPEG/PNG frame
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
  }
} // for coord mapping (R4)
{
  t: 'lv:stopped';
  runId: string;
  reason: 'resumed' | 'cancelled' | 'timeout' | 'error';
}
```

Frames originate from CDP `Page.screencastFrame`; the server acks CDP with
`Page.screencastFrameAck` after forwarding (backpressure-aware: drop to latest frame if the
client lags).

## Client → server

```ts
{ t: 'lv:attach';  runId: string }
{ t: 'lv:detach';  runId: string }

// input — coordinates already mapped to page pixels by the client (R4)
{ t: 'lv:mouse';   runId: string;
    event: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
    x: number; y: number; button?: 'left'|'right'|'middle'|'none';
    buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number }
{ t: 'lv:key';     runId: string;
    event: 'keyDown' | 'keyUp' | 'char';
    key?: string; code?: string; text?: string; modifiers?: number }

// control
{ t: 'lv:resume';  runId: string }     // manual Resume (R3)
{ t: 'lv:cancel';  runId: string }     // operator Cancel
```

Server maps `lv:mouse`/`lv:key` to CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent`.
Malformed/unauthorized/while-not-paused messages are dropped and logged (never throw across
the socket).

## Validation rules

- `runId` must match the connection's attached `LiveViewSession`.
- Input messages dropped unless run status is `awaiting_human`.
- `dataB64` never logged; frames not persisted (beyond existing screenshot capture).
- One live-view session per connection; attaching a second run replaces the first.
