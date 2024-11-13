import { IAkariShardInitDispose } from '@shared/akari-shard/interface'
import { protocol, session } from 'electron'
import { Mime } from 'mime'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { AkariLogger, LoggerFactoryMain } from '../logger-factory'
import { WindowManagerMain } from '../window-manager'

/**
 * 实现 `akari://` 协议, 用户特殊资源的代理
 * akari://league-client/* 代理到 LeagueClient 的 HTTP 服务
 * akari://riot-client/* 代理到 RiotClient 的 HTTP 服务
 * akari://file/ 代理到本地文件系统 (实验性特性, 危险)
 */
export class AkariProtocolMain implements IAkariShardInitDispose {
  static id = 'akari-protocol-main'
  static dependencies = ['logger-factory-main']

  static AKARI_PROXY_PROTOCOL = 'akari'

  private readonly _loggerFactory: LoggerFactoryMain
  private readonly _log: AkariLogger

  private readonly _domainRegistry = new Map<
    string,
    (uri: string, req: Request) => Promise<Response> | Response
  >()

  private _mime: Mime

  constructor(deps: any) {
    this._loggerFactory = deps['logger-factory-main']
    this._log = this._loggerFactory.create(AkariProtocolMain.id)
  }

  async onInit() {
    this._mime = (await import('mime')).default
    this._handlePartitionAkariProtocol(WindowManagerMain.MAIN_WINDOW_PARTITION)
    this._handlePartitionAkariProtocol(WindowManagerMain.AUX_WINDOW_PARTITION)
  }

  async onDispose() {
    this._unhandlePartitionAkariProtocol(WindowManagerMain.MAIN_WINDOW_PARTITION)
    this._unhandlePartitionAkariProtocol(WindowManagerMain.AUX_WINDOW_PARTITION)
  }

  private _unhandlePartitionAkariProtocol(partition: string) {
    session.fromPartition(partition).protocol.unhandle(AkariProtocolMain.AKARI_PROXY_PROTOCOL)
  }

  private _handlePartitionAkariProtocol(partition: string) {
    session
      .fromPartition(partition)
      .protocol.handle(AkariProtocolMain.AKARI_PROXY_PROTOCOL, async (req) => {
        const path1 = req.url.slice(`${AkariProtocolMain.AKARI_PROXY_PROTOCOL}://`.length)
        const index = path1.indexOf('/')
        const domain = path1.slice(0, index).trim()
        const uri = path1.slice(index + 1).trim()

        const handler = this._domainRegistry.get(domain)
        if (handler) {
          return handler(uri, req)
        }

        return new Response(`No handler for ${req.url}`, {
          statusText: 'Not Found',
          headers: { 'Content-Type': 'text/plain' },
          status: 404
        })
      })
  }

  /** unused yet */
  private async _toLocalFileResponse(uri: string) {
    const filePath = path.resolve(uri)

    try {
      await fs.promises.access(filePath, fs.constants.F_OK | fs.constants.R_OK)

      const stats = await fs.promises.stat(filePath)

      if (stats.isDirectory()) {
        return new Response(`Cannot read directory: ${uri}`, {
          headers: { 'Content-Type': 'text/plain' },
          status: 403
        })
      }

      return new Response(fs.createReadStream(filePath), {
        headers: {
          'Access-Control-Allow-Origin': '*',
          Connection: 'keep-alive',
          'Content-Type': this._mime.getType(filePath) || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Content-Length': stats.size.toString(),
          Date: new Date().toUTCString()
        }
      })
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return new Response((error as Error).message, {
          headers: { 'Content-Type': 'text/plain' },
          status: 404
        })
      } else if ((error as any).code === 'EACCES') {
        return new Response((error as Error).message, {
          headers: { 'Content-Type': 'text/plain' },
          status: 403
        })
      } else {
        return new Response((error as Error).message, {
          headers: { 'Content-Type': 'text/plain' },
          status: 500
        })
      }
    }
  }

  static convertWebStreamToNodeStream(readableStream: ReadableStream) {
    const reader = readableStream.getReader()

    const nodeStream = Readable.from({
      async *[Symbol.asyncIterator]() {
        while (true) {
          try {
            const { done, value } = await reader.read()
            if (done) break
            yield value
          } catch {
            break
          }
        }
      }
    })

    return nodeStream
  }

  registerDomain(
    domain: string,
    handler: (uri: string, req: Request) => Promise<Response> | Response
  ) {
    if (this._domainRegistry.has(domain)) {
      throw new Error(`Domain ${domain} is already registered`)
    }

    this._domainRegistry.set(domain, handler)
  }

  unregisterDomain(domain: string) {
    if (!this._domainRegistry.has(domain)) {
      throw new Error(`Domain ${domain} is not registered`)
    }

    this._domainRegistry.delete(domain)
  }

  static register() {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: AkariProtocolMain.AKARI_PROXY_PROTOCOL,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
          bypassCSP: true
        }
      }
    ])
  }
}
