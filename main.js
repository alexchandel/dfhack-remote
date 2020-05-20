/* eslint indent: ["error", 4, {'SwitchCase': 1}] */
const dfc = require('./build/DwarfControl_pb.js')
const rfr = require('./build/RemoteFortressReader_pb.js')

/**
 * @param {Array} a
 * @param {Array} b
 * @returns {Boolean}
 */
function arrayEqual (a, b) {
    if (a === b) return true
    if (a == null || b == null) return false
    if (a.length !== b.length) return false
    // could clone & sort arrays
    for (var i = 0; i < a.length; ++i) {
        if (a[i] !== b[i]) return false
    }
    return true
}

/**
 * An unrecoverable error that closes the socket.
 */
class CodecError extends Error { }

/**
 * A recoverable error that rejects the next pending promise.  This
 * corresponds to a decodable error that should be delivered to the
 * higher-level function.
 */
class FramedCodecError extends Error { }

/**
 * @template In, Out
 * @interface
 */
class Codec {
    /**
     * @returns {?Uint8Array}
     */
    open () { return null }
    /**
     * @param {!In} input
     * @returns {!Uint8Array}
     */
    encode (input) {}
    /**
     * Decode a message from bytes.  Implementor MUST return `null` if no
     * complete reply available yet.  Implementor MUST delete bytes from
     * buf[0] that are consumed.
     * @param {[!Uint8Array]} buf
     * @returns {?Out}
     */
    decode (buf) {}
    /**
     * @returns {Uint8Array}
     */
    close () {}
}

/**
 * Wraps a WebSocket with write/async-read
 * @template In, Out
 */
class CodecRunner {
    constructor (/** @type {!Codec<In, Out>} */ codec) {
        this.codec = codec
        this.sock = new window.WebSocket('ws://127.0.0.1:8080/')
        this.sock.binaryType = 'arraybuffer'
        /** @type {!Array<Uint8Array>} */
        this._queuedWrites = []
        /** @type {!Array< [function(?): void, function(?): void] >} */
        this.callbackQueue = []
        /** @type {!Array<Out>} */
        this.unreadMessages = []

        const self = this
        this.sock.onopen = function (e) {
            console.log('CodecRunner WebSocket: open')
            const init = self.codec.open()
            if (init != null) {
                self.sock.send(init)
            }
        }
        this.sock.onerror = function (e) {
            console.error('CodecRunner WebSocket error:', e)
            self._queuedWrites.splice(0)
            self.unreadMessages.splice(0)
        }
        this.sock.onclose = function (e) {
            console.info('CodecRunner WebSocket: close:', e)
        }
        this.sock.onmessage = function (e) {
            // NOTE: in Node, it's e.data.text().then(text => ...)
            const text = new Uint8Array(e.data)
            /** @type {[!Uint8Array]} */
            const buf = [text]
            let prevLen
            do {
                prevLen = buf[0].length
                let maybeItem
                try {
                    maybeItem = self.codec.decode(buf)
                } catch (e) {
                    if (e instanceof FramedCodecError) {
                        // FramedCodecError is recoverable
                        const callback = self.callbackQueue.shift()
                        if (callback !== undefined) {
                            callback[1](e)
                        }
                    } else {
                        self.sock.close()
                        // socket dead, send error to all waiting callbacks:
                        const cbs = self.callbackQueue.splice(0, self.callbackQueue.length)
                        for (const callback of cbs) {
                            callback[1](e)
                        }
                    }
                }

                // NEVER set if an exception was thrown
                if (maybeItem != null) {
                    // pass DF message
                    self._popReply(maybeItem)
                } // else, have not received enough data to decode
            } while (prevLen > buf[0].length) // TODO should use maybeItem != null?
        }
    }

    _popReply (/** @type {!Object} */ reply) {
        const callback = this.callbackQueue.shift()
        if (callback !== undefined) {
            callback[0](reply)
        } else {
            this.unreadMessages.push(reply)
        }
    }

    write (/** @type {!In} */ src) {
        if (this.sock.readyState === WebSocket.CONNECTING) {
            // FIXME: race condition?
            this._queuedWrites.push(this.codec.encode(src))
        } else {
            this.sock.send(this.codec.encode(src))
        }
    }

