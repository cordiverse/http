import { LookupAddress } from 'dns'
import { HTTP } from '../index.ts'

export function loadFile(url: string): Promise<HTTP.FileResponse | undefined>
export function lookup(address: string): Promise<LookupAddress>
