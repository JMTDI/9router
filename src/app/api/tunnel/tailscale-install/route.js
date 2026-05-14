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
 * On Linux servers (especially containers), try running the official install
 * script directly without sudo — works when the process is already root.
 * Streams output line-by-line via SSE.
 */
function installViaCurlScript(send) {
  return new Promise((resolve, reject) => {
    // curl the install script and pipe to sh
    const child = spawn(
      "sh",
      ["-c", "curl -fsSL https://tailscale.com/install.sh | sh"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, PATH: EXTENDED_PATH },
      }
    );

    child.stdout.on("data", (d) => send("progress", { message: d.toString().trimEnd() }));
    child.stderr.on("data", (d) => send("progress", { message: d.toString().trimEnd() }));

    child.on("close", (code) => {
      if (code === 0) resolve({ success: true });
      else reject(new Error(`Install script exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const platform = os.platform();
  const isWindows = platform === "win32";
  const isMac = platform === "darwin";
  const isBrew = isMac && hasBrew();
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
        // On Linux as root (common in containers/servers): use the official curl script directly
        if (!isWindows && !isMac && isRoot()) {
          send("progress", { message: "Running official Tailscale install script..." });
          await installViaCurlScript(send);
          send("progress", { message: "Tailscale installed successfully." });
          // Start login flow
          const { installTailscale: _orig, ...rest } = await import("@/lib/tunnel/tailscale");
          // Just start login after install
          const { startLogin } = await import("@/lib/tunnel/tailscale");
          const result = await startLogin(shortId).catch(() => null);
          send("done", { success: true, authUrl: result?.authUrl || null });
        } else {
          // Use the existing platform-aware install flow
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
