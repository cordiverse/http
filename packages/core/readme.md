# @cordisjs/http

Fetch-based HTTP client for [Cordis](https://cordis.io).

## Features

- Browser and Node.js support
- Proxy agents (HTTP / HTTPS / SOCKS)
- WebSocket

## Usage

```ts
import { Context } from 'cordis'
import HTTP from '@cordisjs/plugin-http'

const ctx = new Context()
ctx.plugin(HTTP)

// The verb helpers resolve to the decoded body.
const data = await ctx.http.get('https://example.com')
const created = await ctx.http.post('https://example.com', body)

// Calling the service directly resolves to the raw fetch `Response`.
const response = await ctx.http('https://example.com', { method: 'GET' })
console.log(response.status)
const text = await response.text()
```

## API

### Instance Methods

#### http(url, config?)

```ts
interface HTTP {
  (url: string | URL, config?: Config): Promise<Response>
}
```

Send a request. The promise resolves to the raw [fetch `Response`](https://developer.mozilla.org/en-US/docs/Web/API/Response); the body has not been read. Use a verb helper below if you want the decoded body instead.

#### http.[get|delete|head](url, config?)

```ts
interface HTTP {
  get: Request1
  delete: Request1
  head(url: string, config?: Config): Promise<Headers>
}

interface Request1 {
  <K extends keyof ResponseTypes>(url: string, config: Config & { responseType: K }): Promise<ResponseTypes[K]>
  <T = any>(url: string, config?: Config): Promise<T>
}
```

Send a GET / DELETE / HEAD request.

#### http.[post|put|patch](url, data, config?)

```ts
interface HTTP {
  patch: Request2
  post: Request2
  put: Request2
}

interface Request2 {
  <K extends keyof ResponseTypes>(url: string, data: any, config: Config & { responseType: K }): Promise<ResponseTypes[K]>
  <T = any>(url: string, data?: any, config?: Config): Promise<T>
}
```

#### http.ws(url, config?)

```ts
interface HTTP {
  ws(url: string | URL, config?: Config): WebSocket
}
```

Open a WebSocket connection.

> [!NOTE]
> 
> The WebSocket implementation is taken from [`undici`](https://github.com/nodejs/undici) (`this.undici.WebSocket`), the same runtime used for `fetch` above.

#### http.Error.is(error)

```ts
function is(error: any): error is Http.Error
```

### Config

```ts
interface Config {
  baseUrl?: string
  method?: Method
  headers?: Record<string, string>
  redirect?: RequestRedirect
  keepAlive?: boolean
  params?: Record<string, any>
  data?: any
  responseType?: keyof ResponseTypes
  timeout?: number
}
```

#### config.baseUrl

The base URL of the request. If it is set, the `url` will be resolved against it.

See [URL#base](https://developer.mozilla.org/en-US/docs/Web/API/URL/URL#base).

#### config.method

See [fetch#method](https://developer.mozilla.org/en-US/docs/Web/API/fetch#method).

#### config.headers

See [fetch#headers](https://developer.mozilla.org/en-US/docs/Web/API/fetch#headers).

#### config.redirect

See [fetch#redirect](https://developer.mozilla.org/en-US/docs/Web/API/fetch#redirect).

#### config.keepAlive

See [fetch#keepalive](https://developer.mozilla.org/en-US/docs/Web/API/fetch#keepalive).

#### config.params

Additional query parameters. They will be appended to the URL.

#### config.data

The request body. Currently support below types:

- string
- URLSearchParams
- ArrayBuffer / ArrayBufferView
- Blob
- FormData
- Object (will be serialized to JSON)

#### config.responseType

Supported response types:

```ts
interface ResponseTypes {
  json: any
  text: string
  stream: ReadableStream<Uint8Array>
  blob: Blob
  formdata: FormData
  arraybuffer: ArrayBuffer
}
```

#### config.timeout

The request timeout in milliseconds.

#### config.proxyAgent

> [!NOTE]
> 
> In order to use a proxy agent, you need to install `@cordisjs/plugin-proxy-agent`.

### Response

`http(url, config?)` resolves to the raw [fetch `Response`](https://developer.mozilla.org/en-US/docs/Web/API/Response). Its body is not read.

#### response.status

See [Response#status](https://developer.mozilla.org/en-US/docs/Web/API/Response/status).

#### response.statusText

See [Response#statusText](https://developer.mozilla.org/en-US/docs/Web/API/Response/statusText).

#### response.headers

See [Response#headers](https://developer.mozilla.org/en-US/docs/Web/API/Response/headers).

#### response.body

The body is unread. Consume it with the standard methods - `response.json()`, `response.text()`, `response.arrayBuffer()`, `response.blob()` or `response.formData()`.

#### Decoding

`http.get` / `http.delete` / `http.head` / `http.post` / `http.put` / `http.patch` call the service and then decode the body, so they resolve to the decoded value rather than a `Response`:

| call | resolves to |
|---|---|
| `http.get(url, config?)`<br>`http.delete(url, config?)` | decoded body |
| `http.post(url, data, config?)`<br>`http.put(url, data, config?)`<br>`http.patch(url, data, config?)` | decoded body |
| `http.head(url, config?)` | `Headers` |

The decoder is `config.responseType` when given - a key of `ResponseTypes`, or a `(raw: Response) => T` function - and otherwise inferred from the `content-type` header: JSON for `application/json`, text for `text/*`, and an `ArrayBuffer` for anything else.
