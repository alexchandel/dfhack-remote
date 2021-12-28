# dfhack-remote

This project provides browser-side JavaScript bindings to Dwarf Fortress, using
[RemoteFortressReader](https://github.com/DFHack/dfhack/tree/master/plugins/remotefortressreader)
("RFR"), the [protobuf](https://developers.google.com/protocol-buffers)-based
remote access interface to [DFHack](https://github.com/DFHack/dfhack).
With this API, you can talk to Dwarf Fortress from your browser,
your phone, your TV, your car display… any browser that
[supports WebSockets](https://caniuse.com/#feat=websockets) (all of them, even IE).

It may also demo a browser-based fortress viewer someday.

## How it works

You run `websockify`, and then open an HTML page that uses `dfhack-remote`.  The page connects to DFHack through the `websockify` proxy, and loads your fortress.

`websockify` is just a passthrough, and `dfhack-remote` is just a thin wrapper around DFHack.
Your webpage has full, direct access to DFHack.
It could make [Armok Vision](https://github.com/RosaryMala/armok-vision) in the browser
with [threejs](https://threejs.org/)/[voxeljs-next](https://github.com/joshmarinacci/voxeljs-next/).

## Setup

### Prerequisites

* [Node.js](https://nodejs.org/en/), for protobuf libraries and websockify

These are available on most package managers.  For example,

```sh
brew install node
```

```sh
choco install -y nodejs
```

### Compile Browser Bindings

Setup your development environment:

* Install node dependencies with `npm install`.
  * Note: this also compiles RFR's protobufs (from `proto/`) into `build/`.

Run the example:

* Compile the JavaScript example to `build/bundle.js` and launch the `websockify` server with `npm test`

### Running the Example

Run Dwarf Fortress with DFHack and load a fort.
Then run the example with `npm test`.
Now you can open `index.html`.  Try this in your browser's Inspector:

```js
df = new DwarfClient()
x = await df.GetMapInfo()
```

Pass arguments to RFR methods with a dictionary:

```js
x = await df.GetUnitListInside({ minX: 1, minY: 1, minZ: 50, maxX: 9, maxY: 9, maxZ: 56 })
x = await df.GetBlockList({minX: 1, minY: 1, minZ: 50, maxX: 9, maxY: 9, maxZ: 56})
```

## Documentation

The API defines one class, `DwarfClient`:

```js
/**
 * @struct
 */
class DwarfClient {
    /**
     * Upon construction, immediately tries to connect to DFHack.
     * @param {?(number|string)} host An optional numeric port, or string like "127.0.0.1:8080"
     */
    constructor (host = null) {
        ...
    }
    ...
}
```

It has one `async` method for every RFR method.  Pass arguments to RFR methods with a dictionary:

```js
df = new DwarfClient()
await df.GetMapInfo()
await df.GetUnitListInside({ minX: 1, minY: 1, minZ: 50, maxX: 9, maxY: 9, maxZ: 56 })
await df.GetBlockList({ minX: 1, minY: 1, minZ: 50, maxX: 9, maxY: 9, maxZ: 56 })
```

The RFR methods are (sort of) listed in `FUNC_DEFS` in `main.js`.  The RFR
types are defined in the protobuf files in `proto/`.

note: if necessary, parameter names must be converted to camel-case (e.g: ```list_start```->```listStart```)

### Running a Websockify Wrapper

As browsers can only talk to WebSocket ports, not RFR's raw TCP ports,
you must run a [websockify](https://github.com/novnc/websockify-js) gateway
to forward browser requests to RFR.

RFR listens on `127.0.0.1` on TCP port `5000` by default.
To wrap that with WebSockets on TCP port `8080`, run:

```sh
npx websockify --web=. 127.0.0.1:8080 127.0.0.1:5000
```

`npm test` automatically runs this.

Now you can run Dwarf Fortress with DFHack and access data from http://127.0.0.1:8080.

## Issues

RemoteFortressReader has a strange bug where it "remembers" what it returned to
`GetBlockList`, and never returns a block again unless it changes.  That's a
buggy way to implement "change-driven notifications" and should be fixed there.
For now, remember `GetBlockList` only returns changes since the last call!

### TODO

* Make the client an actual JavaScript module.  Right now, it's stuffed into `window.DwarfClient`.
* Optionally print the CoreTextNotification responses somewhere.  Right now, they're just thrown away.
* Embed dfhack as a subrepository, and dynamically find protobuf's.  Right now, they're just copied.
* Optimize, like `java -jar closure-compiler-v20200517.jar -O ADVANCED --js_output_file build/bundle.min.js --js build/bundle.js`
