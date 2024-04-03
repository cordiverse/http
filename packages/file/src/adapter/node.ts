import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { fromBuffer } from 'file-type'
import { FileResponse } from '../index.js'
import { readFile } from 'node:fs/promises'

export { lookup } from 'node:dns/promises'

export async function loadFile(url: string): Promise<FileResponse | undefined> {
  if (url.startsWith('file://')) {
    const data = await readFile(fileURLToPath(url))
    const result = await fromBuffer(data)
    return { mime: result?.mime, filename: basename(url), data: data.buffer }
  }
}
