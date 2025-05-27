import { Terminal, type IDisposable, type ITerminalAddon } from 'xterm';

function createSocket() {
  const endpoint = `${window.location.origin.replace(/^http/, 'ws')}/ws`;
  const socket = new WebSocket(endpoint);
  socket.binaryType = 'arraybuffer';

  return socket;
}

export class TransportAddon implements ITerminalAddon {
  private socket?: WebSocket
  private terminal?: Terminal;
  private disposables: IDisposable[] = [];

  public activate(terminal: Terminal): void {
    terminal.clear();
    terminal.focus();

    this.socket = createSocket();
    this.terminal = terminal;

    this.disposables = [];
    this.disposables.push(addSocketListener(this.socket, 'open', () => this.onSocketOpen()));
    this.disposables.push(addSocketListener(this.socket, 'message', (ev) => this.onSocketMessage(ev)));
    this.disposables.push(addSocketListener(this.socket, 'close', () => {
      setTimeout(() => this.terminal?.write('\r\n\x1B[90mDisconnected from server.\x1B[0m'), 200);
      this.dispose();
    }));
    this.disposables.push(terminal.onData(data => this.sendData(data)));
    this.disposables.push(terminal.onBinary(data => this.sendBinary(data)));
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
        this.terminal?.write(b64DecodeUnicode(data.slice(2)));
      } else if (data.startsWith('1;')) {
        this.terminal?.write(data.slice(2));
      }
    } else {
      this.terminal?.write(new Uint8Array(data));
    }
  }

  private sendData(data: string): void {
    if (!this.checkOpenSocket()) {
      return;
    }
    this.socket?.send(`1;${data}`);
  }

  private sendResize(): void {
    if (!this.checkOpenSocket()) return;
    if (this.terminal == null) return;
    this.socket?.send(`2;${Math.round(this.terminal.rows)};${Math.round(this.terminal.cols)}`);
  }

  private sendBinary(data: string): void {
    if (!this.checkOpenSocket()) return;
    const buffer = new Uint8Array(data.length);
    for (let i = 0; i < data.length; ++i) {
      buffer[i + 2] = data.charCodeAt(i) & 255;
    }
    this.socket?.send(buffer);
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

function b64DecodeUnicode(str: string) {
  return decodeURIComponent(Array.prototype.map.call(atob(str), function (c) {
    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
  }).join(''))
}
