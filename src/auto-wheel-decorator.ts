import { AutoHeight } from "./auto-wheel";
import { BaseEvent, EventMode, Func } from "./event";
export enum InternalEvent {
  /** 初始化 */
  Connected='Connected',
  /** 一切与 scroll 相关的 */
  Scroll='Scroll',
  /** 容器高度变化 */
  WrapperResize='WrapperResize',
  /** 项高度变化 */
  ItemResize='ItemResize',
  /** fix */
  Fix='Fix',
};

/** 记录 订阅事件 -> 函数名 */
const keyToFnName = new Map<InternalEvent, string>();

function createOrderCenter() {
  const center = new BaseEvent({ mode: EventMode.Queue });
  let hasUnfixed = false;
  center.setScheduler(() => {
    const fixI = center.eventQueue.findIndex(it => it.type === InternalEvent.Fix);
    /**
     * 无 fixI，从前往后 看 process 是否有
     * 1. 有未 fix 的 scroll，则直接结束
     * 2. 无未 fix 的 scroll，则触发当前第一个 scroll，并记录 未 fix
     */
    if (!~fixI) {
      if (hasUnfixed) return;
      const first = center.eventQueue[0];
      if (!first) return;
      // 参数0 - event，参数1 - fixId
      center.dispatchEvent([0]);
      hasUnfixed = true;
      return;
    }

    /**
     * 有 fixI
     * 1. 删除已有的 fixed，
     *    先触发 fixId 事件
     *    再触发下一个 scroll 事件
     */
    // 触发 fix 事件
    center.dispatchEvent([fixI]);
    hasUnfixed = false;
    // 触发 第一个 scroll 事件
    const processI = center.eventQueue.findIndex(it => it.type !== InternalEvent.Fix);
    if (!~processI) return;
    center.dispatchEvent([processI]);
    hasUnfixed = true;
  });
  return center;
}

/** 渲染事件通过事件队列按照 渲染+fix 的顺序挨个执行
 * 🌰: 
 * 原顺序    wheel1 , wheel2 , fix1  ,  fix2
 *调整后顺序  wheel1 , fix1  , wheel2 , fix2
 * 这是为了 wheel2 能拿到正确的上一帧缓存信息
  */
export function Order(event: InternalEvent) {
  return function (target: AutoHeight, key: string) { 
    const raw = target[key];
    const rawKey = `__${key}`;
    // 代理函数通过事件中心触发原始函数
    const proxyFn: Func = function(this: AutoHeight, ...args) {
      this['__center'].emit(event, ...args);
    };
    target[key] = proxyFn;

    // 改名后，等待 InitOrder 重写的订阅
    target[rawKey] = raw;
    keyToFnName.set(event, rawKey);
  }
}

type ICtor = { new (...args: any[]): any };
/** 所有和渲染相关的事件通过事件队列按照 渲染+fix 的顺序挨个执行  */
export function InitOrder<T extends ICtor>(Origin: T) {
  const rawInit = Origin.prototype.init;
  /**
   * 重写 init 方法，不使用方法装饰器的原因是，
   * 这个装饰器一定要在所有 Order 装饰器执行后执行，
   * 使用方法装饰器还需要考虑 init 的声明位置，容易在维护时发生错误
   */
  Origin.prototype.init = function() {
    rawInit.call(this);
    const center = createOrderCenter();
    this['__center'] = center;
    keyToFnName.forEach((rawKey, event) => {
      center.on(event, this[rawKey].bind(this));
    })
  }
}