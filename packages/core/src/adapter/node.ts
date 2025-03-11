import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { fileTypeFromStream } from 'file-type'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { RequestInit } from 'undici'

export { lookup } from 'node:dns/promises'

export async function fetchFile(url: URL, init: RequestInit): Promise<Response> {
  try {
    const stream = Readable.toWeb(createReadStream(fileURLToPath(url))) as ReadableStream
    const result = await fileTypeFromStream(stream)
    return new Response(stream, {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': result?.mime || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(url.pathname))}`,
      },
    })
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') {
      return new Response(null, { status: 404, statusText: 'Not Found' })
    } else if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return new Response(null, { status: 403, statusText: 'Forbidden' })
    } else if (error?.code === 'ENAMETOOLONG') {
      return new Response(null, { status: 414, statusText: 'URI Too Long' })
    }
    return new Response(null, { status: 500, statusText: 'Internal Server Error' })
  }
}
