import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { fileTypeFromBuffer } from 'file-type'
import { readFile } from 'node:fs/promises'

export { lookup } from 'node:dns/promises'

export async function fetchFile(url: URL): Promise<Response | undefined> {
  try {
    const data = await readFile(fileURLToPath(url))
    const result = await fileTypeFromBuffer(data)
    return new Response(data, {
      headers: {
        'Content-Type': result?.mime || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${basename(url.href)}"`,
      },
      status: 200,
      statusText: 'OK',
    })
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return new Response(null, { status: 404, statusText: 'Not Found' })
    } else if (error?.code === 'EACCES') {
      return new Response(null, { status: 403, statusText: 'Forbidden' })
    }
    // throw error
    return new Response(null, { status: 500, statusText: 'Internal Server Error' })
  }
}
