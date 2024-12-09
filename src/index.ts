import { AutoWcScroll } from "./auto-wheel";
import { WcScroll } from "./fix-height";
import { Events } from "./util";

const defined = {

}

export function define(name: string, constructor: CustomElementConstructor, options?: ElementDefinitionOptions) {
  if (defined[name]) {
    return;
  }
  defined[name] = constructor;
  return customElements.define(name, constructor, options);
}

export function onInit(id: string, fn: (dom: WcScroll|AutoWcScroll) => void) {
  const handleInit = (dom: WcScroll|AutoWcScroll) => {
    console.log('收到init');
    fn(dom);
  }

  handleInit.scheduler = (doCall, _id: string, dom: WcScroll|AutoWcScroll) => {
    if(id === _id) {
      doCall(dom);
    }
  }

  Events.once('init', handleInit);
}

define('wc-scroll', AutoWcScroll);