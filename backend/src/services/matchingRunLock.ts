const runningMatchingProjects = new Set<number>();

export function acquireMatchingRun(projectId: number): boolean {
  if (runningMatchingProjects.has(projectId)) return false;
  runningMatchingProjects.add(projectId);
  return true;
}

export function releaseMatchingRun(projectId: number): void {
  runningMatchingProjects.delete(projectId);
}

export function isMatchingRunActive(projectId: number): boolean {
  return runningMatchingProjects.has(projectId);
}
