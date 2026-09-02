import { describe, expect, test } from "bun:test";
import type { PtyOpenOptions, PtySession, PtySessionEvents, Vm } from "freestyle";
import { createFreestyleTerminalSession } from "./terminal-session.ts";

describe("Freestyle terminal session", () => {
  test("serves an xterm page and resolves after the user finishes", async () => {
    const session = createFreestyleTerminalSession({
      nodePath: "login",
      title: "GitHub auth",
      command: localInteractiveShell,
      remoteCommand: "printf interactive-ready",
      instructions: "Authenticate GitHub inside the VM.",
    });

    try {
      const page = await fetch(session.url);
      const html = await page.text();

      expect(page.status).toBe(200);
      expect(html).toContain("GitHub auth");
      expect(html).toContain("Authenticate GitHub inside the VM.");
      expect(html).toContain("printf interactive-ready");
      expect(html).toContain("@xterm/xterm");
      expect(html).toContain("@xterm/addon-fit");
      expect(html).toContain("@xterm/addon-web-links");
      expect(html).toContain("terminal-window");
      expect(html).toContain("freestyle.sh");
      expect(html).toContain("Complete task");
      expect(html).toContain("document.addEventListener(\"keydown\"");
      expect(html).toContain("{ capture: true }");
      expect(html).toContain("terminalEl.contains(target)");
      expect(html).toContain("user-select: text");
      expect(html).toContain("keyEventToTerminalInput");
      expect(html).toContain("sendTerminalInput(data)");
      expect(html).toContain("terminalUrlFromEvent");
      expect(html).toContain("expandKnownTerminalUrl");
      expect(html).toContain("openPendingBrowserPrompt");
      expect(html).toContain("window.open(normalized");
      expect(html).toContain("document.addEventListener(\"paste\"");
      expect(html).toContain("term-input-proxy");
      expect(html).toContain("onPointerDownCapture");
      expect(html).toContain("onBeforeInput");
      expect(html).toContain("sendTextInputEventToTerminal");
      expect(html).toContain("sendPasteEventToTerminal");
      expect(html).not.toContain("term-send-form");
      expect(html).not.toContain("Send to terminal");
      const startupInput = readStartupInput(html);
      expect(startupInput).toBe("printf interactive-ready\n");

      const messages: unknown[] = [];
      const socketUrl = new URL(session.url.replace("/?", "/terminal?"));
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);
      socket.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
      });
      await sendOnOpen(socket, startupInput);

      await waitFor(() =>
        messages.some((message) =>
          isMessage(message, "output") && message.data.includes("interactive-ready")
        ),
      );
      await waitFor(() =>
        messages.some((message) =>
          isMessage(message, "status") && message.status === "Running printf interactive-ready" && message.canFinish
        ),
      );

      socket.send(JSON.stringify({ type: "finish" }));
      await expect(session.completed).resolves.toEqual({ finished: true });
      socket.close();
    } finally {
      session.stop();
    }
  });

  test("keeps the terminal open until the user finishes", async () => {
    const session = createFreestyleTerminalSession({
      nodePath: "login",
      title: "Manual auth",
      command: localInteractiveShell,
      remoteCommand: "printf manual-ready",
    });

    let resolved = false;
    session.completed.then(() => {
      resolved = true;
    });

    try {
      const messages: unknown[] = [];
      const socketUrl = new URL(session.url.replace("/?", "/terminal?"));
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);
      socket.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
      });
      const page = await fetch(session.url);
      const startupInput = readStartupInput(await page.text());
      await sendOnOpen(socket, startupInput);

      await waitFor(() =>
        messages.some((message) =>
          isMessage(message, "status") && message.status === "Running printf manual-ready" && message.canFinish
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(resolved).toBe(false);

      socket.send(JSON.stringify({ type: "finish" }));
      await expect(session.completed).resolves.toEqual({ finished: true });
      socket.close();
    } finally {
      session.stop();
    }
  });

  test("can allow finishing while the terminal process is still running", async () => {
    const session = createFreestyleTerminalSession({
      nodePath: "login",
      title: "Keep-open command",
      command: "sleep 5",
      displayCommand: "sleep 5",
      canFinishWhileRunning: true,
    });

    let resolved = false;
    session.completed.then(() => {
      resolved = true;
    });

    try {
      const messages: unknown[] = [];
      const socketUrl = new URL(session.url.replace("/?", "/terminal?"));
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);
      socket.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
      });

      await waitForSocketOpen(socket);
      await waitFor(() =>
        messages.some((message) =>
          isMessage(message, "status") && Boolean(message.canFinish)
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(resolved).toBe(false);

      socket.send(JSON.stringify({ type: "finish" }));
      await expect(session.completed).resolves.toEqual({ finished: true });
      socket.close();
    } finally {
      session.stop();
    }
  });

  test("answers cursor position reports for terminal UI prompts", async () => {
    const session = createFreestyleTerminalSession({
      nodePath: "prompt",
      title: "Prompt UI",
      command: cursorPositionProbe,
    });

    try {
      const messages: unknown[] = [];
      const socketUrl = new URL(session.url.replace("/?", "/terminal?"));
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);
      socket.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
      });

      await waitForSocketOpen(socket);

      await waitFor(() =>
        messages.some((message) =>
          isMessage(message, "output") && message.data.includes("CPR:1b5b32383b31303052")
        ),
      );

      socket.send(JSON.stringify({ type: "finish" }));
      await expect(session.completed).resolves.toEqual({ finished: true });
      socket.close();
    } finally {
      session.stop();
    }
  });

  test("forwards browser terminal input to process stdin", async () => {
    const session = createFreestyleTerminalSession({
      nodePath: "prompt",
      title: "Input prompt",
      command: stdinEchoProbe,
    });

    try {
      const messages: unknown[] = [];
      const socketUrl = new URL(session.url.replace("/?", "/terminal?"));
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);
      socket.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
      });

      await waitForSocketOpen(socket);
      socket.send(JSON.stringify({ type: "input", data: "abc123\n" }));

      await waitFor(() =>
        messages.some((message) =>
          isMessage(message, "output") && message.data.includes("STDIN:abc123")
        ),
      );

      socket.send(JSON.stringify({ type: "finish" }));
      await expect(session.completed).resolves.toEqual({ finished: true });
      socket.close();
    } finally {
      session.stop();
    }
  });

  test("drops terminal-generated string control responses from browser input", async () => {
    const session = createFreestyleTerminalSession({
      nodePath: "prompt",
      title: "Input prompt",
      command: stdinHexProbe,
    });

    try {
      const messages: unknown[] = [];
      const socketUrl = new URL(session.url.replace("/?", "/terminal?"));
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);
      socket.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
      });

      await waitForSocketOpen(socket);
      socket.send(JSON.stringify({ type: "input", data: "\x1b]10;rgb:ffff/ffff/ffff\x07" }));
      socket.send(JSON.stringify({ type: "input", data: "y\n" }));

      await waitFor(() =>
        messages.some((message) =>
          isMessage(message, "output") && message.data.includes("STDINHEX:790a")
        ),
      );

      socket.send(JSON.stringify({ type: "finish" }));
      await expect(session.completed).resolves.toEqual({ finished: true });
      socket.close();
    } finally {
      session.stop();
    }
  });

  test("runs interactive commands with a TTY stdin", async () => {
    const session = createFreestyleTerminalSession({
      nodePath: "prompt",
      title: "TTY probe",
      command: ttyProbe,
    });

    try {
      const messages: unknown[] = [];
      const socketUrl = new URL(session.url.replace("/?", "/terminal?"));
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);
      socket.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
      });

      await waitForSocketOpen(socket);

      await waitFor(() =>
        messages.some((message) =>
          isMessage(message, "output") && message.data.includes("TTY:true")
        ),
      );

      socket.send(JSON.stringify({ type: "finish" }));
      await expect(session.completed).resolves.toEqual({ finished: true });
      socket.close();
    } finally {
      session.stop();
    }
  });

  test("bridges browser input, output, and resize directly to a VM PTY", async () => {
    type OpenOptions = PtyOpenOptions & PtySessionEvents;
    let openOptions: OpenOptions | undefined;
    const writes: string[] = [];
    const resizes: Array<{ cols: number; rows: number }> = [];
    const closed: number[] = [];
    let detached = false;
    const remoteSession = {
      sessionId: 42,
      write: (data: Uint8Array | string) => {
        writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      },
      resize: (size: { cols: number; rows: number }) => {
        resizes.push(size);
      },
      detach: () => {
        detached = true;
      },
    } as unknown as PtySession;
    const vm = {
      pty: {
        open: async (options: OpenOptions) => {
          openOptions = options;
          options.onData?.(new TextEncoder().encode("remote-ready\r\n"));
          return remoteSession;
        },
        close: async (sessionId: number) => {
          closed.push(sessionId);
          return { sessionId };
        },
      },
    } as unknown as Vm;
    const session = createFreestyleTerminalSession({
      nodePath: "login",
      title: "Direct PTY",
      command: "claude auth login",
      displayCommand: "claude auth login",
      pty: { vm },
    });

    const messages: unknown[] = [];
    const socketUrl = new URL(session.url.replace("/?", "/terminal?"));
    socketUrl.protocol = "ws:";
    const socket = new WebSocket(socketUrl);
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)));
    });

    try {
      await waitFor(() => openOptions !== undefined);
      expect(openOptions?.exec).toBe("claude auth login");
      expect(openOptions?.cols).toBe(100);
      expect(openOptions?.rows).toBe(28);
      await waitFor(() =>
        messages.some((message) =>
          isMessage(message, "output") && message.data.includes("remote-ready")
        ),
      );

      socket.send(JSON.stringify({ type: "input", data: "yes\n" }));
      socket.send(JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
      await waitFor(() => writes.includes("yes\n") && resizes.length > 0);
      expect(resizes.at(-1)).toEqual({ cols: 132, rows: 43 });

      openOptions?.onExit?.(0);
      await waitFor(() =>
        messages.some((message) =>
          isMessage(message, "status") && message.status === "Shell exited" && message.canFinish
        ),
      );
      socket.send(JSON.stringify({ type: "finish" }));
      await expect(session.completed).resolves.toEqual({ finished: true });
    } finally {
      socket.close();
      await session.stop();
    }

    expect(detached).toBe(true);
    expect(closed).toEqual([42]);
  });

  test("asks the host to open complete browser auth URLs printed by the terminal", async () => {
    const opened: string[] = [];
    const authUrl = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
    const session = createFreestyleTerminalSession({
      nodePath: "login",
      title: "Claude auth",
      command: "printf %s " + JSON.stringify(`Opening browser to sign in...\nIf the browser didn't open, visit: ${authUrl}\nPaste code here if prompted > `),
      openExternalTarget: (target) => opened.push(target),
    });

    try {
      const socketUrl = new URL(session.url.replace("/?", "/terminal?"));
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);
      await waitForSocketOpen(socket);

      await waitFor(() => opened.includes(authUrl));
      socket.send(JSON.stringify({ type: "finish" }));
      await expect(session.completed).resolves.toEqual({ finished: true });
      socket.close();
    } finally {
      session.stop();
    }
  });

  test("does not open partial browser auth URLs while output is still streaming", async () => {
    const opened: string[] = [];
    const authUrl = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
    const session = createFreestyleTerminalSession({
      nodePath: "login",
      title: "Claude auth",
      command: streamedAuthUrlProbe,
      openExternalTarget: (target) => opened.push(target),
    });

    try {
      const socketUrl = new URL(session.url.replace("/?", "/terminal?"));
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);
      await waitForSocketOpen(socket);

      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(opened).toEqual([]);
      await waitFor(() => opened.includes(authUrl), 2_500);
      socket.send(JSON.stringify({ type: "finish" }));
      await expect(session.completed).resolves.toEqual({ finished: true });
      socket.close();
    } finally {
      session.stop();
    }
  });
});

