import type { Library } from '../shared/types.ts'

export async function fetchLibrary(): Promise<Library> {
  const res = await fetch('/api/library')
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `Library failed to load (${res.status})`)
  return body as Library
}
