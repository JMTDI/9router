import { spawn } from "child_process";

/**
 * Whitelisted commands the browser terminal is allowed to run.
 * Keys are sent as `cmdKey` in the POST body.
 */
const ALLOWED_COMMANDS = {
  "git-pull": {
    label: "git pull",
    cmd: "git",
    args: ["pull"],
  },
  "npm-install": {
    label: "npm install",
    cmd: "npm",
    args: ["install"],
  },
  "npm-build": {
    label: "npm build (next only)",
    // Run next build directly — bypasses the splash server which would
    // conflict with the already-running app on port 8000.
    cmd: "npx",
    args: ["next", "build", "--webpack"],
    env: { NODE_ENV: "production" },
  },
  "update-all": {
    label: "git pull + npm install + build",
    cmd: "sh",
    args: [
      "-c",
      "git pull && npm install && NODE_ENV=production npx next build --webpack",
    ],
  },
  "update-9router": {
    label: "npm i -g 9router@latest --prefer-online",
    cmd: "npm",
    args: ["i", "-g", "9router@latest", "--prefer-online"],
  },
};

export async function GET() {
  return Response.json(
    Object.entries(ALLOWED_COMMANDS).map(([key, { label }]) => ({ key, label }))
  );
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { cmdKey } = body;
  const command = ALLOWED_COMMANDS[cmdKey];
  if (!command) {
    return new Response("Unknown command", { status: 400 });
  }

  const cwd = process.cwd();

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();

      const send = (text) =>
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ text })}\n\n`)
        );

      send(`$ ${command.label}\n`);

      const child = spawn(command.cmd, command.args, {
        cwd,
        shell: process.platform === "win32",
        env: { ...process.env, ...(command.env || {}) },
      });

      child.stdout.on("data", (d) => send(d.toString()));
      child.stderr.on("data", (d) => send(d.toString()));

      child.on("close", (code) => {
        send(`\n[Process finished with exit code ${code}]\n`);
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ done: true, code })}\n\n`)
        );
        controller.close();
      });

      child.on("error", (err) => {
        send(`\nError: ${err.message}\n`);
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ done: true, code: 1 })}\n\n`)
        );
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
