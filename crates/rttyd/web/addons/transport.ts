import { Terminal, type IDisposable, type ITerminalAddon } from 'xterm';
import { TrzszFilter } from './trzsz/filter';
import * as Base64 from "base64-js";

function createSocket() {
  const endpoint = `${window.location.origin.replace(/^http/, 'ws')}/ws`;
  const socket = new WebSocket(endpoint);
  socket.binaryType = 'arraybuffer';

  return socket;
}

export class TransportAddon implements ITerminalAddon {
  private socket?: WebSocket
  private terminal?: Terminal;
  private trzsz?: TrzszFilter;
  private disposables: IDisposable[] = [];

  public activate(terminal: Terminal): void {
    terminal.clear();
    terminal.focus();

    this.socket = createSocket();
    this.terminal = terminal;

    const writeToTerminal = (data: string | ArrayBuffer | Uint8Array | Blob) => {
      if (data instanceof Blob) {
        data.arrayBuffer().then((buffer) => {
          terminal.write(new Uint8Array(buffer));
        }).catch((err) => {
          console.error('Failed to write to terminal', err);
        });
      } else {
        terminal.write(typeof data === "string" ? data : new Uint8Array(data));
      }
    };
    const sendToServer = (data: string | Uint8Array) => {
      if (!this.checkOpenSocket()) return;
      if (typeof data === 'string') {
        this.socket?.send(`1;${data}`);
      } else {
        this.socket?.send(data);
      }
    };
    this.trzsz = new TrzszFilter({
      writeToTerminal,
      sendToServer,
      terminalColumns: terminal.cols,
      isWindowsShell: false,
    });

    this.disposables = [];
    this.disposables.push(addSocketListener(this.socket, 'open', () => this.onSocketOpen()));
    this.disposables.push(addSocketListener(this.socket, 'close', () => {
      setTimeout(() => this.terminal?.write('\r\n\x1B[90mDisconnected from server.\x1B[0m'), 200);
      this.dispose();
    }));
    this.disposables.push(addSocketListener(this.socket, 'error', () => {
      setTimeout(() => this.terminal?.write('\r\n\x1B[90mConnection failed with error.\x1B[0m'), 200);
      this.dispose();
    }));
    this.disposables.push(addSocketListener(this.socket, 'message', (ev) => this.onSocketMessage(ev)));
    this.disposables.push(terminal.onData((data) => this.trzsz?.processTerminalInput(data)));
    this.disposables.push(terminal.onBinary((data) => this.trzsz?.processBinaryInput(data)));
    this.disposables.push(terminal.onResize((size) => this.trzsz?.setTerminalColumns(size.cols)));
    this.disposables.push(addWindowListener('resize', () => this.sendResize()));
  }

  public dispose(): void {
    this.terminal?.blur();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private onSocketOpen(): void {
    setTimeout(() => {
      if (!this.checkOpenSocket()) {
        setTimeout(() => this.onSocketOpen(), 1000);
        return;
      }
      this.sendResize();
      this.disposables.push(this.terminal!.onResize(() => this.sendResize()));
      this.terminal?.focus();
    }, 20);
  }

  private onSocketMessage(ev: MessageEvent): void {
    const data: ArrayBuffer | string = ev.data;
    if (typeof data === 'string') {
      if (data.startsWith('0;')) {
        this.trzsz?.processServerOutput(Base64.toByteArray(data.slice(2)));
      } else if (data.startsWith('1;')) {
        this.trzsz?.processServerOutput(data.slice(2));
      }
    } else {
      this.trzsz?.processServerOutput(data);
    }
  }

  private sendResize(): void {
    if (!this.checkOpenSocket()) return;
    if (this.terminal == null) return;
    this.socket?.send(`2;${Math.round(this.terminal.rows)};${Math.round(this.terminal.cols)}`);
  }

  private checkOpenSocket(): boolean {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return true;
    }
    console.warn(new Error(`Socket state is: ${this.socket?.readyState}`));
    return false;
  }
}

function addSocketListener<K extends keyof WebSocketEventMap>(socket: WebSocket, type: K, handler: (this: WebSocket, ev: WebSocketEventMap[K]) => any): IDisposable {
  socket.addEventListener(type, handler);
  let disposed = false;
  return {
    dispose: () => {
      if (!handler || disposed) {
        // Already disposed
        return;
      }

      disposed = true;
      socket.removeEventListener(type, handler);
    }
  };
}

function addWindowListener<K extends keyof WindowEventMap>(type: K, handler: (this: Window, ev: WindowEventMap[K]) => any, options?: boolean | AddEventListenerOptions): IDisposable {
  window.addEventListener(type, handler, options);
  let disposed = false;
  return {
    dispose: () => {
      if (!handler || disposed) {
        // Already disposed
        return;
      }

      disposed = true;
      window.removeEventListener(type, handler);
    }
  };
}
