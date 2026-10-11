import type { Library } from '../shared/types.ts'

export type SetList = { id: string; name: string; trackIds: string[] }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `${path} failed (${res.status})`)
  return body as T
}

export const fetchLibrary = () => call<Library>('/api/library')
export const fetchSets = () => call<SetList[]>('/api/sets')
export const saveSets = (sets: SetList[]) => call<{ ok: true }>('/api/sets', { method: 'PUT', body: JSON.stringify(sets) })
export const exportSets = (sets: SetList[]) => call<{ path: string; sets: number; tracks: number }>('/api/export', { method: 'POST', body: JSON.stringify(sets) })
