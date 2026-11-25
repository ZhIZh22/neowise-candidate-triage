import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as defaultClassify } from "./mock-ai.mjs";

export const AI_TIMEOUT_MS = 300;
export const TOPICS = new Set(["delivery", "pricing", "other"]);
const MAX_BODY_BYTES = 64 * 1024;

const html = await readFile(new URL("./index.html", import.meta.url));
const clientModule = await readFile(new URL("./triage-client.mjs", import.meta.url));

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class InvalidInput extends Error {}

async function readText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInput("body too large");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidInput("invalid json");
  }
  const text = body !== null && typeof body === "object" ? body.text : undefined;
  if (typeof text !== "string" || text.trim() === "") throw new InvalidInput("text must be a non-empty string");
  return text;
}

// Waits for the model no longer than `timeoutMs`. The signal is passed to the model
// (so it can stop work), and the race guarantees the answer even if it ignores the signal.
async function askModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("AI timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// The model output is untrusted: anything that is not exactly {topic in TOPICS, non-empty draft}
// is rejected and the request goes to manual review.
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const { topic, draft } = data;
  if (typeof topic !== "string" || !TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

export function createApp({ classify = defaultClassify, timeoutMs = AI_TIMEOUT_MS } = {}) {
  async function handleTriage(request, response) {
    let text;
    try {
      text = await readText(request);
    } catch (error) {
      if (error instanceof InvalidInput) return json(response, 400, { status: "invalid_input" });
      throw error;
    }
    let result = null;
    try {
      result = parseModelOutput(await askModel(classify, text, timeoutMs));
    } catch {
      result = null; // timeout or provider error
    }
    if (!result) return json(response, 200, MANUAL_REVIEW);
    return json(response, 200, { status: "ready", ...result });
  }

  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return response.end(html);
      }
      if (request.method === "GET" && request.url === "/triage-client.mjs") {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        return response.end(clientModule);
      }
      if (request.method !== "POST" || request.url !== "/api/triage") {
        return json(response, 404, { status: "not_found" });
      }
      await handleTriage(request, response);
    } catch {
      if (!response.headersSent) json(response, 500, { status: "server_error" });
      else response.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
