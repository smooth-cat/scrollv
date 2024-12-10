import { BaseEvent } from './event';
import { debounce, Events } from './util';

const SLICE_EVENT = 'slice';

const keys = {
  total: undefined,
  itemHeight: undefined,
  pad: undefined
};

export type Keys = keyof typeof keys;

const keyList: Keys[] = Object.values(keys);
export class AutoWcScroll extends HTMLElement {
  static tag = 'wc-scroll';
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
  memoHeight = new Map<number, number>();
  padStart = 0;
  padEnd = 0;
  // memoStart: number;
  // memoEnd: number;
  memo = {
    start:0,
    end: 0,
    padStart:0,
    padEnd: 0,
  };

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
  connectedCallback() {
    console.log('已创建');
    const id = this.attributes.getNamedItem('id')?.value;
    this.watchDoms();
    Events.emit('init', id, this);
    const total = this.attributes.getNamedItem('total')?.value;
    this.calcList(total);
  }

  /** setAttribute 和 innerHTML 🪝 */
  attributeChangedCallback(name, _, newValue) {
    if (name === 'total') {
      this.calcList(newValue);
    }
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
      const pos = this.createPos();
      const event = new CustomEvent(SLICE_EVENT, { detail: pos });
      this.dispatchEvent(event);
    }
  }

  watchDoms() {
    this.wrapper = this.shadow.getElementById('wrapper');
    window['wrapper'] = this.wrapper;
    this.list = this.shadow.getElementById('list');
    this.slotEl = this.shadow.getElementById('slot') as any;
    this.wrapperHeight = this.wrapper.offsetHeight;
    this.observer.observe(this.wrapper);
    this.wrapper.addEventListener('wheel', this.onWheel);
  }

  watchResize = debounce<ResizeObserverCallback>(function (this: AutoWcScroll, entries) {
    for (const entry of entries) {
      if (entry.target === this.wrapper) {
        const itemHeight = this.getProp('itemHeight');
        const height = entry.contentRect.height;
        this.wrapperHeight = height;
        // 下拉高度超过了当前渲染内容的高度，则紧急补上， 注意 renderCount 依赖 wrapperHeight，不能提前更新 wrapperHeight
        // if (height > (this.renderCount - 1) * itemHeight) {
        //   this.wrapperHeight = height;
        //   this.emitSliceAndFix();
        // } else {
        //   this.wrapperHeight = height;
        // }
      }
    }
  }, 300);

  emitSliceAndFix() {
    const pos = this.createPos();
    this.e.emit(SLICE_EVENT, pos);
  }
  createPos = () => {
    const that = this;
    const start = that.padStart;
    const end = that.padEnd;
    const pos = {
      get start() {
        if (!this.filed) {
          requestAnimationFrame(that.fix);
          this.filed = true;
        }
        return start;
      },
      end: end,
      filed: false
    };
    return pos;
  };
  sTop = 0;
  /** 滚动触发时的 delta */
  deltaTop = 0;
  startItem = {
    height: 0,
    /** 被滚动过的区域 */
    scrolled: 0
  };
  RATE = 0.5;
  onWheel = (e: WheelEvent) => {
    const scrolled = this.startItem.scrolled;
    const pad = this.getProp('pad');
    const total = this.getProp('total');
    let dtY = e.deltaY * this.RATE;
    const { minDtY, maxDtY } = this;
    // TODO: 补充 startPad
    dtY = Math.min(Math.max(minDtY, dtY), maxDtY);
    

    this.sTop += dtY;

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
    const { start=0, remain, overflow } = this.calcStart(this.memo.start, -dtY + preOverflow);
    // TODO: 入过新的第一项是虚拟项，算出的 end 会不准
    const screen = overflow + this.wrapperHeight;
    const { end = total } = this.calcEnd(start, screen);
   
    this.overflow = remain;
    this.start = start;
    this.padStart = nature(start - pad);
    this.end = end;
    this.padEnd = Math.min(this.end + pad + 1, total);
    this.emitSliceAndFix();
    return;
  };

  overflow: number;
  minDtY: number;
  maxDtY: number;

  fix = () => {
    const total = this.getProp('total');
    const itemHeight = this.getProp('itemHeight');
    const items = this.slotEl.assignedElements();
    /** 首屏 */
    const fp = this.overflow == null;

    this.memoHeight.clear();

    let renderHeight = 0;
    const startItemIdx = this.start - this.padStart
    this.startItem.height = items[startItemIdx]?.getBoundingClientRect().height || 0;
    /** 从 scrollTop 到 end 的距离 */
    let topToPadEnd = 0;
    let padToTop = 0;
    for (let i = this.padStart, j = 0; i < this.padEnd; i++, j++) {
      const iRealHeight = items[j].getBoundingClientRect().height;
      renderHeight += iRealHeight;
      this.memoHeight.set(i, iRealHeight);
      if(i >= this.start) {
        topToPadEnd += i === this.start ? this.overflow ?? iRealHeight : iRealHeight;
      }
      if(i <= this.start) {
        padToTop += iRealHeight;
      }
    }
    this.renderHeight = renderHeight;
    this.memo = {
      padStart: this.padStart,
      padEnd: this.padEnd,
      start: this.start,
      end: this.end,
    }

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
    const minDtY = -(this.padStart * itemHeight + padToTop - (this.overflow ?? this.startItem.height))
    this.minDtY = minDtY;
    // 非首屏设置偏移量
    if (!fp) {
      const translateY = padToTop - this.overflow;
      this.startItem.scrolled = this.startItem.height - this.overflow;
      this.list.style.setProperty('transform', `translate3d(0,${-translateY}px,0)`);
    }
    console.log('-----------------------------------------------');

    console.log('fix', { maxDtY: this.maxDtY, minDtY: this.minDtY });
  };
  renderHeight = 0;

  calcList(totalStr: string) {
    try {
      const pad = this.getProp('pad');
      const total = this.getProp('total');
      // 列表高度 依赖 data
      const { end } = this.calcEnd(0, this.wrapperHeight);
      this.end = Math.min(end + 1, total);
      this.padEnd = Math.min(end + pad + 1, total);
      this.emitSliceAndFix();
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
  // TODO: 销毁时取消所有监听器
  observer = new ResizeObserver(this.watchResize.bind(this));
}


function nature (num: number) {
  return Math.max(num, 0);
}