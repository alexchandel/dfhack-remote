# dfhack-remote

This project provides browser-side JavaScript bindings to Dwarf Fortress, using
[RemoteFortressReader](https://github.com/DFHack/dfhack/tree/master/plugins/remotefortressreader)
("RFR"), the [protobuf](https://developers.google.com/protocol-buffers)-based
remote access interface to [DFHack](https://github.com/DFHack/dfhack).

It will also provide a browser-based fortress viewer.

## How it works

You run a `websockify` proxy, and open an HTML page containing `dfhack-remote`.  The page's code connects to DFHack through the `websockify` proxy, and loads your fortress.

## Dependencies

* [Node.js](https://nodejs.org/en/), for protobuf libraries
* Python, to run `websockify` (see also experimental [websockify.js](https://github.com/novnc/websockify-js))
* ~~[protoc](https://github.com/protocolbuffers/protobuf), to compile protobuf files to JS~~

These are available on most package managers.  For example,

```sh
brew install node python
```

```sh
choco install -y nodejs python
```

## Browser bindings

Setup your development environment:

* Install node dependencies with `npm install`.
* RemoteFortressReader protobuf definitions in `/proto/`.
* Compile protobufs to `/build/` with `npm run proto`.

## Websockify encapsulation

As browsers can only talk to WebSocket ports, not RFR's raw TCP ports,
you must run a [websockify](https://github.com/novnc/websockify) gateway
to forward browser requests to RFR.

* Install `websockify`, with `pip install websockify`

RFR listens on `127.0.0.1` on TCP port `5000` by default.
To wrap that with WebSockets on TCP port `8080`, for example, run:

```sh
websockify 127.0.0.1:8080 127.0.0.1:5000
```

## TODO

Optimize, like `java -jar closure-compiler-v20200517.jar -O ADVANCED --js_output_file build/bundle.min.js --js build/bundle.js`
