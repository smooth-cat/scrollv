import { BaseEvent, EventMode, Func, ProcessStatus } from './event';
import { cNoop } from './util';
export enum InternalEvent {
  /** 初始化 */
  Connected = 'Connected',
  /** 一切与 scroll 相关的 */
  Scroll = 'Scroll',
  /** 容器高度变化 */
  WrapperResize = 'WrapperResize',
  /** 项高度变化 */
  ItemResize = 'ItemResize',
  /** fix */
  Fix = 'Fix',
  /** fix 后对未填满的部分再次补充 */
  FillTail = 'FillTail',
  /** 修正位置后需要额外与调用方触发的事件 */
  ExtraFix = 'ExtraFix'
}

export enum EventPriority {
  /** fix时，重填容器高度优先级最高, 和 InternalEvent.FillTail 对应
   * 因为只有填满后才应该开始做其他特殊处理
   */
  FillEmpty,
  /** 对应 InternalEvent.InternalEvent, 目前只有 scroll toItem 上下文需要进行对应补滚动，滚动的距离因虚拟而计算失精 */
  ExtraFix,
  /** 以上优先级的其他情况，都是普通优先级 */
  Normal
}

const InternalEvent2Priority = {
  /** 初始化 */
  [InternalEvent.Connected]: EventPriority.Normal,
  /** 一切与 scroll 相关的 */
  [InternalEvent.Scroll]: EventPriority.Normal,
  /** 容器高度变化 */
  [InternalEvent.WrapperResize]: EventPriority.Normal,
  /** 项高度变化 */
  [InternalEvent.ItemResize]: EventPriority.Normal,
  /** fix */
  [InternalEvent.Fix]: EventPriority.Normal,
  /** fix 后对未填满的部分再次补充 */
  [InternalEvent.FillTail]: EventPriority.FillEmpty,
  /** 修正位置后需要额外与调用方触发的事件 */
  [InternalEvent.ExtraFix]: EventPriority.ExtraFix
};

/** 记录 订阅事件 -> 函数名 */
const eventToFnName = new Map<InternalEvent, string>();

function createBlockCenter() {
  const center = new BaseEvent({ mode: EventMode.Queue });
  // 遇到优先级较高的任务把其放队首
  center.setScheduler(() => {
    center.eventQueue.sort((a, b) => {
      const ap = InternalEvent2Priority[a.type];
      const bp = InternalEvent2Priority[b.type];
      // 优先级按从小(靠前)到大排
      if (ap !== bp) return ap - bp;

      // 时间戳也同样按从小到大排
      return a.time - b.time;
    });

    center.processQueue();
  });
  return center;
}

export function BlockQueue() {
  return function (target: any, key: string, descriptor: TypedPropertyDescriptor<Function>) {
    const raw = target[key];
    descriptor.value = function (this: any, ...args) {
      this['__center'].pause();
      raw.call(this, ...args);
    };
  };
}
export function UnBlockQueue() {
  return function (target: any, key: string, descriptor: TypedPropertyDescriptor<Function>) {
    const raw = target[key];
    descriptor.value = function (this: any, ...args) {
      this['__center'].unPause();
      raw.call(this, ...args);
      // 如果执行过程中没有调用其他函数再将 center 锁上，即可在这一次 fix 中继续执行事件中心的任务
      if (this['__center'].status !== ProcessStatus.Paused) {
        this['__center'].start();
      }
    };
  };
}

/** 渲染事件通过事件队列按照 渲染+fix 的顺序挨个执行
 * 🌰:
 * 原顺序    wheel1 , wheel2 , fix1  ,  fix2
 *调整后顺序  wheel1 , fix1  , wheel2 , fix2
 * 这是为了 wheel2 能拿到正确的上一帧缓存信息
 */
export function Queue(event: InternalEvent) {
  return function (target: any, key: string, descriptor: TypedPropertyDescriptor<Function>) {
    const raw = target[key];
    const rawKey = `__${key}`;
    // 代理函数通过事件中心触发原始函数
    const proxyFn: Func = function (this: any, ...args) {
      this['__center'].emit(event, ...args);
    };
    descriptor.value = proxyFn;

    // 改名后，等待 InitOrder 重写的订阅
    target[rawKey] = raw;
    eventToFnName.set(event, rawKey);
  };
}

type ICtor = { new (...args: any[]): any };
/** 所有和渲染相关的事件通过事件队列按照 渲染+fix 的顺序挨个执行  */
export function InitQueue() {
  return function <T extends ICtor>(Origin: T) {
    const rawInit = Origin.prototype.init;
    /**
     * 重写 init 方法，不使用方法装饰器的原因是，
     * 这个装饰器一定要在所有 Order 装饰器执行后执行，
     * 使用方法装饰器还需要考虑 init 的声明位置，容易在维护时发生错误
     */
    Origin.prototype.init = function () {
      rawInit.call(this);
      this['__center'] = createBlockCenter();
      eventToFnName.forEach((rawKey, event) => {
        this['__center'].on(event, this[rawKey].bind(this));
      });
    };

    const rawDestroy = Origin.prototype.destroy;
    Origin.prototype.destroy = function (...args) {
      const ownKeys = Object.getOwnPropertyNames(Origin.prototype).filter(it => typeof this[it] === 'function');
      console.log('proto methods', ownKeys);

      this['__center'].clear();
      this['__center'] = undefined;
      rawDestroy.call(this, ...args);

      ownKeys.forEach(key => {
        // Origin.prototype[key] = cNoop(key);
        this[key] = cNoop(key);
      });
    };
  };
}
export function Observable(target: any, key: string) {
  // 前提是该属性在原型链上而不是在实例本身上
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      return this[`_obs_${key}`];
    },
    set(v) {
      const oldVal = this[`_obs_${key}`];
      if(oldVal === v) return;
      this[`_obs_${key}`] = v;
      const upper = key.replace(/^[a-zA-Z]/, match => match.toUpperCase());
      this[`on${upper}Changed`]?.(v, oldVal);
    }
  });
}

export enum Mode {
  /** 观察者 */
  Observer,
  /** 微任务轮询 */
  MicroPoll,
  /** 宏任务轮询 */
  MacroPoll
};

export function ShouldExec() {
  return function (target: any, key: string, descriptor: TypedPropertyDescriptor<Function>) {
    const raw = target[key];
    // 非 Observer 不执行
    descriptor.value = function (...args) {
      if(this.mode !== Mode.Observer) return;
      raw.apply(this, args);
    }
  }
}