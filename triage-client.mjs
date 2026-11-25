// Browser-side logic of the page, kept free of DOM access so it can be tested with node:test.
// `view` is the only thing that touches the UI; `fetchFn` is injectable.

export function createTriageController({ fetchFn, view }) {
  let currentRequest = 0;
  let currentAbort = null;

  async function submit(text) {
    // A new run invalidates the previous one: drop its draft at once and cancel it.
    currentAbort?.abort();
    const requestId = ++currentRequest;
    const abort = new AbortController();
    currentAbort = abort;
    view.clearResult();
    view.showLoading();

    let outcome;
    try {
      const reply = await fetchFn("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: abort.signal,
      });
      outcome = interpret(reply.status, await reply.json());
    } catch {
      outcome = { kind: "manual_review", reason: "network" };
    }

    // Answer of an outdated request: it must not overwrite the fresh state.
    if (requestId !== currentRequest) return false;
    currentAbort = null;
    if (outcome.kind === "ready") view.showReady(outcome.topic, outcome.draft);
    else if (outcome.kind === "invalid_input") view.showInvalidInput();
    else view.showManualReview(outcome.reason);
    return true;
  }

  return { submit };
}

// Anything that is not a well-formed "ready" answer is treated as manual review,
// so an empty or broken result is never shown as a success.
export function interpret(httpStatus, body) {
  if (httpStatus === 400 && body?.status === "invalid_input") return { kind: "invalid_input" };
  if (httpStatus === 200 && body?.status === "manual_review") return { kind: "manual_review", reason: "ai" };
  if (
    httpStatus === 200 &&
    body?.status === "ready" &&
    typeof body.topic === "string" && body.topic !== "" &&
    typeof body.draft === "string" && body.draft.trim() !== ""
  ) {
    return { kind: "ready", topic: body.topic, draft: body.draft };
  }
  return { kind: "manual_review", reason: "bad_response" };
}

export const TOPIC_LABELS = { delivery: "Доставка", pricing: "Цена", other: "Другое" };