    /**
     * Coalesces 1+ WebSocket packets into one response, based on a Codec,
     * and returns that.
     * @returns {!Promise<Out>}
     */
    async read () {
        if (this.unreadMessages.length) {
            // drain this.unreadMessages if one is queued up
            console.warn('Response arrived before request: %s', this.unreadMessages[0])
            return Promise.resolve(this.unreadMessages.shift())
        } else {
            const callbackQueue = this.callbackQueue
            // resolve is invoked if codec yields a successful item.
            // reject is invoked if codec throws FramedCodecError.
            return new Promise((resolve, reject) => {
                callbackQueue.push([resolve, reject])
            })
        }
    }

    /**
     * Convenience method to write & read a response.
     * @param {!In} src
     * @returns {!Promise<Out>}
     */
    async writeRead (src) {
        this.write(src)
        return this.read()
    }

    close () {
        const close = this.codec.close()
        if (close != null) {
            this.sock.send(close)
        }
        this.sock.close()
    }
}

const REQUEST_MAGIC_HDR = Uint8Array.from([68, 70, 72, 97, 99, 107, 63, 10, 1, 0, 0, 0]) // 'DFHack?\n' 1i32
const RESPONSE_MAGIC_HDR = Uint8Array.from([68, 70, 72, 97, 99, 107, 33, 10, 1, 0, 0, 0]) // 'DFHack!\n' 1i32
/**
 * Possible non-function IDs to be found in RPCMessage.header.id
 */
const RPC = {
    REPLY: {
        RESULT: -1,
        FAIL: -2,
        TEXT: -3
    },
    REQUEST: {
        QUIT: -4
    }
}
/**
 * Possible error codes to be found in RPCReplyFail.header.size:
 */
const CR = {
    LINK_FAILURE: -3,    // RPC call failed due to I/O or protocol error
    NEEDS_CONSOLE: -2,   // Attempt to call interactive command without console
    NOT_IMPLEMENTED: -1, // Command not implemented, or plugin not loaded
    OK: 0,               // Success
    FAILURE: 1,          // Failure
    WRONG_USAGE: 2,      // Wrong arguments or ui state
    NOT_FOUND: 3         // Target object not found (for RPC mainly)
}

/**
 * @struct
 * @constructor
 * @param {number} id
 * @param {!Uint8Array} data
 */
function DwarfMessage (id, data) {
    this.id = id
    this.data = data
}

/**
 * This codec chunks packets & RFR messages together into complete replies to a call.
 * However, it does more (perhaps too much?).  It parses the replies into objects.
 * @extends {Codec<!DwarfMessage, !Array<!DwarfMessage>>}
 */
class DwarfWireCodec extends Codec {
    /*
     * Protocol described at https://github.com/DFHack/dfhack/blob/develop/library/include/RemoteClient.h
     * Data structures at    https://github.com/DFHack/dfhack/blob/develop/library/include/RemoteClient.h
     * Server networking at  https://github.com/DFHack/dfhack/blob/develop/library/RemoteServer.cpp
     * Some functions at     https://github.com/DFHack/dfhack/blob/develop/plugins/remotefortressreader/remotefortressreader.cpp
     *                       https://github.com/DFHack/dfhack/blob/develop/library/RemoteTools.cpp
     *
     * RPCHandshakeHeader = { magic: [u8; 8], version: i32 == 1 }
     * RPCMessageHeader = { id: i16, size: i32 }, size <= 64MiB
     * RPCMessage = { header: RPCMessageHeader, body: [u8; header.size] }
     *      RPCReplyResult  = RPCMessage { { RPC.REPLY.RESULT, sizeof(body) }, body }
     *      RPCReplyFail    = RPCMessage { { RPC.REPLY.FAIL, errno }, }
     * RPCReply = { {RPC.REPLY.TEXT, CoreTextNotification}*, RPCReplyResult | RPCReplyFail }
     *
     * Handshake:
     * -> RPCHandshakeHeader { REQUEST_MAGIC, 1 } == REQUEST_MAGIC_HDR
     * <- RPCHandshakeHeader { RESPONSE_MAGIC, 1 } == RESPONSE_MAGIC_HDR
     *
     * -> RPCMessage { { function_id, sizeof(body) }, body }
     * <- RPCReply
     */

