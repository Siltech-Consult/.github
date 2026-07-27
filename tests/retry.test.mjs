import test from "node:test";
import assert from "node:assert/strict";
import {withRetry} from "../scripts/lib/retry.mjs";

test("retry recupera falha transitiva", async () => {
  let attempts = 0;
  const value = await withRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("secondary rate limit");
      error.status = 403;
      throw error;
    }
    return "ok";
  }, {sleep: async () => {}, delays: [1, 2, 4, 8]});

  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});

test("retry para apos cinco tentativas transitivas", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(async () => {
      attempts += 1;
      const error = new Error("service unavailable");
      error.status = 503;
      throw error;
    }, {sleep: async () => {}, delays: [1, 2, 4, 8]}),
    /service unavailable/
  );
  assert.equal(attempts, 5);
});

test("retry nao repete falha permanente", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(async () => {
      attempts += 1;
      const error = new Error("unprocessable entity");
      error.status = 422;
      throw error;
    }, {sleep: async () => {}, delays: [1, 2, 4, 8]}),
    /unprocessable entity/
  );
  assert.equal(attempts, 1);
});

test("retry nao repete 403 sem sinal de rate limit", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(async () => {
      attempts += 1;
      const error = new Error("resource not accessible by integration");
      error.status = 403;
      throw error;
    }, {sleep: async () => {}}),
    /resource not accessible/
  );
  assert.equal(attempts, 1);
});

test("retry usa Retry-After para limite secundario", async () => {
  const sleeps = [];
  let attempts = 0;
  const value = await withRetry(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("secondary rate limit");
      error.status = 403;
      error.headers = {"retry-after": "3"};
      throw error;
    }
    return "ok";
  }, {sleep: async (milliseconds) => sleeps.push(milliseconds)});

  assert.equal(value, "ok");
  assert.deepEqual(sleeps, [3000]);
});

test("retry usa reset de rate limit e 422 qualificado", async () => {
  const sleeps = [];
  let attempts = 0;
  const value = await withRetry(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("You have exceeded a secondary rate limit");
      error.status = 422;
      error.headers = {"x-ratelimit-reset": "105"};
      throw error;
    }
    return "ok";
  }, {now: () => 100_000, sleep: async (milliseconds) => sleeps.push(milliseconds)});

  assert.equal(value, "ok");
  assert.deepEqual(sleeps, [5000]);
});
