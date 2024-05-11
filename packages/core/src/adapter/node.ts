import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import FileType from 'file-type'
import { FileResponse } from '../index.js'
import { readFile } from 'node:fs/promises'

export { lookup } from 'node:dns/promises'

export async function loadFile(url: string): Promise<FileResponse | undefined> {
  if (url.startsWith('file://')) {
    const data = await readFile(fileURLToPath(url))
    const result = await FileType.fromBuffer(data)
    // https://stackoverflow.com/questions/8609289/convert-a-binary-nodejs-buffer-to-javascript-arraybuffer#answer-31394257
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    return { mime: result?.mime, filename: basename(url), data: buffer }
  }
}

export { WebSocket } from 'ws'
