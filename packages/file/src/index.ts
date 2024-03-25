import HTTP, {} from 'undios'
import { loadFile, lookup } from 'undios-file/adapter'
import { Context, z } from 'cordis'
import { base64ToArrayBuffer } from 'cosmokit'
import mimedb from 'mime-db'
import { isLocalAddress } from './utils.ts'

declare module 'undios' {
  interface HTTP {
    file(url: string, options?: FileConfig): Promise<FileResponse>
    isLocal(url: string): Promise<boolean>
  }
}

export interface FileConfig {
  timeout?: number | string
}

export interface FileResponse {
  mime?: string
  filename: string
  data: ArrayBuffer
}

export const name = 'undios-file'
export const inject = ['http']

export interface Config {}

export const Config: z<Config> = z.object({})

export function apply(ctx: Context, config: Config) {
  ctx.provide('http.file')
  ctx.provide('http.isLocal')

  function createName(mime: string | undefined) {
    let name = 'file'
    const ext = mime && mimedb[mime]?.extensions?.[0]
    if (ext) name += `.${ext}`
    return name
  }

  ctx['http.file'] = async function file(this: HTTP, url: string, options: FileConfig = {}): Promise<FileResponse> {
    const result = await loadFile(url)
    if (result) return result
    const capture = /^data:([\w/-]+);base64,(.*)$/.exec(url)
    if (capture) {
      const [, mime, base64] = capture
      return { mime, data: base64ToArrayBuffer(base64), filename: createName(mime) }
    }
    const { headers, data, url: responseUrl } = await this<ArrayBuffer>(url, {
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: +options.timeout! || undefined,
    })
    const mime = headers.get('content-type') ?? undefined
    const [, name] = responseUrl.match(/.+\/([^/?]*)(?=\?)?/)!
    return { mime, filename: name, data }
  }

  ctx['http.isLocal'] = async function isLocal(url: string) {
    let { hostname, protocol } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return true
    if (/^\[.+\]$/.test(hostname)) {
      hostname = hostname.slice(1, -1)
    }
    try {
      const address = await lookup(hostname)
      return isLocalAddress(address)
    } catch {
      return false
    }
  }

  ctx.on('dispose', () => {
    ctx['http.file'] = undefined
    ctx['http.isLocal'] = undefined
  })
}
