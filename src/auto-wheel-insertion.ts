/**
 * @deprecated
 * 测试情况看来，反应速度没有 ResizeObserver 来的快
 */
import { InitQueue, InternalEvent, Queue, BlockQueue, UnBlockQueue, Observable } from './auto-wheel-decorator';
import { BaseEvent, EventMode, Func } from './event';
import { FrameScope, debounce, Events, macro, cNoop, micro } from './util';

const SLICE_EVENT = 'slice';

const keys = {
  total: undefined,
  itemHeight: undefined,
  pad: undefined
};

type EnterLeaveCbs = {
  enterFromStart?: (entry: IntersectionObserverEntry) => void;
  enterFromEnd?: (entry: IntersectionObserverEntry) => void;
  enter?: (entry: IntersectionObserverEntry) => void;
  leaveFromStart?: (entry: IntersectionObserverEntry) => void;
  leaveFromEnd?: (entry: IntersectionObserverEntry) => void;
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

enum Zone {
  StartVirtual,
  StartPad,
  Visual,
  EndPad,
  EndVirtual
}

type IZone = {
  zone: Zone;
  entry: IntersectionObserverEntry;
};

type LoadContext = {
  from: Zone,
}

type SliceInfo = Pick<AutoHeight, 'start' | 'end'> & Record<any, any>;

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
  startPad: HTMLElement;
  endPad: HTMLElement;
  startVirtual: HTMLElement;
  endVirtual: HTMLElement;

  list: HTMLElement;
  lead: HTMLElement;
  tail: HTMLElement;
  slotEl: HTMLSlotElement;
  padStart = 0;
  padEnd = 0;
  connectedPos: IPos;

  /*----------------- 需计算的属性 -----------------*/
  /** 渲染起始位置 */
  start = 0;
  /** 渲染终止位置(不一定代表真实位置，可能是通过 itemHeight 计算出的预计 end，真实的 memo.end 在 fix 过程中会计算得出) */
  end = 0;
  /** @deprecated 对动态高度的计算 */
  wrapperHeight: number;
  firstConnected = true;

  connectedCallback() {
    if (!this.firstConnected) return;
    console.log('connected isConnected', this.isConnected);
    const id = this.attributes.getNamedItem('id')?.value;
    this.watchDoms();
    Events.emit('init', id, this);
    // this.calcList(0, true);
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
        #wrapper {
          overflow: hidden; position: relative; width: 100%; height: 100%;
        }
        #startPad,#endPad,#startVirtual,#endVirtual {
          position: absolute; width: 100%; height: 100%;
        }
        #list {
          position: absolute; left: 0; top: 1px; right: 0;
        }
        #lead,#tail {
          width: 100%; height: 1px;
        }
      </style>
      <div id="wrapper">
        <div id="startPad">
          <div id="endPad">
            <div id="startVirtual">
              <div id="endVirtual">
                <div id="list">
                  <div id="lead"></div>
                  <slot id="slot"></slot>
                  <div id="tail"></div>
                </div>
              </div>
            </div>
          </div>
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
    // if (type === SLICE_EVENT && this.isConnected) {
    //   const event = new CustomEvent(SLICE_EVENT, { detail: this.connectedPos });
    //   this.dispatchEvent(event);
    // }
  }

  getAvgHeight = () => {
    const listHeight = this.list.clientHeight;
    if(this.end - this.start > 0) {
      return listHeight / (this.end - this.start);
    } 
    return this.getProp('itemHeight');
  }

  @Observable tailZone: Zone;
  @Observable leadZone: Zone;
  loadCtx: LoadContext;
  lockScrollDown=false;
  lockScrollUp=false;
  onTailZoneChanged(value: Zone, oldVal: Zone) {
    console.log(`tail在${Zone[value]},原${Zone[oldVal]}`);
    // console.trace('tail', { ctx: this.loadCtx, value: Zone[value], oldVal: Zone[oldVal] });
    // 向下加载至 tail 进入 EndVirtual
    if ([Zone.Visual, Zone.EndPad].includes(value)) {
      const prevLoadCtx = this.loadCtx;
      this.loadCtx = {
        from: value,
      }
      if(!prevLoadCtx) {
        this.fillEndLoop(true);
      }
    }

    const total = this.getProp('total')

    const isEndToVisual = value === Zone.Visual && [Zone.EndPad, Zone.EndVirtual].includes(oldVal);
    const reachEnd = total === this.end;

    // 从 end 过渡到 Visual，需要将
    if(isEndToVisual && reachEnd) {
      console.log('reachEnd');
      const { bottom: wrapperBottom } = this.wrapper.getBoundingClientRect();
      const { top: tailTop } = this.tail.getBoundingClientRect();
      const toBottom = wrapperBottom - tailTop;
      this.setsTop(this.sTop - toBottom - 1);
      this.lockScrollDown = true;
    }
   

    if(value === Zone.EndVirtual) {
      this.loadCtx = null;
    }
  }

  maxLoop = 20;
  loopCount = 0;
  fillEndLoop (imd: boolean) {
    const total = this.getProp('total');
    // raf 不得超过 20 次
    if(imd !== true) {
      if(this.loopCount === this.maxLoop) {
        this.loopCount = 0;
        return;
      }
      this.loopCount++;
    }

    if(!this.loadCtx) {
      return;
    }

    if(this.end === total) {
      return;
    }

    
    const pad = this.getProp('pad');
    const itemHeight = this.getAvgHeight();
    const { top: tailTop, bottom: tailBottom } = this.tail.getBoundingClientRect();
    const { bottom: wrapperBottom } = this.wrapper.getBoundingClientRect();

    /** 因为 observer 是惰性的，修改 dom 后下一个 raf 时 observer 还没触发，因此需要根据实际当前 dom 情况 判断 tail 的真实位置 */
    const realZone = tailBottom < wrapperBottom 
        ? Zone.Visual 
        : tailBottom < wrapperBottom + pad
          ? Zone.EndPad
          : Zone.EndVirtual;

    this.tailZone = realZone;
    this.loadCtx = { from: realZone };
    if(realZone === Zone.EndVirtual) {
      this.loadCtx = null;
      return;
    }

    const empty = this.loadCtx.from === Zone.Visual 
      //  
      ? wrapperBottom - tailTop + pad 
      // 
      : pad - (tailTop - wrapperBottom);
      

    if(empty < 0) {
      debugger;
    }

    const count = Math.ceil(empty / itemHeight);
    const newEnd = Math.min(this.end + count, total);

    console.log('fillLoop', { imd, realZone: Zone[realZone], tailTop, itemHeight, wrapperBottom, empty, end: newEnd });
    this.emitSliceAndFix({
      start: this.start,
      end: newEnd,
    });
    requestAnimationFrame(this.fillEndLoop.bind(this));
  }

  onLeadZoneChanged(value: Zone, oldVal: Zone) {
    console.log(`lead在${Zone[value]},原${Zone[oldVal]}`);
    const isStartToVisual = value === Zone.Visual
    const reachStart = 0 === this.start;
    if(reachStart && isStartToVisual) {
      const { top: wrapperTop } = this.wrapper.getBoundingClientRect();
      const { bottom: leadBottom } = this.lead.getBoundingClientRect();
      const toTop = wrapperTop - leadBottom;
      this.setsTop(Math.floor((this.sTop - toTop)));
      this.lockScrollUp = true;
    }
  }

  zoneKey = (entry: IntersectionObserverEntry) => (entry.target === this.tail ? 'tailZone' : 'leadZone');

  handleVisual(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      this.enterOrLeave(entry, {
        enter: () => {
          this[this.zoneKey(entry)] = Zone.Visual
        }
      });
    }
  }
  handleStartPad(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      this.enterOrLeave(entry, {
        enter: () => (this[this.zoneKey(entry)] = Zone.StartPad)
      });
    }
  }

  handleEndPad(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      this.enterOrLeave(entry, {
        enter: () => {
          const key = this.zoneKey(entry);
          console.log(key, '进入 endPad 区');
          (this[key] = Zone.EndPad)
        }
      });
    }
  }

  handleStartVirtual(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      this.enterOrLeave(entry, {
        enter: () => (this[this.zoneKey(entry)] = Zone.StartVirtual)
      });
    }
  }
  handleEndVirtual(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      this.enterOrLeave(entry, {
        enter: () => {
          const key = this.zoneKey(entry);
          console.log(key, '进入 endVirtual 区');
          (this[key] = Zone.EndVirtual)
        }
      });
    }
  }

  enterOrLeave = (entry: IntersectionObserverEntry, cbs: EnterLeaveCbs) => {
    // entry 进入视野
    if (entry.isIntersecting) {
      cbs.enter?.(entry);
      return;
    }

    // entry 离开视野
    const { rootBounds, boundingClientRect } = entry;

    // 从下边界离开
    if (boundingClientRect.top > rootBounds.bottom) {
      cbs.leaveFromEnd?.(entry);
      return;
    }

    // 从上边界离开
    cbs.leaveFromStart?.(entry);
  };

  watchDoms() {
    const pad = this.getProp('pad');
    this.wrapper = this.shadow.getElementById('wrapper');
    this.startPad = this.shadow.getElementById('startPad');
    this.endPad = this.shadow.getElementById('endPad');
    this.startVirtual = this.shadow.getElementById('startVirtual');
    this.endVirtual = this.shadow.getElementById('endVirtual');

    this.list = this.shadow.getElementById('list');
    this.slotEl = this.shadow.getElementById('slot') as any;
    this.lead = this.shadow.getElementById('lead');
    this.tail = this.shadow.getElementById('tail');
    this.wrapper.addEventListener(
      'wheel',
      e => {
        e.preventDefault();
        e.stopPropagation();
        this.onWheel(e);
      },
      { passive: false, signal: this.abortCon.signal }
    );

    this.startVirtual.style.setProperty('bottom', `${pad}px`)
    this.endVirtual.style.setProperty('top', `${pad * 2}px`)
    this.list.style.setProperty('top', `-${pad - 1}px`)

    this.visualObs = new IntersectionObserver(this.handleVisual.bind(this), { root: this.wrapper });
    this.startPadObs = new IntersectionObserver(this.handleStartPad.bind(this), {
      root: this.startPad,
      rootMargin: `${pad}px 0px -100% 0px`
    });
    this.endPadObs = new IntersectionObserver(this.handleEndPad.bind(this), {
      root: this.endPad,
      rootMargin: `-100% 0px ${pad}px 0px`
    });

    this.startVirtualObs = new IntersectionObserver(this.handleStartVirtual.bind(this), {
      root: this.startVirtual,
      threshold: 1,
      rootMargin: `${Number.MAX_SAFE_INTEGER}px 0px -100% 0px`
    });
    this.endVirtualObs = new IntersectionObserver(this.handleEndVirtual.bind(this), {
      root: this.endVirtual,
      threshold: 1,
      rootMargin: `-100% 0px ${Number.MAX_SAFE_INTEGER}px 0px`
    });

  
    [this.visualObs, this.startPadObs, this.endPadObs, this.startVirtualObs, this.endVirtualObs].forEach(obs => {
      obs.observe(this.lead);
      obs.observe(this.tail);
    });

  }

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
    const start = that.start;
    const end = that.end;
    const pos = {
      get start() {
        if (!this.filed) {
          // that.frame.requestFrame(() => that.fix());
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

  onWheel(e: WheelEvent) {
    console.log('wheel', e.deltaY > 0 ? '👇🏻' : '👆🏻');
    if((e.deltaY >= 0 && this.lockScrollDown) || (e.deltaY <= 0 && this.lockScrollUp)) {
      return;
    }
    // 向上滚动解锁
    if(e.deltaY < 0) {
      this.lockScrollDown = false;
    }
    // 向下滚动解锁
    if(e.deltaY > 0) {
      this.lockScrollUp = false;
    }

    const dtY = e.deltaY * (e['rate'] || this.RATE);
    const newsTop = this.sTop + dtY;
    this.setsTop(newsTop);
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
  sTop = 0;
  setsTop(v: number) {
    this.sTop = v;
    this.list.style.setProperty('transform', `translate3d(0,${-v}px,0)`);
  }


  /** 渲染完成后仍然有空白（用户预估项值高于真实值的情况）
   * 需要继续补充
   */
  @Queue(InternalEvent.FillTail)
  fillTail() {
    const total = this.getProp('total');
    const pad = this.getProp('pad');
    const { topToPadEnd, wrapperHeight } = this;
    const empty = wrapperHeight - topToPadEnd;

    // 向下一直补到 total 如果还是不满

    const { end } = this.calcEnd(this.memo.padEnd, empty);
    if (end == null) {
      console.log('fillTail-wheel');
      this['__onWheel']({ deltaY: this.topToPadEnd - this.wrapperHeight, rate: 1 } as any);
      return;
    }

    console.log('fillTail-add');
    this.emitSliceAndFix({
      overflow: this.overflow,
      start: this.memo.start,
      padStart: this.memo.padStart,
      end,
      padEnd: Math.min(end + pad + 1, total)
    });
  }

  @Queue(InternalEvent.ExtraFix)
  extraScrollToItem(index: number) {
    const delta = this.calcToItemDelta(index);
    this['__onWheel']({ deltaY: delta, rate: 1 } as any);
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
      throw {
        message: `未传入属性${key}!`,
        raw: error
      };
    }
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
        const delta = this.calcToItemDelta(action.payload.index);
        this.onWheel({ deltaY: delta, rate: 1 } as any);
        this.fixContext = {
          type: 'scrollToItem',
          payload: action.payload.index
        };
        break;
      default:
        break;
    }
  }

  calcToItemDelta(index: number) {
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

  visualObs: IntersectionObserver;
  startPadObs: IntersectionObserver;
  endPadObs: IntersectionObserver;
  startVirtualObs: IntersectionObserver;
  endVirtualObs: IntersectionObserver;
  frame = new FrameScope();
  e = new BaseEvent();
  abortCon = new AbortController();
}

function nature(num: number) {
  return Math.max(num, 0);
}
