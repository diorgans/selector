import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Selector's own settings (~/.selector/config.json): which folders to scan for music.
const CONFIG = process.env.SELECTOR_CONFIG ?? join(homedir(), '.selector', 'config.json')
const DEFAULT_DIRS = [join(homedir(), 'Music', 'Music', 'Media.localized'), join(homedir(), '.selector', 'demo')]

type Config = { musicDirs: string[] }

async function load(): Promise<Config> {
  try {
    const c = JSON.parse(await readFile(CONFIG, 'utf8'))
    return { musicDirs: Array.isArray(c.musicDirs) ? c.musicDirs.filter((d: unknown) => typeof d === 'string') : [] }
  } catch {
    return { musicDirs: [] }
  }
}

async function save(c: Config) {
  await mkdir(dirname(CONFIG), { recursive: true })
  await writeFile(`${CONFIG}.tmp`, JSON.stringify(c, null, 2))
  await rename(`${CONFIG}.tmp`, CONFIG)
}

/** Every folder to scan: the defaults plus any added in Selector (or SELECTOR_MUSIC_DIRS, for tests and demos). */
export async function getMusicDirs(): Promise<string[]> {
  if (process.env.SELECTOR_MUSIC_DIRS) return process.env.SELECTOR_MUSIC_DIRS.split(':').filter(Boolean)
  return [...new Set([...DEFAULT_DIRS, ...(await load()).musicDirs])]
}

/** Connected external drives (from /Volumes), and whether each is being scanned. */
export async function listDrives() {
  const dirs = await getMusicDirs()
  let names: string[] = []
  try {
    names = await readdir('/Volumes')
  } catch {
    /* not macOS */
  }
  const drives = []
  for (const name of names) {
    const path = join('/Volumes', name)
    try {
      const st = await stat(path)
      // Skip the system disk (its /Volumes entry points back at /).
      if (!st.isDirectory() || resolve(path) === '/' || name === 'Macintosh HD' || name === 'Recovery') continue
    } catch {
      continue
    }
    drives.push({ name, path, scanned: dirs.some((d) => d === path || d.startsWith(`${path}/`)) })
  }
  return { dirs, drives }
}

/** Add or remove a folder to scan. Only drives under /Volumes or folders in the home directory. */
export async function changeFolders(body: { add?: string; remove?: string }) {
  const c = await load()
  const ok = (p: string) => (p.startsWith('/Volumes/') || p.startsWith(homedir() + '/')) && !p.includes('..')
  if (body.add) {
    if (!ok(body.add)) throw new Error('Only external drives or folders in your home folder can be added.')
    const st = await stat(body.add).catch(() => null)
    if (!st?.isDirectory()) throw new Error(`Not a folder: ${body.add}`)
    if (!c.musicDirs.includes(body.add)) c.musicDirs.push(body.add)
  }
  if (body.remove) c.musicDirs = c.musicDirs.filter((d) => d !== body.remove)
  await save(c)
  return listDrives()
}
