/* eslint indent: ["error", 4, {'SwitchCase': 1}] */
/* eslint-disable no-prototype-builtins */
// const dfc = require('./build/DwarfControl_pb.js')
const rfr = require('./build/RemoteFortressReader_pb.js')
const cp = require('./build/CoreProtocol_pb.js')

const pjson = require('./proto.json')
const protobuf = require('protobufjs/light')
const root = protobuf.Root.fromJSON(pjson)

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
 * Wraps a WebSocket with write/async-read.
 * `Out` cannot subclass `Error`:
 * @template In, Out
 * @struct
 */
class CodecRunner {
    /**
     * @param {!Codec<In, Out>} codec
     * @param {function(CodecRunner): void} onopen
     */
    constructor (codec, onopen) {
        this.codec = codec
        this.sock = new window.WebSocket('ws://127.0.0.1:8080/')
        this.sock.binaryType = 'arraybuffer'
        /** @type {!Array<Uint8Array>} */
        this._queuedWrites = []
        /** @type {!Array< [function(Out): void, function(?): void] >} */
        this._callbackQueue = []
        /** @type {!Array<Out|Error>} */
        this._unreadMessages = []

        this._buf = new Uint8Array([])

        const self = this
        this.sock.onopen = function (e) {
            console.info('CodecRunner WebSocket: open')
            const init = self.codec.open()
            if (init != null) {
                self.sock.send(init)
            }
            // FIXME should wait for Codec to establish opening
            if (onopen != null) {
                onopen(self)
            }
        }
        this.sock.onerror = function (e) {
            console.error('CodecRunner WebSocket error:', e)
            self._queuedWrites.splice(0)
            self._unreadMessages.splice(0)
        }
        this.sock.onclose = function (e) {
            console.info('CodecRunner WebSocket: close:', e)
        }
        this.sock.onmessage = function (e) {
            // NOTE: in Node, it's e.data.text().then(text => ...)
            /** @type {!Uint8Array} */
            let text
            if (self._buf.length) {
                const newbuf = new Uint8Array(self._buf.length + e.data.byteLength)
                newbuf.set(self._buf)
                newbuf.set(new Uint8Array(e.data), self._buf.length)
                text = newbuf
            } else {
                text = new Uint8Array(e.data)
            }
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
                        self._popReject(e)
                    } else {
                        self.sock.close()
                        // socket dead, send error to all waiting callbacks:
                        const cbs = self._callbackQueue.splice(0, self._callbackQueue.length)
                        for (const callback of cbs) {
                            callback[1](e)
                        }
                    }
                }

