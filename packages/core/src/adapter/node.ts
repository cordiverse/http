import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { fileTypeFromBuffer } from 'file-type'
import { FileResponse } from '..'
import { readFile } from 'node:fs/promises'
import { Binary } from 'cosmokit'

export { lookup } from 'node:dns/promises'

export async function loadFile(url: string): Promise<FileResponse | undefined> {
  if (url.startsWith('file://')) {
    const data = await readFile(fileURLToPath(url))
    const result = await fileTypeFromBuffer(data)
    return {
      type: result?.mime!,
      mime: result?.mime,
      filename: basename(url),
      data: Binary.fromSource(data),
    }
  }
}
