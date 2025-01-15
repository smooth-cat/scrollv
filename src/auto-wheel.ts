import { InitQueue, InternalEvent, Queue, BlockQueue, UnBlockQueue } from './auto-wheel-decorator';
import { BaseEvent, EventMode, Func } from './event';
import { FrameScope, debounce, Events, macro, cNoop, micro } from './util';

const SLICE_EVENT = 'slice';

const keys = {
  total: undefined,
  itemHeight: undefined,
  pad: undefined,
  resizeDebounce: undefined,
  rate: undefined,
  passive: undefined,
};

const optionalKeys = ['rate', 'resizeDebounce', 'passive'];

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
  dt?: number;
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

type SliceInfo = Pick<AutoHeight, 
 'start'
 | 'padStart'
 | 'end'
 | 'padEnd'
 | 'overflow'
>

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
  /** 渲染终止位置(不一定代表真实位置，可能是通过 itemHeight 计算出的预计 end，真实的 memo.end 在 fix 过程中会计算得出) */
  end = 0;
  /** 对动态高度的计算 */
  wrapperHeight: number;
  firstConnected = true;

  /** append 🪝 */
  // @Queue(InternalEvent.Connected)
  connectedCallback() {
    if (!this.firstConnected) return;
    console.log('connected isConnected', this.isConnected);
    const id = this.attributes.getNamedItem('id')?.value;
    this.watchDoms();
    Events.emit('init', id, this);
    this.calcList(this.start, true);
    this.firstConnected = false;
  }

  destroy() {
    if (this.isConnected) {
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
  customListChange: EventListenerOrEventListenerObject;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void {
    if(type === 'listchange') {
      this.customListChange = listener;
      return;
    }
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
    const resizeDebounce = this.getRawProp('resizeDebounce');
    window['wrapper'] = this.wrapper;
    this.list = this.shadow.getElementById('list');
    this.slotEl = this.shadow.getElementById('slot') as any;
    this.wrapperHeight = this.wrapper.offsetHeight;
    this.itemObs = new ResizeObserver(
      resizeDebounce != null
        ? debounce<ResizeObserverCallback>(entries => {
            this.itemResize(entries);
          }, 16)
        : this.itemResize.bind(this)
    );
    
    this.slotEl.addEventListener('slotchange', () => {
      const els = this.slotEl.assignedElements();
      const withoutChild = !els.length;
      const hasFrame = this.frame.frameIds.size > 0;
      /** 
       * 1. 没有任何子项，不管 TODO: 后续处理
       * 2. 当前派发了 RAF 任务来处理，不管
       * 3，ResizeObserver 正在通过微任务处理，不管
       */
      if(withoutChild || hasFrame || this.useMicroFix) return;
      this.onListChange(els as any);
    }, { signal: this.abortCon.signal });

    this.wrapperObs.observe(this.wrapper);
    const usePassive = this.getRawProp('passive') != null;
    this.wrapper.addEventListener(
      'wheel',
      e => {
        if(!usePassive) {
          e.preventDefault();
        }
        this.onWheel(e);
      },
      { passive: usePassive, signal: this.abortCon.signal }
    );
  }

  @Queue(InternalEvent.ListChange)
  onListChange(els: HTMLElement[]) {
    if(typeof this.customListChange === 'function') {
      this.customListChange({ detail: els } as any);
      return;
    }
    const first = els[0];
    const total = this.getProp('total');
    const preOverflow = this.startItem.height - this.startItem.scrolled;
    const overflow = Math.min(first.offsetHeight, preOverflow); 
    // 新 total 和 padStart
    this.emitSliceAndFix({
      overflow,
      start: Math.min(this.start, total - 1),
      padStart: Math.min(this.padStart, total - 1),
      end: Math.min(this.end, total - 1),
      padEnd: Math.min(this.padEnd, total)
    });
  }

  /** 通过 sliceInfo 约束 emit 过程中需要提前设置的属性，避免漏设置 */
  @BlockQueue()
  emitSliceAndFix(sliceInfo: SliceInfo, isFirstPaint = false) {
    Object.assign(this, sliceInfo);

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
    const useMicroFix = that.useMicroFix;
    const pos = {
      get start() {
        if (!this.filed) {
          if(useMicroFix) {
            micro(() => that.fix(useMicroFix))
          } else {
            that.frame.requestFrame(() => that.fix(useMicroFix));
          }
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
    const rate = e['rate'] ?? (this.getProp('rate') || this.RATE);
    const scrolled = this.startItem.scrolled;
    const pad = this.getProp('pad');
    const total = this.getProp('total');
    let dtY = e.deltaY * rate;
    const { minDtY, maxDtY } = this;
    // 滚动到 顶|底 部，则不需要做处理
    if((dtY >= 0 && maxDtY === 0) || (dtY <= 0 && minDtY === 0)) {
      return;
    }

    dtY = Math.min(Math.max(minDtY, dtY), maxDtY);
    // 向下滑动
    if (dtY >= 0) {
      const { end: start = 0, remain, overflow } = this.calcEnd(this.memo.start, scrolled + dtY);
      const screen = remain + this.wrapperHeight;
      const { end = nature(total - 1) } = this.calcEnd(start, screen);

      this.emitSliceAndFix({
        overflow,
        start,
        padStart: nature(start - pad),
        end,
        padEnd: Math.min(end + pad + 1, total)
      });
      return;
    }

    const preOverflow = this.startItem.height - this.startItem.scrolled;
    //  向上滑动, remain 和 overflow 是相反的，overflow 表示被 sTop 遮盖的部分，remain 表示第一项露出的部分
    const { start = 0, remain, overflow } = this.calcStart(this.memo.start, -dtY + preOverflow);
    // TODO: 如果新的第一项是虚拟项，算出的 end 会不准
    const screen = overflow + this.wrapperHeight;
    const { end = nature(total - 1) } = this.calcEnd(start, screen);

    this.emitSliceAndFix({
      overflow: remain,
      start,
      padStart: nature(start - pad),
      end,
      padEnd: Math.min(end + pad + 1, total),
    });
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
  };
  useMicroFix = false;
  translateY = 0;
  setTranslateY(v: number) {
    this.translateY = v;
    this.list.style.setProperty('transform', `translate3d(0,${v}px,0)`);
  }

  fixedId = 0;
  // TODO: 考虑用户其他对列表项 的 增删移操作时，导致一个 block 后出现多个 unblock
  @UnBlockQueue()
  fix(useMicroFix = false) {
    const items = this.slotEl.assignedElements();
    if(!items.length) {
      return;
    }
    // TODO: slot 空白时不应该触发监听
    // if(this.firstFix) {
    //   this.firstFix = false;
    //   return;
    // }
    this.fixedId++;
    if (this.fixId !== this.fixedId) {
      console.warn('未按顺序处理Queue中的事件', { fixId: this.fixId, fixed: this.fixedId });
    }
    console.log(`RAF-${this.fixedId}`);
    console.log(`----------------------------------`);
    const total = this.getProp('total');
    const itemHeight = this.getProp('itemHeight');
    
    const startItemIdx = this.start - this.padStart;
    const endItemIdx = this.end - this.padStart;
    const isStartVirtual = this.start < this.memo.padStart;
    // const isEndVirtual = this.end >= this.memo.padEnd;

    /** 首屏 */
    this.memoHeight.clear();

    const startItemHeight = (this.startItem.height = items[startItemIdx]?.getBoundingClientRect().height || 0);
    /**
     * 如果新 start 是 Visual 则直接认为刚好滚动到其头部，
     * 原因1：真实项的高度小于overflow，导致头部空白，或者 start 项错误
     *       通过直接设值为真实项高度，可以保证 start 相关信息正确，并通过 fixTail 补充整个列表其他项
     * 原因2：滚动接近一个完整虚拟项时，应当对应显示整个真实项
     */
    if (isStartVirtual) {
      this.overflow = startItemHeight;
    }
    this.overflow = this.overflow ?? startItemHeight;
    // if (isStartVirtual && Math.abs(this.overflow - itemHeight) < 10) {
    //   this.overflow = startItemHeight;
    // }

    this.endItem.height = items[endItemIdx]?.getBoundingClientRect().height || 0;
    /** 从 scrollTop 到 end 的距离 */
    let topToPadEnd = 0;
    let padToTop = 0;
    let realEnd: number|null = null;
    const newElToI = new Map<Element, number>();
    for (let i = this.padStart, j = 0; i < this.padEnd; i++, j++) {
      const it = items[j];
      // 原先监听过的删除，elToI 剩余部分是需要解监听的
      if(this.elToI.has(it)) {
        this.elToI.delete(it);
      } 
      // 原先未监听过的进行监听
      else {
        this.itemObs.observe(it);
      }
      newElToI.set(it, i);
      const iRealHeight = it.getBoundingClientRect().height;
      this.memoHeight.set(i, iRealHeight);
      if (i >= this.start) {
        topToPadEnd += i === this.start ? this.overflow : iRealHeight;
        // end 并不能代表这次最终渲染的真实 end，需要再次通过累积 得出真实 end
        if (realEnd == null && topToPadEnd >= this.wrapperHeight) {
          realEnd = i;
          this.endItem.height = iRealHeight;
          this.endItem.scrolled = iRealHeight - (topToPadEnd - this.wrapperHeight);
        }
      }
      if (i <= this.start) {
        padToTop += iRealHeight;
      }
    }
    // 剩余项全部解监听
    this.elToI.forEach((_, el) => {
      this.itemObs.unobserve(el);
    });
    this.elToI = newElToI;

    this.memo = {
      padStart: this.padStart,
      padEnd: this.padEnd,
      start: this.start,
      end: realEnd ?? nature(this.padEnd - 1),
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
    this.startItem.scrolled = this.startItem.height - this.overflow;
    this.setTranslateY(-(padToTop - this.overflow));
   

    // 已渲染的 dom 填不满容器
    if(realEnd == null) {
      this.fillTail(useMicroFix);
    } else {
      this.useMicroFix = false;
    }
    // 如果尾部没问题再修复首部
    // else if() {

    // }
    // console.log('fix', { maxDtY: this.maxDtY, minDtY: this.minDtY });
    
    if (!this.fixContext) return;
    const { type, payload } = this.fixContext;
    switch (type) {
      case 'scrollToItem':
        const { index, dt } = payload;
        // 如果 index 项在视口内则不需要移动 TODO: 单item项测试
        // if ((this.memo.start <= index && index < this.memo.end) || this.memo.start === this.memo.end) break;
        if(dt) {
          this.extraScrollToItem(index, dt);
        }
        break;
      default:
        break;
    }
    this.fixContext = undefined;
  }

  /** 渲染完成后仍然有空白（用户预估项值高于真实值的情况）
   * 需要继续补充
   */
  @Queue(InternalEvent.FillTail)
  fillTail(useMicroFix=false) {
    this.useMicroFix = useMicroFix;
    const total = this.getProp('total');
    const pad = this.getProp('pad');
    const { topToPadEnd, wrapperHeight } = this;
    const empty = wrapperHeight - topToPadEnd;

    // 向下一直补到 total 如果还是不满

    const { end } = this.calcEnd(this.memo.padEnd, empty);
    if(end == null) {
      console.log('fillTail-wheel');
      this['__onWheel']({ deltaY: this.topToPadEnd - this.wrapperHeight, rate: 1 } as any);
      return;
    }
    
    console.log('fillTail-add');
    this.emitSliceAndFix({
      overflow: this.startItem.height - this.startItem.scrolled,
      start: this.memo.start,
      padStart: this.memo.padStart,
      end,
      padEnd: Math.min(end + pad + 1, total),
    });
  }

  @Queue(InternalEvent.ExtraFix)
  extraScrollToItem(index: number, dt = 0) {
    this['__onWheel']({ deltaY: dt, rate: 1 } as any);
  }

  @Queue(InternalEvent.CalcList)
  calcList(start: number, isFirstPaint = false) {
    try {
      const pad = this.getProp('pad');
      const total = this.getProp('total');
      // 列表高度 依赖 data
      const { end = nature(total - 1) } = this.calcEnd(start, this.wrapperHeight);
      this.emitSliceAndFix({
        overflow: undefined,
        start,
        padStart: nature(start - pad),
        end: Math.min(end, total),
        padEnd: Math.min(end + pad + 1, total),
      }, isFirstPaint);
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
      end: end == null ? end : nature(end),
      overflow,
      remain
    };
  };

  getProp(key: Keys) {
    try {
      return Number(this.attributes.getNamedItem(key).value);
    } catch (error) {
      if(optionalKeys.includes(key)) {
        return undefined;
      }

      throw {
        message: `未传入属性${key}!`,
        raw: error
      };
    }
  }

  getRawProp(key: Keys) {
    return this.attributes.getNamedItem(key)?.value;
  }
  timeout = 600;
  // TODO: 滚动过程中 用户重复调用 api
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
        if(this.firstConnected) {
          this.start = action.payload.index;
        } else {
          this.calcList(action.payload.index)
        }
        // const delta = this.calcToItemDelta(action.payload.index, action.payload.dt);
        // this.onWheel({ deltaY: delta, rate: 1 } as any);
        this.fixContext = {
          type: 'scrollToItem',
          payload: action.payload
        };
        break;
      default:
        break;
    }
  }

  calcToItemDelta(index: number, dt = 0) {
    const mStart = this.memo.start;
    let delta: number;
    if (mStart < index) {
      const stack = this.getStack(mStart, index);
      delta = stack - this.startItem.scrolled;
    } else {
      const stack = this.getStack(index, mStart);
      delta = -(stack + this.startItem.scrolled);
    }
    return delta + dt;
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
    const pad = this.getProp('pad');
    const total = this.getProp('total');
    for (const entry of entries) {
      if (entry.target === this.wrapper) {
        // const { height: newHeight } = entry.target.getBoundingClientRect();
        const { blockSize: newHeight } = entry.borderBoxSize[0];
        const oldHeight = this.wrapperHeight;
        if (oldHeight === newHeight) break;
        console.log('wrapper 大小发生变化', newHeight);
        this.wrapperHeight = newHeight;
        // 容器升高了，maxDtY 减少了
        const dtContainer = newHeight - oldHeight;
        this.maxDtY -= dtContainer;
        // 新视口高度 大于 sTop 到最后渲染项的高度需要增加渲染项避免白屏
        if (newHeight > oldHeight && newHeight > this.topToPadEnd) {
          const { end: newEnd } = this.calcEnd(this.memo.end, this.endItem.scrolled + dtContainer);

          if (newEnd != null) {
            this.emitSliceAndFix({
              overflow: this.startItem.height - this.startItem.scrolled,
              start: this.memo.start,
              padStart: this.memo.padStart,
              end: newEnd,
              padEnd: Math.min(newEnd + pad + 1, total)
            });
          }
          // 渲染不满的情况，直接触发一个滚动到 maxDtY 的逻辑，强迫滚动至最后一项，还需考虑wrapperHeight变化对 maxDtY 的变化
          else {
            this['__onWheel']({ deltaY: this.maxDtY, rate: 1 } as any);
          }
        }
        // 重设 memo.end、endItem
        else {
          const { end: newEnd, remain } = this.calcEnd(this.memo.start, this.startItem.scrolled + newHeight);
          this.memo.end = newEnd;
          this.endItem.scrolled = remain;
          this.endItem.height = this.memoHeight.get(newEnd);
        }
      }
    }
  }
  // TODO: 过渡动画时出现问题，虽然 start 标记的是 1 但是 translateY 计算错误
  //       目前已确定，原因在于 resizeObserver 执行后，下一帧 raf 获取到 overflow 不正确导致的
  @Queue(InternalEvent.ItemResize)
  itemResize(entries: ResizeObserverEntry[]) {
    const total = this.getProp('total');
    const pad = this.getProp('pad');
    /** 前 pad 增加量 */
    let dtPrefix = 0;
    let dtVisual = 0;
    let hasResize = false;
    let startDt: number | null = null;
    /** scrolled 占总高的百分比 */
    const startScrolledRate = this.startItem.height === 0 ? 0 : this.startItem.scrolled / this.startItem.height;
    for (const entry of entries) {
      const el = entry.target;
      const i = this.elToI.get(el);
      if (i == null) continue;
      const oldHeight = this.memoHeight.get(i);
      // TODO: 使用 InsertionObserver 优化 getBoundingClientRect
      // const { height: newHeight } = entry.target.getBoundingClientRect();
      const { blockSize: newHeight } = entry.borderBoxSize[0];
      if (oldHeight === newHeight || newHeight === 0) continue;
      hasResize = true;
      this.memoHeight.set(i, newHeight);

      // [padStart, start)
      if (i < this.memo.start) {
        dtPrefix += newHeight - oldHeight;
      } 
      else if (i === this.memo.start) {
        startDt = newHeight - oldHeight;
        if(!startDt) continue;
        const dtScrolled = startDt * startScrolledRate;
        this.startItem.scrolled += dtScrolled;
        this.startItem.height = newHeight;
        // scroll 变大，dtPrefix 变大，minDtY 变小 ✅
        dtPrefix += dtScrolled;
        // 这是 overflow 部分的 dt
        dtVisual += startDt - dtScrolled;
      }
      // (start, padEnd)
      else {
        dtVisual += newHeight - oldHeight;
      }
    }
    if (!hasResize) return;
    console.log('resize');

    // 仅 memo.start 左边的项变化，只需要修改 translateY, minDtY
    if (dtPrefix) {
      // minDtY 是负数，如果前部扩展，说明 minDtY 会更小
      this.minDtY -= dtPrefix;
      // dt 扩张了，translateY 应该减小
      this.setTranslateY(this.translateY - dtPrefix);
    }
    // 首项变化按比例计算
    // 仅 memo.end 右边的项变化，只需要修改 maxDtY topToPadEnd
    if (dtVisual) {
      this.maxDtY = nature(this.maxDtY + dtVisual);
      this.topToPadEnd += dtVisual;
    }

    // 重新计算 end
    const { end: newEnd, remain } = this.calcEnd(this.memo.start, this.startItem.scrolled + this.wrapperHeight);
    // 无法填满的情况，需要向上滚动 padEnd ~ 屏幕底部 的距离
    if (newEnd == null) {
      this.useMicroFix = true;
      this['__onWheel']({ deltaY: this.topToPadEnd - this.wrapperHeight, rate: 1 } as any);
    }
    // 如果新 end 在 padEnd 之内，则只需修改 endItem 相关
    else if (newEnd < this.memo.padEnd) {
      this.memo.end = newEnd;
      this.endItem.scrolled = remain;
      this.endItem.height = this.memoHeight.get(newEnd);
    }
    // 新 end 在 padEnd 之外，则需要重新渲染
    else {
      this.useMicroFix = true;
      this.emitSliceAndFix({
        overflow: this.startItem.height - this.startItem.scrolled,
        start: this.memo.start,
        padStart: this.memo.padStart,
        end: newEnd,
        padEnd: Math.min(newEnd + pad + 1, total),
      });
    }
    // start 是不变的，end 也只在 Resize 中使用
    // memo = {
    //   start: 0,
    //   padStart: 0,
    // };
  }
  wrapperObs = new ResizeObserver(
    debounce<ResizeObserverCallback>(entries => {
      this.wrapperResize(entries);
    })
  );
  itemObs: ResizeObserver;
  frame = new FrameScope();
  e = new BaseEvent();
  abortCon = new AbortController();
}

function nature(num: number) {
  return Math.max(num, 0);
}
