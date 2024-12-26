import { InitQueue, InternalEvent, Queue, BlockQueue, UnBlockQueue } from './auto-wheel-decorator';
import { BaseEvent, EventMode, Func } from './event';
import { FrameScope, debounce, Events, macro, cNoop } from './util';

const SLICE_EVENT = 'slice';

const keys = {
  total: undefined,
  itemHeight: undefined,
  pad: undefined
};

export type Keys = keyof typeof keys;

type BuildAction<T extends Record<any, any>> = {
  [P in keyof T]: {
    type: P;
    payload: T[P];
  };
}[keyof T];

type DeltaPayload = {
  /** 滚动距离 */
  dt: number;
};
type ToItemPayload = {
  /** 需要滚动到的项 */
  index: number;
};

type IScrollV = {
  delta: DeltaPayload;
  toItem: ToItemPayload;
};

type ScrollVType = keyof IScrollV;

type Action = BuildAction<IScrollV>;

type IPos = {
  start: number;
  end: number;
  filed: boolean;
};

@InitQueue()
export class AutoHeight extends HTMLElement {
  static tag = 'scrollv';
  constructor() {
    // 必须首先调用 super 方法, 继承基类
    super();

    // 初始化web component
    this.init();
  }
  template = document.createElement(`template`);
  shadow: ShadowRoot;
  wrapper: HTMLElement;
  list: HTMLElement;
  slotEl: HTMLSlotElement;
  padStart = 0;
  padEnd = 0;
  connectedPos: IPos;

  /*----------------- 需计算的属性 -----------------*/
  /** 渲染起始位置 */
  start = 0;
  /** 渲染终止位置 */
  end = 0;
  /** 对动态高度的计算 */
  wrapperHeight: number;
  firstConnected = true;

  /** append 🪝 */
  @Queue(InternalEvent.Connected)
  connectedCallback() {
    if (!this.firstConnected) return;
    console.log('connected isConnected', this.isConnected);
    const id = this.attributes.getNamedItem('id')?.value;
    this.watchDoms();
    Events.emit('init', id, this);
    this.calcList(0, true);
    this.firstConnected = false;
  }
  
  destroy() {
    if(this.isConnected) {
      this.remove();
    }
    this.shadow = undefined;
    this.wrapper = undefined;
    this.list = undefined;
    this.slotEl = undefined;
    this.connectedPos = undefined;
    this.frame.cancelFrames();
    this.wrapperObs.disconnect();
    this.itemObs.disconnect();
    this.template = undefined;
    this.elToI.clear();
    this.memoHeight.clear();
    const ownKeys = Object.getOwnPropertyNames(this).filter(it => typeof this[it] === 'function');
    console.log('instance methods', ownKeys);
    ownKeys.forEach(key => {
      this[key] = cNoop(key);
    });
    // 组件销毁时自动解除所有监听
    this.abortCon.abort();
  }

  disconnectedCallback() {}
  /** TODO: 补充 total 变更时如何更新的问题
   * setAttribute 和 innerHTML 🪝 */
  attributeChangedCallback(name, _, newValue) {
    // if (name === 'total') {
    //   this.calcList(newValue);
    // }
  }

  onSlice = (fn: (pos: { start: number; end: number }) => void) => {
    this.e.on(SLICE_EVENT, fn);
  };

  adoptedCallback() {
    console.log('adoptedCallback.');
  }

