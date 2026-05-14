"use client";
import { useEffect, useRef, useState, useCallback } from "react";

const COMMANDS = [
  { key: "git-pull",           label: "Git Pull",              icon: "download",      desc: "Pull latest code from repository" },
  { key: "npm-install",        label: "Install Dependencies",  icon: "package_2",     desc: "Run npm install" },
  { key: "npm-build",          label: "Build",                 icon: "build",         desc: "Build Next.js (production)" },
  { key: "update-all",         label: "Full Update",           icon: "rocket_launch", desc: "Pull + install + build in one step" },
  { key: "update-9router",     label: "Update 9Router",        icon: "system_update", desc: "npm i -g 9router@latest --prefer-online" },
  { key: "install-tailscale",  label: "Install Tailscale",     icon: "vpn_lock",      desc: "Install Tailscale (python3 urllib)" },
];

export default function TerminalPage() {
  const [output, setOutput]     = useState("");
  const [running, setRunning]   = useState(false);
  const [exitCode, setExitCode] = useState(null);
  const bottomRef = useRef(null);
  const readerRef = useRef(null);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [output]);

  const abort = useCallback(() => {
    readerRef.current?.cancel();
    readerRef.current = null;
  }, []);

  const runCommand = useCallback(async (cmdKey) => {
    if (running) return;
    setRunning(true);
    setExitCode(null);
    setOutput("");

    // Install Tailscale uses its own dedicated API endpoint (SSE with named events)
    if (cmdKey === "install-tailscale") {
      try {
        const res = await fetch("/api/tunnel/tailscale-install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        if (!res.ok) {
          setOutput(`Error: ${res.status} ${res.statusText}\n`);
          setRunning(false);
          return;
        }

        const reader = res.body.getReader();
        readerRef.current = reader;
        const dec = new TextDecoder();
        let buf = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop();
          for (const part of parts) {
            // Named SSE events: "event: progress/done/error"
            const eventMatch = part.match(/^event:\s*(\w+)/m);
            const dataMatch = part.match(/^data:\s*(.+)/m);
            if (!dataMatch) continue;
            try {
              const msg = JSON.parse(dataMatch[1]);
              const evt = eventMatch?.[1] || "progress";
              if (evt === "progress" && msg.message) setOutput((p) => p + msg.message + "\n");
              if (evt === "done") {
                if (msg.authUrl) setOutput((p) => p + `\nLogin URL: ${msg.authUrl}\n`);
                else setOutput((p) => p + "\n[Tailscale installed successfully]\n");
                setExitCode(0);
                setRunning(false);
              }
              if (evt === "error") {
                setOutput((p) => p + `\nError: ${msg.error}\n`);
                setExitCode(1);
                setRunning(false);
              }
            } catch {}
          }
        }
      } catch (err) {
        setOutput((p) => p + `\nAborted: ${err.message}\n`);
      } finally {
        setRunning(false);
        readerRef.current = null;
      }
      return;
    }

    // All other commands use the generic terminal stream endpoint
    try {
      const res = await fetch("/api/terminal/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmdKey }),
      });

      if (!res.ok) {
        setOutput(`Error: ${res.status} ${res.statusText}\n`);
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      readerRef.current = reader;
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          try {
            const msg = JSON.parse(part.slice(6));
            if (msg.text) setOutput((p) => p + msg.text);
            if (msg.done) {
              setExitCode(msg.code);
              setRunning(false);
            }
          } catch {}
        }
      }
    } catch (err) {
      setOutput((p) => p + `\nAborted: ${err.message}\n`);
    } finally {
      setRunning(false);
      readerRef.current = null;
    }
  }, [running]);

  return (
    <div className="flex flex-col gap-6 p-6 h-full">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Terminal</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Run update commands directly from the browser.
        </p>
      </div>

      {/* Command buttons */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {COMMANDS.map((cmd) => (
          <button
            key={cmd.key}
            onClick={() => runCommand(cmd.key)}
            disabled={running}
            title={cmd.desc}
            className="flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-primary text-xl">{cmd.icon}</span>
            <div>
              <div className="font-medium text-sm">{cmd.label}</div>
              <div className="text-xs text-muted-foreground">{cmd.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Terminal output */}
      <div className="flex flex-col flex-1 rounded-xl border border-border overflow-hidden min-h-0">
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-sm">terminal</span>
            <span className="text-xs font-mono text-muted-foreground">output</span>
            {running && (
              <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            )}
            {exitCode !== null && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-mono ${
                  exitCode === 0
                    ? "bg-green-500/20 text-green-400"
                    : "bg-red-500/20 text-red-400"
                }`}
              >
                exit {exitCode}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {running && (
              <button
                onClick={abort}
                className="text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                Stop
              </button>
            )}
            <button
              onClick={() => { setOutput(""); setExitCode(null); }}
              disabled={running}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Output area */}
        <pre
          className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed bg-[#0a0a0a] text-green-400 whitespace-pre-wrap break-words"
          style={{ minHeight: "300px" }}
        >
          {output || (
            <span className="text-muted-foreground">
              Select a command above to run it. Output will appear here.
            </span>
          )}
          <span ref={bottomRef} />
        </pre>
      </div>
    </div>
  );
}
