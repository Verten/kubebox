'use strict';

const crypto = require('crypto'),
      http   = require('http'),
      https  = require('https'),
      os     = require('os'),
      URI    = require('urijs');

const { Transform } = require('stream');

// TODO: return an async iterator, instead of passing a generator as argument
// see: https://github.com/tc39/proposal-async-iteration
module.exports.get = function (options, { generator, readable, async = true, cancellable = false, rejectOnAbort = false } = {}) {
  if (generator) {
    if (os.platform() === 'browser' && WebSocket && options.headers && (options.headers['Upgrade'] || '').toLowerCase() === 'websocket') {
      return getWebSocketStream(options, { generator, readable, async });
    } else {
      return getStream(options, { generator, readable, async });
    }
  } else {
    return getBody(options, { cancellable, rejectOnAbort });
  }
};

function getBody(options, { cancellable, rejectOnAbort }) {
  let cancellation = Function.prototype;
  const promise = new Promise((resolve, reject) => {
    const client = (options.protocol || 'https').startsWith('https') ? https : http;
    let clientAbort, finished;
    const request = client.request(options, response => {
      if (response.statusCode >= 400) {
        const error = new Error(`Failed to get resource ${options.path || options}, status code: ${response.statusCode}`);
        // standard promises don't handle multi-parameters reject callbacks
        error.response = response;
        // IncomingMessage.destroy is not available in Browserify default shim
        // response.destroy(error);
        reject(error);
        return;
      }
      const body = [];
      response
        .on('data', chunk => body.push(chunk))
        .on('end', () => {
          if (clientAbort) {
            return;
          }
          response.body = Buffer.concat(body);
          finished = true;
          resolve(response);
        })
        .on('aborted', () => {
          if (rejectOnAbort) {
            reject();
          }
        });
    }).on('error', error => {
      finished = true;
      // 'Error: socket hang up' may be thrown on abort
      if (!clientAbort) {
        reject(error);
      }
    });
    if (options.method === 'POST' && options.postData) {
      request.write(JSON.stringify(options.postData));
    }
    request.end();
    cancellation = () => {
      if (!finished) {
        clientAbort = true;
        request.abort();
        return true;
      }
    };
  });
  return cancellable ? { promise, cancellation: () => cancellation() } : promise;
}

function getWebSocketStream(options, { generator, readable, async = true }) {
  let cancellation = Function.prototype;
  const promise = new Promise((resolve, reject) => {
    const url = new URI(options.path)
      .protocol((options.protocol || 'https').startsWith('https') ? 'wss' : 'ws')
      .hostname(options.hostname)
      .port(options.port);
    const protocols = [options.headers['Sec-WebSocket-Protocol']];
    if (options.headers['Authorization']) {
      // https://github.com/kubernetes/kubernetes/commit/714f97d7baf4975ad3aa47735a868a81a984d1f0
      protocols.push(`base64url.bearer.authorization.k8s.io.${Buffer.from(options.headers['Authorization'].substring(7)).toString('base64').replace(/=/g, '')}`);
    }
    const socket = new WebSocket(url.toString(), protocols);
    socket.binaryType = 'arraybuffer';
    if (readable) readable.on('data', data => {
      if (socket.readyState === 1) {
        socket.send(data);
      }
    });

    let clientAbort, abortState;
    cancellation = () => {
      abortState = socket.readyState;
      clientAbort = true;
      socket.close();
    };

    socket.addEventListener('error', event => {
      if (!clientAbort || abortState > 0) {
        reject(Error(`WebSocket connection failed to ${event.target.url}`));
      }
    });

    socket.addEventListener('open', event => {
      const gen = generator();
      gen.next();

      socket.addEventListener('message', event => {
        const res = gen.next(Buffer.from(event.data, 'binary'));
        if (res.done) {
          socket.close();
          event.body = res.value;
          // ignored for async as it's already been resolved
          resolve(event);
        }
      });

      socket.addEventListener('close', event => {
        if (!clientAbort) {
          const res = gen.next();
          // the generator may have already returned from the 'data' event
          if (!async && !res.done) {
            event.body = res.value;
            resolve(event);
          }
        }
        // ignored if the generator is done already
        gen.return();
      });

      if (async) {
        resolve(event);
      }
    });
  });
  return { promise, cancellation: () => cancellation() };
}

