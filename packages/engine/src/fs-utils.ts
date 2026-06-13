import { dirname } from 'node:path'
import type { PromiseFsClient } from 'isomorphic-git'

interface ErrnoLike {
  code?: string
}

/**
 * Create `dir` and any missing parents, tolerating "already exists" — a
 * backend-portable replacement for node:fs's `mkdir(dir, { recursive: true })`.
 *
 * The engine must run over the *minimal* injected-fs contract (the methods
 * isomorphic-git requires), not node:fs extras. LightningFS (the mobile /
 * IndexedDB object store) implements that minimal contract but, unlike node:fs,
 * does **not** honour `{ recursive: true }`: it neither creates intermediate
 * parents nor ignores `EEXIST`. So the engine creates directories itself, one
 * level at a time, swallowing `EEXIST` and recursing on `ENOENT`.
 */
export async function ensureDir(
  fs: PromiseFsClient,
  dir: string,
): Promise<void> {
  try {
    await fs.promises.mkdir(dir)
  } catch (err) {
    const code = (err as ErrnoLike).code
    if (code === 'EEXIST') return
    if (code === 'ENOENT') {
      const parent = dirname(dir)
      if (parent === dir) throw err // reached the root; cannot climb further
      await ensureDir(fs, parent)
      try {
        await fs.promises.mkdir(dir)
      } catch (retryErr) {
        if ((retryErr as ErrnoLike).code !== 'EEXIST') throw retryErr
      }
      return
    }
    throw err
  }
}
