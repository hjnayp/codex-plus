import net from "node:net";
import { DEFAULT_CDP_PORT, validPort } from "./config.ts";
import type { Config } from "./config.ts";
import { readJson, writeJsonAtomic } from "./system.ts";

type Listener = (params: any) => void;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export class CdpClient {
  readonly webSocketUrl: string;
  socket: WebSocket | null = null;
  /// 当前生效的 Page.addScriptToEvaluateOnNewDocument 标识，替换注入脚本时移除旧的。
  injectedScriptId: string | null = null;
  sequence = 0;
  pending = new Map<number, Pending>();
  listeners = new Map<string, Listener[]>();

  constructor(webSocketUrl: string) {
    this.webSocketUrl = webSocketUrl;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const socket = new WebSocket(this.webSocketUrl);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("CDP websocket connection timed out"));
      }, 5000);
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("CDP websocket connection failed")); };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) {
        for (const listener of this.listeners.get(message.method) || []) {
          try { listener(message.params || {}); } catch { /* 事件监听不能打断 CDP 响应。 */ }
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
      else pending.resolve(message.result || {});
    });
    socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP websocket closed"));
      this.pending.clear();
    });
  }

  send(method: string, params: object = {}, { timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<any> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP websocket is not open"));
    }
    const commandTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, commandTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: Listener): () => void {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
    return () => {
      const current = this.listeners.get(method) || [];
      this.listeners.set(method, current.filter((item) => item !== listener));
    };
  }

  get open(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.listeners.clear();
    this.socket?.close();
  }
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = Number(typeof address === "object" ? address?.port : NaN);
      server.close((error) => {
        if (error) reject(error);
        else if (validPort(port)) resolve(port);
        else reject(new Error("无法分配安全的本机 CDP 端口"));
      });
    });
  });
}

function exceptionMessage(details: any): string {
  return details.exception?.description?.split("\n")[0] || details.text || "Codex 页面脚本执行失败";
}

/// 本机回环 CDP 端点：持有当前端口，负责端口选择、页面发现与一次性页面求值。
export class CdpEndpoint {
  readonly #config: Config;
  readonly #requestedPort: number;
  #port: number;

  constructor(config: Config) {
    this.#config = config;
    this.#requestedPort = config.configuredPort ?? DEFAULT_CDP_PORT;
    this.#port = this.#requestedPort;
  }

  get port(): number {
    return this.#port;
  }

  /// 未显式配置端口时沿用记住的端口；显式配置时只沿用为该端口选出的替代端口。
  async loadRememberedPort(): Promise<void> {
    const remembered = await readJson(this.#config.stateFiles.port);
    if (validPort(remembered?.port)
      && (this.#config.configuredPort == null || Number(remembered.requested_port) === this.#requestedPort)) {
      this.#port = Number(remembered.port);
    }
  }

  /// 端口被其他进程占用时换成安全端口并记住；返回是否发生了切换。
  async ensureAvailablePort(): Promise<boolean> {
    if (await this.ready() || await portAvailable(this.#port)) return false;
    const occupiedPort = this.#port;
    this.#port = await findAvailablePort();
    await writeJsonAtomic(this.#config.stateFiles.port, {
      port: this.#port,
      requested_port: occupiedPort,
      selected_at: new Date().toISOString(),
    });
    console.log(`${this.#config.commandName}: 本机端口 ${occupiedPort} 已被占用，已切换到安全端口 ${this.#port}`);
    return true;
  }

  async targets(): Promise<CdpTarget[]> {
    const response = await fetch(`http://127.0.0.1:${this.#port}/json/list`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    const targets = await response.json();
    return Array.isArray(targets) ? targets.filter((target) => (
      target.type === "page"
      && String(target.url || "").startsWith("app://-/index.html")
      && !String(target.url || "").includes("initialRoute=")
    )) : [];
  }

  async ready(): Promise<boolean> {
    try {
      await this.targets();
      return true;
    } catch {
      return false;
    }
  }
}

/// 连接单个页面执行一次表达式并取回值；页面异常转成错误。
export async function evaluateInPage(target: CdpTarget, expression: string, timeoutMs: number): Promise<any> {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.connect();
    const response = await client.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, { timeoutMs });
    if (response.exceptionDetails) throw new Error(exceptionMessage(response.exceptionDetails));
    return response.result?.value;
  } finally {
    client.close();
  }
}
