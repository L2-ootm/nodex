import { mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Local development only. An orphaned lock fails closed until recovered. */
export async function withLocalTransaction<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
  const root = path.resolve(dataDir)
  const lock = path.join(root, '.nodex-enrollment-lock')
  await mkdir(root, { recursive: true })
  const deadline = Date.now() + 5_000
  while (true) {
    try { await mkdir(lock); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  try { return await operation() }
  finally { await rmdir(lock) }
}
export async function readSnapshot<T>(filename: string): Promise<T[]> {
  try { return JSON.parse(await readFile(filename, 'utf8')) as T[] }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
export async function writeSnapshot(filename: string, value: unknown): Promise<void> {
  await writeAtomicText(filename, JSON.stringify(value))
}
export async function writeAtomicText(filename: string, text: string): Promise<void> {
  const temporary = filename + '.' + crypto.randomUUID() + '.tmp'
  try {
    await writeFile(temporary, text, { flag: 'wx' })
    await rename(temporary, filename)
  } finally { await unlink(temporary).catch(() => {}) }
}
