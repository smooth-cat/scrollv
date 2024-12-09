import { BaseEvent } from './event';
import { debounce, Events } from './util';

const SLICE_EVENT = 'slice';

const keys = {
  total: undefined,
  itemHeight: undefined,
  buffer: undefined
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
  memoStart: number;
  memoEnd: number;

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
    const start = that.start;
    const end = that.end;
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
  RATE = 1;
  onWheel = (e: WheelEvent) => {
    const scrolled = this.startItem.scrolled;
    const buffer = this.getProp('buffer');
    const total = this.getProp('total');
    const itemHeight = this.getProp('itemHeight');
    let dtY = e.deltaY * this.RATE;
    const { minDtY, maxDtY } = this;
    dtY = Math.min(Math.max(minDtY,dtY), maxDtY)
    console.log({dtY});
    
    this.sTop += dtY;


    const scrollInRender = dtY >= -scrolled && dtY < this.renderHeight - scrolled;
    // 在渲染出的项中滑动
    if (scrollInRender) {
      const { end: start, remain, overflow } = this.calcEnd(this.memoStart, scrolled + dtY);
      this.start = start;
      const screen = remain + this.wrapperHeight;
      const { end } = this.calcEnd(start, screen);
      this.overflow = overflow;
      if (end == null) {
        this.end = total;
      } else {
        this.end = Math.min(end + buffer + 1, total);
      }
      this.emitSliceAndFix();
      return;
    }
    // 在虚拟项中向上滑动
    if(dtY < -scrolled) {
      let absDt = -dtY - scrolled;
 
      //    |  absDt | 
      //  [ | ]  [  ]  [ | ]
      //    | | -> overflow
      //  | dtc=2   |
      // 假设移动了半项 absDt = 0.5 itemHeight -> dtCount = 1, memoStart - 1 正好是新的 start
      const dtCount = Math.ceil(absDt / itemHeight);
      const newStart = this.memoStart - dtCount;
      const overflow = absDt - itemHeight * nature(dtCount - 1);
      const remain = itemHeight - overflow;
      const screen = remain + this.wrapperHeight;
      const { end } = this.calcEnd(newStart, screen);
      this.start = newStart;
      this.end = Math.min(end + buffer + 1, total);
      this.overflow = overflow;
      this.emitSliceAndFix();
      return;
    }
    // TODO: 在虚拟项中向下滑动
  };

 

  overflow: number;
  minDtY: number;
  maxDtY: number;

  fix = () => {
    const total = this.getProp('total');
    const itemHeight = this.getProp('itemHeight');
    const items = this.slotEl.assignedElements();
    /** 首屏 */
    const fp= this.overflow == null;

    this.memoHeight.clear();

    let renderHeight = 0;
    this.startItem.height = items[0]?.getBoundingClientRect().height || 0;
    /** 从 scrollTop 到 end 的距离 */
    let topToEnd = 0;

    for (let i = this.start, j = 0; i < this.end; i++, j++) {
      const iRealHeight = items[j].getBoundingClientRect().height;
      renderHeight += iRealHeight;
      this.memoHeight.set(i, iRealHeight);
      topToEnd += j === 0 ? (this.overflow ?? iRealHeight) : iRealHeight;
    }
    this.renderHeight = renderHeight;
    this.memoStart = this.start;
    this.memoEnd = this.end;

    /**可向下移动的最大距离 = 视口底部 到 总内容的最后一项
     * = (sTop 到 最后一项) - 视口高度
     * = (sTop 到 end) + (end 到 最后一项) - 视口高度  
     */
    const maxDtY = topToEnd + nature(total - this.end) * itemHeight - this.wrapperHeight;
    this.maxDtY = maxDtY;

    if(!fp) {
      const realRemain = this.startItem.height - this.overflow;
      this.startItem.scrolled = realRemain;
      this.list.style.setProperty('transform', `translate3d(0,${-realRemain}px,0)`);
      this.minDtY = -nature(this.memoStart - 1) * itemHeight - this.startItem.scrolled;
    } else {
      this.minDtY = 0;
    }
    console.log('-----------------------------------------------');
    
    console.log('fix', {maxDtY: this.maxDtY, minDtY: this.minDtY});
  };
  renderHeight = 0;

  calcList(totalStr: string) {
    try {
      const buffer = this.getProp('buffer');
      const total = this.getProp('total');
      // 列表高度 依赖 data
      const { end } = this.calcEnd(0, this.wrapperHeight);
      this.end = Math.min(end + buffer + 1, total);
      this.emitSliceAndFix();
    } catch (error) {
      console.log('total未设置值', totalStr, error);
    }
  }
  /**
   * TODO: 计算
   * 计算从某位置开始，需要几项能填满目标高度
   */
  calcEnd = (from: number, tHeight: number) => {
    const total = this.getProp('total');
    const itemHeight = this.getProp('itemHeight');
    let i = from;
    /** 这一项刚好填满 */
    let end: number;
    let remain = tHeight;
    let overflow: number;

    while (i < total) {
      // 在此区间能拿到真实高度
      if (i >= this.memoStart && i < this.memoEnd) {
        const realHeight = this.memoHeight.get(i);
        if (realHeight > remain) {
          overflow = realHeight - remain;
          end = i;
          break;
        } else {
          remain -= realHeight;
        }
        i++;
        continue;
      }

      if (i < this.memoStart) {
        // [i, this.memoStart) 是虚拟项
        const virtualCount = this.memoStart - i;
        // 需要 x 项填满
        const x = Math.ceil(remain / itemHeight);
        // 足够填满： i=0, x = 2; i+x=2 => [0,1,2]是3项❌; i+x-1=1 => [0,1]✅
        if (virtualCount >= x) {
          overflow = x * itemHeight - remain;
          // remain=0 -> x=0, 需要 max
          remain = remain - Math.max(x - 1, 0) * itemHeight;
          end = i + x - 1;
          break;
        }
        // 不够填满
        else {
          remain -= virtualCount * itemHeight;
        }
        i = this.memoStart;
        continue;
      }

      //  i === this.memoEnd
      // [i, total) 是虚拟项
      const virtualCount = total - i;
      // 需要 x 项填满
      const x = Math.ceil(remain / itemHeight);
      // 足够填满： i=0, x = 2; i+x=2 => [0,1,2]是3项❌; i+x-1=1 => [0,1]✅
      if (virtualCount >= x) {
        overflow = x * itemHeight - remain;
        // remain=0 -> x=0, 需要 max
        remain = remain - Math.max(x - 1, 0) * itemHeight;
        end = i + x - 1;
      }
      // 不够填满
      else {
        remain -= virtualCount * itemHeight;
        end = total - 1;
        debugger;
        throw '无法填满';
      }
      break;
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