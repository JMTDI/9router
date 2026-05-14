"use server";

import os from "os";
import https from "https";
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
 * Fetch a URL using Node's built-in https module (no curl/wget/python needed).
 * Follows redirects automatically.
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Download the official Tailscale install script via Node https, then pipe to sh.
 * Works with zero external tools — only sh (always present) is required.
 */
function installViaNodeFetch(send) {
  return new Promise(async (resolve, reject) => {
    try {
      send("progress", { message: "Downloading Tailscale install script..." });
      const script = await fetchUrl("https://tailscale.com/install.sh");
      send("progress", { message: "Running install script..." });

      const child = spawn("sh", [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, PATH: EXTENDED_PATH },
      });

      child.stdout.on("data", (d) => send("progress", { message: d.toString().trimEnd() }));
      child.stderr.on("data", (d) => send("progress", { message: d.toString().trimEnd() }));

      child.on("close", (code) => {
        if (code === 0) resolve({ success: true });
        else reject(new Error(`Install script exited with code ${code}`));
      });
      child.on("error", reject);

      child.stdin.write(script);
      child.stdin.end();
    } catch (err) {
      reject(err);
    }
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
        // Linux root (container/server): fetch via Node built-in https, pipe to sh
        if (!isWindows && !isMac && isRoot()) {
          await installViaNodeFetch(send);
          send("progress", { message: "Tailscale installed. Starting login..." });

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
