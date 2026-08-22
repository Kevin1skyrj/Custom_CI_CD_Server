const projectQueues = new Map();

export function enqueueProjectTask(projectKey, task) {
  const previousTask =
    projectQueues.get(projectKey) ?? Promise.resolve();

  const currentTask = previousTask.then(() => task());

  const queueTail = currentTask.then(
    () => clearQueue(projectKey, queueTail),
    () => clearQueue(projectKey, queueTail)
  );

  projectQueues.set(projectKey, queueTail);

  return currentTask;
}

function clearQueue(projectKey, queueTail) {
  if (projectQueues.get(projectKey) === queueTail) {
    projectQueues.delete(projectKey);
  }
}