                // NEVER non-null if an exception was thrown
                if (maybeItem != null) {
                    // pass DF message
                    self._popReply(maybeItem)
                } // else, have not received enough data to decode
            } while (prevLen > buf[0].length && buf[0].length) // TODO should use maybeItem != null?

            self._buf = buf[0]
        }
    }

    _popReply (/** @type {!Out} */ reply) {
        const callback = this._callbackQueue.shift()
        if (callback !== undefined) {
            callback[0](reply)
        } else {
            this._unreadMessages.push(reply)
        }
    }

    _popReject (reason) {
        const callback = this._callbackQueue.shift()
        if (callback !== undefined) {
            callback[1](reason)
        } else {
            this._unreadMessages.push(reason)
        }
    }

    write (/** @type {!In} */ src) {
        if (this.sock.readyState === WebSocket.CONNECTING) {
            // NOTE: race condition?  Can it OPEN before this pushes?
            this._queuedWrites.push(this.codec.encode(src))
        } else if (this.sock.readyState === WebSocket.OPEN) {
            this.sock.send(this.codec.encode(src))
        } else {
            throw CodecError(`Cannot write to socket in ${this.sock.readyState}`)
        }
    }

    /**
     * Coalesces 1+ WebSocket packets into one response, based on a Codec,
     * and returns that.
     * @returns {!Promise<Out>}
     */
    async read () {
        if (this._unreadMessages.length) {
            // drain this._unreadMessages if one is queued up
            console.warn('Response arrived before request: %s', this._unreadMessages[0])
            const msg = this._unreadMessages.shift()
            return msg instanceof Error ? Promise.reject(msg) : Promise.resolve(msg)
        } else {
            const _callbackQueue = this._callbackQueue
            // resolve is invoked if codec yields a successful item.
            // reject is invoked if codec throws FramedCodecError.
            return new Promise((resolve, reject) => {
                _callbackQueue.push([resolve, reject])
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
            // give DF socket 100ms to close nicely
            window.setTimeout(() => this.sock.close(), 100)
        } else {
            this.sock.close()
        }
    }
}

const REQUEST_MAGIC_HDR = Uint8Array.from([68, 70, 72, 97, 99, 107, 63, 10, 1, 0, 0, 0]) // 'DFHack?\n' 1i32
const RESPONSE_MAGIC_HDR = Uint8Array.from([68, 70, 72, 97, 99, 107, 33, 10, 1, 0, 0, 0]) // 'DFHack!\n' 1i32
/**
 * Possible non-function IDs to be found in RPCMessage.header.id
 * @enum
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
 * @enum
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
 * @struct
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
     * RPCMessageHeader = { id: i16, (PACK: u16 = 0,) size: i32 }, size <= 64MiB
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
        const size = new Uint8Array((new Int32Array([input.data.length])).buffer)
        const id = new Uint8Array((new Int16Array([input.id])).buffer)
        const buf = new Uint8Array(8 + input.data.length)
        buf.set(id, 0)
        buf.set(size, 4)
        buf.set(input.data, 8)
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
                if (arrayEqual(buf[0].slice(0, 8), RESPONSE_MAGIC_HDR.slice(0, 8))) {
                    console.info('DwarfWireCodec shook hands!')
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
        if (buf[0].length >= 8) {
            // FIXME slow
            const id = (new Int16Array(buf[0].slice(0, 2).buffer))[0]
            const size = (new Int32Array(buf[0].slice(4, 8).buffer))[0]

            if (id === RPC.REPLY.FAIL) {
                buf[0] = buf[0].slice(8) // split_to 8
                // FAIL means "size" is really the errno
                const msgData = new Uint8Array(size.buffer)
                const msg = new DwarfMessage(id, msgData)
                return [msg, ...this._textMessages.splice(0)]
            } else if (id === RPC.REPLY.TEXT || id === RPC.REPLY.RESULT) {
                if (size >= 0 && size <= 67108864 /* 2**26 */) {
                    if (buf[0].length >= 8 + size) {
                        const msgData = buf[0].slice(8, 8 + size)
                        // split_to 8 + size:
                        buf[0] = buf[0].slice(8 + size)

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

/* eslint-disable key-spacing, no-multi-spaces */
const FUNC_DEFS = [
    // plugin, namespace for new protobuf types, { methods }
    [null, 'dfproto', {
        BindMethod:     ['CoreBindRequest', 'CoreBindReply'],
        RunCommand:     ['CoreRunCommandRequest',    'EmptyMessage'],
        CoreSuspend:    ['EmptyMessage',    'IntMessage'],
        CoreResume:     ['EmptyMessage',    'IntMessage'],
        RunLua:         ['CoreRunLuaRequest',    'StringListMessage'],
        GetVersion:     ['EmptyMessage',    'StringMessage'],
        GetDFVersion:   ['EmptyMessage',    'StringMessage'],
        GetWorldInfo:   ['EmptyMessage',    'GetWorldInfoOut'],
        ListEnums:      ['EmptyMessage',    'ListEnumsOut'],
        ListJobSkills:  ['EmptyMessage',    'ListJobSkillsOut'],
        ListMaterials:  ['ListMaterialsIn', 'ListMaterialsOut'],
        ListUnits:      ['ListUnitsIn',     'ListUnitsOut'],
        ListSquads:     ['ListSquadsIn',    'ListSquadsOut'],
        SetUnitLabors:  ['SetUnitLaborsIn', 'EmptyMessage'],
    }],
    ['rename', 'dfproto', {
        RenameSquad:    ['RenameSquadIn',  'EmptyMessage'],
        RenameUnit:     ['RenameUnitIn',   'EmptyMessage'],
        RenameBuilding: ['RenameBuildingIn',    'EmptyMessage']
    }],
    ['RemoteFortressReader', 'RemoteFortressReader', {
        GetMaterialList:    ['EmptyMessage',    'MaterialList'],
        GetGrowthList:      ['EmptyMessage',    'MaterialList'],
        GetBlockList:       ['BlockRequest',    'BlockList'],
        CheckHashes:        ['EmptyMessage',    'EmptyMessage'],
        GetTiletypeList:    ['EmptyMessage',    'TiletypeList'],
        GetPlantList:       ['BlockRequest',    'PlantList'],
        GetUnitList:        ['EmptyMessage',    'UnitList'],
        GetUnitListInside:  ['BlockRequest',    'UnitList'],
        GetViewInfo:        ['EmptyMessage',    'ViewInfo'],
        GetMapInfo:         ['EmptyMessage',    'MapInfo'],
        ResetMapHashes:     ['EmptyMessage',    'EmptyMessage'],
        GetItemList:        ['EmptyMessage',    'MaterialList'],
        GetBuildingDefList: ['EmptyMessage',    'BuildingList'],
        GetWorldMap:        ['EmptyMessage',    'WorldMap'],
        GetWorldMapNew:     ['EmptyMessage',    'WorldMap'],
        GetRegionMaps:      ['EmptyMessage',    'RegionMaps'],
        GetRegionMapsNew:   ['EmptyMessage',    'RegionMaps'],
        GetCreatureRaws:    ['EmptyMessage',    'CreatureRawList'],
        GetPartialCreatureRaws: ['ListRequest', 'CreatureRawList'],
        GetWorldMapCenter:  ['EmptyMessage',    'WorldMap'],
        GetPlantRaws:       ['EmptyMessage',    'PlantRawList'],
        GetPartialPlantRaws:    ['ListRequest', 'PlantRawList'],
        CopyScreen:         ['EmptyMessage',    'ScreenCapture'],
        PassKeyboardEvent:  ['KeyboardEvent',   'EmptyMessage'],
        SendDigCommand:     ['DigCommand',      'EmptyMessage'],
        SetPauseState:      ['SingleBool',      'EmptyMessage'],
        GetPauseState:      ['EmptyMessage',    'SingleBool'],
        GetVersionInfo:     ['EmptyMessage',    'VersionInfo'],
        GetReports:         ['EmptyMessage',    'Status'],

        GetLanguage:        ['EmptyMessage',    'Language']
    }],
    ['RemoteFortressReader', 'AdventureControl', {
        MoveCommand:        ['MoveCommandParams',   'EmptyMessage'],
        JumpCommand:        ['MoveCommandParams',   'EmptyMessage'],
        MenuQuery:          ['EmptyMessage',    'MenuContents'],
        MovementSelectCommand:  ['IntMessage',  'EmptyMessage'],
        MiscMoveCommand:    ['MiscMoveParams',  'EmptyMessage'],
    }],
    ['isoworldremote', 'isoworldremote', {
        GetEmbarkTile: ['TileRequest', 'EmbarkTile'],
        GetEmbarkInfo: ['MapRequest', 'MapReply'],
        GetRawNames: ['MapRequest', 'RawNames']
    }]
]
/* eslint-enable key-spacing, no-multi-spaces */

/**
 * Thrown if the method is missing.
 */
class DFHackNotBound extends Error { }

/**
 * @struct
 */
class DwarfClient {
    constructor () {
        this.framed = new CodecRunner(
            new DwarfWireCodec(),
            () => this._initialize()
        )
        /**
         * Maps short names to fully-qualified-names
         * @type {Map<string, string>}
         */
        this._typeNames = new Map()
        /**
         * Maps fully-qualified-names to protobufjs types
         * @type {Map<string, string>}
         */
        this._protoTypes = new Map()
        /**
         * Maps remote method names to IDs
         * @type {Map<string, string|null>}
         */
        this._methodIds = {}
        this._remoteMethods = new Map()

        this._loadTypeNames()
        this._loadProtoTypes()
    }

    _loadTypeNames () {
        for (const [, ns, methods] of FUNC_DEFS) {
            for (const [, [input, output]] of Object.entries(methods)) {
                if (!this._typeNames.has(input)) {
                    this._typeNames.set(input, `${ns}.${input}`)
                }
                if (!this._typeNames.has(output)) {
                    this._typeNames.set(output, `${ns}.${output}`)
                }
            }
        }
    }

    _loadProtoTypes () {
        for (const fqn of this._typeNames.values()) {
            this._protoTypes.set(fqn, root.lookupType(fqn))
        }
    }

    async _initialize () {
        // cache method IDs, and construct remote method
        for (const [plugin, , methods] of FUNC_DEFS) {
            for (const [name, [inputShort, outputShort]] of Object.entries(methods)) {
                const inputFqn = this._typeNames.get(inputShort)
                const outputFqn = this._typeNames.get(outputShort)

                const id = await this.BindMethod(name, inputFqn, outputFqn, plugin)
                this._methodIds[name] = id == null ? id : id.getAssignedId()

                if (id != null && name !== 'BindMethod') {
                    const inputType = this._protoTypes.get(inputFqn)
                    const outputType = this._protoTypes.get(outputFqn)
                    this._remoteMethods.set(
                        name,
                        this._remoteMethodFactory(name, inputType, outputType)
                    )
                    this[name] = this._remoteMethods.get(name)
                }
            }
        }
        return true
    }

    /**
     * @template In, Out
     * @param {string} name
     * @param {In} inputType
     * @param {Out} outputType
     * @returns {function(In): Out)}
     */
    _remoteMethodFactory (name, inputType, outputType) {
        return async function (input) {
            const req = inputType.encode(inputType.create(input)).finish()
            const msgs = await this.framed.writeRead(
                new DwarfMessage(this.getMethodId('GetMapInfo'), req)
            )
            if (msgs[0].id === RPC.REPLY.FAIL) {
                console.error(msgs[0])
                return null
            } else {
                return outputType.toObject(outputType.decode(msgs[0].data))
            }
        }
    }

    /**
     * Destroy socket.
     */
    destroy () {
        this.framed.close()
    }

    /**
     * @param {string} name
     * @returns {number}
     * @throws {DFHackNotBound}
     */
    getMethodId (name) {
        const id = this._methodIds[name]
        if (id == null) throw new DFHackNotBound(name)
        else return id
    }

    /**
     * GetVersion, dfproto.EmptyMessage, dfproto.StringMessage
     * @param {string} method
     * @param {string} inputMsg
     * @param {string} outputMsg
     * @param {?string=} plugin
     * @returns {rfr.CoreBindReply}
     */
    async BindMethod (method, inputMsg, outputMsg, plugin) {
        const req = new cp.CoreBindRequest()
        req.setMethod(method)
        req.setInputMsg(inputMsg)
        req.setOutputMsg(outputMsg)
        if (plugin != null) {
            req.setPlugin(plugin)
        }
        const msgs = await this.framed.writeRead(new DwarfMessage(0, req.serializeBinary()))
        if (msgs[0].id === RPC.REPLY.FAIL) {
            // FIXME should throw error
            console.error(`Failed to bind ${method}:`, msgs[0])
            return null
        } else {
            return cp.CoreBindReply.deserializeBinary(msgs[0].data)
        }
    }

    /**
     * @returns {rfr.BlockList}
     */
    async oldGetBlockList (minX, minY, minZ, maxX, maxY, maxZ, blocksNeeded) {
        const req = new rfr.BlockRequest()
        req.setMinX(minX)
        req.setMinY(minY)
        req.setMinZ(minZ)
        req.setMaxX(maxX)
        req.setMaxY(maxY)
        req.setMaxZ(maxZ)
        if (blocksNeeded != null) req.setBlocksNeeded(blocksNeeded)
        const msgs = await this.framed.writeRead(
            new DwarfMessage(this.getMethodId('GetBlockList'), req.serializeBinary())
        )
        return rfr.BlockList.deserializeBinary(msgs[0].data).toObject()
    }

    /**
     * @returns {rfr.UnitList}
     */
    async oldGetUnitListInside (minX, minY, minZ, maxX, maxY, maxZ, blocksNeeded) {
        const req = new rfr.BlockRequest()
        req.setMinX(minX)
        req.setMinY(minY)
        req.setMinZ(minZ)
        req.setMaxX(maxX)
        req.setMaxY(maxY)
        req.setMaxZ(maxZ)
        if (blocksNeeded != null) req.setBlocksNeeded(blocksNeeded)
        const msgs = await this.framed.writeRead(
            new DwarfMessage(this.getMethodId('GetUnitListInside'), req.serializeBinary())
        )
        return rfr.UnitList.deserializeBinary(msgs[0].data).toObject()
    }

    /**
     * @returns {rfr.MapInfo}
     */
    async oldGetMapInfo () {
        const req = new cp.EmptyMessage()
        const msgs = await this.framed.writeRead(
            new DwarfMessage(this.getMethodId('GetMapInfo'), req.serializeBinary())
        )
        return rfr.MapInfo.deserializeBinary(msgs[0].data).toObject()
    }
}

function main () {
    const df = new DwarfClient()
    // await df.GetBlockList(1, 1, 50, 9, 9, 56)
    // await df.GetUnitListInside(1, 1, 50, 9, 9, 56)
    return df
}

window.FUNC_DEFS = FUNC_DEFS
window.main = main