  init() {
    this.template.innerHTML = `
      <style>
        :host {
          display: block;
        }
      </style>
      <div id="wrapper" style="overflow: hidden; position: relative; width: 100%; height: 100%">
        <div id="list" style="position: absolute; left: 0; top: 0; right: 0;">
          <slot id="slot"></slot>
        </div>
      </div>
    `;
    this.shadow = this.attachShadow({ mode: 'open' });
    this.shadow.appendChild(this.template['content'].cloneNode(true));
    // 还可用事件监听来实现
    this.e.on(SLICE_EVENT, detail => {
      const event = new CustomEvent(SLICE_EVENT, { detail });
      this.dispatchEvent(event);
    });
    window['ins'] = this;
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void {
    // 在组件销毁时自动解除所有监听
    let opts: EventListenerOptions = {};
    if (typeof options === 'boolean') {
      opts.capture = options;
    } else {
      opts = options || {};
    }
    if (!opts['signal']) opts['signal'] = this.abortCon.signal;
    super.addEventListener(type, listener, opts);
    if (type === SLICE_EVENT && this.isConnected) {
      const event = new CustomEvent(SLICE_EVENT, { detail: this.connectedPos });
      this.dispatchEvent(event);
    }
  }

  watchDoms() {
    this.wrapper = this.shadow.getElementById('wrapper');
    window['wrapper'] = this.wrapper;
    this.list = this.shadow.getElementById('list');
    this.slotEl = this.shadow.getElementById('slot') as any;
    this.wrapperHeight = this.wrapper.offsetHeight;
    this.wrapperObs.observe(this.wrapper);
    this.wrapper.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.onWheel(e);
    }, { passive: false });
  }
  @BlockQueue()
  emitSliceAndFix(isFirstPaint = false) {
    const pos = this.createPos(++this.fixId);
    if (isFirstPaint) {
      this.connectedPos = pos;
    }
    this.e.emit(SLICE_EVENT, pos);
  }
  createPos = (fixId: number) => {
    console.log(`post-fix-${fixId}`);
    const that = this;
    const start = that.padStart;
    const end = that.padEnd;
    const pos = {
      get start() {
        if (!this.filed) {
          that.frame.requestFrame(() => that.fix(fixId));
          this.filed = true;
        }
        return start;
      },
      end: end,
      filed: false
    };
    return pos;
  };

  RATE = 0.5;
  overflow: number;
  @Queue(InternalEvent.Scroll)
  onWheel(e: WheelEvent) {
    const rate = e['rate'] ?? this.RATE;
    const scrolled = this.startItem.scrolled;
    const pad = this.getProp('pad');
    const total = this.getProp('total');
    let dtY = e.deltaY * rate;
    const { minDtY, maxDtY } = this;
    dtY = Math.min(Math.max(minDtY, dtY), maxDtY);
    // 向下滑动
    if (dtY >= 0) {
      const { end: start = 0, remain, overflow } = this.calcEnd(this.memo.start, scrolled + dtY);
      const screen = remain + this.wrapperHeight;
      const { end = total } = this.calcEnd(start, screen);

      this.overflow = overflow;
      this.start = start;
      this.padStart = nature(start - pad);
      this.end = end;
      this.padEnd = Math.min(this.end + pad + 1, total);
      this.emitSliceAndFix();
      return;
    }

    const preOverflow = this.overflow;
    //  向上滑动, remain 和 overflow 是相反的，overflow 表示被 sTop 遮盖的部分，remain 表示第一项露出的部分
    const { start = 0, remain, overflow } = this.calcStart(this.memo.start, -dtY + preOverflow);
    // TODO: 如果新的第一项是虚拟项，算出的 end 会不准
    const screen = overflow + this.wrapperHeight;
    const { end = total } = this.calcEnd(start, screen);

    this.overflow = remain;
    this.start = start;
    this.padStart = nature(start - pad);
    this.end = end;
    this.padEnd = Math.min(this.end + pad + 1, total);
    this.emitSliceAndFix();
    return;
  }
  fixId = 0;
  startItem = {
    height: 0,
    /** 被滚动过的区域 */
    scrolled: 0
  };
  endItem = {
    height: 0,
    /** 被滚动过的区域 */
    scrolled: 0
  };
  topToPadEnd: number;
  minDtY: number;
  maxDtY: number;
  memo = {
    start: 0,
    end: 0,
    padStart: 0,
    padEnd: 0
  };
  elToI = new Map<Element, number>();
  memoHeight = new Map<number, number>();
  fixContext: {
    type: string;
    payload: any;
  }

  @UnBlockQueue()
  fix(fixId: number) {
    if(this.fixId !== fixId) {
      console.warn('未按顺序处理Queue中的事件', { fixId, currentId: this.fixId })
    }
    console.log(`RAF-${fixId}`);
    console.log(`----------------------------------`);
    const total = this.getProp('total');
    const itemHeight = this.getProp('itemHeight');
    const items = this.slotEl.assignedElements();
    const startItemIdx = this.start - this.padStart;
    const endItemIdx = this.end - this.padStart;
    const isStartVirtual = this.start < this.memo.padStart;

    /** 首屏 */
    const fp = this.overflow == null;
    this.memoHeight.clear();
    this.elToI.forEach((_, el) => this.itemObs.unobserve(el));
    this.elToI.clear();

    const startItemHeight = (this.startItem.height = items[startItemIdx]?.getBoundingClientRect().height || 0);
    /**
     * 通过 api 向上滚动时
     * 如果正好滚动高度为一个虚拟项高度，
     * 则认为这个项被滚动过了一个真实项的高度
     */
    if (isStartVirtual && Math.abs(this.overflow - itemHeight) < 10) {
      this.overflow = startItemHeight;
    }

    this.endItem.height = items[endItemIdx]?.getBoundingClientRect().height || 0;
    /** 从 scrollTop 到 end 的距离 */
    let topToPadEnd = 0;
    let padToTop = 0;
    /** end 项露出的部分 */
    let endScrolled = 0;
    for (let i = this.padStart, j = 0; i < this.padEnd; i++, j++) {
      const it = items[j];
      this.itemObs.observe(it);
      this.elToI.set(it, i);
      const iRealHeight = it.getBoundingClientRect().height;
      this.memoHeight.set(i, iRealHeight);
      if (i >= this.start) {
        topToPadEnd += i === this.start ? this.overflow ?? iRealHeight : iRealHeight;
        if (i === this.end) {
          // 能够填满
          if (topToPadEnd >= this.wrapperHeight) {
            endScrolled = iRealHeight - (topToPadEnd - this.wrapperHeight);
          } else {
            endScrolled = iRealHeight;
          }
        }
      }
      if (i <= this.start) {
        padToTop += iRealHeight;
      }
    }
    this.endItem.scrolled = endScrolled;
    this.memo = {
      padStart: this.padStart,
      padEnd: this.padEnd,
      start: this.start,
      end: this.end
    };

    /** 高度重构后需要计算 */
    this.topToPadEnd = topToPadEnd;
    /**可向下移动的最大距离 = 视口底部 到 总内容的最后一项
     * = (sTop 到 最后一项) - 视口高度
     * = (sTop 到 end) + (end 到 最后一项) - 视口高度
     */
    const maxDtY = topToPadEnd + nature(total - this.padEnd) * itemHeight - this.wrapperHeight;
    this.maxDtY = maxDtY;

    /**
     * 可向上移动的最大距离 = 视口顶部 到 第一项顶部
     * = [0, padStart) 虚拟项 + [padStart, start] 真实项 - overflow；
     * 首屏 start 项的 overflow 是一整项
     */
    const minDtY = -(this.padStart * itemHeight + padToTop - (this.overflow ?? this.startItem.height));
    this.minDtY = minDtY;
    // 非首屏设置偏移量
    if (!fp) {
      const translateY = padToTop - this.overflow;
      this.startItem.scrolled = this.startItem.height - this.overflow;
      this.list.style.setProperty('transform', `translate3d(0,${-translateY}px,0)`);
    }

    // console.log('fix', { maxDtY: this.maxDtY, minDtY: this.minDtY });
    this.extraFix();
  }

  extraFix() {
    if(!this.fixContext) return;
    const { type, payload } = this.fixContext
    switch (type) {
      case 'scrollToItem':
        const index = payload;
        // 如果 index 项在视口内则不需要移动
        if(this.memo.start <= index && index < this.memo.end) break;
        const delta = this.calcToItemDelta(index);
        this['__onWheel']({ deltaY: delta, rate: 1 } as any);
        this['__center'].pause();
        break;
      default:
        break;
    }

    this.fixContext = undefined;
  }

  calcList(start: number, isFirstPaint = false) {
    try {
      const pad = this.getProp('pad');
      const total = this.getProp('total');
      // 列表高度 依赖 data
      const { end } = this.calcEnd(start, this.wrapperHeight);
      this.start = start;
      this.end = Math.min(end, total);
      this.padEnd = Math.min(end + pad + 1, total);
      this.emitSliceAndFix(isFirstPaint);
    } catch (error) {
      console.log('total未设置值', start, error);
    }
  }
  /**
   * TODO: 计算
   * 计算从某位置开始，需要几项能填满目标高度
   */
  calcStart = (from: number, tHeight: number) => {
    const itemHeight = this.getProp('itemHeight');
    let i = from;
    /** 这一项刚好填满 */
    let start: number;
    let remain: number;
    let overflow: number;

    while (0 <= i) {
      // 在此区间能拿到真实高度
      if (i >= this.memo.padStart && i < this.memo.padEnd) {
        const realHeight = this.memoHeight.get(i);
        if (realHeight >= tHeight) {
          overflow = realHeight - tHeight;
          remain = tHeight;
          start = i;
          break;
        } else {
          tHeight -= realHeight;
        }
        i--;
        continue;
      }

      if (i < this.memo.padStart) {
        // [0, i] 是虚拟项
        const virtualCount = i + 1;
        // 需要 x 项填满
        const x = Math.ceil(tHeight / itemHeight);
        if (virtualCount >= x) {
          overflow = x * itemHeight - tHeight;
          remain = itemHeight - overflow;
          start = i - x + 1;
          break;
        }
        // 不够填满
        else {
          tHeight -= virtualCount * itemHeight;
        }
        i = -1;
        continue;
      }

      //  this.memo.padEnd <= i
      // [this.memo.padEnd, i] 是虚拟项
      const virtualCount = i + 1 - this.memo.padEnd;
      // 需要 x 项填满
      const x = Math.ceil(tHeight / itemHeight);
      if (virtualCount >= x) {
        overflow = x * itemHeight - tHeight;
        remain = itemHeight - overflow;
        start = i - x + 1;
        break;
      }
      // 不够填满
      else {
        tHeight -= virtualCount * itemHeight;
      }
      i = this.memo.padEnd - 1;
    }

    return {
      // end 含 -1计算，数组长度极端情况需要更改
      start: start == null ? start : nature(start),
      overflow,
      remain
    };
  };
  calcEnd = (from: number, tHeight: number) => {
    const total = this.getProp('total');
    const itemHeight = this.getProp('itemHeight');
    let i = from;
    /** 这一项刚好填满 */
    let end: number;
    let remain: number;
    let overflow: number;

    while (i < total) {
      // 在此区间能拿到真实高度
      if (i >= this.memo.padStart && i < this.memo.padEnd) {
        const realHeight = this.memoHeight.get(i);
        if (realHeight >= tHeight) {
          overflow = realHeight - tHeight;
          remain = tHeight;
          end = i;
          break;
        } else {
          tHeight -= realHeight;
        }
        i++;
        continue;
      }

      if (i < this.memo.padStart) {
        // [i, this.memo.padStart) 是虚拟项
        const virtualCount = this.memo.padStart - i;
        // 需要 x 项填满
        const x = Math.ceil(tHeight / itemHeight);
        // 足够填满： i=0, x = 2; i+x=2 => [0,1,2]是3项❌; i+x-1=1 => [0,1]✅
        if (virtualCount >= x) {
          overflow = x * itemHeight - tHeight;
          remain = itemHeight - overflow;
          end = i + x - 1;
          break;
        }
        // 不够填满
        else {
          tHeight -= virtualCount * itemHeight;
        }
        i = this.memo.padStart;
        continue;
      }

      // this.memoEnd <= i
      // [i, total) 是虚拟项
      const virtualCount = total - i;
      // 需要 x 项填满
      const x = Math.ceil(tHeight / itemHeight);
      // 足够填满： i=0, x = 2; i+x=2 => [0,1,2]是3项❌; i+x-1=1 => [0,1]✅
      if (virtualCount >= x) {
        overflow = x * itemHeight - tHeight;
        remain = itemHeight - overflow;
        end = i + x - 1;
        break;
      }
      // 不够填满
      else {
        tHeight -= virtualCount * itemHeight;
      }
      i = total;
    }

    return {
      // end 含 -1计算，数组长度极端情况需要更改
      end: end == null ? end : Math.max(end, 0),
      overflow,
      remain
    };
  };

  getProp(key: Keys) {
    try {
      return Number(this.attributes.getNamedItem(key).value);
    } catch (error) {
      throw {
        message: `未传入属性${key}!`,
        raw: error
      };
    }
  }
  timeout = 600;

  // TODO: 滚动过程中又触发了其他滚动
  // scrollv(scrollType: 'delta', opt: IScrollV['delta']): void;
  // scrollv(scrollType: 'toItem', opt: IScrollV['toItem']): void;
  scrollv<T extends ScrollVType>(type: T, payload: IScrollV[T]) {
    const action: Action = {
      type,
      payload
    } as any;

    switch (action.type) {
      case 'delta':
        const dt = action.payload.dt;
        const times = Math.ceil(this.timeout / 16);
        const absDt = Math.abs(dt);
        const step = Number((absDt / times).toFixed(2));
        let realTimes = Math.floor(absDt / step);
        const last = absDt - realTimes * step;
        if (last) realTimes++;
        this._doScroll(realTimes, absDt < 0, step, last);
        break;
      case 'toItem':
        const delta = this.calcToItemDelta(action.payload.index);
        this.onWheel({ deltaY: delta, rate: 1 } as any);
        this.fixContext = {
          type: 'scrollToItem',
          payload: action.payload.index,
        }
        break;
      default:
        break;
    }
  }

  calcToItemDelta (index: number) {
    const mStart = this.memo.start;
    let delta: number;
    if (mStart < index) {
      const stack = this.getStack(mStart, index);
      delta = stack - this.startItem.scrolled;
    } else {
      const stack = this.getStack(index, mStart);
      delta = -(stack + this.startItem.scrolled);
    }
    return delta;
  }

  getStack(start: number, end: number) {
    const itemHeight = this.getProp('itemHeight');
    let stack = 0;
    const mStart = this.memo.padStart;
    const mEnd = this.memo.padEnd;
    for (let i = start; i < end; ) {
      if (i < mStart) {
        // 计算 mStart 前的高度
        stack += (mStart - start) * itemHeight;
        i = mStart;
      } else if (i < mEnd) {
        stack += this.memoHeight.get(i);
        i++;
      } else {
        stack += (end - mEnd) * itemHeight;
        i = end;
      }
    }
    return stack;
  }
  _doScroll = (remainTimes: number, isNegative: boolean, step: number, last?: number) => {
    let scrollValue = step;
    if (remainTimes === 1 && last) scrollValue = last;
    this.onWheel({ deltaY: isNegative ? -scrollValue : scrollValue, rate: 1 } as any);
    remainTimes--;
    if (remainTimes === 0) return;
    this.frame.requestFrame(() => this._doScroll(remainTimes, isNegative, step, last));
  };

  // callback 是微任务，但 debounce 后是宏任务，因此一定能拿到 fix 的真确信息
  @Queue(InternalEvent.WrapperResize)
  wrapperResize(entries: ResizeObserverEntry[]) {
    console.log('wrapper 大小发生变化');
    const pad = this.getProp('pad');
    const total = this.getProp('total');
    for (const entry of entries) {
      if (entry.target === this.wrapper) {
        const { height: newHeight } = entry.target.getBoundingClientRect();
        const oldHeight = this.wrapperHeight;
        this.wrapperHeight = newHeight;
        // 容器升高了，maxDtY 减少了
        const dtContainer = newHeight - oldHeight;
        this.maxDtY -= dtContainer;
        // 新视口高度 大于 sTop 到最后渲染项的高度需要增加渲染项避免白屏
        if (newHeight > oldHeight && newHeight > this.topToPadEnd) {
          const { end: newEnd } = this.calcEnd(this.memo.end, this.endItem.scrolled + dtContainer);

          if (newEnd != null) {
            this.end = newEnd;
            this.padEnd = Math.min(this.end + pad + 1, total);
            this.emitSliceAndFix();
          }
          // 渲染不满的情况，直接触发一个滚动到 maxDtY 的逻辑，强迫滚动至最后一项，还需考虑wrapperHeight变化对 maxDtY 的变化
          else {
            this['__onWheel']({ deltaY: this.maxDtY, rate: 1 } as any);
          }
        }
        // 重设 memo.end、endItem
        else {
          const { end: newEnd, remain } = this.calcEnd(this.memo.start, this.startItem.scrolled + newHeight);
          this.end = newEnd;
          this.endItem.scrolled = remain;
          this.endItem.height = this.memoHeight.get(newEnd);
        }
      }
    }
  }

  // TODO: 修复移动到宽度不同的容器时，内部元素高度自动变化，translateY 计算不正确
  @Queue(InternalEvent.ItemResize)
  itemResize(entries: ResizeObserverEntry[]) {
    console.log('itemResize');
    const shouldRerender = (stackDt: number) => {
      const { topToPadEnd, wrapperHeight } = this;
      const resized = topToPadEnd + stackDt;
      // 如果缩小后小于了视口高度说明需要从新渲染
      if (resized < wrapperHeight) {
        return true;
      }
    };

    const total = this.getProp('total');
    const pad = this.getProp('pad');
    let minI: number;
    let maxI: number;
    /** 前 pad 增加量 */
    let dtPrefix = 0;
    let dtVisual = 0;
    let dtSuffix = 0;
    let hasResize = false;
    for (const entry of entries) {
      const el = entry.target;
      const i = this.elToI.get(el);
      if (i == null) continue;
      const oldHeight = this.memoHeight.get(i);
      const { height: newHeight } = entry.target.getBoundingClientRect();
      if (oldHeight === newHeight || newHeight === 0) continue;
      hasResize = true;
      this.memoHeight.set(i, newHeight);
      // console.log(`${i}项高度变化 ${oldHeight} -> ${newHeight}`);
      if (i < (minI ?? Infinity)) {
        minI = i;
      }
      if (i > (maxI ?? -1)) {
        maxI = i;
      }

      // [padStart, start)
      if (i < this.memo.start) {
        dtPrefix += newHeight - oldHeight;
      }
      // [start, end]
      else if (i <= this.memo.end) {
        dtVisual += newHeight - oldHeight;
      }
      // (end, padEnd)
      else {
        dtSuffix += newHeight - oldHeight;
      }
    }
    if (!hasResize) return;

    const needRerender = shouldRerender(dtVisual + dtSuffix);

    // 仅 memo.start 左边的项变化，只需要修改 translateY, minDtY
    if (dtPrefix) {
      // minDtY 是负数，如果前部扩展，说明 minDtY 会更小
      this.minDtY -= dtPrefix;
      const tranStr = this.style.getPropertyValue('transform');
      const regExp = /([^\,\s])+px/;
      const [_, y = '0'] = tranStr.match(regExp) || [];
      let yNum = Number(y);
      yNum -= dtPrefix;
      this.list.style.setProperty('transform', `translate3d(0,${yNum}px,0)`);
    }
    // 仅 memo.end 右边的项变化，只需要修改 maxDtY topToPadEnd
    if (dtVisual || dtSuffix) {
      this.maxDtY = nature(this.maxDtY + dtVisual + dtSuffix);
      this.topToPadEnd += dtVisual + dtSuffix;
    }

    // TODO: 不论是否触发 fix 都应该重设 memo.end、memo.padEnd、endItem
    // 从 start 开始计算
    if (needRerender) {
      const { end: newEnd } = this.calcEnd(this.memo.start, this.startItem.scrolled + this.wrapperHeight);
      if (newEnd != null) {
        this.end = newEnd;
        this.padEnd = Math.min(this.end + pad + 1, total);
        this.emitSliceAndFix();
      }
      // 渲染不满的情况，需要向上滚动 padEnd - 屏幕底部 的距离
      else {
        this['__onWheel']({ deltaY: this.topToPadEnd - this.wrapperHeight, rate: 1 } as any);
      }
      return;
    }

    // 不需要 rerender 说明一定够填满，重新计算最后一项即可
    if (dtVisual) {
      const { end: newEnd, remain } = this.calcEnd(this.memo.start, this.startItem.scrolled + this.wrapperHeight);
      this.memo.end = newEnd;
      this.memo.padEnd = Math.min(this.end + pad + 1, total);
      this.endItem.scrolled = remain;
      this.endItem.height = this.memoHeight.get(newEnd);
    }

    // 不重置的原因是 第一项的 top 是固定的 scrolled 是不变的
    // startItem = {
    //   height: 0,
    //   /** 被滚动过的区域 */
    //   scrolled: 0
    // };
    // start 是不变的，end 也只在 Resize 中使用
    // memo = {
    //   start: 0,
    //   padStart: 0,
    // };
  }
  wrapperObs = new ResizeObserver(debounce<ResizeObserverCallback>((entries) => {
    this.wrapperResize(entries);
  }));
  itemObs = new ResizeObserver(this.itemResize.bind(this));
  frame = new FrameScope();
  e = new BaseEvent();
  abortCon = new AbortController();
}

function nature(num: number) {
  return Math.max(num, 0);
}
