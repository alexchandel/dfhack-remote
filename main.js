/* eslint indent: ["error", 4] */
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
 * @interface
 */
class Codec {
    /**
     * @returns {?Uint8Array}
     */
    open () { return null }
    /**
     * @param {[!Uint8Array]} src
     * @returns {?Object}
     */
    decode (/** Uint8Array */ src) {}
}

/**
 * Wraps a WebSocket with write/async-read
 */
class CodecRunner {
    constructor (/** @type {!Codec} */ codec) {
        this.codec = codec
        this.sock = new window.WebSocket('ws://[::1]:8080/')
        /** @type {!Array< !Array<function(?): void> >} */
        this.callbackQueue = []
        this.unreadMessages = []

        const self = this
        this.sock.onopen = function (e) {
            const init = self.codec.open()
            if (init != null) {
                self.sock.send(init)
            }
        }
        this.sock.onmessage = function (e) {
            // FIXME is .text().then() always safe?
            e.data.text().then(text => {
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
                } while (prevLen > buf[0].length) // FIXME should use maybeItem != null?
            })
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

    write (/** @type {Uint8Array} */ src) {
        this.sock.send(src)
    }

    /**
     * Coalesces 1+ WebSocket packets into one response, based on a Codec,
     * and returns that.
     * @returns {!Promise}
     */
    async read () {
        // FIXME drain this.unreadMessages if they're queued up
        const callbackQueue = this.callbackQueue
        // resolve is invoked if codec yields a successful item.
        // reject is invoked if codec throws FramedCodecError.
        return new Promise((resolve, reject) => {
            callbackQueue.push([resolve, reject])
        })
    }

    /**
     * Convenience method to write & read a response.
     * @param {!Uint8Array} src
     * @returns {!Promise}
     */
    async writeRead (/** @type {Uint8Array} */ src) {
        this.write(src)
        return this.read()
    }
}

const REQUEST_MAGIC_HDR = Uint8Array.from([68, 70, 72, 97, 99, 107, 63, 10, 1, 0, 0, 0]) // 'DFHack?\n' 1i32
const RESPONSE_MAGIC_HDR = Uint8Array.from([68, 70, 72, 97, 99, 107, 33, 10, 1, 0, 0, 0]) // 'DFHack!\n' 1i32
// const RPC_REPLY_RESULT = -1
// const RPC_REPLY_FAIL = -2
// const RPC_REPLY_TEXT = -3
// const RPC_REQUEST_QUIT = -4
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

class DwarfWireCodec extends Codec {
    /*
     * Protocol described at https://github.com/DFHack/dfhack/blob/develop/library/include/RemoteClient.h
     * Data structures at https://github.com/DFHack/dfhack/blob/develop/library/include/RemoteClient.h
     * Server networking at https://github.com/DFHack/dfhack/blob/develop/library/RemoteServer.cpp
     *
     * RPCHandshakeHeader = { magic: [u8; 8], version: i32 == 1 }
     * RPCMessageHeader = { id: i16, size: i32 }, size <= 64MiB
     * RPCMessage = { header: RPCMessageHeader, body: [u8; header.size] }
     *      RPCReplyResult  = RPCMessage { { RPC.REPLY.RESULT, sizeof(body) }, body }
     *      RPCReplyFail    = RPCMessage { { RPC.REPLY.FAIL, errno }, }
     * RPCReply = { RPC_REPLY_TEXT:CoreTextNotification*, RPCReplyResult | RPCReplyFail }
     * <- { RPC_REPLY_TEXT:CoreTextNotification*, RPC_REPLY_RESULT() | RPC_REPLY_FAIL() }
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
    }

    /**
     * @returns {Uint8Array}
     */
    open () { return REQUEST_MAGIC_HDR }

    /**
     * Attempts to decode a frame from the provided buffer of bytes.
     * Returns Result<Option<Item>, Error>.
     * Rust invokes .split_to() on buffer, returning first half.
     * @param {[!Uint8Array]} buf
     * @returns {?Object}
     */
    decode (buf) {
        if (!this.shookHands) {
            if (buf[0].length >= 12) {
                if (arrayEqual(buf[0].slice(0, 8), RESPONSE_MAGIC_HDR)) {
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
            if (size >= 0 && size <= 67108864 /* 2**26 */) {
                if (buf[0].length >= 6 + size) {
                    const msgData = buf[0].slice(6, 6 + size)
                    // split_to 6 + size:
                    buf[0] = buf[0].slice(6 + size)
                    // FIXME must collect until RESULT|FAIL
                    return { id: id, data: msgData }
                }
            } else {
                throw new CodecError('Invalid size in RFR packet.')
            }
        }
        return null
    }
    // decode_eof
}

class DwarfClient {
    constructor () {
        this.framed = new CodecRunner(new DwarfWireCodec())
    }

    async GetBlockList (minX, minY, minZ, maxX, maxY, maxZ) {
        const req = new rfr.BlockRequest()
        req.setMinX(minX)
        req.setMinY(minY)
        req.setMinZ(minZ)
        req.setMaxX(maxX)
        req.setMaxY(maxY)
        req.setMaxZ(maxZ)
        const res = req.BlockList.deserializeBinary(
            await this.framed.writeRead(req.serializeBinary())
        )
    }
}

export function main () {
    const df = new DwarfClient()
    df.GetBlockList(0, 0, 0, 1, 1, 1)
        .then(result => console.log(result))
        .catch(error => console.error(error))
}