const localInteractiveShell = "bash --noprofile --norc -i";
const cursorPositionProbe = "node -e " + JSON.stringify([
  "process.stdin.setRawMode?.(true);",
  "process.stdout.write('\\x1b[6n');",
  "process.stdin.once('data', (chunk) => {",
  "  process.stdout.write('CPR:' + Buffer.from(chunk).toString('hex') + '\\n');",
  "  process.exit(0);",
  "});",
].join(""));
const stdinEchoProbe = "node -e " + JSON.stringify([
  "process.stdin.once('data', (chunk) => {",
  "  process.stdout.write('STDIN:' + chunk.toString('utf8').trim() + '\\n');",
  "  process.exit(0);",
  "});",
].join(""));
const stdinHexProbe = "node -e " + JSON.stringify([
  "process.stdin.setRawMode?.(true);",
  "let data = Buffer.alloc(0);",
  "process.stdin.on('data', (chunk) => {",
  "  data = Buffer.concat([data, chunk]);",
  "  if (data.includes(10)) {",
  "    process.stdout.write('STDINHEX:' + data.toString('hex') + '\\n');",
  "    process.exit(0);",
  "  }",
  "});",
].join(""));
const ttyProbe = "node -e " + JSON.stringify([
  "process.stdout.write('TTY:' + Boolean(process.stdin.isTTY) + '\\n');",
  "process.exit(0);",
].join(""));
const streamedAuthUrlProbe = "node -e " + JSON.stringify([
  "process.stdout.write(\"Opening browser to sign in...\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true\");",
  "setTimeout(() => {",
  "  process.stdout.write('&state=abc\\nPaste code here if prompted > ');",
  "}, 1000);",
].join(""));

function readStartupInput(html: string): string {
  const match = /const startupInput = (.*);/.exec(html);
  if (!match) throw new Error("startup input was not rendered");
  const value = JSON.parse(match[1]!) as unknown;
  if (typeof value !== "string") throw new Error("startup input was not a string");
  return value;
}

async function sendOnOpen(socket: WebSocket, data: string): Promise<void> {
  await waitForSocketOpen(socket);
  socket.send(JSON.stringify({ type: "input", data }));
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve) => {
    socket.addEventListener("open", () => {
      resolve();
    }, { once: true });
  });
}

function isMessage(
  value: unknown,
  type: string,
): value is { type: string; data: string; status: string; canFinish?: boolean } {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === type);
}

async function waitFor(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!assertion()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for terminal event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
