/**
 * trzsz: https://github.com/trzsz/trzsz.js
 * Copyright(c) 2022 Lonny Wong <lonnywong@qq.com>
 * @license MIT
 */

import Pako from "pako";
import * as Base64 from "base64-js";

/**
 * trzsz version injected by rollup-plugin-version-injector
 */
export const trzszVersion = "[VersionInject]{version}[/VersionInject]";

/* eslint-disable require-jsdoc */

export const isRunningInWindows = (function () {
  try {
    return process.platform === "win32";
  } catch (err) {
    return false;
  }
})();

export function strToUint8(str: string): Uint8Array {
  return Uint8Array.from(str, (v) => v.charCodeAt(0));
}

export async function uint8ToStr(buf: Uint8Array, encoding: BufferEncoding = "binary"): Promise<string> {
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    if (encoding == "binary") {
      reader.readAsBinaryString(new Blob([buf]));
    } else {
      reader.readAsText(new Blob([buf]), encoding);
    }
  });
}

export function strToArrBuf(str: string) {
  return strToUint8(str).buffer;
}

export function encodeBuffer(buf: string | Uint8Array): string {
  const buffer = Pako.deflate(buf);
  return Base64.fromByteArray(buffer);
}

export function decodeBuffer(buf: string): Uint8Array {
  const buffer = Base64.toByteArray(buf);
  return Pako.inflate(buffer);
}

export class TrzszError extends Error {
  private readonly type: string | null;
  private readonly trace: boolean;

  constructor(message: string, type: string | null = null, trace: boolean = false) {
    if (type === "fail" || type === "FAIL" || type === "EXIT") {
      try {
        message = new TextDecoder().decode(decodeBuffer(message));
      } catch (err) {
        message = `decode [${message}] error: ${err}`;
      }
    } else if (type) {
      message = `[TrzszError] ${type}: ${message}`;
    }

    super(message);
    Object.setPrototypeOf(this, TrzszError.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TrzszError);
    }

    this.name = "TrzszError";
    this.type = type;
    this.trace = trace;
  }

  public isTraceBack() {
    if (this.type === "fail" || this.type === "EXIT") {
      return false;
    }
    return this.trace;
  }

  public isRemoteExit() {
    return this.type === "EXIT";
  }

  public isRemoteFail() {
    return this.type === "fail" || this.type === "FAIL";
  }

  public isStopAndDelete() {
    if (this.type !== "fail") {
      return false;
    }
    return this.message === "Stopped and deleted";
  }

  public static getErrorMessage(err: Error) {
    if (err instanceof TrzszError && !err.isTraceBack()) {
      return err.message;
    }
    if (err.stack) {
      return err.stack.replace("TrzszError: ", "");
    }
    return err.toString();
  }
}

export interface TrzszFile {
  closeFile: () => void;
}

export interface TrzszFileReader extends TrzszFile {
  getPathId: () => number;
  getRelPath: () => string[];
  isDir: () => boolean;
  getSize: () => number;
  readFile: (buf: ArrayBuffer) => Promise<Uint8Array>;
}

export interface TrzszFileWriter extends TrzszFile {
  getFileName: () => string;
  getLocalName: () => string;
  isDir: () => boolean;
  writeFile: (buf: Uint8Array) => Promise<void>;
  deleteFile: () => Promise<string>;
}

export type OpenSaveFile = (
  saveParam: any,
  fileName: string,
  directory: boolean,
  overwrite: boolean,
) => Promise<TrzszFileWriter>;

export interface ProgressCallback {
  onNum: (num: number) => void;
  onName: (name: string) => void;
  onSize: (size: number) => void;
  onStep: (step: number) => void;
  onDone: () => void;
}

export function checkDuplicateNames(files: TrzszFileReader[]) {
  const names = new Set();
  for (const file of files) {
    const path = file.getRelPath().join("/");
    if (names.has(path)) {
      throw new TrzszError(`Duplicate name: ${path}`);
    }
    names.add(path);
  }
}

export function isVT100End(c: number): boolean {
  if (0x61 <= c && c <= 0x7a) {
    // 'a' <= c && c <= 'z'
    return true;
  }
  if (0x41 <= c && c <= 0x5a) {
    // 'A' <= c && c <= 'Z'
    return true;
  }
  return false;
}

export function stripServerOutput(output: string | ArrayBuffer | Uint8Array | Blob) {
  let uint8: Uint8Array;
  if (typeof output === "string") {
    uint8 = strToUint8(output);
  } else if (output instanceof ArrayBuffer) {
    uint8 = new Uint8Array(output);
  } else if (output instanceof Uint8Array) {
    uint8 = output;
  } else {
    return output;
  }
  const buf = new Uint8Array(uint8.length);
  let skipVT100 = false;
  let idx = 0;
  for (let i = 0; i < uint8.length; i++) {
    const c = uint8[i]!;
    if (skipVT100) {
      if (isVT100End(c)) {
        skipVT100 = false;
      }
    } else if (c == 0x1b) {
      skipVT100 = true;
    } else {
      buf[idx++] = c;
    }
  }
  while (idx > 0) {
    const c = buf[idx - 1];
    if (c != 0x0d && c != 0x0a) {
      // not \r\n
      break;
    }
    idx--;
  }
  const result = buf.subarray(0, idx);
  if (result.length > 100) {
    return output;
  }
  return String.fromCharCode.apply(null, Array.from(result));
}

export const TmuxMode = {
  NoTmux: 0,
  TmuxNormalMode: 1,
  TmuxControlMode: 2,
};

export function formatSavedFiles(fileNames: string[], destPath: string): string {
  let msg = `Saved ${fileNames.length} ${fileNames.length > 1 ? "files/directories" : "file/directory"}`;
  if (destPath.length > 0) {
    msg += ` to ${destPath}`;
  }
  return [msg].concat(fileNames).join("\r\n- ");
}

export function stripTmuxStatusLine(buf: string): string {
  while (true) {
    const beginIdx = buf.indexOf("\x1bP=");
    if (beginIdx < 0) {
      return buf;
    }
    let bufIdx = beginIdx + 3;
    const midIdx = buf.substring(bufIdx).indexOf("\x1bP=");
    if (midIdx < 0) {
      return buf.substring(0, beginIdx);
    }
    bufIdx += midIdx + 3;
    const endIdx = buf.substring(bufIdx).indexOf("\x1b\\");
    if (endIdx < 0) {
      return buf.substring(0, beginIdx);
    }
    bufIdx += endIdx + 2;
    buf = buf.substring(0, beginIdx) + buf.substring(bufIdx);
  }
}