function getStream(options, { generator, readable, async = true }) {
  let cancellation = Function.prototype;

  const promise = new Promise((resolve, reject) => {
    let clientAbort, serverAbort;
    const client = (options.protocol || 'https').startsWith('https') ? https : http;
    const request = client.get(options)
      .on('error', error => {
        // FIXME: check the state of the connection and the promise
        // 'Error: socket hang up' may be thrown on close
        // for containers that have not emitted any logs yet
        if (!clientAbort) reject(error);
      })
      .on('response', response => {
        if (response.statusCode >= 400) {
          const error = new Error(`Failed to get resource ${options.path}, status code: ${response.statusCode}`);
          // standard promises don't handle multi-parameters reject callbacks
          error.response = response;
          response.destroy(error);
          return;
        }
        const gen = generator();
        gen.next();

        response
          .on('aborted', () => serverAbort = !clientAbort)
          .on('data', chunk => {
            // TODO: is there a way to avoid the client to deal with fragmentation?
            const res = gen.next(chunk);
            if (res.done) {
              // we may work on the http.ClientRequest if needed
              response.destroy();
              response.body = res.value;
              // ignored for async as it's already been resolved
              resolve(response);
            }
          })
          .on('end', () => {
            if (serverAbort || clientAbort && !async) {
              try {
                // FIXME: what happens when the generator is done already?
                const res = gen.throw(new Error('Request aborted'));
                // the generator may have already returned from the 'data' event
                if (!async && !res.done) {
                  response.body = res.value;
                  resolve(response);
                }
              } catch (e) {
                if (!async) {
                  reject(e);
                }
                // else swallow for generators that ignore aborted requests
              }
            } else if (!(clientAbort && async)) {
              const res = gen.next();
              // the generator may have already returned from the 'data' event
              if (!async && !res.done) {
                response.body = res.value;
                resolve(response);
              }
            }
            // ignored if the generator is done already
            gen.return();
          });

        if (async) {
          resolve(response);
        }
      })
      .on('upgrade', (response, socket, head) => {
        // TODO: verify 'Sec-WebSocket-Accept' during WebSocket handshake
        if (response.statusCode !== 101) {
          const error = new Error(`Failed to upgrade resource ${options.path}, status code: ${response.statusCode}`);
          // standard promises don't handle multi-parameters reject callbacks
          error.response = response;
          response.destroy(error);
          return;
        }
        cancellation = () => {
          clientAbort = true;
          socket.end();
        };

        if (readable) readable.pipe(new Encode()).pipe(socket);

        const gen = decode(generator(), socket);
        gen.next();

        socket
          .on('data', data => {
            // the server may still be sending some data as the socket
            // is ended, not aborted, on cancel
            if (!clientAbort) {
              const res = gen.next(data);
              if (res.done) {
                socket.end();
                response.body = res.value;
                // ignored for async as it's already been resolved
                resolve(response);
              }
            } else {
              gen.return();
            }
          })
          .on('end', () => {
            if (!clientAbort) {
              const res = gen.next();
              // the generator may have already returned from the 'data' event
              if (!async && !res.done) {
                response.body = res.value;
                resolve(response);
              }
            }
            // ignored if the generator is done already
            // FIXME: avoid leaking the client generator
            gen.return();
          });

        if (async) {
          resolve(response);
        }
      });
    cancellation = () => {
      clientAbort = true;
      request.abort();
    };
  });
  return { promise, cancellation: () => cancellation() };
}

