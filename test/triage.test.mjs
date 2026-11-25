import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";
import { createTriageController } from "../triage-client.mjs";

async function withServer(options, run) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, body, raw = false) =>
  fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });

const MANUAL = { status: "manual_review", topic: null, draft: null };

test("1. normal request -> ready with topic and draft", async () => {
  await withServer({}, async (base) => {
    const reply = await post(base, { text: "Какая цена у вашего товара?" });
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), {
      status: "ready",
      topic: "pricing",
      draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  });
});

test("2. empty / missing / non-string text -> 400 invalid_input", async () => {
  await withServer({}, async (base) => {
    for (const body of [{ text: "" }, { text: "   " }, {}, { text: 5 }, { text: null }, [], null]) {
      const reply = await post(base, body);
      assert.equal(reply.status, 400, JSON.stringify(body));
      assert.deepEqual(await reply.json(), { status: "invalid_input" });
    }
  });
});

test("3. invalid JSON -> 400 invalid_input", async () => {
  await withServer({}, async (base) => {
    const reply = await post(base, "{not json", true);
    assert.equal(reply.status, 400);
    assert.deepEqual(await reply.json(), { status: "invalid_input" });
  });
});

// Failures of the real mock: scenarios 4-8 go through the HTTP API with the unchanged mock-ai.mjs.
for (const [number, label, marker] of [
  [4, "AI timeout (mock waits 1200 ms, API waits 300 ms)", "[timeout]"],
  [5, "AI error", "[error]"],
  [6, "AI returns invalid JSON", "[bad-json]"],
  [7, "AI returns unknown topic", "[bad-topic]"],
  [8, "AI returns empty draft", "[empty-draft]"],
]) {
  test(`${number}. ${label} -> manual_review`, async () => {
    await withServer({}, async (base) => {
      const started = Date.now();
      const reply = await post(base, { text: `Вопрос по доставке ${marker}` });
      assert.equal(reply.status, 200);
      assert.deepEqual(await reply.json(), MANUAL);
      if (marker === "[timeout]") assert.ok(Date.now() - started < 1_000, "must not wait for the slow model");
    });
  });
}

test("4b. timeout is controlled: a model that never answers -> manual_review after timeoutMs", async () => {
  const hanging = () => new Promise(() => {});
  await withServer({ classify: hanging, timeoutMs: 20 }, async (base) => {
    const reply = await post(base, { text: "hello" });
    assert.deepEqual(await reply.json(), MANUAL);
  });
});

test("model output with extra shapes is rejected -> manual_review", async () => {
  for (const output of ["null", "[]", '"x"', '{"topic":"other"}', '{"topic":1,"draft":"x"}', '{"topic":"other","draft":5}']) {
    await withServer({ classify: async () => output }, async (base) => {
      assert.deepEqual(await (await post(base, { text: "hello" })).json(), MANUAL, output);
    });
  }
});

// ---- UI logic (triage-client.mjs) with a fake view and controllable fetch ----

function fakeView() {
  const state = { draft: null, topic: null, message: null, log: [] };
  return {
    state,
    clearResult() { state.draft = null; state.topic = null; state.message = null; state.log.push("clear"); },
    showLoading() { state.message = "loading"; },
    showReady(topic, draft) { state.topic = topic; state.draft = draft; state.message = "ready"; },
    showInvalidInput() { state.message = "invalid"; },
    showManualReview(reason) { state.message = `manual:${reason}`; state.draft = ""; },
  };
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const reply = (status, body) => ({ status, json: async () => body });

test("9. UI clears the previous draft immediately when a new run starts", async () => {
  const view = fakeView();
  const second = deferred();
  const answers = [Promise.resolve(reply(200, { status: "ready", topic: "other", draft: "Старый" })), second.promise];
  const controller = createTriageController({ fetchFn: () => answers.shift(), view });
  await controller.submit("first");
  assert.equal(view.state.draft, "Старый");
  const pending = controller.submit("second"); // answer not received yet
  assert.equal(view.state.draft, null, "old draft must be gone while the new request is in flight");
  assert.equal(view.state.message, "loading");
  second.resolve(reply(200, { status: "manual_review", topic: null, draft: null }));
  await pending;
  assert.equal(view.state.draft, "");
  assert.equal(view.state.message, "manual:ai");
});

test("9b. network error and malformed answers -> manual review, no draft shown", async () => {
  for (const fetchFn of [
    async () => { throw new TypeError("network down"); },
    async () => reply(500, { status: "server_error" }),
    async () => reply(200, { status: "ready", topic: "other", draft: "  " }),
    async () => ({ status: 200, json: async () => { throw new SyntaxError("not json"); } }),
  ]) {
    const view = fakeView();
    await createTriageController({ fetchFn, view }).submit("x");
    assert.match(view.state.message, /^manual:/);
    assert.equal(view.state.draft, "");
  }
});

test("10. stale response does not overwrite the fresh result", async () => {
  const view = fakeView();
  const first = deferred();
  const second = deferred();
  const answers = [first.promise, second.promise];
  const controller = createTriageController({ fetchFn: () => answers.shift(), view });
  const p1 = controller.submit("first");
  const p2 = controller.submit("second");
  // the second (fresh) request finishes first, then the outdated one
  second.resolve(reply(200, { status: "ready", topic: "pricing", draft: "Свежий" }));
  assert.equal(await p2, true);
  first.resolve(reply(200, { status: "ready", topic: "delivery", draft: "Устаревший" }));
  assert.equal(await p1, false);
  assert.equal(view.state.draft, "Свежий");
  assert.equal(view.state.topic, "pricing");
});

test("10b. stale error does not overwrite the fresh result either", async () => {
  const view = fakeView();
  const first = deferred();
  const second = deferred();
  const answers = [first.promise, second.promise];
  const controller = createTriageController({ fetchFn: () => answers.shift(), view });
  const p1 = controller.submit("first");
  const p2 = controller.submit("second");
  second.resolve(reply(200, { status: "ready", topic: "other", draft: "Свежий" }));
  await p2;
  first.resolve(Promise.reject(new TypeError("aborted")));
  await p1;
  assert.equal(view.state.draft, "Свежий");
  assert.equal(view.state.message, "ready");
});
