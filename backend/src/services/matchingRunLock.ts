const runningMatchingProjects = new Set<number>();

interface MatchingResult {
  total: number;
  matched: number;
  unmatched: number;
  mode: string;
  llmSuggestions: number;
  llmMatchingEnabled: boolean;
  error?: string;
}

const matchingResults = new Map<number, MatchingResult>();

export function acquireMatchingRun(projectId: number): boolean {
  if (runningMatchingProjects.has(projectId)) return false;
  runningMatchingProjects.add(projectId);
  matchingResults.delete(projectId);
  return true;
}

export function releaseMatchingRun(projectId: number): void {
  runningMatchingProjects.delete(projectId);
}

export function isMatchingRunActive(projectId: number): boolean {
  return runningMatchingProjects.has(projectId);
}

export function setMatchingResult(projectId: number, result: MatchingResult): void {
  matchingResults.set(projectId, result);
}

export function getMatchingResult(projectId: number): MatchingResult | undefined {
  return matchingResults.get(projectId);
}

export function clearMatchingResult(projectId: number): void {
  matchingResults.delete(projectId);
}