// TODO: handle fragmentation and continuation frame
function* decode(gen, socket) {
  gen.next();
  let data, frame;
  while (data = yield) {
    do {
      if (!frame) {
        frame = decodeFrame(data);
      } else {
        const payload = data.slice(0, frame.length - frame.payload.length);
        if (frame.mask) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] = payload[i] ^ frame.maskingKey[i % 4];
          }
        }
        frame.payload = Buffer.concat([frame.payload, payload], frame.payload.length + payload.length);
        frame.offset = payload.length;
      }
      if (frame.payload && frame.payload.length < frame.length) {
        // wait for more payload data
        break;
      }
      // the frame is complete
      switch (frame.opcode) {
        case 0x1:
        case 0x2:
          // text or binary frame
          const { done, value } = gen.next(frame.payload);
          if (done) {
            return value;
          }
          break;
        case 0x8:
          // handle connection close in the 'end' event handler
          socket.end();
          // return directly
          return gen.next().value;
      }
      data = data.slice(frame.offset);
      frame = undefined;
    } while (data.length > 0);
  }
  return gen.next().value;
}

// https://tools.ietf.org/html/rfc6455#section-5.2
// https://tools.ietf.org/html/rfc6455#section-5.7
function decodeFrame(buffer) {
  const FIN    = buffer[0] & 0x80;
  const RSV1   = buffer[0] & 0x40;
  const RSV2   = buffer[0] & 0x20;
  const RSV3   = buffer[0] & 0x10;
  const opcode = buffer[0] & 0x0F;
  const mask   = buffer[1] & 0x80;
  let length   = buffer[1] & 0x7F;

  // just return the opcode on connection close
  if (opcode === 0x8) {
    return { opcode, offset: 2 };
  }

  let nextByte = 2;
  if (length === 126) {
    length = buffer.readUInt16BE(nextByte);
    nextByte += 2;
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(nextByte));
    if (!Number.isSafeInteger(length)) {
      throw Error('Frame length greater than 2^53-1 is not supported!');
    }
    nextByte += 8;
  }

  let maskingKey;
  if (mask) {
    maskingKey = buffer.slice(nextByte, nextByte + 4);
    nextByte += 4;
  }

  const offset = nextByte + length;
  const payload = buffer.slice(nextByte, offset);
  if (maskingKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i] ^ maskingKey[i % 4];
    }
  }
  return { FIN, opcode, mask, maskingKey, length, offset, payload };
}

function encodeFrame(data) {
  const length = data.length;
  let extra = 0;
  if (length <= 125) {
    extra = 0;
  } else if (length <= (1 << 17) - 1) {
    extra = 2;
  } else if (length <= (1 << 64) - 1) {
    extra = 8;
  } else {
    // TODO: handle very large messages, fragment into multiple continuation frames...
    throw Error('Frame length greater than 2^64 is not supported!');
  }

  const frame = Buffer.allocUnsafe(6 + length + extra);
  const random = crypto.randomBytes(4);
  for (let i = 0, j = 0; i < length; i++, j++) {
    data[i] = data[i] ^ random[j % 4];
  }

  frame[0] = 0x80 | 0x1;
  let next = 2;
  if(extra === 0) {
    frame[1] = 0x80 | length;
  } else if (extra === 2) {
    frame[1] = 0x80 | 126;
    frame[2] = length >> 8;
    frame[3] = length & 0xFF;
    next = 4;
  } else {
    frame[1] = 0x80 | 127;
    frame[2] = length >> 56;
    frame[3] = length >> 48;
    frame[4] = length >> 40;
    frame[5] = length >> 32;
    frame[6] = length >> 24;
    frame[7] = length >> 16;
    frame[8] = length >> 8;
    frame[9] = length & 0xFF;
    next = 10
  }
  frame[next++] = random[0];
  frame[next++] = random[1];
  frame[next++] = random[2];
  frame[next++] = random[3];
  for (let i = 0; i < length; i++) {
    frame[next + i] = data[i];
  }
  return frame;
}

class Encode extends Transform {
  constructor() {
    super({
      transform(chunk, _, callback) {
        try {
          this.push(encodeFrame(chunk));
          callback();
        } catch (error) {
          callback(error);
        }
      }
    });
  }
}
