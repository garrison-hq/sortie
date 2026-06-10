/**
 * Singleton WebSocket client for the server's /api/events stream.
 *
 * - Lazily connected on first subscription; auto-reconnects with a fixed
 *   2s backoff whenever the socket closes or errors.
 * - Frames are JSON-parsed behind a guard; malformed frames are dropped.
 * - Listener exceptions never disturb the socket or other listeners.
 */
import { useEffect, useRef, useState } from 'react';
import type { RunEvent } from './types';

const RECONNECT_DELAY_MS = 2000;

type EventListener = (ev: RunEvent) => void;
type StatusListener = (connected: boolean) => void;

let started = false;
let connected = false;
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const eventListeners = new Set<EventListener>();
const statusListeners = new Set<StatusListener>();

function isRunEvent(value: unknown): value is RunEvent {
  if (value === null || typeof value !== 'object') return false;
  const ev = value as Record<string, unknown>;
  return typeof ev['type'] === 'string' && typeof ev['runId'] === 'string';
}

function setConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  for (const listener of [...statusListeners]) {
    try {
      listener(next);
    } catch {
      // status listeners must never disturb the socket
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

function connect(): void {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${proto}//${window.location.host}/api/events`);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    setConnected(true);
  };

  ws.onmessage = (msg: MessageEvent) => {
    if (typeof msg.data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.data);
    } catch {
      return; // malformed frame — drop it
    }
    if (!isRunEvent(parsed)) return;
    for (const listener of [...eventListeners]) {
      try {
        listener(parsed);
      } catch {
        // event listeners must never disturb the socket
      }
    }
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
    setConnected(false);
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws.close();
  };
}

function ensureSocket(): void {
  if (started) return;
  started = true;
  connect();
}

/** Subscribe to live RunEvents; returns an unsubscribe function. */
export function subscribeEvents(listener: EventListener): () => void {
  ensureSocket();
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

/**
 * Subscribe to connection state changes; the listener is invoked immediately
 * with the current state. Returns an unsubscribe function.
 */
export function subscribeStatus(listener: StatusListener): () => void {
  ensureSocket();
  statusListeners.add(listener);
  listener(connected);
  return () => {
    statusListeners.delete(listener);
  };
}

/** React hook: live RunEvent feed. The handler is kept fresh via a ref. */
export function useRunEvents(handler: EventListener): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => subscribeEvents((ev) => handlerRef.current(ev)), []);
}

/** React hook: current WS connection state (true = connected). */
export function useWsConnected(): boolean {
  const [value, setValue] = useState(connected);
  useEffect(() => subscribeStatus(setValue), []);
  return value;
}
