import { WcScrollItem } from "./auto-height";
import { WcScroll } from "./fix-height";
import { Events } from "./util";

console.log(WcScroll.name);


export function register(...cmp: ({new() : HTMLElement})[]) {
  cmp.forEach((ctor) => {
    customElements.define(ctor['tag'], ctor);
  })
}

export function onInit(id: string, fn: (dom: WcScroll) => void) {
  Events.on('init', (_id, ...args) => {
    console.log('收到init');
    
    if(id === _id) {
      // @ts-ignore
      fn(...args);
    }
  });
}

register(WcScroll, WcScrollItem);
onInit('scroll', (dom) => {
  console.log('init', dom);
  const data = Array.from({length: 100}, (_, i) => i);
  dom.start(data, (list) => {
    const html = list.map((it) => `<div class="item" slot="item">${it}</div>`).join('');
    console.log({html});
    dom.innerHTML = html;
  });
})