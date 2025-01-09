import { AutoHeight } from "./auto-wheel";
import { AutoHeight as AutoHeightInsertion } from "./auto-wheel-insertion";
import { FixHeight } from "./fix-height";
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

export function onInit(id: string, fn: (dom: FixHeight|AutoHeight) => void) {
  const handleInit = (dom: FixHeight|AutoHeight) => {
    console.log('收到init');
    fn(dom);
  }

  handleInit.scheduler = (doCall, _id: string, dom: FixHeight|AutoHeight) => {
    if(id === _id) {
      doCall(dom);
    }
  }

  Events.once('init', handleInit);
}

export {
  AutoHeight,
  FixHeight,
  AutoHeightInsertion,
}