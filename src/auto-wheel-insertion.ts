/**
 * @deprecated
 * 测试情况看来，反应速度没有 ResizeObserver 来的快
 */
import {
  InitQueue,
  InternalEvent,
  Queue,
  BlockQueue,
  UnBlockQueue,
  Observable,
  Mode,
  ShouldExec
} from './auto-wheel-decorator';
import { BaseEvent, EventMode, Func } from './event';
import { FrameScope, debounce, Events, macro, cNoop, micro } from './util';

const SLICE_EVENT = 'slice';

const keys = {
  total: undefined,
  itemHeight: undefined,
  pad: undefined
};

type EnterLeaveCbs = {
  enterFromStart?: (entry: IEntry) => void;
  enterFromEnd?: (entry: IEntry) => void;
  enter?: (entry: IEntry) => void;
  leaveFromStart?: (entry: IEntry) => void;
  leaveFromEnd?: (entry: IEntry) => void;
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
  entry: IEntry;
};

type LoadContext = {
  from: Zone;
};
type IEntry = IntersectionObserverEntry;
type SliceInfo = Pick<AutoHeight, 'start' | 'end'> & Record<any, any>;

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
  lead: HTMLElement;
  tail: HTMLElement;
  slotEl: HTMLSlotElement;
  connectedPos: IPos;

  /*----------------- 需计算的属性 -----------------*/
  /** 渲染起始位置 */
  start = 0;
  /** 渲染终止位置(不一定代表真实位置，可能是通过 itemHeight 计算出的预计 end，真实的 memo.end 在 fix 过程中会计算得出) */
  end = 0;

  firstConnected = true;
  // TODO: 首屏白屏问题
  connectedCallback() {
    if (!this.firstConnected) return;
    console.log('connected isConnected', this.isConnected);
    const id = this.attributes.getNamedItem('id')?.value;
    this.watchDoms();
    Events.emit('init', id, this);
    this.boundaryCheck();
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
          position: absolute; left: 0; top: 0px; right: 0;
        }
        #lead,#tail {
          width: 100%; height: 0px;
        }
      </style>
      <div id="wrapper">
        <div id="list">
          <div id="lead"></div>
          <slot id="slot"></slot>
          <div id="tail"></div>
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

  getAvgHeight = () => {
    const listHeight = this.list.clientHeight;
    if (this.end - this.start > 0) {
      return listHeight / (this.end - this.start);
    }
    return this.getProp('itemHeight');
  };

  @Observable tailZone: Zone;
  @Observable leadZone: Zone;
  loadEndCtx: LoadContext;
  loadStartCtx: LoadContext;
  lockScrollDown = false;
  lockScrollUp = true;
  mode = Mode.Observer;
  maxDtY: number;
  minDtY: number;

  fillEnd({ itemHeight, tailTop, tailBottom, wrapperBottom }: any) {
    const total = this.getProp('total');
    if (this.end === total) {
      return;
    }

    const pad = this.getProp('pad');
    // tailBottom = Math.floor(tailBottom);

    /** 因为 observer 是惰性的，修改 dom 后下一个 raf 时 observer 还没触发，因此需要根据实际当前 dom 情况 判断 tail 的真实位置 */
    const realZone =
      tailBottom <= wrapperBottom ? Zone.Visual : tailBottom <= wrapperBottom + pad ? Zone.EndPad : Zone.EndVirtual;

    if (realZone === Zone.EndVirtual) {
      console.warn('fillEnd在不需要填充时被调用', JSON.stringify(arguments[0]));
      return;
    }

    const empty =
      realZone === Zone.Visual
        ? //
          wrapperBottom - tailTop + pad
        : //
          pad - (tailTop - wrapperBottom);

    if (empty < 0) {
      debugger;
    }

    const count = Math.ceil(empty / itemHeight);
    const newEnd = Math.min(this.end + count, total);
    console.trace('fillEnd', { realZone: Zone[realZone], tailTop, itemHeight, wrapperBottom, empty, end: newEnd });
    this.emitSliceAndFix({
      start: this.start,
      end: newEnd
    });
  }

  fillStart({ itemHeight, leadTop, leadBottom, wrapperTop }: any) {
    if (this.start === 0) {
      return;
    }
    const pad = this.getProp('pad');
    // leadBottom = Math.ceil(leadBottom);
    /** 因为 observer 是惰性的，修改 dom 后下一个 raf 时 observer 还没触发，因此需要根据实际当前 dom 情况 判断 tail 的真实位置 */
    const realZone =
      leadTop >= wrapperTop ? Zone.Visual : leadTop >= wrapperTop - pad ? Zone.StartPad : Zone.StartVirtual;

    if (realZone === Zone.StartVirtual) {
      console.warn('fillStart在不需要填充时被调用', JSON.stringify(arguments[0]));
      return;
    }

    const empty =
      realZone === Zone.Visual
        ? //
          leadBottom - wrapperTop + pad
        : //
          pad - (wrapperTop - leadBottom);

    if (empty < 0) {
      debugger;
    }

    const count = Math.ceil(empty / itemHeight);
    const newStart = nature(this.start - count);

    console.trace('fillStart', { realZone: Zone[realZone], leadTop, itemHeight, wrapperTop, empty, end: newStart });
    this.emitSliceAndFix({
      start: newStart,
      end: this.end
    });
  }

  broadHandlers = (entry: IEntry) => {
    return entry.target === this.tail
      ? {
          enter: this.o.tailEnterBroad,
          leaveFromEnd: this.o.tailLeaveBroadFromEnd
          // leaveFromStart: this.o.tailLeaveBroadFromStart,
        }
      : {
          enter: this.o.leadEnterBroad,
          // leaveFromEnd: this.o.leadLeaveBroadFromEnd,
          leaveFromStart: this.o.leadLeaveBroadFromStart
        };
  };

  o = {
    /*----------------- windObs -----------------*/
    tailEnterWind: (entry: IEntry) => {},
    tailLeaveWindFromEnd: (entry: IEntry) => {},
    leadEnterWind: (entry: IEntry) => {},
    leadLeaveWindFromStart: (entry: IEntry) => {},
    /*----------------- broadObs -----------------*/
    tailEnterBroad: (entry: IEntry) => {
      const { bottom: wrapperBottom } = entry.rootBounds;
      const { bottom: tailBottom, top: tailTop } = entry.boundingClientRect;
      this.fillEnd({
        itemHeight: this.getAvgHeight(),
        tailTop,
        tailBottom,
        wrapperBottom
      });
    },
    tailLeaveBroadFromEnd: (entry: IEntry) => {},
    leadEnterBroad: (entry: IEntry) => {
      const { top: wrapperTop } = entry.rootBounds;
      const { bottom: leadBottom, top: leadTop } = entry.boundingClientRect;
      this.fillStart({
        itemHeight: this.getAvgHeight(),
        leadTop,
        leadBottom,
        wrapperTop
      });
    },
    leadLeaveBroadFromStart: (entry: IEntry) => {},
    itemLeaveBroadFromStart: (entry: IEntry) => {},
    itemLeaveBroadFromEnd: (entry: IEntry) => {}
  }
  i = {
    /*----------------- windObs -----------------*/
    tailEnterWind: () => {},
    tailLeaveWindFromEnd: () => {},
    leadEnterWind: () => {},
    leadLeaveWindFromStart: () => {},
    tailEnterBroad: () => {},
    tailLeaveBroadFromEnd: () => {},
    leadEnterBroad: () => {},
    leadLeaveBroadFromStart: () => {},
    itemLeaveFromStart: () => {},
    itemLeaveFromEnd: () => {}
  };


  /** 边界检测，若未检测到任何需要渲染的边界条件
 * 则返回 false
 * 若检测到则返回 true
 */
  boundaryCheck() {
    const els = this.slotEl.assignedElements() as HTMLElement[];
    this.watchItems(els);
    const pad = this.getProp('pad');
    const total = this.getProp('total');
    if(this.start < this.memo.start) {
      const addedCount= this.memo.start - this.start;
      let addedTop = 0;
      for (let i = 0; i < els.length; i++) {
        if(i === addedCount) break;
        const el = els[i];
        addedTop += el.offsetHeight;
      }
      this.setsTopDt(v => v + addedTop, true);
      this.memo.start = this.start;
      this.memo.end = this.end;
    }
    const { top: leadTop, bottom: leadBottom } = this.lead.getBoundingClientRect();
    const { top: tailTop, bottom: tailBottom } = this.tail.getBoundingClientRect();
    const { top: wrapperTop, bottom: wrapperBottom } = this.wrapper.getBoundingClientRect();
    let needRerender = false;

    if(this.end === total) {
      this.maxDtY = tailTop - wrapperBottom;
    } else  {
      this.maxDtY = null;
    }

    if(this.start === 0) {
      this.minDtY = leadBottom - wrapperTop;
    } else  {
      this.minDtY = null;
    }


    if(tailBottom < pad + wrapperBottom) {
      needRerender = true;
      this.fillEnd({
        itemHeight: this.getAvgHeight(),
        tailTop,
        tailBottom,
        wrapperBottom
      });
    }
    if(leadTop > wrapperTop - pad) {
      needRerender = true;
      this.fillStart({
        itemHeight: this.getAvgHeight(),
        leadTop,
        leadBottom,
        wrapperTop
      });
    }

    return needRerender;
  }

  @ShouldExec()
  handleBroad(entries: IEntry[]) {
    let endDel = 0;
    let endDelCount = 0;
    let startDel = 0;
    let startDelCount = 0;
    for (const entry of entries) {
      if (entry.target === this.tail || entry.target === this.lead) {
        const handlers = this.broadHandlers(entry);
        this.enterOrLeave(entry, handlers);
        continue;
      }

      this.enterOrLeave(entry, {
        leaveFromStart: () => {
          startDel += entry.boundingClientRect.height;
          startDelCount++;
        },
        leaveFromEnd: () => {
          endDel += entry.boundingClientRect.height;
          endDelCount++;
        }
      });
    }

    if (startDel) {
      this.emitSliceAndFix({
        start: this.start + startDelCount,
        end: this.end
      });
      this.setsTopDt(_ => -startDel);
    }

    if (endDel) {
      this.emitSliceAndFix({
        start: this.start,
        end: this.end - endDelCount
      });
    }
  }
  isMount = true;

  @ShouldExec()
  handleWind(entries: IEntry[]) {
    const isMount = this.isMount;
    for (const entry of entries) {
      // lead 进入 Visual 时优先级比 end 高
      if (entry.target === this.lead) {
        this.enterOrLeave(entry, {
          enter: () => {
            const { bottom: leadBottom } = entry.boundingClientRect;
            const { top: wrapperTop } = entry.rootBounds;
            const scrollUpDist = leadBottom - wrapperTop;
            console.log('lead 进入 Visual', leadBottom, wrapperTop);
            this.setsTopDt(v => Math.floor(v + scrollUpDist + 1), true);
            this.boundaryCheck();
            this.lockScrollUp = true;
          },
          leaveFromStart: () => {
            console.log('lead 离开了 top');
            this.lockScrollUp = false;
          }
        });
        return;
      }
      this.enterOrLeave(entry, {
        enter: () => {
          const { top: tailTop } = entry.boundingClientRect;
          const { bottom: wrapperBottom } = entry.rootBounds;
          const scrollDownDist = wrapperBottom - tailTop;
          console.log('tail 进入 Visual', tailTop, wrapperBottom);
          this.setsTopDt(v => Math.floor(v - scrollDownDist - 1), true);
          this.boundaryCheck();
          this.lockScrollDown = true;
        },
        leaveFromEnd: () => {
          this.lockScrollDown = false;
        }
      });
    }
  }

  enterOrLeave = (entry: IEntry, cbs: EnterLeaveCbs) => {
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
    this.windObs = new IntersectionObserver(this.handleWind.bind(this), {
      root: this.wrapper,
      threshold: 1,
      rootMargin: `-1px 0px -1px 0px`
    });
    this.broadObs = new IntersectionObserver(this.handleBroad.bind(this), {
      root: this.wrapper,
      rootMargin: `${pad}px 0px ${pad}px 0px`
    });
    // this.slotEl.addEventListener('slotchange', this.watchItems.bind(this));
    this.broadObs.observe(this.lead);
    this.broadObs.observe(this.tail);
    this.windObs.observe(this.lead);
    this.windObs.observe(this.tail);
  }
  watchedItems = new Set<Element>();
  watchItems(els = this.slotEl.assignedElements()) {
    els.forEach((it, i) => {

      if (!it['__$watched']) {
        this.broadObs.observe(it);
        it['__$watched'] = true;
      }
      // 从旧监听项删除重叠项，剩下的是移除项
      else {
        this.watchedItems.delete(it);
      }
    });
    // 需要解监听的项删除
    this.watchedItems.forEach(it => {
      it['__$watched'] = undefined;
      this.broadObs.unobserve(it);
    });

    this.watchedItems = new Set(els);
  }
  unHandledUnshift = 0;
  emitSliceAndFix(sliceInfo: SliceInfo, isFirstPaint = false) {
    const preStart = this.start;
    const curStart = sliceInfo.start;
    // 将往前移动的数累加到 unHandledHeadDrop 给捕获器处理
    if(curStart < preStart) {
      this.unHandledUnshift += preStart - curStart;
    }
    this.memo.start = this.start;
    this.memo.end = this.end;
    Object.assign(this, sliceInfo);

    const pos = this.createPos(this.fixId++);
    if (!this.connectedPos) {
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
          // 渲染完成后重新评估
          micro(() => that.boundaryCheck());
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
  onWheel(e: WheelEvent) {
    let dtY = e.deltaY * (e['rate'] || this.RATE);
    // console.log('wheel', e.deltaY > 0 ? '👇🏻' : '👆🏻');
    if (((dtY >= 0) && this.lockScrollDown) || ((dtY <= 0) && this.lockScrollUp)) {
      return;
    } 

    this.setsTopDt(_ => dtY);
    return;
  }
  fixId = 0;
  memo = {
    start: 0,
    end: 0
  };
  elToI = new Map<Element, number>();
  memoHeight = new Map<number, number>();
  fixContext: {
    type: string;
    payload: any;
  };
  sTop = 0;
  cbList = new Set<any>();
  setsTopDt(cb: (v: number) => number, issTop = false) {
    if(issTop) {
      this.sTop = cb(this.sTop)
    } 
    else {
      let dtY = cb(this.sTop);
      if(this.maxDtY != null) {
        dtY = Math.min(dtY, this.maxDtY);
        // 10 - 1 = 9  
        this.maxDtY -= dtY;
      } 
  
      if(this.minDtY != null) {
        dtY = Math.max(dtY, this.minDtY);
        //-10 - 1 = -11
        this.minDtY -= dtY;
      }
      this.sTop += dtY;
    }
    this.list.style.setProperty('transform', `translate3d(0,${-this.sTop}px,0)`);
    // const hasRaf = this.cbList.size > 0;
    // this.cbList.add(cb);
    // if(!hasRaf) {
    //   requestAnimationFrame(() => {
    //     let res = this.sTop;
    //     this.cbList.forEach((cb) => {
    //       res = cb(res);
    //     });
    //     this.sTop = res;
    //     this.list.style.setProperty('transform', `translate3d(0,${-this.sTop}px,0)`);
    //     this.cbList.clear();
    //   })
    // }
  }

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

  broadObs: IntersectionObserver;
  windObs: IntersectionObserver;
  frame = new FrameScope();
  e = new BaseEvent();
  abortCon = new AbortController();
}

function nature(num: number) {
  return Math.max(num, 0);
}
