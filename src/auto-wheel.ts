import { InitOrder, InternalEvent, Order } from './auto-wheel-decorator';
import { BaseEvent, EventMode, Func } from './event';
import { debounce, Events, macro } from './util';

const SLICE_EVENT = 'slice';

const keys = {
  total: undefined,
  itemHeight: undefined,
  pad: undefined
};

export type Keys = keyof typeof keys;

type IPos = {
  start: number,
  end: number,
  filed: boolean
}
@InitOrder
export class AutoWcScroll extends HTMLElement {
  static tag = 'scrollv';
  constructor() {
    // 必须首先调用 super 方法, 继承基类
    super();

    // 初始化web component
    this.init();
  }

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
  /** 内容高度 */
  get expectPlaceholderHeight() {
    const itemHeight = this.getProp('itemHeight');
    const total = this.getProp('total');
    return itemHeight * total;
  }
  /** 对动态高度的计算 */
  wrapperHeight: number;
  /*----------------- 需计算的属性 -----------------*/
  e = new BaseEvent();
  #data: any[];
  template = document.createElement(`template`);

  /** append 🪝 */
  @Order(InternalEvent.Connected)
  connectedCallback() {
    const id = this.attributes.getNamedItem('id')?.value;
    this.watchDoms();
    Events.emit('init', id, this);
    const total = this.attributes.getNamedItem('total')?.value;
    this.calcList(total);
  }

  /** setAttribute 和 innerHTML 🪝 */
  attributeChangedCallback(name, _, newValue) {
    // if (name === 'total') {
    //   this.calcList(newValue);
    // }
  }

  onSlice = (fn: (pos: { start: number; end: number }) => void) => {
    this.e.on(SLICE_EVENT, fn);
  };

  disconnectedCallback() {
    console.log('disconnectedCallback.');
  }
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
    super.addEventListener(type, listener, options);
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
    this.wrapper.addEventListener('wheel', this.onWheel.bind(this), { passive: false });
  }
  fixId = 0;
  emitSliceAndFix(pos?: IPos) {
    pos = pos || this.createPos(++this.fixId);
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
          requestAnimationFrame(() => that.fix(fixId));
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
  @Order(InternalEvent.Scroll)
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

  @Order(InternalEvent.Fix)
  fix(fixId: number) {
    console.log(`RAF-${fixId}`);
    console.log(`----------------------------------`);
    const total = this.getProp('total');
    const itemHeight = this.getProp('itemHeight');
    const items = this.slotEl.assignedElements();
    /** 首屏 */
    const fp = this.overflow == null;

    this.memoHeight.clear();
    this.elToI.forEach((_, el) => this.itemObs.unobserve(el));
    this.elToI.clear();

    const startItemIdx = this.start - this.padStart;
    const endItemIdx = this.end - this.padStart;
    this.startItem.height = items[startItemIdx]?.getBoundingClientRect().height || 0;
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
  }

  calcList(totalStr: string) {
    try {
      const pad = this.getProp('pad');
      const total = this.getProp('total');
      // 列表高度 依赖 data
      const { end } = this.calcEnd(0, this.wrapperHeight);
      this.end = Math.min(end, total);
      this.padEnd = Math.min(end + pad + 1, total);
      this.connectedPos = this.createPos(++this.fixId);
      this.emitSliceAndFix(this.connectedPos);
    } catch (error) {
      console.log('total未设置值', totalStr, error);
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
  aniScroll(dt: number) {
    const times = Math.ceil(this.timeout/16);
    const absDt = Math.abs(dt);
    const step =  Number((absDt / times).toFixed(2));
    let realTimes = Math.floor(absDt / step);
    const last = absDt - realTimes * step;
    if(last) realTimes++;
    this._doScroll(realTimes, absDt < 0, step,last)
  }
  _doScroll = (remainTimes: number, isNegative: boolean, step: number, last?: number) => {
    let scrollValue = step;
    if (remainTimes === 1 && last) scrollValue = last;
    this.onWheel({ deltaY: isNegative ? -scrollValue : scrollValue, rate: 1 } as any);
    remainTimes--;
    if (remainTimes === 0) return;
    requestAnimationFrame(() => this._doScroll(remainTimes, isNegative, step, last));
  };

  // callback 是微任务，但 debounce 后是宏任务，因此一定能拿到 fix 的真确信息
  wrapperResize = debounce<ResizeObserverCallback>(function (this: AutoWcScroll, entries) {
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
            this.onWheel({ deltaY: this.maxDtY, rate: 1 } as any);
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
  }, 300);

  itemResize(entries: ResizeObserverEntry[]) {
    const shouldRerender = (stackDt: number) => {
      const { topToPadEnd, wrapperHeight } = this;
      const resized = topToPadEnd + stackDt;
      // 如果缩小后小于了视口高度说明需要从新渲染
      if (resized < wrapperHeight) {
        return true;
      }
    };

    macro(() => {
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
          this.onWheel({ deltaY: this.topToPadEnd - this.wrapperHeight, rate: 1 } as any);
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
    });
  }

  // TODO: 销毁时取消所有监听器
  wrapperObs = new ResizeObserver(this.wrapperResize.bind(this));
  itemObs = new ResizeObserver(this.itemResize.bind(this));
}

function nature(num: number) {
  return Math.max(num, 0);
}
