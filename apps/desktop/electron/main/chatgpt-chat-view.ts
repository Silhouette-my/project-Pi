import { app, BrowserWindow, ipcMain, WebContentsView, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { getModuleDirectory } from "./module-path";
import { authStatusScript, conversationScript, streamPayload, trustedChatGptUrl, type ChatGptAuthStatus } from "./chatgpt-chat-page";
import { chatGptDocumentEndpoint, logChatGptDocumentEvent, logChatGptConversationEvent } from "./chatgpt-chat-diagnostics";
import { importPreviousChatLogin } from "./chatgpt-login-import";

type Notify = (method: string, params: Record<string, unknown>) => void;
const STREAM_CHANNEL = "pi-desktop/chatgpt-chat/stream";

export class ChatGptChatView {
  private view: WebContentsView | null = null;
  private loading: Promise<void> | null = null;
  private loginWindow: BrowserWindow | null = null;
  private offscreen = true;
  private loginPromise: Promise<ChatGptAuthStatus> | null = null;
  private statusPromise: Promise<ChatGptAuthStatus> | null = null;
  private backendDiagnosticNeeded = true;
  private authenticatedDiagnosticNeeded = true;
  private authEpoch = 0;
  private diagnosticChecks: NonNullable<ChatGptAuthStatus["diagnostic"]>["checks"];
  private pending = new Map<string, Notify>();
  private active = new Set<Notify>();
  private disposed = false;
  private loggingOut = false;
  private headers: Record<string, string> = {};
  private documentStatus: ChatGptAuthStatus | null = null;
  private documentTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    ipcMain.on(STREAM_CHANNEL, this.onStream);
  }

  private retireBrowser(): void {
    const view = this.view;
    this.view = null;
    this.loading = null;
    this.authEpoch++;
    this.backendDiagnosticNeeded = true;
    this.authenticatedDiagnosticNeeded = true;
    this.diagnosticChecks = undefined;
    this.documentStatus = null;
    this.headers = {};
    if (this.documentTimer) clearTimeout(this.documentTimer);
    view?.webContents.close();
  }

  private documentNeedsUserAction(): boolean { return this.documentStatus?.state === "error" || this.documentStatus?.state === "challenge"; }

  private onStream = (event: IpcMainEvent, raw: unknown): void => {
    const wc = this.view?.webContents;
    if (!wc || event.sender !== wc || !event.senderFrame || event.senderFrame !== wc.mainFrame || !trustedChatGptUrl(event.senderFrame.url)) return;
    const payload = streamPayload(raw);
    if (!payload) return;
    const notify = this.pending.get(payload.requestId);
    if (!notify) return;
    if (payload.type === "diagnostic") { logChatGptConversationEvent(payload); return; }
    const { type, ...params } = payload;
    if (type !== "chunk") {
      this.pending.delete(payload.requestId);
      this.active.delete(notify);
    }
    notify(`chatgpt.conversation.${type}`, params);
  };

  private async ready(): Promise<WebContentsView> {
    if (this.disposed) throw new Error("ChatGPT browser was closed.");
    if (!this.view) {
      this.documentStatus = null;
      const view = new WebContentsView({ webPreferences: {
        partition: "persist:chatgpt-chat", contextIsolation: true, sandbox: true,
        // Sentinel uses a hidden iframe. A never-attached normal view does not
        // schedule iframe animation frames; offscreen rendering does, without
        // creating a native host window or exposing the conversation document.
        offscreen: this.offscreen, backgroundThrottling: false,
        nodeIntegration: false, preload: join(getModuleDirectory(import.meta.url), "../preload/chatgpt-chat.cjs"),
      } });
      view.setBounds({ x: 0, y: 0, width: 1000, height: 780 });
      this.view = view;
      view.webContents.setWindowOpenHandler(({ url }) => {
        logChatGptDocumentEvent("popup_denied", { url });
        return { action: "deny" };
      });
      view.webContents.on("will-navigate", (event, url) => {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") event.preventDefault();
      });
      view.webContents.on("render-process-gone", (_event, details) => {
        if (this.view !== view) return;
        const reason = ["clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction"].includes(details?.reason) ? details.reason : "unknown";
        logChatGptDocumentEvent("render_gone", { url: view.webContents.getURL(), reason });
        const status: ChatGptAuthStatus = { loggedIn: false, state: "error", message: "The ChatGPT browser stopped rendering. Close and reopen login.", diagnostic: { endpoint: chatGptDocumentEndpoint(view.webContents.getURL()), status: null, contentType: null, reason: "document_render_gone" } };
        this.documentStatus = status;
        if (this.documentTimer) clearTimeout(this.documentTimer);
        this.failPending("ChatGPT browser process exited. Open login again.");
        this.loginWindow?.close();
        if (this.view === view) this.retireBrowser();
        this.documentStatus = status;
      });
      view.webContents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
        if (this.view === view && mainFrame && !inPlace) {
          logChatGptDocumentEvent("navigation", { url });
          this.documentStatus = null;
          if (this.documentTimer) clearTimeout(this.documentTimer);
          this.authEpoch++;
          this.backendDiagnosticNeeded = true;
          this.authenticatedDiagnosticNeeded = true;
          this.diagnosticChecks = undefined;
          this.failPending("ChatGPT page navigated during the request.", true);
        }
      });
      view.webContents.on("did-fail-load", (_event, errorCode, _description, url, mainFrame) => {
        if (this.view !== view || !mainFrame || errorCode === -3) return;
        logChatGptDocumentEvent("load_failed", { url, errorCode });
        if (errorCode === -379 && this.documentStatus?.state === "challenge") return;
        this.documentStatus = { loggedIn: false, state: "error", message: `The ChatGPT login page failed to load (network error ${errorCode}). Close and reopen login.`, diagnostic: { endpoint: chatGptDocumentEndpoint(url), status: null, contentType: null, reason: `document_load_failed_${errorCode}` } };
      });
      view.webContents.on("did-finish-load", () => {
        const epoch = this.authEpoch;
        if (this.documentTimer) clearTimeout(this.documentTimer);
        this.documentTimer = setTimeout(async () => {
          if (this.view !== view || epoch !== this.authEpoch || this.documentNeedsUserAction()) return;
          try {
            const empty = await view.webContents.executeJavaScript(`({ text: document.body?.innerText?.trim().length ?? 0, visuals: document.querySelectorAll('input,button,iframe,canvas,video,svg,[role="button"]').length })`);
            if (this.view !== view || epoch !== this.authEpoch || empty?.text !== 0 || empty?.visuals !== 0 || this.documentNeedsUserAction()) return;
            const url = view.webContents.getURL();
            logChatGptDocumentEvent("empty_document", { url, reason: "no_text_or_controls" });
            this.documentStatus = { loggedIn: false, state: "checking", message: "The ChatGPT login page has no visible content yet. If it stays blank, close and reopen login.", diagnostic: { endpoint: chatGptDocumentEndpoint(url), status: null, contentType: null, reason: "document_empty" } };
          } catch { /* Navigation may replace the page while its counts are read. */ }
        }, 3000);
      });
      view.webContents.session.webRequest.onCompleted({ urls: ["https://*/*"] }, (details) => {
        if (this.view !== view || details.webContentsId !== view.webContents.id) return;
        if (details.resourceType !== "mainFrame") {
          const endpoint = chatGptDocumentEndpoint(details.url);
          if (details.statusCode >= 400 && (endpoint.startsWith("https://chatgpt.com/api/auth/") || endpoint.startsWith("https://auth.openai.com/api/auth/"))) {
            logChatGptDocumentEvent("auth_response_failed", { url: details.url, status: details.statusCode });
          }
          return;
        }
        const header = Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === "content-type")?.[1]?.[0];
        const contentType = header?.split(";")[0]?.trim().toLowerCase() ?? null;
        logChatGptDocumentEvent("response", { url: details.url, status: details.statusCode, contentType });
        if (details.statusCode === 403 && contentType === "text/html") {
          this.documentStatus = { loggedIn: false, state: "challenge", message: "Complete verification in the ChatGPT login window.", diagnostic: { endpoint: chatGptDocumentEndpoint(details.url), status: details.statusCode, contentType, reason: "document_challenge" } };
        } else if (details.statusCode >= 400) {
          this.documentStatus = { loggedIn: false, state: "error", message: `The ChatGPT login page failed to load (HTTP ${details.statusCode}). Close and reopen login.`, diagnostic: { endpoint: chatGptDocumentEndpoint(details.url), status: details.statusCode, contentType, reason: "document_http_error" } };
        }
      });
      view.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      view.webContents.session.webRequest.onBeforeSendHeaders({ urls: ["https://chatgpt.com/backend-api/*"] }, (details, callback) => {
        for (const [key, value] of Object.entries(details.requestHeaders)) {
          if (["oai-client-version", "oai-client-build-number"].includes(key.toLowerCase())) this.headers[key] = value;
        }
        callback({ requestHeaders: details.requestHeaders });
      });
      this.loading = view.webContents.loadURL("https://chatgpt.com/");
    }
    const view = this.view;
    const loading = this.loading;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        loading,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("ChatGPT page load timed out."), { code: "CHATGPT_PAGE_LOAD_TIMEOUT" })), 30000);
        }),
      ]);
    }
    catch (error) {
      if (this.view === view && this.loading === loading && this.documentStatus?.state === "challenge") {
        this.loading = Promise.resolve();
        return view;
      }
      if (this.view === view && this.loading === loading) {
        view.webContents.close();
        this.view = null;
        this.loading = null;
      }
      throw error;
    } finally { if (timer) clearTimeout(timer); }
    if (this.disposed || this.view !== view || this.loading !== loading) throw new Error("ChatGPT browser is unavailable. Open login again.");
    return view;
  }

  status(): Promise<ChatGptAuthStatus> {
    if (this.loggingOut) return Promise.resolve({ loggedIn: false, state: "checking" });
    if (this.documentStatus?.state === "error" || this.documentStatus?.state === "challenge") return Promise.resolve(this.documentStatus);
    if (this.statusPromise) return this.statusPromise;
    this.statusPromise = this.probeStatus().finally(() => { this.statusPromise = null; });
    return this.statusPromise;
  }

  private async probeStatus(): Promise<ChatGptAuthStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const view = await this.ready();
      const epoch = this.authEpoch;
      if (this.documentStatus?.state === "challenge") return this.documentStatus;
      if (!trustedChatGptUrl(view.webContents.getURL())) return { loggedIn: false, state: "checking", diagnostic: { endpoint: "/api/auth/session", status: null, contentType: null, reason: "login_redirect" } };
      const result = await Promise.race([
        view.webContents.executeJavaScript(authStatusScript(this.backendDiagnosticNeeded, this.authenticatedDiagnosticNeeded)) as Promise<ChatGptAuthStatus>,
        new Promise<ChatGptAuthStatus>((resolve) => { timer = setTimeout(() => resolve({ loggedIn: false, state: "error", diagnostic: { endpoint: "/api/auth/session", status: null, contentType: null, reason: "page_probe_timeout" } }), 12000); }),
      ]);
      if (this.disposed || this.view !== view || this.authEpoch !== epoch) return { loggedIn: false, state: "checking", diagnostic: { endpoint: "/api/auth/session", status: null, contentType: null, reason: "page_changed" } };
      if (result.diagnostic?.checks) {
        this.backendDiagnosticNeeded = false;
        if (result.loggedIn) this.authenticatedDiagnosticNeeded = false;
        this.diagnosticChecks = result.diagnostic.checks;
      } else if (result.diagnostic && this.diagnosticChecks) {
        result.diagnostic.checks = this.diagnosticChecks;
      }
      if (!result.loggedIn && (result.state === "signed_out" || result.state === "checking") && this.documentStatus) return this.documentStatus;
      return result;
    } catch (error) {
      const timedOut = error instanceof Error && "code" in error && error.code === "CHATGPT_PAGE_LOAD_TIMEOUT";
      return { loggedIn: false, state: "error", diagnostic: { endpoint: "/api/auth/session", status: null, contentType: null, reason: timedOut ? "page_load_timeout" : "page_execution_error" } };
    } finally { if (timer) clearTimeout(timer); }
  }

  async executeAccountScript(script: string): Promise<unknown> {
    if (this.loggingOut || this.disposed) throw new Error("ChatGPT browser is unavailable.");
    if (!(await this.status()).loggedIn) throw new Error("Log in to ChatGPT in provider settings first.");
    const epoch = this.authEpoch;
    const view = await this.ready();
    if (this.loggingOut || this.disposed || epoch !== this.authEpoch) throw new Error("ChatGPT page changed during the request.");
    if (!trustedChatGptUrl(view.webContents.getURL())) throw new Error("ChatGPT login is still redirecting.");
    const result: unknown = await view.webContents.executeJavaScript(script);
    if (this.disposed || this.view !== view || epoch !== this.authEpoch) throw new Error("ChatGPT page changed during the request.");
    return result;
  }

  login(): Promise<ChatGptAuthStatus> {
    if (this.loginPromise) { this.loginWindow?.focus(); return this.loginPromise; }
    if (this.documentStatus?.state !== "challenge") {
      this.documentStatus = null;
    }
    this.backendDiagnosticNeeded = true;
    this.authenticatedDiagnosticNeeded = true;
    this.diagnosticChecks = undefined;
    this.loginPromise = this.showLogin().finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  async importLogin(): Promise<ChatGptAuthStatus> {
    if (this.disposed || this.loggingOut || this.loginPromise || this.pending.size) {
      throw new Error("Finish the current ChatGPT operation before importing a login.");
    }
    const current = await this.status();
    if (current.loggedIn) return current;
    if (this.disposed || this.loggingOut || this.loginPromise || this.pending.size) {
      throw new Error("Finish the current ChatGPT operation before importing a login.");
    }
    this.loggingOut = true;
    try {
      this.retireBrowser();
      await importPreviousChatLogin();
    } finally {
      this.loggingOut = false;
    }
    return this.status();
  }

  private async showLogin(): Promise<ChatGptAuthStatus> {
    // Interactive login uses a normal view in the same persistent session.
    // No credentials are copied between the login and offscreen renderers.
    this.failPending("ChatGPT login was reopened.");
    this.retireBrowser();
    this.offscreen = false;
    let view: WebContentsView;
    try {
      view = await this.ready();
    } catch {
      this.offscreen = true;
      this.retireBrowser();
      return { loggedIn: false, state: "error", diagnostic: { endpoint: "/", status: null, contentType: null, reason: "initial_load_failed_or_timeout" } };
    }
    const window = new BrowserWindow({ width: 1000, height: 780, title: "ChatGPT", webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    this.loginWindow = window;
    window.contentView.addChildView(view);
    const resize = () => { const [width, height] = window.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }); };
    resize(); window.on("resize", resize);
    return new Promise((resolve) => {
      let result: ChatGptAuthStatus = { loggedIn: false, state: "checking" };
      let checking = false;
      let closed = false;
      let failures = 0;
      let completed = false;
      const deadline = setTimeout(() => {
        if (closed) return;
        completed = true;
        result = { ...result, loggedIn: false, state: "error", message: "ChatGPT login verification timed out. Close and reopen login to retry.", diagnostic: { endpoint: "/api/auth/session", status: null, contentType: null, reason: "login_timeout", checks: result.diagnostic?.checks } };
        window.close();
      }, 180000);
      const timer = setInterval(async () => {
        if (checking || closed) return;
        checking = true;
        try {
          const status = await this.status();
          if (!closed) {
            result = status;
            failures = status.state === "error" ? failures + 1 : 0;
            if (status.loggedIn || failures >= 3) { completed = true; window.close(); }
          }
        }
        catch {
          if (!closed && ++failures >= 3) {
            completed = true;
            result = { loggedIn: false, state: "error", diagnostic: { endpoint: "/api/auth/session", status: null, contentType: null, reason: "page_execution_error" } };
            window.close();
          }
        }
        finally { checking = false; }
      }, 1500);
      window.on("close", () => {
        closed = true; clearInterval(timer); clearTimeout(deadline);
        if (this.documentStatus?.state === "error") { result = this.documentStatus; completed = true; }
        window.contentView.removeChildView(view);
        this.offscreen = true;
        if (this.view === view) this.retireBrowser();
      });
      window.on("closed", () => {
        this.loginWindow = null;
        resolve(completed ? result : this.documentStatus?.state === "error" ? this.documentStatus : { loggedIn: false, state: "signed_out", diagnostic: { endpoint: "/api/auth/session", status: null, contentType: null, reason: "login_cancelled" } });
      });
    });
  }

  async logout(): Promise<ChatGptAuthStatus> {
    if (this.loggingOut) throw new Error("ChatGPT logout is already in progress.");
    this.loggingOut = true;
    this.authEpoch++;
    this.backendDiagnosticNeeded = true;
    this.authenticatedDiagnosticNeeded = true;
    this.diagnosticChecks = undefined;
    try {
      this.loginWindow?.close();
      this.failPending("ChatGPT was logged out.");
      const view = await this.ready();
      await view.webContents.executeJavaScript(`window.__piChatRequests?.forEach(c => c.abort())`);
      await view.webContents.session.clearStorageData();
      await view.webContents.session.clearCache();
      this.headers = {};
      this.loading = view.webContents.loadURL("https://chatgpt.com/");
      await this.loading;
      return { loggedIn: false, state: "signed_out" };
    } finally { this.loggingOut = false; }
  }

  async open(params: Record<string, unknown>, notify: Notify): Promise<{ opened: true }> {
    const { requestId, body } = params;
    if (this.disposed || this.loggingOut) throw new Error("ChatGPT browser is unavailable. Open login again.");
    if (typeof requestId !== "string" || !requestId || !body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid ChatGPT conversation request.");
    if (this.pending.has(requestId)) throw new Error("Duplicate ChatGPT request ID.");
    // Reserve before the first await. Identity also fences a reused request ID
    // against completion of an earlier cancelled opening request.
    const delivery: Notify = (method, payload) => notify(method, payload);
    this.pending.set(requestId, delivery);
    logChatGptConversationEvent({ requestId, stage: "open", outcome: "started" });
    let view: WebContentsView;
    let openingStage: "status" | "page" = "status";
    try {
      logChatGptConversationEvent({ requestId, stage: "status", outcome: "started" });
      const status = await this.status();
      logChatGptConversationEvent({ requestId, stage: "status", outcome: status.loggedIn ? "completed" : "failed", reason: status.loggedIn ? "authenticated" : status.diagnostic?.reason ?? "not_authenticated", ...(status.diagnostic?.status !== null && status.diagnostic?.status !== undefined ? { status: status.diagnostic.status } : {}), contentType: status.diagnostic?.contentType });
      if (this.pending.get(requestId) !== delivery) throw new Error("ChatGPT request cancelled.");
      if (!status.loggedIn) throw new Error("Log in to ChatGPT in provider settings first.");
      openingStage = "page";
      logChatGptConversationEvent({ requestId, stage: "page", outcome: "started" });
      view = await this.ready();
      if (this.pending.get(requestId) !== delivery) throw new Error("ChatGPT request cancelled.");
    } catch (error) {
      logChatGptConversationEvent({ requestId, stage: openingStage, outcome: "failed", reason: this.pending.get(requestId) !== delivery ? "cancelled" : openingStage === "status" ? "not_authenticated" : "page_execution_error" });
      if (this.pending.get(requestId) === delivery) this.pending.delete(requestId);
      throw error;
    }
    this.active.add(delivery);
    logChatGptConversationEvent({ requestId, stage: "page", outcome: "completed" });
    logChatGptConversationEvent({ requestId, stage: "open", outcome: "completed" });
    // Do not await the fetch: its stream uses notifications, including errors.
    void view.webContents.executeJavaScript(conversationScript(requestId, body as Record<string, unknown>, this.headers)).catch(() => {
      const pending = this.pending.get(requestId);
      if (pending !== delivery) return;
      logChatGptConversationEvent({ requestId, stage: "page", outcome: "failed", reason: "page_execution_error" });
      this.pending.delete(requestId);
      this.active.delete(delivery);
      pending?.("chatgpt.conversation.error", { requestId, error: "ChatGPT page could not execute the request." });
    });
    return { opened: true };
  }

  async cancel(params: Record<string, unknown>): Promise<{ cancelled: true }> {
    if (typeof params.requestId !== "string") throw new Error("Invalid ChatGPT request ID.");
    const requestId = params.requestId;
    if (this.pending.has(requestId)) {
      const notify = this.pending.get(requestId)!;
      this.pending.delete(requestId);
      this.active.delete(notify);
      try {
        if (this.view && trustedChatGptUrl(this.view.webContents.getURL())) await this.view.webContents.executeJavaScript(`window.__piChatRequests?.get(${JSON.stringify(requestId)})?.abort()`);
      } finally {
        notify("chatgpt.conversation.error", { requestId, error: "ChatGPT request cancelled." });
      }
    }
    return { cancelled: true };
  }

  private failPending(error: string, activeOnly = false): void {
    for (const [requestId, notify] of this.pending) {
      // Initial page loading is setup for opening requests, not interruption.
      if (activeOnly && !this.active.has(notify)) continue;
      this.pending.delete(requestId);
      this.active.delete(notify);
      notify("chatgpt.conversation.error", { requestId, error });
    }
  }

  async cancelAll(): Promise<void> {
    this.failPending("ChatGPT runtime disconnected.");
    if (this.view && trustedChatGptUrl(this.view.webContents.getURL())) {
      // The old runtime must not leave a consumer conversation running after exit.
      await this.view.webContents.executeJavaScript(`window.__piChatRequests?.forEach(c => c.abort())`);
    }
  }

  dispose(): void {
    if (this.documentTimer) clearTimeout(this.documentTimer);
    this.disposed = true;
    this.authEpoch++;
    this.failPending("ChatGPT browser was closed.");
    this.loginWindow?.close();
    this.view?.webContents.close();
    this.view = null; this.loading = null;
    ipcMain.removeListener(STREAM_CHANNEL, this.onStream);
  }
}

let instance: ChatGptChatView | null = null;
export function getChatGptChatView(): ChatGptChatView {
  if (!instance) {
    instance = new ChatGptChatView();
    app.once("before-quit", () => { instance?.dispose(); instance = null; });
  }
  return instance;
}
