export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ArtifactMeta = { id: string; kind: string; object: string | null; title: string; ext: string; createdAt: number };
export type SessionMeta = { id: string; title: string; updatedAt: number; count: number; favorite?: boolean };
export type RepoInfo = { source: "local" | "remote"; ref: string; baseUrl?: string; branch?: string; sha?: string; framework?: string; fileCount?: number; hasMetadata?: boolean; error?: string };

export async function jget<T>(path: string): Promise<T | null> {
  try { return (await fetch(`${API}${path}`)).json() as Promise<T>; } catch { return null; }
}
