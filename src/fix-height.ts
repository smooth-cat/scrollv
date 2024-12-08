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
export class WcScroll extends HTMLElement {
  static tag = 'wc-scroll';
  /** ctor -> attr -> connected */
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

  /*----------------- 需计算的属性 -----------------*/
  /** 渲染起始位置 */
  start = 0;
  /** 渲染终止位置 */
  get end() {
    if (this.renderCount == null) return -1;
    return this.start + this.renderCount + 1;
  }
  /** start 是一半在屏幕内的项，
   * 其前面有 [0,start-1] 共 start 项，
   * 因此translateY 是 start * height */
  get translateY() {
    return this.start * this.getProp('itemHeight');
  }
  /** 单屏渲染个数 */
  get renderCount() {
    return Math.ceil(this.wrapperHeight / this.getProp('itemHeight')) + this.getProp('buffer');
  }
  /** 内容高度 */
  listHeight: number;
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

  /** setAttribute 和 innerHTML 🪝 ctor -> attr -> connected */
  attributeChangedCallback(name, _, newValue) {
    if (name === 'total') {
      this.calcList(newValue);
    }
  }

  onSlice = (fn: (pos: [start: number, end: number]) => void) => {
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
          <slot></slot>
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
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void {
    super.addEventListener(type, listener, options);
    if (type === SLICE_EVENT && this.isConnected) {
      const event = new CustomEvent(SLICE_EVENT, { detail: [this.start, this.end] });
      this.dispatchEvent(event);
    }
  }

  watchDoms() {
    this.wrapper = this.shadow.getElementById('wrapper');
    this.placeholder = this.shadow.getElementById('placeholder');
    this.list = this.shadow.getElementById('list');
    this.wrapperHeight = this.wrapper.offsetHeight;
    this.observer.observe(this.wrapper);
    this.wrapper.addEventListener('scroll', this.onScroll.bind(this));
  }

  watchResize = debounce<ResizeObserverCallback>(function (this: WcScroll, entries) {
    for (const entry of entries) {
      if (entry.target === this.wrapper) {
        const itemHeight = this.getProp('itemHeight');
        const height = entry.contentRect.height;
        // 下拉高度超过了当前渲染内容的高度，则紧急补上， 注意 renderCount 依赖 wrapperHeight，不能提前更新 wrapperHeight
        if (height > (this.renderCount - 1) * itemHeight) {
          this.wrapperHeight = height;
          this.e.emit(SLICE_EVENT, [this.start, this.end]);
        } else {
          this.wrapperHeight = height;
        }
      }
    }
  }, 300);

  calcList(totalStr: string) {
    this.isConnected;
    try {
      const total = parseInt(totalStr);
      // 子列表高度
      const itemHeight = this.getProp('itemHeight');
      // 列表高度 依赖 data
      this.listHeight = itemHeight * total;
      this.placeholder.style.setProperty('height', `${this.listHeight}px`);
      this.e.emit(SLICE_EVENT, [this.start, this.end]);
    } catch (error) {
      console.log('total未设置值', totalStr, error);
    }
  }

  onScroll() {
    const itemHeight = this.getProp('itemHeight');
    const sTop = this.wrapper.scrollTop;
    // 滚动过的项 start 是一半在屏幕内的项，其前面有 [0,start-1] 共 start 项，因此translateY 是 start * height
    this.start = Math.floor(sTop / itemHeight);
    this.list.style.setProperty('transform', `translate3d(0,${this.translateY}px,0)`);
    this.e.emit(SLICE_EVENT, [this.start, this.end]);
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

  observer = new ResizeObserver(this.watchResize.bind(this));
}
