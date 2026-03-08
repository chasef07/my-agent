// twilio-transport.ts — Typed wrapper around Twilio's Media Streams WebSocket
// Isolates Twilio's JSON message format from all other concerns.

import type { WebSocket } from "ws";

// Twilio WebSocket event types
interface TwilioStartEvent {
  event: "start";
  start: {
    streamSid: string;
    callSid: string;
    accountSid: string;
    mediaFormat: { encoding: string; sampleRate: number; channels: number };
  };
}

interface TwilioMediaEvent {
  event: "media";
  media: {
    payload: string;
    timestamp: string;
    chunk: string;
  };
}

interface TwilioStopEvent {
  event: "stop";
  stop: { accountSid: string; callSid: string };
}

type TwilioEvent =
  | { event: "connected" }
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioStopEvent;

export class TwilioTransport {
  private socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;

    socket.on("message", (data: Buffer) => {
      const event: TwilioEvent = JSON.parse(data.toString());

      switch (event.event) {
        case "start":
          this._onStart?.(event.start.streamSid, event.start.callSid);
          break;
        case "media":
          this._onMedia?.(event.media.payload);
          break;
        case "stop":
          this._onStop?.();
          break;
      }
    });

    socket.on("close", () => this._onClose?.());
    socket.on("error", (err: Error) => this._onError?.(err));
  }

  sendAudio(streamSid: string, base64: string): void {
    this.socket.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64 } }));
  }

  clearAudio(streamSid: string): void {
    this.socket.send(JSON.stringify({ event: "clear", streamSid }));
  }

  // --- Callback registration ---

  private _onStart: ((streamSid: string, callSid: string) => void) | null = null;
  private _onMedia: ((payload: string) => void) | null = null;
  private _onStop: (() => void) | null = null;
  private _onClose: (() => void) | null = null;
  private _onError: ((err: Error) => void) | null = null;

  onStart(cb: (streamSid: string, callSid: string) => void): void { this._onStart = cb; }
  onMedia(cb: (payload: string) => void): void { this._onMedia = cb; }
  onStop(cb: () => void): void { this._onStop = cb; }
  onClose(cb: () => void): void { this._onClose = cb; }
  onError(cb: (err: Error) => void): void { this._onError = cb; }
}
