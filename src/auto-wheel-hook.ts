import { BaseEvent } from './event';
import { cNoop, FrameScope } from './util';

const SLICE_EVENT = 'slice';

const keys = {
  total: true,
  itemHeight: true,
  pad: undefined,
  rate: undefined,
  passive: undefined
};

export type Keys = keyof typeof keys;

type BuildAction<T extends Record<any, any>> = {
  [P in keyof T]: {
    type: P;
    payload: T[P];
  };
}[keyof T];

type DeltaPayload = {
  /** 滚动距离 */
  dt: number;
};
type ToItemPayload = {
  /** 需要滚动到的项 */
  index: number;
  dt?: number;
};

type IScrollV = {
  delta: DeltaPayload;
  toItem: ToItemPayload;
};

type ScrollVType = keyof IScrollV;
type Action = BuildAction<IScrollV>;
type SliceInfo = Pick<AutoHeight, 'start' | 'end'> & Record<any, any>;

export class AutoHeight extends HTMLElement {
  constructor() {
    super();
    this.init();
  }
  static tag = 'scrollv';
  template = document.createElement(`template`);
  shadow: ShadowRoot;
  mounted = false;
  /** lead 新增项产生的 top 变化需要在 slotchange 中去除 */
  unCalcLeadAddItem = 0;
  /*----------------- doms -----------------*/
  wrapper: HTMLElement;
  list: HTMLElement;
  lead: HTMLElement;
  slotEl: HTMLSlotElement;
  tail: HTMLElement;

  /*----------------- slice -----------------*/
  start = 0;
  end = 0;

  /*----------------- scroll -----------------*/
  top = 0;
  setTop(update: (top: number) => number, pure?: 'pure') {
    const res = update(this.top);
    this.top = res;
    this.list.style.setProperty('transform', `translateY(${-this.top}px)`);
    if (pure) return;
    this.onTopChange();
  }

  //
  observed = new Set<Element>();
  leaveObserved = {
    first: undefined,
    last: undefined
  };

