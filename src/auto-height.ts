import { BaseEvent } from "./event";

export class WcScrollItem extends HTMLElement {
  static tag = 'wc-scroll-item'
  constructor() {
    // 必须首先调用 super 方法, 继承基类
    super();

    // 初始化web component
    this.init();
  }

  e = new BaseEvent();
  /** 初始化操作都放这里 */
  connectedCallback() {
    this.setAttribute('slot', 'item');
  }

  #data: any[]
  set data(val: any[]) {
    this.#data = val;
  }

  disconnectedCallback() {
    console.log('disconnectedCallback.');
  }
  adoptedCallback() {
    console.log('adoptedCallback.');
  }
  attributeChangedCallback(name, oldValue, newValue) {
  }

  template = document.createElement(`template`);
  shadow: ShadowRoot;
  init() {
    this.template.innerHTML = `
      <style>
        :host {
          display: block;
        }
      </style>
      <div class="item">
       <slot></slot>
      </div>
    `
    this.shadow = this.attachShadow({ mode: 'open' });
    this.shadow.appendChild(this.template['content'].cloneNode(true));
  }
}