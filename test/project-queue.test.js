import assert from "node:assert/strict";
import { test } from "node:test";

import { enqueueProjectTask } from "../src/services/project-queue.service.js";

function createDeferredPromise() {
  let resolve;

  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

test("runs tasks for the same project one at a time", async () => {
  const firstTaskGate = createDeferredPromise();
  const events = [];

  const firstTask = enqueueProjectTask("owner/repository", async () => {
    events.push("first-started");
    await firstTaskGate.promise;
    events.push("first-finished");
  });

  const secondTask = enqueueProjectTask("owner/repository", async () => {
    events.push("second-started");
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first-started"]);

  firstTaskGate.resolve();
  await Promise.all([firstTask, secondTask]);

  assert.deepEqual(events, [
    "first-started",
    "first-finished",
    "second-started",
  ]);
});

test("allows tasks for different projects to run concurrently", async () => {
  const sharedGate = createDeferredPromise();
  const events = [];

  const firstProject = enqueueProjectTask("owner/project-one", async () => {
    events.push("project-one-started");
    await sharedGate.promise;
  });

  const secondProject = enqueueProjectTask("owner/project-two", async () => {
    events.push("project-two-started");
    await sharedGate.promise;
  });

  await Promise.resolve();
  assert.deepEqual(events.sort(), [
    "project-one-started",
    "project-two-started",
  ]);

  sharedGate.resolve();
  await Promise.all([firstProject, secondProject]);
});

test("continues a project queue after a task fails", async () => {
  const events = [];

  const failingTask = enqueueProjectTask("owner/failing-project", async () => {
    events.push("failed");
    throw new Error("Expected test failure");
  });

  const nextTask = enqueueProjectTask("owner/failing-project", async () => {
    events.push("continued");
  });

  await assert.rejects(failingTask, /Expected test failure/);
  await nextTask;

  assert.deepEqual(events, ["failed", "continued"]);
});
