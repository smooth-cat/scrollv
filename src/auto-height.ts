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
  placeholder: HTMLElement;
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

  /** 单屏渲染个数
   *
   */
  get renderCount() {
    // this.calcEnd(this.start)
    // 从 start 开始往后按实际计算
    return Math.ceil(this.wrapperHeight / this.getProp('itemHeight')) + this.getProp('buffer');
  }
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
      <div id="wrapper" style="overflow: auto; position: relative; width: 100%; height: 100%">
        <div id="placeholder" style="position: absolute; left: 0; top: 0; right: 0;"></div>
        <div id="list" style="position: relative; left: 0; top: 0; right: 0;">
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
    this.placeholder = this.shadow.getElementById('placeholder');
    this.list = this.shadow.getElementById('list');
    this.slotEl = this.shadow.getElementById('slot') as any;
    this.wrapperHeight = this.wrapper.offsetHeight;
    this.observer.observe(this.wrapper);
    this.wrapper.addEventListener('scroll', this.onScroll);
  }

  watchResize = debounce<ResizeObserverCallback>(function (this: AutoWcScroll, entries) {
    for (const entry of entries) {
      if (entry.target === this.wrapper) {
        const itemHeight = this.getProp('itemHeight');
        const height = entry.contentRect.height;
        // 下拉高度超过了当前渲染内容的高度，则紧急补上， 注意 renderCount 依赖 wrapperHeight，不能提前更新 wrapperHeight
        if (height > (this.renderCount - 1) * itemHeight) {
          this.wrapperHeight = height;
          this.emitSliceAndFix();
        } else {
          this.wrapperHeight = height;
        }
      }
    }
  }, 300);

  emitSliceAndFix() {
    const pos = this.createPos();
    this.e.emit(SLICE_EVENT, pos);
    // 渲染前修正 placeholder 的高度， 和 inner 的位置
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
  sTop: number;
  onScroll = (e: Event) => {
    const sTop = this.wrapper.scrollTop;
    this.sTop = sTop;
    if (this.ignoreTop != null && sTop === this.ignoreTop) {
      console.log({ sTop, ignoreTop: this.ignoreTop });
      this.ignoreTop = undefined;
      return;
    }

    const total = this.getProp('total');
    const buffer = this.getProp('buffer');
    // [0-end] 可填满 sTop
    const { end: start, remain } = this.calcEnd(0, sTop);
    // 第一次是按 第0次 真实渲染的高度计算新 start ✅，sTop = 第0项 + 第1项remain 部分
    // 第二次是按 第1次 真实渲染高度计算，此时，sTop = 第0项 + 第1项 + 第二项remain 部分
    // 但此时会按 第0项(virtual) + 第一项 + 第二项 ... 进行 start 计算，此时的偏差在 第0项的真实与virtual
    this.start = start;
    const screen = remain + this.wrapperHeight;
    const { end } = this.calcEnd(start, screen);
    this.end = Math.min(end + buffer + 1, total);
    console.log({ sTop, remain });
    this.remain = remain;
    this.emitSliceAndFix();
  };

  remain: number;

  fix = () => {
    const itemHeight = this.getProp('itemHeight');
    // 真实渲染高度
    const { height } = this.list.getBoundingClientRect();

    // 根据 项高度算出的预期渲染高度
    const expectH = (this.end - this.start) * itemHeight;
    // 高度差
    const deltaH = height - expectH;

    this.placeholder.style.setProperty('height', `${this.expectPlaceholderHeight + deltaH}px`);
    const items = this.slotEl.assignedElements();
    // if (
    //   Math.abs(
    //     this.wrapper.scrollTop + this.wrapper.getBoundingClientRect().height - (this.expectPlaceholderHeight + deltaH)
    //   ) < 10
    // ) {
    //   debugger;
    // }

    let deltaTop = 0;
    // 可知 [memoStart ， start - 1] 项变为 virtual scrollTop 需要减少至这些想和虚拟项的差值
    if (this.start > this.memoStart) {
      let stack = 0;
      let i: number;
      for (i = this.memoStart; i < this.start && i < this.memoEnd; i++) {
        stack += this.memoHeight.get(i);
      }
      deltaTop = -(stack - (i - this.memoStart) * itemHeight);
    }
    // 从 start 到 memoStart-1 项变为真实 dom
    else {
      let stack = 0;
      let i: number;
      let j: number;
      for (i = this.start, j = 0; i < this.memoStart && i < this.end; i++, j++) {
          stack += items[j].getBoundingClientRect().height;
      }
      deltaTop = stack - (i - this.start) * itemHeight;
    }

    this.memoHeight.clear();

    for (let i = this.start, j = 0; i < this.end; i++, j++) {
      this.memoHeight.set(i, items[j].getBoundingClientRect().height);
    }

    this.memoStart = this.start;
    this.memoEnd = this.end;

    let sTop = this.wrapper.scrollTop;
    
    // TODO: 触底时 scrollTop 过高导致底部留白
    if (deltaTop) {
      // 向上滚动 3000 -> 0 的时候 deltaTop 为负，由 itemHeight 设置过高触发
      this.wrapper.scrollTop = this.ignoreTop = sTop = Math.max(sTop + deltaTop, 0);
    }
    console.log('fix', {sTop, deltaTop});
    if (this.remain != null) {
      this.list.style.setProperty('transform', `translate3d(0,${sTop - this.remain}px,0)`);
    }
    this.remain = undefined;
  };

  ignoreTop: number;

  calcList(totalStr: string) {
    try {
      const buffer = this.getProp('buffer');
      const total = this.getProp('total');
      // 列表高度 依赖 data
      this.placeholder.style.setProperty('height', `${this.expectPlaceholderHeight}px`);
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
        throw '无法填满';
      }
      break;
    }

    return {
      // end 含 -1计算，数组长度极端情况需要更改
      end: Math.max(end, 0),
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
