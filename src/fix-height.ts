import { BaseEvent, Func } from "./event";
import { debounce, EventMap, Events } from "./util";

const keys = {
  'itemHeight': undefined,
  'bufferCount': undefined,
}

export type Keys = keyof typeof keys;

const keyList: Keys[] = Object.values(keys);
export class WcScroll extends HTMLElement {
  static tag = 'wc-scroll'
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
  #start = 0;
  /** 渲染终止位置 */
  get end () {
    if(this.renderCount == null) return -1;
    return this.#start + this.renderCount + 1;
  }
  /** start 是一半在屏幕内的项，
   * 其前面有 [0,start-1] 共 start 项，
   * 因此translateY 是 start * height */
  get translateY ( ) {
    return this.#start * this.getProp('itemHeight');
  }
  /** 单屏渲染个数 */ 
  get renderCount() {
    return Math.ceil(this.wrapperHeight / this.getProp('itemHeight')) + this.getProp('bufferCount');
  };
  /** 内容高度 */ 
  listHeight: number; 
  /** 对动态高度的计算 */
  wrapperHeight: number;
  /*----------------- 需计算的属性 -----------------*/
  e = new BaseEvent();
  #data: any[]
  template = document.createElement(`template`);
  connectedCallback() {
    console.log('已创建');
    const id = this.attributes.getNamedItem('id')?.value;
    this.initDoms();
    Events.emit('init', id, this);
  }

  
  set data(val: any[]) {
    this.#data = val;
    this.calcData();
  }
  

  start = (data: any[], fn: (list: any[]) => void) => {
    this.e.on('list', fn);
    this.data = data;
  }

  disconnectedCallback() {
    console.log('disconnectedCallback.');
  }
  adoptedCallback() {
    console.log('adoptedCallback.');
  }
  attributeChangedCallback(name, oldValue, newValue) {
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
          <slot name="item"></slot>
        </div>
      </div>
    `
    this.shadow = this.attachShadow({ mode: 'open' });
    this.shadow.appendChild(this.template['content'].cloneNode(true));
  }

  

  initDoms() {
    this.wrapper = this.shadow.getElementById('wrapper');
    this.placeholder = this.shadow.getElementById('placeholder');
    this.list = this.shadow.getElementById('list');
    this.wrapperHeight = this.wrapper.offsetHeight;
    this.observer.observe(this.wrapper)
    this.wrapper.addEventListener('scroll', this.onScroll.bind(this))
  }
  
  watchResize = debounce<ResizeObserverCallback>(function(this: WcScroll, entries) {
    for (const entry of entries) {
      if(entry.target === this.wrapper) {
        const itemHeight = this.getProp('itemHeight');
        const height = entry.contentRect.height;
        // 下拉高度超过了当前渲染内容的高度，则紧急补上， 注意 renderCount 依赖 wrapperHeight，不能提前更新 wrapperHeight
        if (height > (this.renderCount - 1) * itemHeight) {
          this.wrapperHeight = height;
          this.e.emit('list', this.#data.slice(this.#start, this.end));
        } else {
          this.wrapperHeight = height;
        }
      }
    }
  }, 300) 


  calcData() {
    // 子列表高度
    const itemHeight = this.getProp('itemHeight');
    // 列表高度 依赖 data
    this.listHeight = itemHeight * this.#data.length;
    this.placeholder.style.setProperty('height', `${this.listHeight}px`);
    this.e.emit('list', this.#data.slice(this.#start, this.end));
  }

  onScroll() {
    console.log('监听滚动');
    const itemHeight = this.getProp('itemHeight');
    const sTop = this.wrapper.scrollTop;

    // 滚动过的项 start 是一半在屏幕内的项，其前面有 [0,start-1] 共 start 项，因此translateY 是 start * height
    this.#start = Math.floor(sTop / itemHeight);
    this.e.emit('list', this.#data.slice(this.#start, this.end));
    this.list.style.setProperty('transform', `translateY(${this.translateY}px)`);
  }


  getProp(key: Keys) {
    try {
      return Number(this.attributes.getNamedItem(key).value);
    } catch (error) {
      throw {
        message: `未传入属性${key}!`,
        raw: error,
      }
      
    }
  }

  observer = new ResizeObserver(this.watchResize.bind(this));
}