    constructor () {
        super()
        this.shookHands = false
        // queue of higher-level messages stripped off wire, to be returned later
        this._textMessages = []
    }

    /**
     * @returns {Uint8Array}
     */
    open () { return REQUEST_MAGIC_HDR }

    /**
     * @param {!DwarfMessage} input
     * @returns {!Uint8Array}
     */
    encode (input) {
        const size = new Int32Array([input.data.length])
        const id = new Int16Array([input.id])
        const buf = new Uint8Array(6 + input.data.length)
        buf.set(id.buffer, 0)
        buf.set(size.buffer, 2)
        buf.set(input.data, 6)
        return buf
    }

    /**
     * Attempts to decode a frame from the provided buffer of bytes.
     * Returns Result<Option<Item>, Error>.
     * Rust invokes .split_to() on buffer, returning first half.
     * @param {[!Uint8Array]} buf
     * @returns {?Array<!DwarfMessage>}
     */
    decode (buf) {
        if (!this.shookHands) {
            if (buf[0].length >= 12) {
                if (arrayEqual(buf[0].slice(0, 8), RESPONSE_MAGIC_HDR)) {
                    console.log('Shook hands!')
                    this.shookHands = true
                    // split_to 12:
                    buf[0] = buf[0].slice(12)
                } else {
                    throw new CodecError('Handshake response invalid.')
                }
            } else {
                return null
            }
        }
        // this.shookHands ASSUMED true now
        if (buf[0].length >= 6) {
            // FIXME slow
            const id = (new Int16Array(buf[0].buffer.slice(0, 2)))[0]
            const size = (new Int32Array(buf[0].buffer.slice(2, 4)))[0]

            if (id === RPC.REPLY.FAIL) {
                buf[0] = buf[0].slice(6) // split_to 6
                // FAIL means "size" is really the errno
                const msgData = new Uint8Array(size.buffer)
                const msg = new DwarfMessage(id, msgData)
                return [msg, ...this._textMessages.splice(0)]
            } else if (id === RPC.REPLY.TEXT || id === RPC.REPLY.RESULT) {
                if (size >= 0 && size <= 67108864 /* 2**26 */) {
                    if (buf[0].length >= 6 + size) {
                        const msgData = buf[0].slice(6, 6 + size)
                        // split_to 6 + size:
                        buf[0] = buf[0].slice(6 + size)

                        // collect TEXT replies until a RESULT|FAIL
                        const msg = new DwarfMessage(id, msgData)
                        if (id === RPC.REPLY.TEXT) {
                            this._textMessages.push(msg)
                        } else { // RESULT
                            return [msg, ...this._textMessages.splice(0)]
                        }
                    } // else not ready
                } else {
                    throw new CodecError('Invalid size in RFR packet.')
                }
            } else {
                throw new FramedCodecError('Illegal reply ID: ' + id)
            }
        }
        return null
    }
    // decode_eof

    close () {
        return this.encode(new DwarfMessage(RPC.REQUEST.QUIT, new Uint8Array()))
    }
}

class DwarfClient {
    constructor () {
        this.framed = new CodecRunner(new DwarfWireCodec())
    }

    destroy () {
        this.framed.close()
    }

    /**
     * @returns {rfr.BlockList}
     */
    async GetBlockList (minX, minY, minZ, maxX, maxY, maxZ) {
        const req = new rfr.BlockRequest()
        req.setMinX(minX)
        req.setMinY(minY)
        req.setMinZ(minZ)
        req.setMaxX(maxX)
        req.setMaxY(maxY)
        req.setMaxZ(maxZ)
        const msgs = await this.framed.writeRead(new DwarfMessage(17, req.serializeBinary()))
        return req.BlockList.deserializeBinary(msgs[0].data)
    }
}

function main () {
    const df = new DwarfClient()
    // df.GetBlockList(0, 0, 0, 1, 1, 1)
    //     .then(result => console.log(result))
    //     .catch(error => console.error(error))
    return df
}

window.main = main
