// Modified from https://github.com/sindresorhus/ip-regex/blob/3e220cae3eb66ecfdf4f7678bea7306ceaa41c76/index.js

import { LookupAddress } from 'dns'
import { FileResponse } from '../index.js'

const v4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/

const v6seg = '[a-fA-F\\d]{1,4}'

/* eslint-disable no-multi-spaces */
const v6core = [
  `(?:${v6seg}:){7}(?:${v6seg}|:)`,                                     // 1:2:3:4:5:6:7::  1:2:3:4:5:6:7:8
  `(?:${v6seg}:){6}(?:${v4}|:${v6seg}|:)`,                              // 1:2:3:4:5:6::    1:2:3:4:5:6::8   1:2:3:4:5:6::8  1:2:3:4:5:6::1.2.3.4
  `(?:${v6seg}:){5}(?::${v4}|(?::${v6seg}){1,2}|:)`,                    // 1:2:3:4:5::      1:2:3:4:5::7:8   1:2:3:4:5::8    1:2:3:4:5::7:1.2.3.4
  `(?:${v6seg}:){4}(?:(?::${v6seg}){0,1}:${v4}|(?::${v6seg}){1,3}|:)`,  // 1:2:3:4::        1:2:3:4::6:7:8   1:2:3:4::8      1:2:3:4::6:7:1.2.3.4
  `(?:${v6seg}:){3}(?:(?::${v6seg}){0,2}:${v4}|(?::${v6seg}){1,4}|:)`,  // 1:2:3::          1:2:3::5:6:7:8   1:2:3::8        1:2:3::5:6:7:1.2.3.4
  `(?:${v6seg}:){2}(?:(?::${v6seg}){0,3}:${v4}|(?::${v6seg}){1,5}|:)`,  // 1:2::            1:2::4:5:6:7:8   1:2::8          1:2::4:5:6:7:1.2.3.4
  `(?:${v6seg}:){1}(?:(?::${v6seg}){0,4}:${v4}|(?::${v6seg}){1,6}|:)`,  // 1::              1::3:4:5:6:7:8   1::8            1::3:4:5:6:7:1.2.3.4
  `(?::(?:(?::${v6seg}){0,5}:${v4}|(?::${v6seg}){1,7}|:))`,             // ::2:3:4:5:6:7:8  ::2:3:4:5:6:7:8  ::8             ::1.2.3.4
]
/* eslint-enable no-multi-spaces */

const v6 = new RegExp(`^(?:${v6core.join('|')})(?:%[0-9a-zA-Z]{1,})?$`)

export async function lookup(address: string): Promise<LookupAddress> {
  if (v4.test(address)) return { address, family: 4 }
  if (v6.test(address)) return { address, family: 6 }
  throw new Error('Invalid IP address')
}

export async function loadFile(url: string): Promise<FileResponse | undefined> {
  return undefined
}

const { WebSocket } = globalThis
export { WebSocket }
