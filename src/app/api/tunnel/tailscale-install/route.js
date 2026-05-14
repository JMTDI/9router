"use server";

import os from "os";
import { execSync, spawn } from "child_process";
import { installTailscale } from "@/lib/tunnel/tailscale";
import { getCachedPassword, loadEncryptedPassword, initDbHooks } from "@/mitm/manager";
import { getSettings, updateSettings } from "@/lib/localDb";
import { loadState, generateShortId } from "@/lib/tunnel/state.js";

initDbHooks(getSettings, updateSettings);

const EXTENDED_PATH = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ""}`;

function hasBrew() {
  try { execSync("which brew", { stdio: "ignore", windowsHide: true, env: { ...process.env, PATH: EXTENDED_PATH } }); return true; } catch { return false; }
}

function isRoot() {
  try { return process.getuid?.() === 0; } catch { return false; }
}

/**
 * Download and run the official Tailscale install script using python3 urllib
 * (no curl/wget required — python3 is always present in Node.js containers).
 * Streams stdout/stderr via the `send` SSE callback.
 */
function installViaPython(send) {
  return new Promise((resolve, reject) => {
    // Python one-liner: fetch install.sh via urllib then pipe to sh
    const pyScript = [
      "import urllib.request, subprocess, sys",
      "r = urllib.request.urlopen('https://tailscale.com/install.sh')",
      "script = r.read()",
      "p = subprocess.run(['sh'], input=script)",
      "sys.exit(p.returncode)",
    ].join("; ");

    const child = spawn("python3", ["-c", pyScript], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PATH: EXTENDED_PATH },
    });

    child.stdout.on("data", (d) => send("progress", { message: d.toString().trimEnd() }));
    child.stderr.on("data", (d) => send("progress", { message: d.toString().trimEnd() }));

    child.on("close", (code) => {
      if (code === 0) resolve({ success: true });
      else reject(new Error(`Tailscale install script exited with code ${code}`));
    });
    child.on("error", (err) => reject(new Error(`python3 not found: ${err.message}`)));
  });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const platform = os.platform();
  const isWindows = platform === "win32";
  const isMac = platform === "darwin";
  const isBrew = isMac && hasBrew();
  // On Linux as root (common in containers), no sudo password needed
  const needsPassword = !isWindows && !isBrew && !isRoot();

  const sudoPassword = body.sudoPassword || getCachedPassword() || await loadEncryptedPassword() || "";

  if (needsPassword && !sudoPassword.trim()) {
    return new Response(JSON.stringify({ error: "Sudo password is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const shortId = loadState()?.shortId || generateShortId();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      const send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { closed = true; }
      };

      try {
        // Linux root (container/server): use python3 urllib — no curl/wget/sudo needed
        if (!isWindows && !isMac && isRoot()) {
          send("progress", { message: "Downloading Tailscale install script via python3..." });
          await installViaPython(send);
          send("progress", { message: "Install complete. Starting login..." });

          // Kick off tailscale login to get auth URL
          const { startLogin } = await import("@/lib/tunnel/tailscale");
          const result = await startLogin(shortId).catch(() => null);
          send("done", { success: true, authUrl: result?.authUrl || null });
        } else {
          // macOS (brew or pkg), Linux non-root (sudo), Windows (MSI)
          const result = await installTailscale(sudoPassword, shortId, (msg) => {
            send("progress", { message: msg });
          });
          send("done", { success: true, authUrl: result?.authUrl || null });
        }
      } catch (error) {
        console.error("Tailscale install error:", error);
        const msg = error.message?.includes("incorrect password") || error.message?.includes("Sorry")
          ? "Wrong sudo password"
          : error.message;
        send("error", { error: msg });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
