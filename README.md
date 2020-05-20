# dfhack-remote

This project will provide browser-side bindings to
[RemoteFortressReader](https://github.com/DFHack/dfhack/tree/master/plugins/remotefortressreader)
("RFR"), the [protobuf](https://developers.google.com/protocol-buffers)-based
remote access interface to [DFHack](https://github.com/DFHack/dfhack).

It will also provide a browser-based fortress viewer.

## Dependencies

* [Node.js](https://nodejs.org/en/), for protobuf libraries
* [protoc](https://github.com/protocolbuffers/protobuf), to compile protobuf files to JS
* Python, to run `websockify` (see also experimental [websockify.js](https://github.com/novnc/websockify-js))

These are available on most package managers.  For example,

```sh
brew install node python protobuf
```

```sh
choco install -y nodejs python protoc
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