  init() {
    this.template.innerHTML = `
      <style>
        :host {
          display: block;
        }
        #wrapper {
          overflow: hidden; position: relative; width: 100%; height: 100%;
        }
        #startPad,#endPad,#startVirtual,#endVirtual {
          position: absolute; width: 100%; height: 100%;
        }
        #list {
          position: absolute; left: 0; top: 0px; right: 0;
        }
        #lead,#tail {
          width: 100%; height: 0px;
        }
      </style>
      <div id="wrapper">
        <div id="list">
          <div id="lead"></div>
          <slot id="slot"></slot>
          <div id="tail"></div>
        </div>
      </div>
    `;
    this.shadow = this.attachShadow({ mode: 'open' });
    this.shadow.appendChild(this.template['content'].cloneNode(true));
    window['ins'] = this;
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void {
    super.addEventListener(type, listener, options);
    if (type === 'slice' && this.mounted) {
      this.dispatchEvent(new CustomEvent(SLICE_EVENT, { detail: this }));
    }
  }

  connectedCallback() {
    if (this.mounted) return;
    console.log('connectedCallback');
    const { shadow } = this;
    this.wrapper = shadow.getElementById('wrapper');
    this.list = shadow.getElementById('list');
    this.lead = shadow.getElementById('lead');
    this.slotEl = shadow.getElementById('slot') as any;
    this.tail = shadow.getElementById('tail');
    this.watch();
    this.fix();
    this.mounted = true;
  }

  /** 几个事件监听
   * 1. slotchange -> onListChange 内部 dom 变了 (个数、引用)
   * 2. wrapper -> onResize 大小变化 、 item 大小变化
   * 3. translateY 变化
   */
  watch() {
    const rate = this.getProp('rate') || 1;
    const passive = !!this.getAttribute('passive');
    this.resizeObs.observe(this.wrapper);
    this.wrapper.addEventListener(
      'wheel',
      e => {
        if (!passive) e.preventDefault();
        e['rate'] = rate;
        this.onWheel(e);
      },
      { signal: this.abortCon.signal, passive }
    );
    this.slotEl.addEventListener('slotchange', this.onListChange.bind(this), { signal: this.abortCon.signal });
  }
  watchItems(els: Element[]) {
    if (!els.length) return;
    // const first = els[0];
    // this.memoObs(first, 'first');
    // const last = els.at(-1);
    // this.memoObs(last, 'last');

    els.forEach(el => {
      if (this.observed.has(el)) {
        this.observed.delete(el);
      } else {
        this.resizeObs.observe(el);
      }
    });
    this.observed.forEach(el => this.resizeObs.unobserve(el));
    this.observed = new Set(els);
  }

  onWheel(e: WheelEvent) {
    const rate = e['rate'];
    let dt = e.deltaY * rate;
    console.log('wheel', dt);
    let maxDt = Number.MAX_SAFE_INTEGER;
    let minDt = Number.MIN_SAFE_INTEGER;
    if (dt > 0 && !this.hasMore()) {
      const { bottom: wBottom } = this.wrapper.getBoundingClientRect();
      const { top: pos } = this.tail.getBoundingClientRect();
      maxDt = pos - wBottom;
      if (maxDt < 1) return;
    }
    if (dt < 0 && !this.hasMore('lead')) {
      const { top: wTop } = this.wrapper.getBoundingClientRect();
      const { top: pos } = this.lead.getBoundingClientRect();
      minDt = pos - wTop;
      if (minDt > -1) return;
    }

    dt = Math.min(Math.max(minDt, dt), maxDt);
    this.setTop(v => v + dt);
  }

  onListChange() {
    console.log('onListChange');

    const els = this.slotEl.assignedElements();

    if (this.unCalcLeadAddItem) {
      let dtTop = 0;
      for (let i = 0; i < this.unCalcLeadAddItem; i++) {
        const element = els[i];
        dtTop += element.getBoundingClientRect().height;
      }
      this.setTop(v => v + dtTop, 'pure');
      this.unCalcLeadAddItem = 0;
    }
    this.fix();
    this.watchItems(els);
  }

  onResize() {
    this.fix();
  }

  onTopChange() {
    this.fix();
  }

  fix() {
    const shouldFixTail = this.fixLead();
    if (shouldFixTail) {
      this.fixTail();
    }
  }
  /**
   * 1. lead 在视口内
   * 2. lead 在视口下
   * @return 是否继续判断 tail
   */
  fixLead() {
    const total = this.getProp('total');
    const { pad } = this;
    const { top: pos } = this.lead.getBoundingClientRect();
    const { top: wTop, bottom: wBottom, height: wHeight } = this.wrapper.getBoundingClientRect();
    const avgHeight = this.avgHeight();
    const needEagerRender = pos - wTop > 1;
    const needPreRender = pos > wTop - pad;
    const leadNoMore = !this.hasMore('lead');
    const leadInTailVirtual = pos > wBottom;

    const c1 = needEagerRender && leadNoMore && 'to 0';
    const c2 = needEagerRender && leadInTailVirtual && 'rerender lead in virtual';
    const c3 = needPreRender && !leadNoMore && 'add lead';

    console.trace('fixstart', {
      needEagerRender,
      leadNoMore,
      leadInTailVirtual,
      needPreRender,
      start: this.start,
      case: c1 || c2 || c3
    });

    if (needEagerRender) {
      // lead 没有更多了直接滚到 0
      if (leadNoMore) {
        this.setTop(() => 0);
        return;
      }
      // pos 在 tail virtual 部分，需要渲染
      if (leadInTailVirtual) {
        const dtItem = Math.ceil((pos - wTop) / avgHeight);
        const count = Math.ceil(wHeight / avgHeight);
        const start = nature(this.start - dtItem);
        const end = this.valid(start + count);
        this.setTop(() => 0, 'pure');
        this.emitSliceAndFix({
          start,
          end
        });
        return;
      }
    }

    const delTailCount = this.calcDelTailCount();
    if (needPreRender && !leadNoMore) {
      const dtItem = Math.ceil((pos - (wTop - pad)) / avgHeight);
      const start = nature(this.start - dtItem);
      this.unCalcLeadAddItem = this.start - start;
      this.emitSliceAndFix({
        start,
        end: nature(this.end - delTailCount)
      });
      return;
    }

    if (delTailCount) {
      this.emitSliceAndFix({
        start: this.start,
        end: nature(this.end - delTailCount)
      });
      return;
    }

    return true;
  }

  calcDelTailCount() {
    // TODO: 即使 top 无变化也应该做删除判断
    const els = this.slotEl.assignedElements();
    const wBottom = this.wrapper.getBoundingClientRect().bottom;
    let delCount = 0;

    for (let i = els.length - 1; i >= 0; i--) {
      const it = els[i];
      const itemTop = it.getBoundingClientRect().top;
      if (itemTop > wBottom + this.pad) {
        delCount++;
      } else {
        break;
      }
    }

    return delCount;
  }
  get pad() {
    return this.getProp('pad') || 300;
  }
  /**
   * 1. tail 在视口内
   * 2. tail 在视口上
   */
  fixTail() {
    const { pad } = this;
    const { bottom: pos } = this.tail.getBoundingClientRect();
    const { top: wTop, bottom: wBottom, height: wHeight } = this.wrapper.getBoundingClientRect();
    const needEagerRender = wBottom - pos > 1;
    const needPreRender = pos < wBottom + pad;
    const avgHeight = this.avgHeight();
    const tailNoMore = !this.hasMore();
    const tailInLeadVirtual = pos < wTop;

    const c1 = needEagerRender && tailNoMore && 'to bottom';
    const c2 = needEagerRender && tailInLeadVirtual && 'rerender tail in virtual';
    const c3 = needPreRender && !tailNoMore && 'add tail';

    console.trace('fixend', {
      needEagerRender,
      tailNoMore,
      tailInLeadVirtual,
      needPreRender,
      end: this.end,
      case: c1 || c2 || c3
    });

    // 紧急渲染
    if (needEagerRender) {
      // 首尾不足情况下的渲染
      if (tailNoMore) {
        const leadNoMore = !this.hasMore('lead');
        const { bottom: leadPos } = this.lead.getBoundingClientRect();
        const remainDist = Math.floor(wTop - leadPos);
        const needDist = wBottom - pos;
        // 头部没有剩余项时只向下滚动 可滚动的距离
        if (leadNoMore) {
          if (remainDist > needDist) {
            this.setTop(v => v - needDist);
            return;
          } else {
            // 剩余部分较小，此时，只能让头部全部显示，底部留白
            this.setTop(v => 0, 'pure');
            return;
          }
        }

        this.setTop(v => v - needDist);
        return;
      }

      // pos 在 top virtual 部分，需要重新计算渲染
      if (tailInLeadVirtual) {
        const dtItem = Math.ceil((wBottom - pos) / avgHeight);
        const count = Math.ceil(wHeight / avgHeight);
        const end = this.valid(this.end + dtItem);
        const start = nature(end - count);
        this.setTop(() => 0, 'pure');
        this.emitSliceAndFix({
          start,
          end
        });
        return;
      }
    }

    // lead 没有更多了直接滚到 0
    // 向下预渲染前，计算上部分需要删除的项
    const { delCount, delHeight } = this.calcDelLeadCount();

    // 预渲染
    if (needPreRender && !tailNoMore) {
      const dtItem = Math.ceil((wBottom + pad - pos) / avgHeight);
      const end = this.valid(this.end + dtItem);
      const start = this.valid(this.start + delCount);
      console.log({ delCount, start });
      this.setTop(v => v - delHeight, 'pure');
      this.emitSliceAndFix({
        start,
        end
      });
      return;
    }

    if(delCount) {
      const start = this.valid(this.start + delCount);
      this.setTop(v => v - delHeight, 'pure');
      this.emitSliceAndFix({
        start,
        end: this.end
      });
      return;
    }

    return true;
  }

  calcDelLeadCount() {
    const els = this.slotEl.assignedElements();
    const wTop = this.wrapper.getBoundingClientRect().top;
    let delCount = 0;
    let delHeight = 0;
    for (let i = 0; i < els.length; i++) {
      const it = els[i];
      const { bottom: itemBottom, height } = it.getBoundingClientRect();
      if (itemBottom < wTop - this.pad) {
        delCount++;
        delHeight += height;
      } else {
        break;
      }
    }

    return { delCount, delHeight };
  }

  valid(v: number) {
    const total = this.getProp('total');
    return Math.min(v, total);
  }

  emitSliceAndFix(sliceInfo: SliceInfo) {
    console.trace('slice change', sliceInfo.start, sliceInfo.end);
    Object.assign(this, sliceInfo);
    this.dispatchEvent(new CustomEvent(SLICE_EVENT, { detail: this }));
  }

  avgHeight() {
    if (this.start < this.end) {
      // connectedCallback Fix 中 end 被修改，可能用户没开始监听 slice 事件，导致事件 miss
      // 而在后续的 resize Fix 中 又有机会触发一次 fix，此时 start < end，因此只能通过 listHeight 二次确认
      const listHeight = this.list.getBoundingClientRect().height;
      if (listHeight === 0) return this.getProp('itemHeight');
      return listHeight / (this.end - this.start);
    }
    return this.getProp('itemHeight');
  }

  hasMore(lead?: 'lead') {
    const total = this.getProp('total');
    return lead ? this.start > 0 : this.end < total;
  }

  getProp(key: Keys) {
    try {
      return Number(this.attributes.getNamedItem(key).value);
    } catch (error) {
      if (keys[key]) {
        throw {
          message: `未传入属性${key}!`,
          raw: error
        };
      }
    }
  }

  resizeObs = new ResizeObserver(this.onResize.bind(this));
  abortCon = new AbortController();

  /*----------------- api -----------------*/
  scrollv<T extends ScrollVType>(type: T, payload: IScrollV[T]) {
    const action = { type, payload } as Action;
    switch (action.type) {
      case 'toItem':
        const { index, dt } = action.payload;
        this.scrollToItem(index, dt);
        break;
      case 'delta':
        // noop
        break;
      default:
        break;
    }
  }

  scrollToItem(index: number, dt = 0) {
    index = this.valid(index);
    const avgHeight = this.avgHeight();
    const wHeight = this.wrapper.getBoundingClientRect().height;
    const count = Math.ceil(wHeight / avgHeight);
    this.setTop(() => dt, 'pure');
    this.emitSliceAndFix({
      start: index,
      end: this.valid(index + count)
    });
  }

  destroy() {
    if (this.isConnected) {
      this.remove();
    }
    this.shadow = undefined;
    this.wrapper = undefined;
    this.list = undefined;
    this.slotEl = undefined;
    this.resizeObs.disconnect();
    this.abortCon.abort();
    this.observed.clear();
    const ownKeys = Object.getOwnPropertyNames(this).filter(it => typeof this[it] === 'function');
    const portoKeys = Object.getOwnPropertyNames(AutoHeight.prototype).filter(it => typeof this[it] === 'function');
    [...ownKeys, ...portoKeys].forEach(key => {
      this[key] = cNoop(key);
    });
  }
}

function nature(num: number) {
  return Math.max(num, 0);
}
