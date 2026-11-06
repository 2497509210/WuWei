import { vi } from "vitest";

/** Network-boundary double: the real upload API constructs and drives this XHR. */
export class FakeXHR extends EventTarget {
  static instances: FakeXHR[] = [];
  static onSend: ((request: FakeXHR) => void) | null = null;
  static get latest(): FakeXHR { return this.instances[this.instances.length - 1]; }
  static reset() { this.instances = []; this.onSend = null; }

  upload = new EventTarget();
  status = 0;
  statusText = "";
  responseText = "";
  responseType = "";
  withCredentials = false;
  timeout = 0;
  readyState = 0;
  method = "";
  url = "";
  body: Document | XMLHttpRequestBodyInit | null = null;
  headers: Record<string, string> = {};
  responseHeaders: Record<string, string> = {};
  aborted = false;
  transportSignal = new AbortController();

  constructor() { super(); FakeXHR.instances.push(this); }
  open(method: string, url: string | URL) { this.method = method; this.url = String(url); this.readyState = 1; }
  setRequestHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; }
  getResponseHeader(name: string) { return this.responseHeaders[name.toLowerCase()] ?? null; }
  send(body: Document | XMLHttpRequestBodyInit | null = null) {
    this.body = body;
    FakeXHR.onSend?.(this);
  }
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.transportSignal.abort();
    this.dispatchEvent(new ProgressEvent("abort"));
  }
  emitUploadProgress(loaded: number, total = 0, lengthComputable = false) {
    this.upload.dispatchEvent(new ProgressEvent("progress", { loaded, total, lengthComputable }));
  }
  completeUpload(loaded = 0, total = 0, lengthComputable = false) {
    this.upload.dispatchEvent(new ProgressEvent("load", { loaded, total, lengthComputable }));
  }
  respond(status: number, body: unknown, raw = false) {
    this.status = status;
    this.responseText = raw ? String(body) : JSON.stringify(body);
    this.readyState = 4;
    this.dispatchEvent(new ProgressEvent("load"));
  }
  fail() { this.dispatchEvent(new ProgressEvent("error")); }
}

export function installFakeXHR(): typeof FakeXHR {
  FakeXHR.reset();
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  return FakeXHR;
}

/** Preserve existing component tests' fetch fixtures while exercising real XHR API code. */
export function installFetchXHRBridge(options: { completeUpload?: boolean } = {}): typeof FakeXHR {
  installFakeXHR();
  FakeXHR.onSend = request => {
    if (options.completeUpload !== false) request.completeUpload();
    void globalThis.fetch(request.url, {
      method: request.method,
      body: request.body as BodyInit,
      credentials: request.withCredentials ? "include" : "same-origin",
      signal: request.transportSignal.signal,
    }).then(async response => {
      const body = await response.json();
      if (!request.aborted) request.respond(response.status, body);
    }).catch(() => { if (!request.aborted) request.fail(); });
  };
  return FakeXHR;
}
