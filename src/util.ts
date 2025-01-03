import { BaseEvent } from './event';

export const Events = new BaseEvent();
export const EventMap = new Map<string, BaseEvent>();

export const debounce = <T extends Function>(fn: T, timeout = 300) => {
  let timer;
  return function (this, ...args: any[]) {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    timer = setTimeout(() => {
      fn?.call(this, ...args);
      timer = null;
    }, timeout);
  } as unknown as T;
};

let id = 0;
const idToFn = new Map<number, Function>();
const messageChannel = new MessageChannel();
messageChannel.port1.onmessage = e => {
  const { data: id } = e;
  const cb = idToFn.get(id);
  cb?.();
  idToFn.delete(id);
};

export const macro = (cb: Function) => {
  id++;
  idToFn.set(id, cb);
  messageChannel.port2.postMessage(id);
};
const p = Promise.resolve();
export const micro = (cb: Function) => {
  p.then(cb as any);
}

export class FrameScope {
  frameIds = new Set();
  cancelFrames = (id?: number) => {
    if (id == null) return this.frameIds.clear();
    this.frameIds.delete(id);
  };
  requestFrame = (fn: (time: DOMHighResTimeStamp) => void) => {
    const that = this;
    function withId(time) {
      that.frameIds.delete(id);
      fn(time);
    }
    const id = requestAnimationFrame(withId);
    that.frameIds.add(id);
  };
}

export const cNoop = (rawName: string) => {
  return function () {
    console.warn(`Calling ${rawName} method while scrollv web-component is destroyed.`);
  }
}